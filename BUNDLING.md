# Distribution: self-contained bundles

CodeGraph ships a **vendored Node runtime** alongside the app. Because Node 22.5+
has a built-in real SQLite (`node:sqlite`, with WAL + FTS5), bundling Node means:

- **No native build** — `better-sqlite3` is gone, so there are zero native addons
  to compile or rebuild.
- **No wasm fallback** — and therefore no more `database is locked` (issue #238).
- **No Node-version dependence** — the app always runs on the bundled Node,
  whatever the user has (or doesn't have) installed.

## What's in a bundle

Built by [`scripts/build-bundle.sh`](scripts/build-bundle.sh) — one archive per
platform, identical recipe (only the Node download differs):

```
codegraph-<target>/
  node | node.exe          # official Node runtime for <target>
  lib/
    dist/                  # compiled app (+ tree-sitter .wasm grammars, schema.sql)
    node_modules/          # production deps only (pure JS / wasm — portable)
  bin/
    codegraph | codegraph.cmd   # launcher → runs the bundled Node with the app
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`,
`win32-arm64`. Unix targets produce `.tar.gz` (shell launcher); Windows produces
`.zip` (`node.exe` + a `.cmd` launcher).

```bash
scripts/build-bundle.sh linux-x64            # -> release/codegraph-linux-x64.tar.gz
scripts/build-bundle.sh win32-x64            # -> release/codegraph-win32-x64.zip
```

Because dropping better-sqlite3 left **zero native addons**, building a bundle is
pure file-packaging — **any** target builds on **any** OS (the whole matrix builds
on one Linux runner). Cross-compilation isn't a concern; only *run-testing* a
bundle needs the target platform (or emulation, e.g. `docker run --platform
linux/amd64`).

## Install channels

**Bridgenext fork: channels 1-3 are live.** npm is the primary channel; the
standalone installers remain for machines with no Node — see "Release pipeline".

1. **`curl | sh`** ([`install.sh`](install.sh)) — no Node required; ideal for a
   fresh Linux VPS over SSH. Detects os/arch, pulls the archive from GitHub
   Releases, **verifies it against the release's `SHA256SUMS` and aborts on a
   mismatch**, then symlinks `codegraph` onto PATH. Re-run to upgrade;
   `--uninstall` to remove.
2. **Windows** ([`install.ps1`](install.ps1)) — `irm … | iex`; same flow as
   install.sh (detect arch, pull the `.zip` from Releases, verify the checksum,
   add to PATH).
3. **npm — the primary channel.** ([`scripts/npm-shim.js`](scripts/npm-shim.js))
   `npm i -g @bridgenext/codegraph`. Scoped to `@bridgenext/codegraph`: the main
   package is a tiny shim and the bundles ship as per-platform
   `optionalDependencies` (`@bridgenext/codegraph-<target>` with `os`/`cpu`), so
   npm installs only the matching one. The shim — run by the user's Node —
   execs the bundle, so the real work runs on the bundled Node 24, even on old
   Node. On Windows it invokes the bundled `node.exe` against the app entry
   directly (not the `.cmd` launcher) — modern Node throws `EINVAL` when asked
   to spawn a `.cmd`/`.bat`. `scripts/pack-npm.sh` assembles the publishable
   layout and the release workflow publishes it.
4. **Homebrew / Scoop** — TODO (tap + cask pointing at the Release archives).

## Release pipeline

[`.github/workflows/release.yml`](.github/workflows/release.yml) — manually
triggered. Reads the version from `package.json`, builds every platform bundle on
one runner, generates `SHA256SUMS`, attests build provenance, and creates the
GitHub Release (notes from `CHANGELOG.md`).

**npm publish.** The workflow runs `scripts/pack-npm.sh` and publishes the
per-platform packages first, then the `@bridgenext/codegraph` shim that lists
them as `optionalDependencies`. Needs an `NPM_TOKEN` secret with publish rights
on the `@bridgenext` scope; a production run fails fast without it. Publishes
with `--access public` (a scoped package is restricted on first publish) and
`--provenance`. A staging run only `--dry-run`s, so a rehearsal can never
occupy a real version. Upstream's OIDC trusted publishing was bound to the
upstream repo and the `@colbymchenry` scope, so it could not be reused.

`SHA256SUMS` is load-bearing rather than decorative: `install.sh` / `install.ps1`
verify against it and refuse to install on a mismatch, so a release published
without it silently downgrades every install to unverified.

Still TODO:
- **Code signing** — the main gap for "download & run": macOS Gatekeeper needs a
  Developer ID + notarization; Windows needs Authenticode. Homebrew softens the
  macOS case (handles quarantine).
- Retire the now-vestigial Node-version gate in `src/bin/codegraph.ts` — the
  bundle always runs Node 24, and the npm shim does no tree-sitter work.
- Re-wire `npm uninstall` cleanup (the agent-config `preuninstall`) through the
  shim — the generated main package doesn't carry it.
