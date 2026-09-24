---
title: Installation
description: Install CodeGraph and configure your AI coding agents.
---

## 1. Install the CLI

This is the Bridgenext fork. The package is `@bridgenext/codegraph`, published under Bridgenext's own scope:

```bash
npm i -g @bridgenext/codegraph
```

It bundles its own Node runtime, and npm downloads only the build matching your OS and CPU.

No Node.js on the machine? Use the standalone installer, which pulls the same build from this repository's Releases:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bridgenext/forge-codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/bridgenext/forge-codegraph/main/install.ps1 | iex
```

The installer verifies the downloaded archive against the release's `SHA256SUMS` and aborts on a mismatch. Open a **new terminal** afterwards so `codegraph` resolves on your `PATH`.

## 2. Run the agent installer

```bash
codegraph install
```

The installer will:

- Ask which agent(s) to configure — auto-detecting installed ones from **Claude Code**, **Cursor**, **Codex CLI**, **opencode**, **Hermes Agent**, **Gemini CLI**, **Antigravity IDE**, and **Kiro**.
- Check that `codegraph` is on your `PATH` (so agents can launch the MCP server).
- Ask whether configs apply to all your projects or just this one.
- Write each chosen agent's MCP server config, plus a small marker-fenced CodeGraph section in the agent's instructions file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`). Cursor and Kiro get the MCP config only. Removed cleanly by `codegraph uninstall`.
- Set up auto-allow permissions when Claude Code is one of the targets.

The installer **wires up your agents only — it does not index your code.** After it finishes, build each project's graph yourself with `codegraph init` (step 4 below).

For Claude Code specifically:

```bash
codegraph install --target=claude
```

## Non-interactive (scripting / CI)

```bash
codegraph install --yes                              # auto-detect agents, install global
codegraph install --target=claude --yes              # Claude Code only
codegraph install --target=cursor,claude --yes       # explicit target list
codegraph install --target=auto --location=local     # detected agents, project-local
codegraph install --print-config claude              # print snippet, no file writes
```

| Flag | Values | Default |
|---|---|---|
| `--target` | `auto`, `all`, `none`, or csv (`claude,cursor,…`) | prompt |
| `--location` | `global`, `local` | prompt |
| `--yes` | (boolean) | prompt every step |
| `--no-permissions` | (boolean) skip Claude auto-allow list | permissions on |
| `--print-config <id>` | dump snippet for one agent and exit | — |

## 3. Restart your agent

Restart your agent (Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / Gemini CLI / Antigravity IDE / Kiro) for the MCP server to load.

## 4. Initialize projects

```bash
cd your-project
codegraph init
```

`codegraph init` creates the local `.codegraph/` directory and builds the full graph in the same step — one command. A single global `codegraph install` covers every project; you run `codegraph init` once per project.

## Supported platforms

Every release ships a self-contained build (bundled Node runtime — nothing to compile) for all three desktop OSes, on both x64 and arm64:

| Platform | Architectures | Install |
|---|---|---|
| Windows | x64, arm64 | PowerShell installer or npm |
| macOS | x64, arm64 | shell installer or npm |
| Linux | x64, arm64 | shell installer or npm |

## Uninstall

Changed your mind? One command removes CodeGraph from every agent it configured:

```bash
codegraph uninstall
```

This reverses the installer — stripping CodeGraph's MCP server config, instructions, and permissions from each configured agent. Your project indexes (`.codegraph/`) are left untouched; remove those per-project with `codegraph uninit`. Use `--target` to remove from specific agents, or `--yes` to run non-interactively.
