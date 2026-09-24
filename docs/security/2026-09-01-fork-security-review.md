# Security review — Bridgenext fork of CodeGraph

**Date:** 2026-09-01
**Base:** upstream CodeGraph 1.6.0 (`6a056ec`)
**Scope:** whole repository, with emphasis on the Claude Code integration, the
install/upgrade path, and anything that leaves the machine.
**Reviewer:** Shivam Pawar

This is the record behind the fork's first hardening pass. It states what was
found, how severe it is, and what was done — including the things deliberately
*not* changed.

## Summary

| Severity | Finding | Location | Status |
|---|---|---|---|
| High | Release bundles downloaded and executed with no integrity verification | `install.sh`, `install.ps1` | **Fixed** |
| High | Shipped dependency `picomatch@4.0.3` — ReDoS + method injection in POSIX character classes | `package.json` | **Fixed** |
| Medium | Rewriting `~/.claude.json` discarded its file mode, exposing MCP `env` secrets | `src/installer/targets/shared.ts` | **Fixed** |
| Medium | Usage telemetry enabled by default, sent to a third-party endpoint | `src/telemetry/`, many call sites | **Fixed (removed)** |
| Medium | Installer POSTed the user's e-mail address to a third-party marketing endpoint | `src/installer/beta-signup.ts` | **Fixed (removed)** |
| Medium | Installer ran `npm install -g` against the public registry mid-install | `src/installer/index.ts` | **Fixed** |
| Medium | No CI: no tests, type check, or dependency audit ran on push/PR | `.github/workflows/` | **Fixed** |
| Low | Daemon socket world-connectable between `listen()` and `chmod()` | `src/mcp/daemon.ts` | **Fixed** |
| Low | Atomic config write used a predictable temp name without `O_EXCL` | `src/installer/targets/shared.ts` | **Fixed** |
| Low | Corrupt-config `.backup` copy relied on undocumented mode-preservation | `src/installer/targets/shared.ts` | **Fixed** |
| Low | Sensitive-directory check skipped for a not-yet-existing `projectPath` | `src/mcp/tools.ts` | **Open (accepted)** |
| Low | Dev-only advisories in the vitest/rollup toolchain (incl. one critical) | `package.json` devDeps | **Open (tracked)** |
| Info | `codegraph upgrade` executes a downloaded shell script (`curl \| sh`) | `src/upgrade/index.ts` | **Open (accepted)** |
| Info | Indexed code reaches the agent's context — an injection channel by design | `src/mcp/`, prompt hook | **Open (inherent)** |
| Info | `RELEASE_PAT` is a long-lived PAT used by the release workflow | `.github/workflows/release.yml` | **Open (documented)** |

Clean results: no hardcoded credentials or keys anywhere in the tree or in git
history; no SQL injection (every interpolation is a generated `?` placeholder
list, a constant identifier, or a validated number); no command injection
(every `spawnSync` uses a constant argv, never a shell string built from
input); no unsafe deserialization; no SSRF sink (all URLs are constants).

---

## Findings

### HIGH-1 — Release bundles were downloaded and executed without integrity verification

**Location:** `install.sh`, `install.ps1`

**What.** Both installers downloaded `codegraph-<target>.{tar.gz,zip}` from
GitHub Releases, extracted it, and put the result on the user's `PATH` — with
no check that the bytes were the ones the release workflow produced. The
release already published a `SHA256SUMS` asset; nothing consumed it.
(`scripts/npm-shim.js` did verify, so the protection existed but only on the
npm path this fork does not use.)

**Why it is a vulnerability.** TLS authenticates the *connection* to GitHub, not
the *artifact*. Anything that can alter the artifact between build and disk —
a compromised or swapped release asset, a corporate MITM proxy, a caching
mirror, a partially-written download — produces an archive that is silently
extracted into a directory on `PATH`.

**Impact.** Arbitrary code execution as the installing user, on every machine
that runs the install one-liner. This is the highest-value target in the repo:
the install command is copy-pasted into terminals by every teammate, and the
extracted bundle contains a vendored Node runtime plus the app.

**Remediation (done).** Both installers now fetch the release's `SHA256SUMS`,
locate the line for the exact asset name, compare it against the computed
digest, and **abort** on mismatch. Absent or unlisted checksums degrade to a
warning (older releases predate the manifest) rather than a hard failure, so
the check cannot break an install; a *mismatch* is always fatal.
`CODEGRAPH_SKIP_CHECKSUM=1` exists as a documented, loud escape hatch.

