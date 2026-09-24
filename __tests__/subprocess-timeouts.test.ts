import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * #1139: every git/npm subprocess call must be time-bounded. A stuck git
 * (network filesystem, wedged fsmonitor daemon) otherwise blocks the caller
 * forever — worst on the daemon's main event loop, where `gitWorktreeRoot`/
 * `gitCommonDir` run (memoized) while serving MCP clients and an unbounded
 * hang would trip the 60s liveness watchdog and SIGKILL a healthy daemon.
 * `extraction/index.ts` already passes a timeout on every git call; these
 * tests pin the same convention on the stragglers it flagged.
 */

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => `${os.tmpdir()}\n`),
  execSync: vi.fn(() => ''),
}));

import { execFileSync } from 'child_process';
import { gitWorktreeRoot, gitCommonDir } from '../src/sync/worktree';
import { isGitRepo } from '../src/sync/git-hooks';

const timeoutOf = (): unknown => {
  const call = vi.mocked(execFileSync).mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call![2] as { timeout?: unknown }).timeout;
};

describe('git subprocess calls pass a timeout (#1139)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  it('gitWorktreeRoot bounds `git rev-parse --show-toplevel`', () => {
    gitWorktreeRoot(os.tmpdir());
    expect(timeoutOf()).toEqual(expect.any(Number));
  });

  it('gitCommonDir bounds `git rev-parse --git-common-dir`', () => {
    gitCommonDir(os.tmpdir());
    expect(timeoutOf()).toEqual(expect.any(Number));
  });

  it('isGitRepo bounds `git rev-parse --is-inside-work-tree`', () => {
    isGitRepo(os.tmpdir());
    expect(timeoutOf()).toEqual(expect.any(Number));
  });
});

describe('no exec*Sync call site in these modules is unbounded (#1139)', () => {
  // Source-level sweep: behavior tests above can only reach exported
  // functions; this also covers the non-exported `gitHooksDir`, and catches
  // future call sites added to these files without a timeout.
  //
  // `src/installer/index.ts` used to be in this list for its `npm install -g`
  // (buried in an interactive prompt flow). The Bridgenext fork removed that
  // call — it fetched the UPSTREAM package from the public registry, and the
  // step was redundant since reaching it means an installed `codegraph` is
  // already running. The file now has no exec*Sync at all, which the next test
  // pins directly; keeping it here would only fail the non-vacuity guard.
  it.each([
    'src/sync/worktree.ts',
    'src/sync/git-hooks.ts',
  ])('%s passes a timeout at every exec*Sync call site', (rel) => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
    const sites = src.split(/\bexec(?:File)?Sync\(/).slice(1);
    // Non-vacuity: a rename or a refactor that empties the file must not turn
    // this into a silently-passing no-op.
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      // The options object sits within a few hundred chars of the call.
      expect(site.slice(0, 400)).toMatch(/\btimeout\s*:/);
    }
  });

  it('src/installer/index.ts spawns no subprocess at all', () => {
    // Stronger than "bounded": the installer must not shell out to a package
    // manager (or anything else) mid-install. Regression guard for the fork's
    // removal of `npm install -g <upstream package>` — a reintroduced install
    // step would both fetch a different project's code and add an unbounded
    // network dependency to the install path.
    // Asserted on the spawn PRIMITIVES rather than on a command string: you
    // cannot invoke a package manager without one of these, and matching prose
    // would trip on the comment that explains why the call was removed.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/installer/index.ts'), 'utf8');
    expect(src).not.toMatch(/\bexec(?:File)?Sync\(/);
    expect(src).not.toMatch(/\bexecFile\(/);
    expect(src).not.toMatch(/\bspawn(?:Sync)?\(/);
  });
});
