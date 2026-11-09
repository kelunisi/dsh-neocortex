# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 喂养（watch）模块的 P1 骨架：`src/watch/`、三档开关（`off` / `code` / `agent`，默认 `off`）、`<dataDir>/watch.json` 原子持久化，以及 Web 面板的「喂养」页签。开关能存能读；`off` 时不启动定时器、不抓取、不发送、不创建文件。
- P0 技术结论 [`docs/p0-agent-mode.md`](docs/p0-agent-mode.md)：`agent` 模式可行，但需要随包交付一个 agent preset 行，并依赖 Host 的 `agentPresets.mount()`；`code` 模式不依赖这些，仍是默认推荐。
- P2 数据层：vendor `bilibili-mcp`（MIT，锁定上游提交，不跟踪更新）；自带极小 MCP stdio 客户端；只读工具白名单在 MCP 进程侧用 `BILI_MCP_TOOLS` 强制；`watch_selftest` 五项体检（Python / 脚本 / 依赖 / 登录态 / ffmpeg）；`watch_login` 扫码登录（B 站 passport 接口，凭证落在数据目录并收紧权限）。

### Changed

- 版本进入 `0.5.0-dev.0` 开发线；P9 发布时改为 `0.5.0`。

### Notes

- 这是开发版，不是发布版。P2 起的抓取、判据、待确认队列、互动与隐私闸尚未实现。

## [0.4.0] - 2026-11-05

### Added

- Public release of `dsh-neocortex`: the Zhinao (second brain) plugin for DeepSeek Harness, with layered Markdown memory (L1 long-term model / L2 knowledge / L3 recent status), a local recall ledger with explanations, lifecycle engine with weekly review, and a Web panel.
- Blank brain template initialization: first run copies a generic, personal-info-free Markdown skeleton into the chosen directory, so a new brain starts from a documented structure.
- Brain takeover: point the plugin at an existing Zhinao directory and adopt it without modifying any existing file.
- Upgrade-skeleton mode: adopt an existing but incomplete Zhinao directory and create only the missing template files — existing files are never touched.

### Notes

- 0.4.0 is the first public release. It carries forward the complete 0.3.0 development-line feature set (the P1–P4 scope validated by the internal acceptance suite); the only functional additions are the template-based setup wizard (new brain / takeover) and the release-candidate packaging. There are no breaking changes relative to a 0.3.0-configured brain.

## [0.4.1] - 2026-11-05

### Added

- npm version and license badges in the READMEs.

### Changed

- Releases now publish through GitHub Actions trusted publishing (OIDC with provenance). Pushing a `v*` tag runs the publish workflow; no long-lived npm tokens are involved.

### Notes

- 0.4.1 was published entirely by CI to validate the automated release pipeline end to end.

## [0.4.2] - 2026-11-06

### Fixed

- Tool results are normalized to lossless JSON before returning. `neocortex_remember` no longer fails on DSH 0.2.2+ with `value is not lossless JSON` when no prior entry was replaced (the report carried `tombstoneId: undefined`). Memory writes were always correct; only the tool report was rejected by the stricter DSH 0.2.2 output validation.

### Notes

- Compatibility verified on DSH 0.2.2-rc.1: plugin load, systemPrompt injection, and all three tools (`neocortex_remember` / `neocortex_recall` / `neocortex_panel`) behave as on 0.2.1-rc.5.