Covered by `__tests__/install-sh-checksum.test.ts`, which extracts the real
verification function out of the shipped `install.sh` — so the test cannot
drift from the script — and exercises match, mismatch, tampered-archive,
not-listed, empty-manifest, binary-mode (`*name`), uppercase-hash,
multi-asset, and prefix-collision cases.

Defence in depth: the release workflow already produced signed build
attestations. A checksum proves integrity; an attestation proves origin.
Verify with `gh attestation verify <file> -R bridgenext/forge-codegraph`.

### HIGH-2 — `picomatch@4.0.3` shipped with two high-severity advisories

**Location:** `package.json` → `dependencies.picomatch`

**What.** GHSA-c2c7-rcm5-vvqj (ReDoS via extglob quantifiers, CVSS 7.5) and
GHSA-3v7f-55p6-f55p (method injection in POSIX character classes causing
incorrect glob matching, CVSS 5.3).

**Why it is a vulnerability.** picomatch is a *runtime* dependency: it
evaluates the include/exclude globs that decide which files get indexed and
watched. Those patterns come from a project's `.codegraph/config.json` and
`.gitignore` — i.e. from the repository being indexed, which is not always
first-party.

**Impact.** A crafted pattern in an untrusted repository could hang the indexer
(denial of service), and incorrect matching could cause files to be indexed or
skipped contrary to the configured exclusions.

**Remediation (done).** Bumped to `^4.0.7`. `npm audit --omit=dev` now reports
**0 vulnerabilities**. Verified no behavioral change across the 99 tests in the
seven glob-dependent suites (`exclude-config`, `include-config`,
`include-ignored-config`, `watch-policy`, `is-test-file`,
`android-res-exclusion`, `generated-detection`).

### MEDIUM-1 — Rewriting an agent config discarded its file permissions

**Location:** `src/installer/targets/shared.ts` → `atomicWriteFileSync`

**What.** The function wrote a temp sibling and renamed it over the target. A
rename replaces the inode, so the resulting file carries the *temp file's*
mode. The temp file was created with the process umask (0644 under the usual
022). Any target file the user had tightened was silently widened.

**Why it is a vulnerability.** The primary target is `~/.claude.json`. Beyond
account metadata, that file holds every MCP server definition the user has
configured — including each server's `env` block, which is the conventional
place to put an API key or token. `~/.claude/settings.json` is written the same
way. A user who ran `chmod 600 ~/.claude.json` had that undone by
`codegraph install`, without any indication.

**Impact.** Credentials for the user's other MCP servers become readable by
every local account on the machine. Worse on shared build hosts, jump boxes,
and multi-user dev servers. Note the affected file is one CodeGraph does not
own — the damage is to a *third party's* secrets.

**Remediation (done).** `atomicWriteFileSync` now stats the target and restores
its exact mode on the temp file before the rename. Files that did not
previously exist keep the platform default, so nothing else changes — the rule
is strictly "never widen". All eleven agent targets funnel through this one
function, so the fix covers every one of them.

Covered by `__tests__/installer-file-permissions.test.ts` (POSIX-gated for the
mode assertions, since Windows has no POSIX permission bits). The full
230-test installer contract suite still passes.

### MEDIUM-2 — Usage telemetry, enabled by default, to a third-party endpoint

**Location:** `src/telemetry/`, `telemetry-worker/`, `telemetry-dashboard/`, plus
call sites in `src/bin/codegraph.ts`, `src/installer/index.ts`,
`src/mcp/{session,proxy,index}.ts`

**What.** Upstream shipped opt-out, **default-on** telemetry POSTing to
`telemetry.getcodegraph.com`: a persistent random machine ID, version, OS,
arch, Node major, a CI flag, and per-day rollups of every MCP tool call and CLI
command — including the connecting agent's name and version from the MCP
handshake, and which prompt-hook gate tier fired.

**Why it is a vulnerability.** Upstream's disclosure was accurate about what it
excluded (no source, paths, symbol names, or IPs), so this is not a data-leak
finding. It is an unacceptable default for an internal engineering tool: a
stable per-machine identifier and a daily activity profile of Bridgenext
engineers' tooling flowed to an endpoint outside Bridgenext's control, with no
contractual relationship, and with the off-switch depending on an environment
variable that a fresh laptop or CI runner will not have set.

**Impact.** Third-party visibility into internal tool adoption, per-machine
activity patterns, which agents are in use, and which languages appear in
Bridgenext codebases.

**Remediation (done).** Removed entirely — see `docs/design/no-telemetry.md`
for the complete record. Deliberately a deletion, not a flag: a default-on
system gated by an env var stays one config mistake away from reporting, and a
reviewer cannot answer "does this build phone home?" by inspection. Enforced by
`__tests__/no-telemetry.test.ts`, whose strongest check allow-lists every
literal HTTP host in the tree — so a new sink cannot be added without a
visible, reviewable diff.

