/**
 * Release-workflow staging (pre-release) guarantees.
 *
 * A production release is irreversible in practice: the moment it publishes,
 * every teammate's `install.sh` resolves it through `releases/latest`. The
 * workflow therefore supports a rehearsal mode (`prerelease: true`) that must
 * hold three properties, each of which fails SILENTLY if it regresses — the
 * workflow still goes green and you only find out from a teammate.
 *
 *   1. The release is flagged `--prerelease`. That flag is the ONLY thing
 *      keeping a rehearsal out of the `/releases/latest` API and the
 *      `releases/latest` redirect — the two paths install.sh uses to discover
 *      a version. Drop it and a staging build instantly becomes what everyone
 *      installs.
 *   2. A staging run never mutates `main` — it must not promote the
 *      `[Unreleased]` CHANGELOG block (which would spend the real release's
 *      notes) and must not push.
 *   3. The tag it publishes is one install.sh can actually resolve.
 *
 * (3) is the subtle one and the reason this file runs a shell rather than only
 * grepping. install.sh normalizes a tag by prepending `v` when absent, so a
 * release published as `dev` is unreachable: the installer looks for `vdev` and
 * 404s on download. The workflow carries the same normalization so it can't
 * publish such a tag — and "the same" is exactly the kind of duplicated logic
 * that drifts. So the test extracts the REAL normalization line out of both
 * files, runs each under `sh`, and asserts they agree, instead of restating
 * either one here. No network.
 *
 * Shell-gated rather than platform-gated, matching install-sh-checksum.test.ts:
 * it runs on Linux/macOS CI and on a Windows dev box with Git Bash.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const INSTALL_SH = path.join(ROOT, 'install.sh');
const RELEASE_YML = path.join(ROOT, '.github', 'workflows', 'release.yml');

/** Read a file as LF-normalized lines (a Windows checkout may hold CRLF). */
function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
}

/**
 * The `v`-prefix normalization, in whatever variable the host file uses:
 *   install.sh   -> case "$version" in v*) ;; *) version="v$version" ;; esac
 *   release.yml  -> case "$TAG"     in v*) ;; *) TAG="v$TAG"         ;; esac
 * The backreference pins that the same variable is read and written, so a
 * half-edited line can't pass as a match.
 */
const NORMALIZE_RE =
  /^case\s+"\$(\w+)"\s+in\s+v\*\)\s*;;\s*\*\)\s*\1="v\$\1"\s*;;\s*esac$/;

function extractNormalizeLine(file: string): { line: string; varName: string } {
  for (const raw of lines(file)) {
    const m = raw.trim().match(NORMALIZE_RE);
    if (m) return { line: raw.trim(), varName: m[1] };
  }
  throw new Error(`tag normalization (case "$X" in v*) …) not found in ${path.basename(file)}`);
}

/** Run one extracted normalization line against a tag; return the result. */
function normalize(file: string, tag: string): string {
  const { line, varName } = extractNormalizeLine(file);
  const script = `${varName}='${tag}'\n${line}\nprintf '%s' "$${varName}"`;
  const r = spawnSync(SH!, ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sh failed for ${path.basename(file)}: ${r.stderr}`);
  return r.stdout ?? '';
}

function findPosixShell(): string | null {
  const candidates = ['sh'];
  if (process.platform === 'win32') {
    const where = spawnSync('where', ['git'], { encoding: 'utf8' });
    for (const l of (where.stdout ?? '').split(/\r?\n/)) {
      const gitExe = l.trim();
      if (!gitExe) continue;
      const root = path.dirname(path.dirname(gitExe));
      candidates.push(path.join(root, 'usr', 'bin', 'sh.exe'));
      candidates.push(path.join(root, 'bin', 'sh.exe'));
    }
  }
  for (const sh of candidates) {
    const r = spawnSync(sh, ['-c', 'exit 0'], { encoding: 'utf8' });
    if (r.status === 0) return sh;
  }
  return null;
}

const SH = findPosixShell();

describe('release workflow: staging (pre-release) mode', () => {
  const yml = fs.readFileSync(RELEASE_YML, 'utf8');

  it('exposes prerelease + tag inputs on workflow_dispatch', () => {
    expect(yml).toMatch(/workflow_dispatch:/);
    expect(yml).toMatch(/^\s+prerelease:\s*$/m);
    expect(yml).toMatch(/^\s+tag:\s*$/m);
    // A boolean input is what makes the `if:` guard below evaluate correctly;
    // a string input would make `!inputs.prerelease` false for "false".
    expect(yml).toMatch(/prerelease:[\s\S]{0,200}?type:\s*boolean/);
  });

  it('skips the CHANGELOG promote on a staging run', () => {
    // Without this guard a rehearsal consumes [Unreleased] and pushes to main,
    // so the real release that follows publishes empty notes.
    expect(yml).toMatch(/if:\s*\$\{\{\s*!inputs\.prerelease\s*\}\}/);
  });

  it('passes --prerelease to gh release create when staging', () => {
    // Deliberately NOT a `toContain('--prerelease')`: the flag is discussed in
    // this workflow's comments, so a substring check passes even after the flag
    // is deleted from the code (verified by mutation). Pin the two halves of
    // the actual mechanism instead — the guarded assignment, and the fact that
    // the variable reaches the create call.
    expect(yml).toMatch(
      /inputs\.prerelease\s*\}\}"\s*=\s*"true"\s*\][\s\S]{0,160}FLAGS="--prerelease"/,
    );
    expect(yml).toMatch(/gh release create[\s\S]{0,200}\$FLAGS/);
  });

  it('does not push the lock-file sync to main on a staging run', () => {
    const pushes = yml.split('\n').filter((l) => l.includes('git push origin'));
    expect(pushes.length).toBeGreaterThan(0); // non-vacuity: pushes still exist
    // Every push must sit under a prerelease guard. Cheap structural proxy:
    // the lock-file step's push is wrapped in an `if … prerelease … else`.
    expect(yml).toMatch(
      /inputs\.prerelease\s*\}\}"\s*=\s*"true"\s*\][\s\S]{0,300}git push origin/,
    );
  });
});

describe.skipIf(!SH)('release tag normalization matches install.sh', () => {
  // `dev` is the real case that motivated this: the fork carried a `dev`
  // pre-release, and CODEGRAPH_VERSION=dev resolves to `vdev` -> 404.
  const cases = ['1.6.0', 'v1.6.0', '1.6.0-rc.1', 'v1.6.0-rc.1', 'dev', 'v0.9.4'];

  it('finds the normalization in both files', () => {
    expect(extractNormalizeLine(INSTALL_SH).varName).toBeTruthy();
    expect(extractNormalizeLine(RELEASE_YML).varName).toBeTruthy();
  });

  it.each(cases)('agrees on %s', (tag) => {
    const fromInstaller = normalize(INSTALL_SH, tag);
    const fromWorkflow = normalize(RELEASE_YML, tag);
    expect(fromWorkflow).toBe(fromInstaller);
    expect(fromWorkflow.startsWith('v')).toBe(true);
  });

  it('prepends v to a bare tag, so `dev` would publish as `vdev`', () => {
    // Not a quirk to fix — it is why a staging tag must be written WITH the
    // `v`. Pinned so the asymmetry stays visible if either side changes.
    expect(normalize(RELEASE_YML, 'dev')).toBe('vdev');
    expect(normalize(INSTALL_SH, 'dev')).toBe('vdev');
  });

  it('leaves an already-prefixed tag untouched', () => {
    expect(normalize(RELEASE_YML, 'v1.6.0-rc.1')).toBe('v1.6.0-rc.1');
  });
});
