# dsh-neocortex

[![npm version](https://img.shields.io/npm/v/dsh-neocortex)](https://www.npmjs.com/package/dsh-neocortex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Zhinao (Neocortex) — a Markdown-authoritative second brain for DeepSeek Harness. It **reads** your personal model and knowledge base, and **writes** back from Bilibili feeding: video notes, recent status, follow suggestions, and comment replies.

## Features

- **Layered memory (L1/L2/L3)**: L1 long-term model gated by user confirmation; L2 knowledge written with mandatory sources; L3 recent status under daily quotas.
- **Local recall (R1)**: the first four turns of a new session retrieve the personal model, knowledge pages and recent status by the actual question; `neocortex_recall` also exposes knowledge-only search.
- **Bilibili feeding (watch)**: daily scheduled search, deep-read, pending queue, one-keystroke accept/drop, then L2 source page + L3 recent entry.
- **Read/write loop**: followed UPs get a reserved slot; accepted videos feed comment mining; model drafts are automatically sent with an owner mention, privacy gate and daily quota.
- **Human line**: following an UP still requires a click; comments are automatic by explicit user decision, but privacy/412/budget stop everything.
- **Local ledger with recall explanations**: every recall and write is accounted for; the panel explains why a memory was injected.
- **Lifecycle & weekly review**: scenes/entries sleep, wake and revive by bounded rules; a resumable weekly review queues L1 candidates for the user.
- **Web panel / floating ball**: pending cards, follow suggestions, three budget sliders, scheduler state and comment report.
- **Blank template initialization / takeover**: first run initializes a generic, personal-info-free Markdown skeleton, or adopts an existing Zhinao directory without touching its files.

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

v0.5 adds a `src/watch/` feeding module to the same plugin, off by default.

- **Settings → Plugins → Zhinao → Feeding** switches between `off / code`; the state is persisted to `<dataDir>/watch.json`.
- `off` is inert: no process, no tokens, no harvesting, no files.
- `watch_selftest` (`action: "install"`) creates the venv, installs the Bilibili MCP requirements, then checks Python / script / deps / login / ffmpeg. `watch_login` runs QR login and stores the credential with current-user-only permissions.
- The code mode produces the daily Markdown report, JSONL records and pending-confirmation queue. Accepting queue items is separate from harvesting; no comments, DMs or follows are sent by a round.
- `code` uses deterministic harvesting and model judgement. An experimental restricted-agent implementation remains in the repository but is **not exposed** in the panel; the product decision is `off / code` only.
- `watch_run` supports `dry` and `suggest` (read-only follow suggestions).

## Uninstall

Removing the plugin does **not** delete your brain data: the Markdown files, the local ledger and settings stay on disk.

## Development

```sh
node --test tests/*.test.mjs
```

For learning purposes.
