# No telemetry (Bridgenext fork)

This fork of CodeGraph collects nothing and reports nothing. This page records
**what was removed**, **why the removal is structural rather than a config
flag**, and **what network activity legitimately remains**, so a future
maintainer merging from upstream knows exactly what must not come back.

Enforced by `__tests__/no-telemetry.test.ts`, which fails the build if any of
it reappears.

## What upstream collected

Upstream CodeGraph shipped an opt-out, **default-on** telemetry system.

| Component | What it was |
|---|---|
| `src/telemetry/index.ts` | The client: consent resolution, an on-disk `~/.codegraph/telemetry.json` machine ID, a `telemetry-queue.jsonl` buffer, and the HTTPS sender |
| `telemetry-worker/` | A Cloudflare Worker ingest endpoint serving `telemetry.getcodegraph.com`, writing to a D1 database |
| `telemetry-dashboard/` | A Cloudflare Worker + web UI for reading that database |
| `TELEMETRY.md`, `docs/design/telemetry.md` | The user-facing disclosure and the engineering contract |

Data left the machine as a POST to `https://telemetry.getcodegraph.com/v1/events`
carrying a random machine UUID, CodeGraph version, OS, arch, Node major, a CI
flag, and one of four events:

- `install` — which agents were configured, global vs local, fresh/upgrade/re-run.
- `index` — the language names present in the indexed project, plus coarse
  file-count and duration buckets.
- `usage_rollup` — per-day counts of each MCP tool and CLI command, its error
  count, and the **connecting agent's name and version from the MCP handshake**
  (e.g. `Claude Code 2.1`). The Claude Code prompt hook additionally reported
  which gate tier fired.
- `uninstall` — which agents were removed.

Upstream's disclosure was accurate about what it excluded (no source, paths,
names, or IPs). The problem for internal use is not the field list — it is that
an internal engineering tool reported *any* per-machine activity to a
third-party endpoint by default.

## Separately: the marketing e-mail signup

`src/installer/beta-signup.ts` prompted at the end of an install or upgrade and
POSTed the user's **e-mail address** to `https://getcodegraph.com/api/waitlist`.

It was strictly opt-in and never fired under `--yes`, but it is still personal
data leaving a Bridgenext machine for a third party, so it was removed with the
telemetry.

## What was removed

Deleted outright: `src/telemetry/`, `telemetry-worker/`, `telemetry-dashboard/`,
`src/installer/beta-signup.ts`, `TELEMETRY.md`, `docs/design/telemetry.md`, and
their test suites.

Call sites removed:

| Location | What it did |
|---|---|
| `src/bin/codegraph.ts` | `preAction` hook counting every CLI subcommand; index-completion event; uninit event; prompt-hook gate counters; the whole `codegraph telemetry` subcommand |
| `src/installer/index.ts` | The consent prompt, the `install` event, the `uninstall` event, and the end-of-install flush |
| `src/mcp/session.ts` | Per-tool-call `recordUsage`, and the `clientInfo` capture that existed only to attribute those calls to an agent |
| `src/mcp/proxy.ts` | The same, on the in-process fallback path |
| `src/mcp/index.ts` | The 6-hourly background flush timer on the long-lived server |
| `src/upgrade/index.ts` | The `offerBetaSignup` hook on the upgrade path |

### Why removal, not a flag

Upstream already supported `CODEGRAPH_TELEMETRY=0` and `DO_NOT_TRACK=1`. That
was deliberately **not** the approach taken, for three reasons:

1. A flag is default-on. Any machine that misses the env var — a fresh laptop,
   a CI runner, a container that does not inherit the shell profile — reports.
2. A flag is a runtime condition. Reviewing "does this build phone home?"
   means reasoning about every code path that reads it. With the module gone,
   the answer is decidable by inspection.
3. A flag can be flipped back by a config change or an upstream merge. Deleting
   the sender means reintroducing it is a visible code change that fails
   `no-telemetry.test.ts`.

### The `codegraph telemetry` command

Removed rather than stubbed. A teammate migrating from an upstream install who
runs `codegraph telemetry off` out of habit now gets commander's standard
unknown-command error. That is intended: there is nothing to configure.

Note that upstream's on-disk state is **not** cleaned up automatically — an
existing `~/.codegraph/telemetry.json` and any `~/.codegraph/telemetry-queue.jsonl`
left by a prior upstream install simply stop being read or written. Nothing in
this build ever sends the buffered contents. Delete them if you want the disk
clean:

```bash
rm -f ~/.codegraph/telemetry.json ~/.codegraph/telemetry-queue*.jsonl ~/.codegraph/beta-signup.json
```

## What network activity remains

Exactly one outbound destination: **github.com**, for release metadata and
release artifacts.

| Caller | Request | Payload |
|---|---|---|
| `src/upgrade/update-check.ts` | `GET github.com/bridgenext/forge-codegraph/releases/latest` at most once per 24h from a long-lived MCP server | None. A redirect is read for the tag; nothing identifying is sent |
| `src/upgrade/index.ts` (`codegraph upgrade`) | Resolves the latest tag, then downloads the release bundle | None, and only when the user runs the command |
| `install.sh` / `install.ps1` | Downloads the bundle + `SHA256SUMS` | None |

These are version resolution and artifact download, not measurement: no
identifier is minted, nothing is buffered, and nothing about the user, the
machine, or the indexed code is transmitted. Both are suppressed by
`CODEGRAPH_NO_UPDATE_CHECK=1` or the cross-tool `DO_NOT_TRACK=1`, and the
update check is additionally skipped whenever it cannot reach the network.

**Indexing itself never leaves the machine.** Parsing, storage (SQLite under
`.codegraph/`), and every MCP query are local. That was true upstream and is
unchanged.

## Keeping it that way

`__tests__/no-telemetry.test.ts` asserts, over `src/`, `scripts/`, `site/src/`
and the top-level build files:

- the deleted directories and modules do not exist;
- none of the removed identifiers (`getTelemetry`, `recordUsage`,
  `recordLifecycle`, `CODEGRAPH_TELEMETRY`, `submitBetaSignup`, …) appear;
- no analytics SDK (`posthog`, `mixpanel`, `amplitude`, `sentry`, …) is a
  dependency;
- **every literal http(s) host in the tree is on an explicit allow-list**,
  split into hosts that may be *requested* (GitHub, the npm registry) and hosts
  that only ever appear as documentation links.

That last check is the load-bearing one: a new exfiltration sink cannot be
added without either failing the test or editing the allow-list, and editing
the allow-list is a visible, reviewable diff.

When merging from upstream, run:

```bash
npx vitest run __tests__/no-telemetry.test.ts
```

A failure means upstream telemetry came back with the merge. Remove it; do not
extend the allow-list to accommodate it.
