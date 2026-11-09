# dsh-neocortex

[![npm version](https://img.shields.io/npm/v/dsh-neocortex)](https://www.npmjs.com/package/dsh-neocortex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Zhinao (Neocortex) — a Markdown-authoritative second brain for DeepSeek Harness, with a local recall ledger, lifecycle engine, weekly review and a Web panel.

## Features

- **Layered memory (L1/L2/L3)**: L1 long-term model (background, collaboration preferences, task standards) gated by user confirmation; L2 knowledge written automatically with mandatory sources; L3 recent status written directly under daily quotas.
- **Local ledger with recall explanations**: a crash-conscious local ledger accounts for every recall and write; the Web panel explains why a memory was injected.
- **Lifecycle & weekly review**: scenes and entries sleep, wake, revive and get promoted by bounded rules; a resumable weekly review queues L1 candidates and sleeping entries for the user.
- **Web panel**: state, recall explanations, L1-only confirmation, review actions, read-only L2 audit, undo, and six bounded settings sliders.
- **Blank template initialization / takeover**: first run initializes your brain from a generic, personal-info-free Markdown skeleton, or adopts an existing Zhinao directory without touching its files.

## Requirements

- DeepSeek Harness (DSH) `>= 0.2.1-rc.5`.
- Verified on Windows.

## Install

```sh
dsh plugin --profile web add dsh-neocortex
```

or install `dsh-neocortex` from a DSH plugin market in the GUI.

## First run

Open **Settings → Plugins → Zhinao / Neocortex** and run the setup wizard. You choose the directory yourself in every mode:

- **New brain**: pick an empty directory; the wizard copies the blank template into it. Any conflicting file aborts the initialization — nothing is overwritten.
- **Use existing**: point to an existing Zhinao directory; the wizard only verifies it and never modifies existing files.
- **Upgrade skeleton**: point to an existing but incomplete Zhinao directory; the wizard creates only the missing skeleton files and skips every file that already exists.

## Usage

Agents get three tools:

- `neocortex_remember` — write one atomic fact to L1/L2/L3 with quota or queue feedback.
- `neocortex_recall` — recall general and sleeping personal history; routes external-knowledge questions to web search.
- `neocortex_panel` — panel state, review preview, undo, review execution/retry, and bounded settings updates. L1 confirmation and weekly-review accept/reject stay user-only.

You can also steer it in natural language: "skip the brain this time" (no read/write), "don't remember this" (don't save), "remember this" (save it).

## Feeding module (v0.5, in development)

v0.5 adds a `src/watch/` feeding module to the same plugin, off by default. Current progress: P1 skeleton + P2 data layer.

- **Settings → Plugins → Zhinao → Feeding** switches between `off / code / agent`; the state is persisted to `<dataDir>/watch.json`.
- `off` is inert: no process, no tokens, no harvesting, no files.
- From P2 on, two tools configure the runtime:
  - `watch_selftest` (`action: "install"`) creates the venv, installs the Bilibili MCP requirements, then checks Python / script / deps / login / ffmpeg.
  - `watch_login` (`action: "start"` / `"poll"`) runs QR login; the credential lands in `<dataDir>/watch/bili-mcp/bili_credential.json` with current-user-only permissions.
- Harvest, triage, the pending queue, comments/DMs and the privacy gate arrive from P3 on. The `agent` mode waits for preset assembly validation; see [`docs/p0-agent-mode.md`](docs/p0-agent-mode.md).

## Uninstall

Removing the plugin does **not** delete your brain data: the Markdown files, the local ledger and settings stay on disk.

## Development

```sh
node --test tests/*.test.mjs
```

For learning purposes.
