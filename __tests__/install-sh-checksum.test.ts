/**
 * install.sh archive-integrity tests.
 *
 * The standalone installer downloads a release bundle and extracts it into a
 * directory that is then put on the user's PATH — so the archive's bytes
 * become executable code. TLS authenticates the connection to GitHub, but
 * nothing authenticated the CONTENT: a corrupted download, a caching proxy, or
 * a swapped release asset would all be extracted and run unnoticed. The
 * release already publishes a SHA256SUMS asset; the installer now verifies
 * against it and aborts on a mismatch.
 *
 * Following the `install-sh-prune.test.ts` idiom, these tests extract the REAL
 * verification function from the shipped `install.sh` — between its
 * `CODEGRAPH_VERIFY_CHECKSUM` markers — and exercise it against temp fixtures,
 * so the test can never drift from the script that ships. No network.
 *
 * The block is `/bin/sh`, so the suite is gated on a POSIX shell being
 * available rather than on the platform: it runs on Linux/macOS CI and also on
 * a Windows dev box that has Git Bash, which is where the shipped script most
 * often goes unexercised. install.ps1 carries the equivalent PowerShell check
 * for Windows users.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const INSTALL_SH = path.join(__dirname, '..', 'install.sh');
const START = '# >>> CODEGRAPH_VERIFY_CHECKSUM';
const END = '# <<< CODEGRAPH_VERIFY_CHECKSUM';
const ASSET = 'codegraph-linux-x64.tar.gz';

/** Pull the exact verify block out of the shipped install.sh (no duplication). */
function extractVerifyBlock(): string {
  // Strip CR: a Windows checkout may hold the script with CRLF endings, and
  // `sh` would choke on the trailing \r inside the extracted function body.
  const lines = fs.readFileSync(INSTALL_SH, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
  const i = lines.findIndex((l) => l.trim() === START);
  const j = lines.findIndex((l) => l.trim() === END);
  if (i < 0 || j < 0 || j <= i) {
    throw new Error('CODEGRAPH_VERIFY_CHECKSUM markers not found in install.sh');
  }
  // Only the function definition is reusable in isolation; the driver below it
  // performs the network fetch. Cut at the function's closing brace.
  const block = lines.slice(i + 1, j);
  const end = block.findIndex((l) => l === '}');
  if (end < 0) throw new Error('verify_checksum() closing brace not found');
  return block.slice(0, end + 1).join('\n');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render a path the way the POSIX shell we found expects it. Git Bash's MSYS
 * coreutils cannot open a `C:\dir\file` argument, so translate to `/c/dir/file`
 * — harness-only: install.sh itself only ever runs on a real POSIX system.
 */
function shPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

/** Run the real verify_checksum() and return its exit code. */
function verify(archive: string, asset: string, sums: string): number {
  const script = [
    extractVerifyBlock(),
    `verify_checksum ${shq(shPath(archive))} ${shq(asset)} ${shq(shPath(sums))}`,
  ].join('\n');
  const r = spawnSync(SH!, ['-c', script], { encoding: 'utf8' });
  return r.status ?? -1;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Locate a POSIX shell that can also hash.
 *
 * On Linux/macOS this is just `sh`. On Windows, Git for Windows ships
 * `sh.exe` + `sha256sum.exe` under its `usr/bin`, but that directory is
 * deliberately kept OFF the system PATH — so we derive it from wherever `git`
 * itself resolves. Finding it means this suite exercises the shipped shell on
 * a Windows dev box too, instead of silently skipping exactly where the POSIX
 * installer is least likely to be tested.
 */
function findPosixShell(): string | null {
  const candidates = ['sh'];
  if (process.platform === 'win32') {
    const where = spawnSync('where', ['git'], { encoding: 'utf8' });
    for (const line of (where.stdout ?? '').split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      // <root>\cmd\git.exe or <root>\bin\git.exe -> <root>\usr\bin\sh.exe
      const root = path.dirname(path.dirname(gitExe));
      candidates.push(path.join(root, 'usr', 'bin', 'sh.exe'));
      candidates.push(path.join(root, 'bin', 'sh.exe'));
    }
  }
  for (const sh of candidates) {
    const r = spawnSync(sh, ['-c', 'command -v sha256sum || command -v shasum'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout?.trim()) return sh;
  }
  return null;
}

const SH = findPosixShell();

describe.skipIf(!SH)('install.sh archive checksum verification', () => {
  let dir: string;
  let archive: string;
  let good: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-checksum-'));
    archive = path.join(dir, 'cg.tar.gz');
    fs.writeFileSync(archive, 'pretend this is a 50MB bundle');
    good = sha256(archive);
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function writeSums(body: string): string {
    const p = path.join(dir, 'SHA256SUMS');
    fs.writeFileSync(p, body);
    return p;
  }

  it('accepts an archive whose hash matches (exit 0)', () => {
    expect(verify(archive, ASSET, writeSums(`${good}  ${ASSET}\n`))).toBe(0);
  });

  it('REJECTS an archive whose hash does not match (exit 1)', () => {
    const wrong = '0'.repeat(64);
    expect(verify(archive, ASSET, writeSums(`${wrong}  ${ASSET}\n`))).toBe(1);
  });

  it('rejects a tampered archive even when SHA256SUMS is intact', () => {
    const sums = writeSums(`${good}  ${ASSET}\n`);
    fs.appendFileSync(archive, 'malicious payload');
    expect(verify(archive, ASSET, sums)).toBe(1);
  });

  it('reports "not listed" (exit 2) when the asset is absent from SHA256SUMS', () => {
    expect(verify(archive, ASSET, writeSums(`${good}  codegraph-darwin-arm64.tar.gz\n`))).toBe(2);
  });

  it('reports "not listed" (exit 2) for an empty SHA256SUMS', () => {
    expect(verify(archive, ASSET, writeSums(''))).toBe(2);
  });

  it('accepts the binary-mode "*name" spelling sha256sum emits', () => {
    expect(verify(archive, ASSET, writeSums(`${good} *${ASSET}\n`))).toBe(0);
  });

  it('accepts an uppercase hash', () => {
    expect(verify(archive, ASSET, writeSums(`${good.toUpperCase()}  ${ASSET}\n`))).toBe(0);
  });

  it('picks the right line out of a multi-asset SHA256SUMS', () => {
    const other = '1'.repeat(64);
    const sums = writeSums(
      `${other}  codegraph-darwin-arm64.tar.gz\n` +
      `${other}  codegraph-darwin-x64.tar.gz\n` +
      `${good}  ${ASSET}\n` +
      `${other}  codegraph-win32-x64.zip\n`,
    );
    expect(verify(archive, ASSET, sums)).toBe(0);
  });

  it('does not match an asset name by prefix or suffix', () => {
    // `codegraph-linux-x64.tar.gz` must not be satisfied by a line for
    // `evil-codegraph-linux-x64.tar.gz`.
    expect(verify(archive, ASSET, writeSums(`${good}  evil-${ASSET}\n`))).toBe(2);
  });

  it('install.sh aborts the install on mismatch rather than warning', () => {
    // Pin the policy, not just the helper: the mismatch branch must `exit 1`.
    const script = fs.readFileSync(INSTALL_SH, 'utf8');
    expect(script).toMatch(/CHECKSUM MISMATCH[\s\S]{0,400}exit 1/);
  });

  it('install.sh points at the Bridgenext fork', () => {
    const script = fs.readFileSync(INSTALL_SH, 'utf8');
    expect(script).toMatch(/^REPO="bridgenext\/forge-codegraph"$/m);
  });
});