### MEDIUM-3 — Installer POSTed the user's e-mail address to a third party

**Location:** `src/installer/beta-signup.ts`

**What.** At the end of a successful install or upgrade, the installer offered
to join a product beta waitlist and POSTed the address to
`https://getcodegraph.com/api/waitlist`.

**Why it is a vulnerability.** Personal data leaving a Bridgenext machine for a
third-party marketing endpoint. Strictly opt-in and never shown under `--yes`,
which caps the severity — but it is not functionality an internal fork should
carry, and a corporate address disclosed here is a small phishing-surface
expansion.

**Impact.** Disclosure of employee e-mail addresses to an external party.

**Remediation (done).** Module deleted, both call sites removed
(`src/installer/index.ts`, and the `offerBetaSignup` hook in
`src/upgrade/index.ts`), tests removed. Guarded by `no-telemetry.test.ts`.

### MEDIUM-4 — Installer ran `npm install -g` against the public registry

**Location:** `src/installer/index.ts` (step 2)

**What.** `codegraph install` shelled out to
`execSync('npm install -g @colbymchenry/codegraph')`.

**Why it is a vulnerability.** In the fork this is doubly wrong. It fetches
**upstream's** package rather than this build — so a teammate who ran the fork's
installer could end up running upstream code, telemetry included, defeating the
entire point of the fork. It also introduces an unnecessary network fetch of
executable code from a public registry during an install, and the step was
redundant: reaching that code means an installed `codegraph` is already
running.

**Impact.** Silent substitution of a different project's code for the reviewed
one; an avoidable supply-chain dependency in the install path.

**Remediation (done).** Replaced with a pure-PATH check (`hasCommand`, no
spawn, no network). If `codegraph` is missing the installer prints this
repository's install one-liner and continues. No package manager is invoked.

### MEDIUM-5 — No CI

**Location:** `.github/workflows/`

**What.** The only workflows were a manually-dispatched release and a docs-site
deploy. Nothing ran the 190+ test files, the type check, or a dependency audit
on a push or pull request.

**Why it is a vulnerability.** A security fix with no gate is a security fix
until the next merge. Newly disclosed advisories in shipped dependencies would
go unnoticed indefinitely, and a regression in the path-containment or
permission-preservation logic would reach `main` silently.

**Remediation (done).** Added `.github/workflows/ci.yml`: type check, build,
the test suite, plus a **blocking** `npm audit --omit=dev --audit-level=high`
for shipped dependencies and a non-blocking dev-dependency audit (so dev-only
noise cannot train people to ignore the blocking job). It also re-runs the
no-telemetry guard as its own blocking step, out of the test job, so the
property the fork exists to hold can't be lost to a slow run or a quarantine
list. Pinned to Node 24 — older 22.x lines ship `node:sqlite` without FTS5,
which fails the suite wholesale in a way that reads as a code bug.

Making the gate *meaningful* took two further steps, both verified in Docker:

- **Three test files carrying pre-existing upstream failures are quarantined**
  into a separate non-blocking job rather than deleted or ignored. Measured
  over two full passes of upstream HEAD, so they are demonstrably not caused by
  this work. `explore-factory-closure` / `explore-oversize-member` (4 tests)
  were additionally checked against a purpose-built image with the Rust
  extraction kernel compiled — they fail identically, ruling out the
  wasm-fallback explanation. They still run, so fixing them shows up as green.
- **The per-test timeout was raised from vitest's 5s default to 30s** in
  `vitest.config.ts`. Most tests here build a project on disk, index it with
  real parsing in worker threads, and query real SQLite; under full parallel
  load a rotating handful exceeded 5s and failed as "timed out" with nothing
  wrong. CI adds `--retry=2` for the residual scheduling nondeterminism — it
  retries a *failing* test, so a real regression still fails all three attempts
  and reddens the job.

With those in place the blocking job runs **3,018 tests green, exit 0** on
Linux/Node 24 — a gate that means something, rather than a permanently red
check people learn to ignore.

### LOW-1 — Daemon socket briefly world-connectable

**Location:** `src/mcp/daemon.ts`

**What.** The Unix domain socket was `chmod 0600`-ed in the `listen()` callback
— i.e. *after* the node was created with `0777 & ~umask` (0755 typically).

**Why it is a vulnerability.** Anyone who can connect to that socket can issue
MCP tool calls against the project's index, which serve file content from the
project root. The window is milliseconds, but the fallback socket path lives in
`os.tmpdir()` — a world-writable directory shared with every other local user.

