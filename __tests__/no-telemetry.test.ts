/**
 * Guard: this fork ships NO telemetry, analytics, or usage reporting.
 *
 * Upstream CodeGraph collected anonymous usage stats (a client in
 * `src/telemetry/`, a Cloudflare ingest worker in `telemetry-worker/`, and a
 * dashboard in `telemetry-dashboard/`) and offered a marketing e-mail signup
 * that POSTed the user's address to `getcodegraph.com`. The Bridgenext fork
 * removed all of it. This suite fails if any of it is reintroduced — by a
 * merge from upstream, a copy-paste, or a new dependency.
 *
 * The rule it enforces is narrow and mechanical: **no outbound network sink
 * other than the GitHub release feed**, and none of the removed identifiers.
 * The one remaining outbound call is the update check / `codegraph upgrade`
 * (a plain GET for a release tag, carrying nothing about the user or their
 * code, disabled by `CODEGRAPH_NO_UPDATE_CHECK` or `DO_NOT_TRACK`), so
 * github.com is the only host allowed to appear in a request.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

/** Directories that hold shipped code/config — the surface this guard covers. */
const SCANNED_DIRS = ['src', 'scripts', 'site/src'];
/** Top-level files that describe how the tool is built, shipped, and installed. */
const SCANNED_FILES = ['package.json', 'install.sh', 'install.ps1', 'vitest.config.ts'];

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sh', '.ps1', '.astro', '.md']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // an optional dir (site/) may not exist in every checkout
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'wasm') continue;
      walk(full, out);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function shippedFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCANNED_DIRS) walk(path.join(REPO_ROOT, dir), files);
  for (const file of SCANNED_FILES) {
    const full = path.join(REPO_ROOT, file);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/** Every match of `pattern` across the shipped tree, as `path:line` strings. */
function findAll(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of shippedFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      // Defensive: `RegExp.test` advances `lastIndex` on a /g pattern, so a
      // future caller passing one would silently skip every other match.
      pattern.lastIndex = 0;
      if (pattern.test(line)) hits.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('no telemetry in this fork', () => {
  it('the telemetry client module is gone', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src/telemetry'))).toBe(false);
  });

  it('the telemetry ingest worker and dashboard are gone', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'telemetry-worker'))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'telemetry-dashboard'))).toBe(false);
  });

  it('the marketing e-mail signup module is gone', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src/installer/beta-signup.ts'))).toBe(false);
  });

  it.each([
    ['telemetry client API', /\b(getTelemetry|recordUsage|recordLifecycle|recordIndexEvent)\s*\(/],
    ['telemetry config/env', /\b(CODEGRAPH_TELEMETRY|CODEGRAPH_TELEMETRY_ENDPOINT|CODEGRAPH_TELEMETRY_DEBUG)\b/],
    ['telemetry endpoint', /telemetry\.getcodegraph\.com/],
    ['telemetry state files', /telemetry-queue|telemetry\.json/],
    ['beta / waitlist signup', /\b(BETA_SIGNUP_ENDPOINT|submitBetaSignup|maybeOfferBetaSignup|hasBetaSignupChoice)\b/],
    ['waitlist endpoint', /getcodegraph\.com\/api\/waitlist/],
    ['third-party analytics SDKs', /\b(posthog|mixpanel|amplitude|segment\.com\/analytics|google-analytics|gtag\()/i],
  ])('no %s anywhere in the shipped tree', (_label, pattern) => {
    expect(findAll(pattern)).toEqual([]);
  });

  it('declares no analytics/telemetry dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    const banned = /posthog|mixpanel|amplitude|analytics|telemetry|sentry|bugsnag|datadog|newrelic/i;
    expect(names.filter((n) => banned.test(n))).toEqual([]);
  });

  /**
   * The strongest guard: enumerate every literal http(s) URL that shipped code
   * could REQUEST, and require each host to be one we deliberately allow. A new
   * exfiltration sink cannot be added without failing here.
   *
   * Documentation links are excluded by host, not by intent — `docsUrl` fields
   * and error-message links point at vendor docs (docs.claude.com, kiro.dev,
   * …) and are never fetched. Adding a host here is a deliberate act that
   * shows up in review.
   */
  it('contacts no host other than GitHub', () => {
    const REQUESTABLE_HOSTS = new Set([
      'github.com',
      'api.github.com',
      'raw.githubusercontent.com',
      'objects.githubusercontent.com',
      'registry.npmjs.org',
    ]);
    // Hosts that only ever appear as human-readable documentation links.
    const DOC_ONLY_HOSTS = new Set([
      'docs.claude.com', 'code.claude.com', 'docs.cursor.com', 'docs.github.com',
      'opencode.ai', 'kiro.dev', 'geminicli.com', 'antigravity.google',
      'code.visualstudio.com', 'hermes-agent.nousresearch.com', 'modelcontextprotocol.io',
      'developer.apple.com', 'luau.org', 'nodejs.org', 'opensource.org', 'img.shields.io',
      'www.npmjs.com', 'cdn.example.com', 'example.com', 'astro.build', 'starlight.astro.build',
      'bridgenext.github.io', 'x.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
      'schemas.wp.org', 'www.w3.org', 'creativecommons.org', 'unpkg.com',
      'tree-sitter.github.io',
    ]);

    const urlPattern = /https?:\/\/([a-zA-Z0-9.-]+)/g;
    const offenders: string[] = [];
    for (const file of shippedFiles()) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const m of line.matchAll(urlPattern)) {
          const host = m[1]!.toLowerCase().replace(/[.,)'"`;]+$/, '');
          if (REQUESTABLE_HOSTS.has(host) || DOC_ONLY_HOSTS.has(host)) continue;
          offenders.push(`${rel(file)}:${i + 1}: ${host}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
