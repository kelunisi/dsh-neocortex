# bilibili-mcp（vendored）

- 上游仓库：https://github.com/c1overzz/dsh-bili-scroll
- 上游提交：`1096b042e2d6d35a6ce3a373ebc0be51552e43c7`（2026-11-07）
- 原始路径：`vendor/bilibili-mcp/`
- 基础项目：`AGI_Ananas/bilibili-mcp`（MIT）
- 本仓库许可：MIT，见同目录 `LICENSE`

## 约定

- 本目录内容**原样复制**，不修改上游行为；dsh-neocortex 只做运行时复制到数据目录后启动。
- **不跟踪上游更新**（用户 2026-11-09 决定）：上游后续提交不会自动进入本仓库；如需升级，人工 diff 后整体替换并更新上面的提交号。
- 只使用其**只读工具**子集：通过 `BILI_MCP_TOOLS` 白名单在 MCP 进程侧强制，写操作（`bili_reply` / `bili_send_message`）默认不暴露。
- 登录凭证 `bili_credential.json` 不放在本目录，运行时落在 `<dataDir>/watch/bili-mcp/`，并收紧文件权限。