**Impact.** On a multi-user host, a local user polling for the socket could win
the race and read project source through the daemon.

**Remediation (done).** The umask is tightened to `0o177` across the bind, so
the socket is `0600` **at creation** and the permissive state never exists. It
is restored immediately; this runs during the detached daemon's sequential
startup, before any other file-creating work. The `chmod` is retained as a
fixup for platforms where umask does not apply to `AF_UNIX` nodes.

### LOW-2 — Predictable temp filename without `O_EXCL`

**Location:** `src/installer/targets/shared.ts` → `atomicWriteFileSync`

**What.** The temp path was `<target>.tmp.<pid>` — guessable — and was written
with `fs.writeFileSync`, which follows an existing symlink at that path.

**Why it is a vulnerability.** In a directory another user can write to, an
attacker who pre-creates `<target>.tmp.<pid>` as a symlink causes the config
content to be written through it. The realistic targets here (`~/.claude`,
`~/.codegraph`, the project directory) are not normally attacker-writable, which
is what keeps this Low.

**Impact.** Arbitrary file write as the installing user, in the narrow case of a
writable config directory.

**Remediation (done).** The temp name now carries 6 random bytes and is created
with `'wx'` (`O_CREAT|O_EXCL`), which fails outright rather than following a
pre-planted path, at mode `0600`.

### LOW-3 — Corrupt-config backup relied on undocumented mode preservation

**Location:** `src/installer/targets/shared.ts` → `readJsonFile`

**What.** When a config file fails to parse, it is copied to `<path>.backup`
before being overwritten. `fs.copyFileSync` creates the destination with the
source's mode on the platforms we ship, but Node does not document this.

**Why it is a vulnerability.** The backup is a verbatim copy of a file that can
contain MCP `env` secrets. If the copy landed at the process umask, MEDIUM-1
would reappear via the backup.

**Remediation (done).** The backup's mode is now explicitly set from the
source's.

### LOW-4 — Sensitive-directory check skipped for a not-yet-existing path *(open, accepted)*

**Location:** `src/mcp/tools.ts` (~line 1590)

**What.** `validateProjectPath` — which refuses `/etc`, `/`, `~/.ssh`, `~/.aws`
and friends — is only invoked `if (existsSync(projectPath))`. A non-existent
path skips the refusal and proceeds to walk *up* looking for the nearest
`.codegraph/`.

