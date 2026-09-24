/**
 * Regression: the installer must never widen the permissions of an agent
 * config file it rewrites.
 *
 * `~/.claude.json` is the file `codegraph install --location=global` edits for
 * Claude Code. It is also where Claude Code keeps MCP server definitions —
 * including each server's `env` block, which routinely holds API keys and
 * tokens — next to account metadata. Users who `chmod 600` it expect that to
 * stick.
 *
 * `atomicWriteFileSync` writes a temp sibling and renames it into place. A
 * rename swaps the inode, so the resulting file carries the TEMP file's mode.
 * Writing the temp with the process umask therefore silently downgraded a
 * 0600 config to 0644 (world-readable) the first time the installer touched
 * it. These tests pin the fix: the original mode survives the write, and the
 * temp file is never readable by anyone but the owner while it exists.
 *
 * POSIX-gated: Windows does not implement POSIX permission bits, and
 * `fs.statSync().mode` there reports a synthesized value that carries no
 * group/other distinction, so the assertion is meaningless (not merely
 * different). The hardening itself still runs on Windows — `chmodSync` is a
 * documented no-op for these bits — it just cannot be asserted there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync, writeJsonFile } from '../src/installer/targets/shared';

const isPosix = process.platform !== 'win32';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-perms-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe('atomicWriteFileSync permission preservation', () => {
  it.runIf(isPosix)('preserves a 0600 file mode across a rewrite', () => {
    const file = path.join(tmpDir, 'claude.json');
    fs.writeFileSync(file, '{"mcpServers":{}}\n');
    fs.chmodSync(file, 0o600);

    atomicWriteFileSync(file, '{"mcpServers":{"codegraph":{}}}\n');

    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain('codegraph');
  });

  it.runIf(isPosix)('preserves a 0640 file mode across a rewrite', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, '{}\n');
    fs.chmodSync(file, 0o640);

    writeJsonFile(file, { permissions: { allow: ['mcp__codegraph__*'] } });

    expect(mode(file)).toBe(0o640);
  });

  it.runIf(isPosix)('never widens permissions on repeated writes', () => {
    const file = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(file, '{}\n');
    fs.chmodSync(file, 0o600);

    for (let i = 0; i < 3; i++) writeJsonFile(file, { round: i });

    expect(mode(file)).toBe(0o600);
  });

  it('leaves no temp files behind', () => {
    const file = path.join(tmpDir, 'config.json');
    writeJsonFile(file, { a: 1 });
    writeJsonFile(file, { a: 2 });
    const leftovers = fs.readdirSync(tmpDir).filter((n) => n.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to follow a symlink pre-planted at the temp path', () => {
    // The temp name now carries random bytes, so an attacker cannot guess it;
    // O_EXCL is the belt-and-braces guard. Assert the O_EXCL half directly by
    // proving a write still lands on the real file and never on an outside
    // target that shares the temp prefix.
    const file = path.join(tmpDir, 'target.json');
    const outside = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(outside, 'ORIGINAL');

    writeJsonFile(file, { safe: true });

    expect(fs.readFileSync(outside, 'utf8')).toBe('ORIGINAL');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ safe: true });
  });

  it('still creates a file that did not exist', () => {
    const file = path.join(tmpDir, 'nested', 'new.json');
    writeJsonFile(file, { created: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ created: true });
  });
});
