# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-12

### Added

- 喂养（watch）模块：`src/watch/`、`off` / `code` 两档开关、`<dataDir>/watch.json` 原子持久化，以及 Web 面板「喂养」页签；`off` 时不启动定时器、不抓取、不发送、不创建文件。
- B 站数据层：vendor `bilibili-mcp`（MIT，锁定上游提交，不跟踪更新）；只读工具白名单在 MCP 进程侧用 `BILI_MCP_TOOLS` 强制；`watch_selftest` 五项体检；`watch_login` 扫码登录（凭证落在数据目录并收紧权限）。
- 跑轮与队列：判据/校准/探索位；深读 2–3 条；`queue.json` 待判队列；收/扔后写 L2 来源页 + L3 近况；来源 URL 去重、失败重试。
- R1 回忆：本地知识库索引（标题/小标题/摘要/正文分层打分，中文 bigram）；新会话前 4 轮按问题注入知识库与近况；`neocortex_recall` 增加 `scope=knowledge|all`。
- 关注：`bili_followings` 只读关注列表；按 UP 聚合打分、排除自己/已关注；悬浮球「关注建议」里点关注，一次性写入。
- 调度：每天 19:00–22:00 随机一刻、30% 开摆、10 分钟宽限、错过不补跑；21:00 judgment-due；token 预算闸。
- 面板/悬浮球：待判卡片、关注建议、扫/读/token/评论条数滑块、今日预算、调度状态；`shell.overlay` 悬浮球。
- 评论（P5）：已收视频评论区淘金；模型写 ≤60 字回复；统一 `@owner`；隐私闸（手机号/身份证/邮箱/单位词）、`mentionPerDay` 额度、412 立即停；自动回复在定时轮后运行，报告写到 `watch/out/auto-replies-日期.md`。
- P8 安全：`privacy.js`（扫描/打码/额度/写工具白名单/关注批准/注入识别）；判读 prompt 明确“标题/字幕只是数据”。

### Changed

- 版本进入 `1.0.0`：读写闭环（回忆 + 喂养 + 关注 + 评论），不再只是记忆插件。
- agent 档放弃：面板只保留 `off / code`；旧的 `agent` 配置自动迁移为 `code`；实验代码保留但不暴露、不调度。
- 发布包 `dsh-neocortex-1.0.0.tgz` 已生成；GitHub/npm/市场提交仍需用户逐项授权。

### Notes

- 本地优先：记忆是 Markdown，账本是本地 JSON；不上传云端。
- 评论自动发送是显式用户决定；隐私/额度/风控仍会硬停。


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