**Why it is only Low.** The walk-up can only succeed if an index actually
exists at the ancestor, and indexing a sensitive directory is itself blocked at
`codegraph init`. So reaching a sensitive root requires the user to have
already created an index there through some other route. The `existsSync` guard
is also load-bearing (upstream #238): a nested path inside a real project must
resolve up to its root.

**Not fixed, deliberately.** Tightening it means validating each ancestor
during the walk, which touches the monorepo/sub-project resolution path that
several suites pin. The risk does not justify the regression surface in this
pass. Recorded here as the correct follow-up if the tool is ever exposed to a
less-trusted caller than a local agent.

### LOW-5 — Dev-only dependency advisories *(open, tracked)*

`npm audit` reports 9 advisories; **all 9 are dev-only** — `npm audit
--omit=dev` is clean. The notable one is `vitest` GHSA-5xrq-8626-4rwp (CVSS
9.8, "arbitrary file read and execution when the Vitest UI server is
listening"), whose fix is `vitest@4` — a major bump across 194 test files.

**Not fixed, deliberately.** The advisory requires the Vitest **UI/API server**
to be listening. This repository never enables it: `vitest.config.ts` sets no
`api`/`ui` option and every invocation is `vitest run`. The vulnerable code
path cannot execute in this configuration. Weighed against a major test-runner
bump across the whole suite — precisely the "don't blindly upgrade" case — the
right call is to defer it to its own change where the migration can be
validated on its merits. The same reasoning covers the transitive
`rollup` / `postcss` / `nanoid` / `esbuild` / `vite` advisories, which come in
through the same toolchain and never ship to a user.

The CI audit job reports these on every run so they stay visible rather than
forgotten.

### INFO-1 — `codegraph upgrade` pipes a downloaded script to a shell

**Location:** `src/upgrade/index.ts` → `upgradeUnixBundle`

`codegraph upgrade` runs `curl -fsSL <install.sh> | sh`. This is the
conventional pattern (rustup, nvm, Homebrew) and is architecturally deliberate:
re-running the canonical installer keeps download, version-resolution, and PATH
logic from drifting between first install and upgrade.

Accepted, with the note that the fix for HIGH-1 materially improves it: the
script fetched over TLS from `raw.githubusercontent.com` now verifies the
artifact it downloads, so the unverified surface shrinks from "the whole
bundle" to "the installer script itself". Replacing the pattern outright would
be an architectural change without a proportionate gain.

### INFO-2 — Indexed code reaches the agent's context

**Location:** `src/mcp/tools.ts`, `codegraph prompt-hook`

CodeGraph's purpose is to put source from the indexed repository into an
agent's context, and the Claude Code prompt hook does so automatically on
structural prompts. A comment in an indexed file that reads like an
instruction is therefore a prompt-injection channel.

This is inherent to the product, not a defect, and the exposure is the same as
the agent using `Read`/`Grep` on the same repository — CodeGraph changes how
the content is retrieved, not whether the agent can see it. Two existing
controls limit the blast radius and were verified intact:

- `validatePathWithinRoot` (`src/utils.ts`) resolves symlinks on both sides, so
  content-serving reads cannot escape the project root (upstream #527).
- `isConfigLeafNode` (`src/utils.ts`) returns the KEY only for values lifted
  out of pure config files (`application.yml`, `.properties`), so DB passwords
  and JDBC URLs are never pushed into agent context (upstream #383).

The standing mitigation is organisational: only index repositories you trust as
much as you trust the agent's output.

### INFO-3 — `RELEASE_PAT` is a long-lived personal access token

**Location:** `.github/workflows/release.yml`

The release workflow authenticates as a maintainer PAT rather than
`GITHUB_TOKEN`, because a branch-protection ruleset blocks the default token
from pushing the auto-generated CHANGELOG commit to `main`.

Accepted for now — the workflow is manual-dispatch only, so the blast radius is
small. When Bridgenext configures this repository, scope the token to
`contents:write` on this repository alone, set an expiry, and rotate per
policy. A GitHub App installation token would be the stronger long-term answer.

---

## What was checked and found clean

- **Hardcoded secrets / keys / tokens.** None in the tree or in git history.
  The only match for a credential-shaped literal is a deliberate fixture in
  `__tests__/config-secret-redaction.test.ts` (`sk-live-DO-NOT-LEAK-…`), which
  exists to prove secrets are *not* surfaced.
- **Command injection.** Every `spawnSync`/`execSync` call site uses a constant
  command with an argv array. No shell string is built from user, agent, or
  file input. (`.gitignore` now also covers `.npmrc`.)
- **SQL injection.** All `${}` interpolation into SQL is either a generated
  `?,?,?` placeholder list, a constant identifier from a fixed array, or a
  number validated by `Number.isFinite` (`resolveWalHealBytes`). Values always
  bind through prepared statements.
- **Path traversal / arbitrary file read.** `validatePathWithinRoot` applies a
  lexical `../` check *and* a `realpath` containment check at both
  content-serving sinks. The indexing read path's `allowSymlinkEscape` waiver
  keeps the lexical guard and never serves content to an agent.
- **Unsafe deserialization.** Only `JSON.parse`, always inside `try/catch`. No
  `eval`. The two `new Function('specifier', 'return import(specifier)')` uses
  are the standard CJS→ESM dynamic-import shim over a constant string.
- **SSRF.** Every request URL is a module constant. The one env override
  (`CODEGRAPH_TELEMETRY_ENDPOINT`) is gone with the telemetry module.
- **Insecure transport.** All remote URLs are `https`.
- **Excessive permissions.** The Claude permission grant is a single
  server-scoped `mcp__codegraph__*`, which gates *prompting*, not visibility —
  it cannot expose a tool the server does not list. Daemon pidfiles and
  registry records are written `0600`; the socket is now `0600` at creation.
- **Malicious / unnecessary dependencies.** 10 runtime dependencies, all
  well-known and purposeful. No install/postinstall scripts in the dependency
  tree. No analytics SDK (asserted by `no-telemetry.test.ts`).

## Follow-ups for a later pass

1. Migrate to `vitest@4` and clear the dev-dependency advisories (LOW-5).
2. Validate ancestors during the `.codegraph/` walk-up so a sensitive directory
   cannot be reached via a non-existent path (LOW-4).
3. Scope, expire, and rotate `RELEASE_PAT`, or replace it with a GitHub App
   token (INFO-3).
4. Add Dependabot (or `npm audit` on a schedule) so advisories surface without
   waiting for a push.
5. Add branch protection on `main` requiring the new CI jobs to pass.
6. Triage the three quarantined test files (see `ci.yml`'s `QUARANTINED`) and
   move them back into the blocking job. They are upstream defects, not fork
   ones, but they are real gaps in retrieval-quality coverage.
