# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeGraph is a local-first code intelligence library + CLI + MCP server. It parses any supported codebase with tree-sitter, stores symbols/edges/files in SQLite (FTS5), and exposes a knowledge graph to AI agents (Claude Code, Cursor, Codex CLI, opencode) over MCP. Per-project data lives in `.codegraph/`. Extraction is deterministic — derived from AST, not LLM-summarized.

**This is the Bridgenext fork ([bridgenext/forge-codegraph](https://github.com/bridgenext/forge-codegraph)), not upstream.** Two things differ from upstream and must not be reverted by a merge:

1. **No telemetry.** Upstream's telemetry client, ingest worker, dashboard, and the installer's marketing e-mail signup are deleted — not flag-disabled. `__tests__/no-telemetry.test.ts` fails the build if any of it returns; see `docs/design/no-telemetry.md` for the full removal record and the allow-listed network hosts. When merging upstream, run that suite and delete whatever it flags rather than widening the allow-list.
2. **Distribution is npm + GitHub Releases, both under Bridgenext.** The published package is **`@bridgenext/codegraph`** (never upstream's `@colbymchenry/codegraph`), assembled by `scripts/pack-npm.sh` and published by the release workflow — per-platform packages first, then the shim that lists them as `optionalDependencies`. The repo's own root `package.json` stays `private: true`: it is never the published artifact, so this only stops a stray root `npm publish` shipping the wrong contents under the right name. `src/upgrade/index.ts`'s `REPO` is `bridgenext/forge-codegraph` — that is the **repo slug**, not a package name, and it legitimately appears in `repository` metadata (npm requires it to match for `--provenance`) and in release-asset URLs. `install.sh` / `install.ps1` download from this repo's releases and **verify the archive against `SHA256SUMS` before extracting**.

Same binary serves as installer, indexer, and MCP server.

## Build, Test, Run

```bash
npm run build           # tsc + copy schema.sql and *.wasm into dist/; chmods dist/bin/codegraph.js
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all)
npm run test:watch
npm run test:eval       # only __tests__/evaluation/
npm run eval            # build then run __tests__/evaluation/runner.ts via tsx

npm run cli             # build then run the local dist binary

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets` (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **Any new SQL or grammar wasm must be copied or it won't ship.**

Node engines: `>=20.0.0 <25.0.0`. There is a hard exit on Node 25.x and below 20 (see `src/bin/node-version-check.ts`).

## Architecture

### Layered pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

The public API surface is `src/index.ts` — the `CodeGraph` class wires all the layers and re-exports types. Library users only touch this file; the MCP server and CLI also drive it.

### Module layout

- `src/index.ts` — `CodeGraph` class: `init`/`open`/`close`, `indexAll`, `sync`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`, `buildContext`, `watch`/`unwatch`.
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`, `sqlite-adapter.ts`. Backed by Node's built-in **`node:sqlite`** (`DatabaseSync`) — real SQLite with WAL + FTS5, exposed through a thin better-sqlite3-shaped adapter. The bundled runtime always ships Node ≥22.5, so `node:sqlite` is always available: **no native build step and no wasm fallback**. (Running from source needs Node ≥22.5.) `codegraph status` reports the live backend (`node-sqlite`, the sole backend).
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language), plus standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi). `parse-worker.ts` runs heavy parsing off the main thread.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts` for tsconfig path aliases + cargo workspace member globs), `name-matcher.ts`, and `frameworks/` (Express, Laravel, Rails, FastAPI, Django, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, Cargo workspaces). Frameworks emit `route` nodes and `references` edges.
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager` (high-level queries).
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- `src/installer/` — see below.
- `src/bin/codegraph.ts` — CLI (commander). Subcommands: `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `affected`, `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).

### NodeKind / EdgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`, `union`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

### Multi-agent installer

`src/installer/` is the entry point for `codegraph install` (and the bare `codegraph` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding a 5th agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location and MCP-server JSON/TOML/JSONC writing. (Targets no longer write an instructions file — see below.)
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.codegraph]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips.
- `instructions-template.ts` no longer holds an instructions body — it exports only the `<!-- CODEGRAPH_START -->`/`<!-- CODEGRAPH_END -->` markers. The installer **stopped writing** a `## CodeGraph` block into each agent's instructions file (`CLAUDE.md` / `~/.codex/AGENTS.md` / `~/.config/opencode/AGENTS.md` / `~/.gemini/GEMINI.md` / `.cursor/rules/codegraph.mdc` / Kiro steering doc) because it duplicated the MCP `initialize` instructions verbatim (issue #529). Each target's `install` (self-heal on upgrade) and `uninstall` use the markers to **strip** a block a previous install left behind. `server-instructions.ts` is the single source of truth for agent-facing guidance.
- All installer changes need matching coverage in `__tests__/installer-targets.test.ts` — there are ~47 parameterized contract tests covering install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for Codex.

### Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the tools, and as of issue #529 it is the **single source of truth** for agent-facing tool guidance — the installer no longer writes a duplicate `## CodeGraph` instructions block into `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/codegraph.mdc`. Edit tool guidance here and nowhere else.

## Retrieval performance & dynamic-dispatch coverage (do not regress)

CodeGraph's core value is letting an agent answer **structural/flow** questions ("how does X reach Y", trace, impact, callers) with a few **fast** codegraph calls and **zero Read/Grep**. The optimization target is **wall-clock latency + tool-call count** — *don't optimize for token cost*. (Cost is **lower**, not "flat" as earlier framing claimed: a current-build with-vs-without A/B across the 7 README repos, median of 4, saved on average **35% cost · 57% tokens · 46% time · 71% tool calls** — reproducing the published README. The mechanism is **far fewer turns over a much smaller accumulated context** — NOT cache-ability: the without-arm's huge token volume is *mostly* cheap cache-reads, which is why token-count savings (57%) look bigger than cost savings (35%). Measure tokens by **summing per-turn assistant usage**, not `result.usage` (last-turn only in current Claude Code). See `docs/benchmarks/call-sequence-analysis.md`.) The mechanism that drives everything here: **an agent falls back to Read/Grep the instant a codegraph answer is insufficient.** So every change is judged by one question — is codegraph's answer sufficient enough to *stop* the agent from reading?

**Target behavior:** a flow question resolves in **1 codegraph call on small repos, scaling to 3–5 on large**, with **Read/Grep = 0**. When reviewing a PR or trying something new, do not regress this.

### Adapt the tool to the agent — don't try to change the agent

The lever that decides whether a retrieval change lands. **Test before building anything here: does this make a tool the agent _already calls_ do more with the input it _already gives_? If it instead needs the agent to behave differently — pick a different tool, query differently, learn from examples — it hits the low-salience wall and won't land.**

CodeGraph's only channels to influence the agent are low-salience: the MCP `initialize` instructions (`server-instructions.ts`) and the tool descriptions. Changing them does **not** reliably move the agent's tool _choice_ or query style — validated: trace-first steering ported into the server-instructions + tool descriptions (3 wording variants) never reproduced what a CLI `--append-system-prompt` achieved, and **regressed** wall-clock vs baseline. New tools fare worse (rarely chosen — the agent under-picks even `trace`); "better examples" is the same steering. The agent's tool-choice does improve on its own as host models get better at tool use — but that is not ours to force.

What works is meeting the agent where it already is:
- **explore-flow** — `codegraph_explore` is the PRIMARY tool the agent reliably calls; its query is a precise bag of symbol names (incl. qualified `Class.method`) spanning the flow the agent is after; explore finds the call path _among those named symbols_ (riding synthesized edges) and leads its output with it. (`buildFlowFromNamedSymbols`: segment/co-naming disambiguation; ≤1 unnamed bridge so it never wanders a god-function's fan-out. Overload-aware: a PascalCase type token in the query biases an overloaded name to that type's own def — `DataRequest task` → DataRequest's `task`, not the abstract base; named-symbol files sort first.)
- **Sufficiency** — make the tool's output complete enough that the agent stops. `codegraph_node` returns the full body + the caller/callee trail, and for an AMBIGUOUS name returns **every overload's body in one call** (so the agent never Reads a file to find the right overload — validated on Alamofire/gin). This is the after-explore depth tool (labeled SECONDARY).
- **Errors teach abandonment** — one or two `isError: true` responses early in a session and the agent stops calling codegraph entirely (maintainer-observed, repeatedly). `isError` is reserved for genuine "stop trying" cases: security refusals (`PathRefusalError`) and real malfunctions (which carry a retry-once note). Every expected/recoverable condition — project not indexed, symbol not found, file not in the index — returns a **SUCCESS-shaped response carrying the guidance** (`NotIndexedError` → `textResult`, see `ToolHandler.execute`'s catch). The same principle is why the tool surface is **always exposed, even at an un-indexed root** (the old empty-`tools/list` gate was removed in #964 — it broke monorepos where only sub-projects carry a `.codegraph/`, and hid the tools from a session that started before `codegraph init`): safety comes from the response SHAPE (success-shaped guidance, never `isError`), not from hiding tools. An un-indexed root's `initialize` sends a per-project variant (`SERVER_INSTRUCTIONS_NO_ROOT_INDEX` — "pass `projectPath` to a project that has a `.codegraph/`"), not an "inactive" note; indexing is still deliberately the user's call, never the agent's.

What fails is the inverse — folding a precise answer into a **fuzzy-input** tool: the now-removed `codegraph_context` took a description, not symbols, so it couldn't disambiguate a flow's endpoints and surfaced the _wrong feature_ (which is why it was cut). Precise output needs precise input — explore takes a symbol bag for exactly this reason. (`codegraph_trace` was likewise removed: explore-flow does its job and the agent under-picked it.)

The remaining lever under this axis is **coverage**: every flow made to connect statically (a new dynamic-dispatch synthesizer, or extracting symbols static parsing skipped — e.g. object-literal store actions in `create((set,get)=>({...}))`) is then surfaced automatically by explore-flow, no agent change needed. Reactive/reconciler runtimes (Halo's `ReactiveExtensionClient`, MediatR, Vue Proxy) are the frontier — flows there have no static edges, so nothing surfaces (correctly — silent beats wrong). Full investigation + A/B record: `docs/benchmarks/call-sequence-analysis.md` + auto-memory `project_codegraph_read_displacement`.

### Explore budget — keep BOTH budgets monotonic with repo size

Two functions in `src/mcp/tools.ts` scale explore with indexed file count. This is the expected resolution (a regression here silently forces agents back to Read):

| Repo | files | explore calls | chars/call | per-file |
|---|---|---|---|---|
| express (small) | 147 | 1 | 18K | 3800 |
| excalidraw/django (medium) | 643–3043 | 2 | 28K | 6500 |
| vscode (large) | 10446 | 3 | 35K | 7000 |
| ~20k / ~40k | — | 4 / 5 | 38K | 7000 |

- `getExploreBudget(fileCount)` → **call** budget: `<500→1, <5000→2, <15000→3, <25000→4, ≥25000→5` (max 5).
- `getExploreOutputBudget(fileCount)` → **per-call** output (chars / files / per-file). **Invariant: a larger tier must never get a smaller `maxCharsPerFile` than a smaller tier.** (Regression that motivated this doc: the `<5000` tier's 2500 was *below* the `<500` tier's 3800, so on a god-file repo — excalidraw's 415 KB `App.tsx` — one explore returned <1% of the file and forced a Read.)
- Explore output must **never tell the agent to "use Read"** — steer to another `codegraph_explore` and "treat returned source as already Read."

### Dynamic-dispatch coverage — the flow must EXIST in the graph end-to-end

Static tree-sitter extraction misses computed/indirect calls, so flows break at dynamic dispatch and the agent reads to reconstruct them. Synthesizers/resolvers bridge these so `codegraph_explore` connects them end-to-end (`src/resolution/callback-synthesizer.ts`, `src/resolution/frameworks/`). Channels today: callback/observer, EventEmitter, **React re-render** (`setState`→`render`), **JSX child** (`render`→child component), django ORM descriptor. All synthesized edges are `provenance:'heuristic'` with `metadata.synthesizedBy` + `registeredAt` (the wiring site), surfaced inline in `codegraph_explore`'s Flow section and the `codegraph_node` trail.

**Principle: partial coverage is WORSE than none.** Bridging one boundary but not the next reveals a hop the agent then drills + reads to finish. Measured on excalidraw: react-render alone *raised* reads to 5–7; only completing the flow (adding the jsx-child hop) dropped it to 0–1. **Always close the flow end-to-end and re-measure** — never ship a half-bridged flow.

### Validation methodology (REQUIRED for every new language/framework)

For each **language × framework**, validate on **small, medium, and large** real repos with **≥3 different flow prompts** each:

1. **Pick the canonical flow** for the framework ("how does X reach Y": state→render, request→handler→view, query→SQL, action→reducer→store…).
2. **Deterministic probes** (`scripts/agent-eval/probe-{node,explore}.mjs` against the built `dist/`): `codegraph_explore` with the flow's symbol names connects from→to end-to-end with no break (its Flow section shows the path); **no node explosion** (`select count(*) from nodes` stable before/after re-index); synthesized-edge **precision** spot-check (`select … where provenance='heuristic'`).
3. **Agent A/B** (`scripts/agent-eval/run-all.sh <repo> "<Q>"`): with vs without codegraph, **≥2 runs/arm** (run-to-run variance is large — never conclude from n=1). Record **duration, total tool calls, Read, Grep**. Optional forced-Read-0 sufficiency proof via the block-read hook (`scripts/agent-eval/hook-settings.json`).
   - **Every run also reports three feedback metrics** — residual context occupancy, explore sufficiency (what the agent did NEXT after each explore), and allocation efficiency (share of returned bytes the answer cited) — under each run, plus a side-by-side arm table (`compare-arms.mjs`). Entry point: `docs/benchmarks/agent-eval-feedback-metrics.md`. Reading them: `Read a file we returned` is an allocation miss, `Read a file we did NOT return`/`Grep` is recall; allocation efficiency is **relative** (attribution is by citation) so it is only valid between builds on the same question; occupancy *shares* are Claude Code / 200k and don't transfer to another host — the arm ratio does.
   - **The `codegraph` CLI is blocked in every arm** (`no-cli-shim.sh`: sanitized PATH + a PreToolUse hook, shared by both harnesses). Without it 14 of 15 without-arm runs in one 7-repo pass reached codegraph through Bash. Check the contamination row before believing any number: `CLI calls that RETURNED output` > 0 invalidates the run (in a new-vs-baseline A/B it silently drops calls from all three metrics, since a CLI explore is not a tool call).
   - **Model policy — every A/B arm runs Claude with `--model sonnet --effort high`. Always. Never Opus/Fable.** All `scripts/agent-eval/*.sh` default to this (`MODEL`/`EFFORT` env override exists — don't raise it without an explicit reason from the maintainer). Two reasons, and the second matters more than cost: (a) Sonnet doesn't burn tokens; (b) **Sonnet is the deliberate floor model** — codegraph's real users attach it to whatever agent they already run (Cursor Composer, Gemini, etc.), so we validate on a "dumber" model on purpose: a stronger model's tool-use covers up the salience/sufficiency problems a weaker one exposes. An affordance that lands on Sonnet generalizes up to every host; one that only works on Opus/Fable doesn't generalize down to the agents most users actually have. Both arms always use the same model.
   - **MCP attach is a startup-latency issue, not a hard block.** On a multi-step task the agent dives into Read/grep before codegraph finishes its ~2-3s startup (worse when the eval is itself run nested inside a Claude session, under CPU contention), so it runs with no codegraph. Fix: **pre-warm a persistent daemon** for the target (`CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` high; spawn `serve --mcp --path <target> </dev/null &`; wait for `.codegraph/daemon.sock`) **and skip the startup re-exec** (`CODEGRAPH_WASM_RELAUNCHED=1`) so claude connects before the agent's first turn. Don't trust claude's `init` snapshot — it can read `status:"pending"` / 0 tools even when it then connects; judge by actual codegraph usage in `parse-run.mjs`'s `by type`. To isolate a change — **new-build vs baseline-build, both codegraph-on** (vs run-all.sh's with-vs-without) — use `scripts/agent-eval/ab-new-vs-baseline.sh <indexed-repo> "<task>" [baseline-ref]` (it bakes in the pre-warm).
4. **Pass bar:** a normal flow question reaches **~0 Read/Grep within the repo's explore-call budget**, runs **faster** than without-codegraph, and shows **no regression on a control repo**. Record the numbers in `docs/design/dynamic-dispatch-coverage-playbook.md` (the coverage matrix).

Full playbook + per-mechanism design: `docs/design/dynamic-dispatch-coverage-playbook.md` and `docs/design/callback-edge-synthesis.md`.

### Worked example — Excalidraw (TS/React, medium, 643 files)

The template to replicate per language/framework. Question: *"how does updating an element re-render the canvas on screen?"* (the full flow crosses three React boundaries: observer callback, `setState`→`render`, and JSX child).

| Stage | duration | Read | Grep | codegraph |
|---|---|---|---|---|
| Without codegraph | 115–139s | 9–10 | 10–11 | 0 |
| Broken (explore-budget regression) | 131–139s | 5–10 | 3–5 | 6–14 |
| Fixed (budget + msgs + synthesis) | 64–112s | 0–2 | 2–4 | 3–**10** |
| + trace-first steering | **51–74s** | **0–2** | 0–4 | **3–4** |

n=4 unhooked runs/stage, same prompt. After steering flow questions to `codegraph_trace` first: **best run 0 Read / 0 Grep / 3 codegraph / 51s**; **2 of 4 fully clean** (0 Read, 0 Grep). Steering eliminated the over-drill variance — call count tightened from 3–10 to 3–4, trace adoption went 3/4 → 4/4, and the `search`+`callers` path-reconstruction floundering dropped to 0. Run-to-run variance is still real; report the range, never a single run. **Residual reads/greps are all the nonce data-flow** (`canvasNonce` — a local prop with no graph edges); that's the def-use/data-flow frontier, left deliberately uncovered (tracking every local would explode the graph). Validated: `trace(mutateElement, renderStaticScene)` connects in **6 hops** across all three boundaries (`mutateElement → triggerUpdate → [callback] triggerRender → [react-render] render → [jsx] StaticCanvas → renderStaticScene`), each hop showing inline source + the wiring site; node count stable at 9,289; 1 callback + 46 react-render + 280 jsx-render synthesized edges (no explosion, precision-checked).

## Tests

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all 4 agent targets (see installer notes above).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise codegraph against synthetic projects and score the results; run via `npm run eval` (builds first). Not part of `npm test`.
- `sqlite-backend.test.ts` / `node-sqlite-backend.test.ts` — pin that `node:sqlite` is the sole backend: `getBackend()` reports `node-sqlite` and the DB comes up in WAL.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts` — regression coverage for specific past PRs/incidents; don't rename these, the names anchor to git history.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking.

### Windows-gated tests

Behavior that differs by platform (path resolution, drive letters, `SENSITIVE_PATHS`, `%APPDATA%` config dirs, CRLF) must be gated, not assumed. Use `it.runIf(process.platform === 'win32')(...)` for Windows-only assertions and `it.runIf(process.platform !== 'win32')(...)` for POSIX-only ones — e.g. `/etc` is sensitive on POSIX but resolves to `C:\etc` (non-existent) on Windows, so an ungated `/etc` assertion fails on Windows. Validate the Windows side for real (see below); don't merge a Windows-gated test you haven't seen run.

## Cross-platform validation

The dev machine — and the default `npm test` target — is **macOS**, so local runs cover the macOS path. The other two platforms aren't here; when a change is platform-sensitive (file watching, sockets / named pipes, path & symlink handling, process lifecycle, inotify budget) validate them for real rather than guessing.

> **Bridgenext fork note.** The fork is maintained from a **Windows** box, which inverts the upstream assumption above: here it is the POSIX-gated tests that silently skip locally, so any change to file modes, socket permissions, or shell scripts must be run under Docker before it is called done. `Dockerfile.test` at the repo root exists for exactly this — it is not shipped and not used by CI:
>
> ```bash
> docker build -f Dockerfile.test -t codegraph-test .
> docker run --rm --init codegraph-test npx vitest run __tests__/installer-file-permissions.test.ts
> ```
>
> Windows also produces a large, run-to-run-varying set of `EPERM`/`EBUSY` failures on temp-dir cleanup (~120–165 tests across ~37 files). **Never judge a regression from the Windows numbers alone** — diff the failing *test names* against a baseline run, and confirm anything new on Linux.
>
> Node must be **24+** locally: Node 22.15's bundled `node:sqlite` has no FTS5, and the suite fails with `no such module: fts5` in ~530 places, which looks like a code failure but is a runtime gap.

### Linux (Docker)

When asked to test or validate on Linux, use **Docker**. Build a throwaway image from the repo and run the suite inside it:

- `FROM node:24-bookworm`; `COPY` the repo with a `.dockerignore` excluding `node_modules`/`dist`/`.git`/`.codegraph`; `RUN npm ci && npm run build`. Don't reuse the host `node_modules` — `esbuild`/`rollup` ship platform-specific binaries.
- Run with **`docker run --rm --init`**. The `--init` is load-bearing for any process-lifecycle test (daemon reaping, the #277 PPID watchdog, idle-timeout): without a zombie-reaping PID 1, a SIGKILL'd/exited process lingers as a zombie and `process.kill(pid, 0)` still reports it *alive*, so exit-detection assertions false-fail even though the process did exit.
- Linux is where the inotify watch budget actually bites: count a process's watches via `/proc/<pid>/fdinfo/*` (sum `^inotify ` lines on the fd whose `readlink` is `anon_inode:inotify`).

### Windows (Parallels VM + SSH)

Upstream's setup, kept for reference. **On the Bridgenext fork the dev box IS Windows**, so validate Windows behavior directly and use Docker (above) for the POSIX side instead.

For any Windows-specific PR, bug, or implementation, validate it on the real Windows VM rather than guessing. Connection details live in the gitignored **`.parallels`** file at the repo root (VM name, guest IP, SSH user/key). `prlctl exec` needs Parallels Pro and is unavailable, so SSH is the bridge.

- Connect / run from the Mac host: `ssh <user>@<guest_ip> "..."`. For multi-line work, pipe PowerShell over stdin and **refresh PATH from the registry** first (sshd's session has a stale PATH after winget installs):
  ```
  ssh colby@10.211.55.3 "powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<'PS'
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  Set-Location C:\dev\codegraph
  PS
  ```
- Clone fresh into a **Windows-local** path (`C:\dev\codegraph`) and `npm ci` there — never run npm against the shared Mac repo, since `esbuild`/`rollup` ship platform-specific binaries.
- Guest toolchain (winget): Node LTS, Git, and the **VC++ ARM64 redistributable** (required by `@rollup/rollup-win32-arm64-msvc`, which vitest pulls in).
- Fetch a contributor PR head straight from their fork to dodge `pull/<n>/head` lag: `git fetch <fork-url> <branch>` then `git checkout -f FETCH_HEAD`.
- Known pre-existing Windows failures (they reproduce on `main`, unrelated to your change — confirm against `origin/main` before blaming your PR, and don't let them mask new regressions): `security.test.ts > Session marker symlink resistance > does not follow a pre-planted symlink` (symlink creation needs privileges on Windows); and the `mcp-initialize.test.ts` / `mcp-roots.test.ts` suites, which fail in `afterEach` with `EPERM` removing the temp dir because a spawned `serve --mcp` (its `--liftoff-only` re-exec grandchild) still holds the cwd / SQLite file open — a Windows file-locking quirk, not a logic bug.

### Known pre-existing failures — measured baseline (2026-09-01)

Measured on upstream `1.6.0` (`6a056ec`), two full passes per platform, so a PR can be judged against real numbers instead of guesswork. **Diff failing TEST NAMES against a baseline run; never conclude from a single run's totals.**

| Platform | Result | Notes |
|---|---|---|
| Linux (Docker, Node 24, no kernel prebuild) | ~9–10 failed / ~3042 passed | The reliable signal — use this one |
| Windows (Node 24, no kernel prebuild) | ~120–165 failed / ~2860 passed across ~37 files | Overwhelmingly `EPERM`/`EBUSY` temp-dir cleanup; the failing set churns every run |

**Deterministic on Linux (failed in both passes, on upstream HEAD):**

- `explore-factory-closure.test.ts` — 3 tests, and `explore-oversize-member.test.ts` — 1 test. Both assert delivered-line counts and fail with `expected 1 to be greater than 20`, on Windows and Linux alike. **Not a kernel-fallback artifact** — checked directly: building `codegraph-kernel` (`npm run build:kernel`) and re-running reproduces all four failures unchanged, so the wasm-vs-native extraction path is not the variable. These are genuine unfixed retrieval-quality regressions inherited from upstream; they need their own investigation and are out of scope for the fork work.
- `sync-rebuild-convergence.test.ts` — 1 test (`stays converged across a sequence of adds, edits, renames and deletes`) failed in both full-suite passes but **passes when the file is run alone**, so it is load-sensitive rather than genuinely broken.

**`install.sh` suites** (`install-sh-prune`, `install-sh-checksum`) fail if the working-tree `install.sh` has CRLF — they extract real blocks from it and run them under `sh`. `.gitattributes` now pins `*.sh` to `eol=lf` so this cannot recur; if you see `set: pipefail: invalid option name`, your working tree predates that and needs re-checking-out.

Everything else that appears is load-sensitive flake: it passes when the file is run in isolation and appears in **both** arms of a with/without comparison.

## Releases

Published as [GitHub Releases](https://github.com/bridgenext/forge-codegraph/releases) on this fork — **npm publishing is removed** (see the fork note at the top). `CHANGELOG.md` is the source of truth; GitHub Release notes are extracted from it.

### Writing changelog entries

**Default: write entries under `## [Unreleased]`** — that's the section reserved for work landing between releases. **Don't pre-create a `## [X.Y.Z]` block** for the next release: the Release workflow's first step is `scripts/prepare-release.mjs`, which automatically promotes everything under `[Unreleased]` into a new `## [X.Y.Z] - <YYYY-MM-DD>` block at release time (or merges into a pre-existing `[X.Y.Z]` block if one exists — but you don't need one). Pre-staging is what caused the v0.9.5 sparse-release-notes incident: a sparse `[0.9.5]` block hand-added before the rest of the work landed got picked by the extractor over the much-larger `[Unreleased]` section above it. Don't do that.

Formatting rules for any entry (anywhere — `[Unreleased]` or otherwise):

1. **Write friendly, user-facing notes — not engineer-facing ones.** Group under `### New Features` and `### Fixes` (sentence-case). Surface `### Breaking Changes` and `### Security` as their own sections **only when the release has them**; fold improvement-flavored changes into New Features. Omit empty sections. (This replaces the old Keep-a-Changelog `Added/Changed/Fixed/Removed/Deprecated` grouping: the GitHub Release page extracts each version block **verbatim** via `scripts/extract-release-notes.mjs`, and the old dense, implementation-focused entries rendered as an unreadable wall of text — so the whole CHANGELOG was rewritten to this format and every published release re-noted to match.)
2. **One plain-language sentence per bullet:** what changed and why it matters to a user. Lead with the capability, or with the symptom that's now fixed.
3. **Strip the internals.** No internal file paths (`src/...`), no internal symbol / function / class names, no benchmark numbers / percentages / node-or-edge counts. **Keep:** language & framework names (Go, Spring, NestJS, …), things a user types or sets (`codegraph install`, `codegraph_explore`, the `CODEGRAPH_*` env vars), agent / IDE names (Claude Code, Cursor, opencode, Kiro, …), and a brief `Thanks @user` when a contributor is credited.
4. Issue / PR references in entries are by number (`(#403)` etc.); the GitHub renderer auto-links them in the published release notes.
5. **Don't add a `[X.Y.Z]: https://...` link reference yourself** — `prepare-release.mjs` appends it automatically when it promotes the version (idempotent: a re-run is a no-op if it already exists).
6. **Every release opens with a `### Highlights` block — the only part most people read.** At most ~8 one-line bullets, in plain language for someone who doesn't read code, ordered by what a typical user notices first (new agent/IDE support and setup changes, then answer quality, then reliability), plus a one-sentence upgrade note when a re-index is needed. Write or refresh it in `[Unreleased]` when a release is being prepared — not per PR — and keep the detailed `### New Features` / `### Fixes` entries below it. When `### Fixes` grows past ~15 entries, group them under `####` sub-headings (`Better answers from codegraph_explore`, `Finding your project, live updates, and the CLI`, `Indexing reliability and disk usage`, `Language and framework accuracy`) so a skimmer can find their area.

Multi-word headings like `### New Features` are safe on the normal release path: `prepare-release.mjs` **Case A** moves the whole `[Unreleased]` body verbatim into `[X.Y.Z]`. (Only its rarely-used **Case B** *merge* splits sub-sections with a single-word `^### (\w+)$` regex that wouldn't match them — and Case B fires only if a `[X.Y.Z]` block was pre-created, which rule above already forbids.)

### Release flow (the user runs these)

Releases are built and published by the **GitHub Actions "Release" workflow**
(`.github/workflows/release.yml`). It runs `scripts/prepare-release.mjs` to
promote `[Unreleased]` into `[<version>]` (and auto-commit + push that
CHANGELOG change back to `main` so on-disk truth matches the published
notes), then bundles a Node runtime per platform (`scripts/build-bundle.sh`)
and publishes the GitHub Release with a `SHA256SUMS` manifest.

**This fork publishes `@bridgenext/codegraph` to npm.** The release workflow
runs `scripts/pack-npm.sh`, publishes the per-platform packages first, then the
shim that lists them as `optionalDependencies` — with `--access public` and
`--provenance`. It needs an `NPM_TOKEN` secret with publish rights on the
`@bridgenext` scope; a production run fails fast without it, and a staging run
only `--dry-run`s. Upstream's OIDC trusted publishing was bound to the upstream
repo + `@colbymchenry` scope, so it could not be reused. **Never run
`npm publish` by hand** — the root manifest is `private` precisely so a manual
root publish cannot ship the wrong contents under the right name.

**Claude does NOT bump the version unless explicitly asked.** The maintainer
typically does it themselves — often by editing `package.json` directly via
the GitHub web UI. Don't proactively commit a version bump as part of
unrelated work, and don't propose one when summarizing a PR.

When the maintainer DOES bump the version, the only edit strictly required is
to `package.json` — the workflow's "Sync package-lock.json" step detects a
mismatch between `package.json` and `package-lock.json`, runs
`npm install --package-lock-only --ignore-scripts` to rewrite the lock file's
version fields (top-level + `packages.""`), and auto-commits + pushes the
result back to `main` with `[skip ci]`. So a GitHub-web-UI single-file edit to
`package.json` is enough to kick off a clean release. (If they edit both files
locally, that's fine too — the sync step no-ops.)

Once `package.json` is at the target version on `main`, trigger
**Actions → Release → Run workflow** (on `main`). The workflow:

1. Syncs `package-lock.json` to `package.json`'s version if they've drifted; commits + pushes that change.
2. Runs `prepare-release.mjs <X.Y.Z>` → promotes `[Unreleased]` → `[X.Y.Z] - <today>` in `CHANGELOG.md`, appends the link reference, commits + pushes the move with `[skip ci]`.
3. Builds every platform bundle on one runner, generates `SHA256SUMS`, and attests build provenance.
4. Creates the GitHub Release with notes from the freshly-promoted `[X.Y.Z]` block.

`SHA256SUMS` is load-bearing, not decorative: `install.sh` / `install.ps1`
verify every downloaded archive against it and refuse to install on a
mismatch. A release published without it degrades installs to unverified.

#### Rehearsing a release (staging / pre-release)

A production release is effectively irreversible — every teammate's installer
resolves `releases/latest` the moment it publishes — so the whole path can be
rehearsed first. Two ways in:

- **Push an `-rc` tag** (`v*-rc*`) from **any branch**. This is the only route
  that works *before* a merge, because `workflow_dispatch` is offered only for
  workflows on the default branch — a feature branch cannot dispatch Release at
  all. (`ci.yml` demonstrates the asymmetry: it isn't on `main`, yet it runs on
  PRs, because `push`/`pull_request` triggers use the workflow file from the
  pushed ref.)

  ```sh
  git tag v1.6.0-rc.1 && git push origin v1.6.0-rc.1
  ```

- **Actions → Release → Run workflow** with `prerelease` ticked and `tag` set
  (e.g. `v1.6.0-rc.1`) — available once the workflow is on `main`.

Either way the run is *staging*, which means:

- The release is flagged **pre-release**, which GitHub excludes from *both* the
  `/releases/latest` API and the `releases/latest` redirect. Those are the only
  two ways `install.sh` discovers a version, so a default install can never
  resolve to a staging build. Reach it deliberately with
  `CODEGRAPH_VERSION=v1.6.0-rc.1`.
- The CHANGELOG promote is **skipped** and no step pushes to `main`, so a
  rehearsal can't consume the `[Unreleased]` block or move the branch. Notes
  come from `[Unreleased]`, and an empty block doesn't fail the run.
- The tag comes from the input, so staging needs no `package.json` bump.

Everything else — kernel matrix, bundles, `SHA256SUMS`, attestation — runs
exactly as in a real release; that's the point, since those are the parts that
can only fail in CI.

**`RELEASE_PAT` is required only for a production release.** It exists so the
CHANGELOG-promote commit can push past the branch ruleset; a staging run pushes
nothing, so `checkout` falls back to the job's own `GITHUB_TOKEN`
(`secrets.RELEASE_PAT || github.token`). Without that fallback an unset secret
interpolates to the empty string and `checkout` dies at step 2 with `Input
required and not supplied: token` — which is how the first staging run failed.
A *production* run without the PAT is failed fast, with an explanatory error, by
the `Resolve release mode` step rather than 20 minutes later at the push.

The staging-vs-production decision is made **once**, in the `Resolve release
mode` step, and **fails closed**: a run is staging unless it is a
`workflow_dispatch`, *from the default branch*, with `prerelease` unticked. So a
tag push or a branch dispatch is structurally incapable of cutting a production
release — it does not depend on remembering to tick the box. Plain `vX.Y.Z` tags
deliberately do **not** trigger the workflow; production goes through dispatch.

**Tags must start with `v`.** `install.sh` normalizes a bare tag by prepending
`v` (`case "$version" in v*) ;; *) version="v$version" ;; esac`), so a release
published as `dev` is unreachable — the installer looks for `vdev` and 404s.
The workflow normalizes the same way to prevent publishing one. (The repo has a
leftover `dev` pre-release carrying **0 assets**; it is inert because
pre-releases are excluded from `latest`, but it should be deleted.)

**Never reuse a production tag for a staging run:** the workflow's re-run branch
only refreshes assets via `gh release upload --clobber` and will not flip an
existing release's pre-release flag.

To test the *installer* against a staging build without touching your real
setup, sandbox its writes:

```sh
CODEGRAPH_VERSION=v1.6.0-rc.1 \
CODEGRAPH_INSTALL_DIR=/tmp/cgtest CODEGRAPH_BIN_DIR=/tmp/cgbin sh install.sh
```

**Do not run `npm publish`, `git push`, or `git tag` yourself** — these are
publish actions on shared state. Write the files, hand the user the commands.

### CI

`.github/workflows/ci.yml` runs on every push and PR to `main`: type check,
build, the full test suite (Node 24 — older 22.x lines ship `node:sqlite`
without FTS5, and the suite fails wholesale with `no such module: fts5` on
them), plus a **blocking** `npm audit --omit=dev --audit-level=high` and a
non-blocking dev-dependency audit. Don't add `|| true` to the production
audit; if it goes red, fix or replace the dependency.

## House rules

- The `0.7.x` line is in active multi-agent rollout. Any change to `src/installer/` (especially `targets/`) needs corresponding test coverage and a CHANGELOG entry — installer regressions break every new install silently.
- When changing what the MCP tools do or how agents should use them, edit `src/mcp/server-instructions.ts` — it is the **single source of truth** for agent-facing tool guidance (issue #529). The installer no longer writes a duplicate instructions block into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursor/rules/codegraph.mdc` / Kiro steering, so there's nothing to keep in sync anymore. (The repo's own checked-in `.cursor/rules/codegraph.mdc` is dogfooding config — update it too if you use Cursor on this repo, but it ships nowhere.)
- CodeGraph provides **code context**, not product requirements. For new features, ask the user about UX, edge cases, and acceptance criteria — the graph won't tell you.
- **When the user references issues, PR comments, or external reports, anchor them to a date and version before drawing conclusions.** Check the comment's `createdAt` against:
  - The **last released version** — `grep -m1 '^## \[' CHANGELOG.md` shows the top-of-file version (older releases follow). A comment dated before the latest `## [X.Y.Z] - YYYY-MM-DD` is reacting to *released* state — work that's only on `main` or on an unmerged branch doesn't apply.
  - The **last main commit** — `git log --first-parent main -1 --format='%ai %h %s'`. A comment after the last release but before a fix on main may already be addressed there but unreleased.
  - The **current branch's tip** — your own unmerged work obviously can't be what the comment is reacting to.
  Always disambiguate "released," "merged-but-unreleased," and "in-progress" before agreeing that a user-reported problem is unfixed (or that a fix is incomplete). A user saying "your fix only covers X" about a recent PR is usually pointing at the *released* shortcomings — your in-flight branch may already address them but they have no way to know that.
- **Version-tag every image referenced in `README.md`.** GitHub caches README images (`raw.githubusercontent.com` with a 5-minute TTL; third-party hosts sit behind the long-lived camo proxy), so updating an asset in place can keep showing the stale version. Give each README image URL a `?v=N` query tag and **bump `N` in the same commit whenever the asset bytes change** — e.g. `assets/waitlist.svg?v=2`. The changed URL sidesteps every cache so the new image shows immediately instead of waiting on a TTL to expire.
