# P2 验收记录：数据层（B 站只读 MCP + 登录 + 体检）

> 日期：2026-11-09 · 对应 `智脑插件-v0.5-喂养模块.md` §7 的 P2

## 交付物

| 文件 | 作用 |
|---|---|
| `vendor/bilibili-mcp/` | 上游 `c1overzz/dsh-bili-scroll@1096b042`（MIT）原样复制；`UPSTREAM.md` 记来源与许可；不跟踪上游 |
| `src/watch/mcp.js` | 极小 MCP stdio 客户端（initialize → tools/call） |
| `src/watch/bili.js` | 只读客户端工厂；`BILI_MCP_TOOLS` 白名单在 MCP 进程侧强制 |
| `src/watch/python.js` | Python 解释器发现（config → DSH 自带运行时 → PATH）、venv、依赖、ffmpeg、凭证读取 |
| `src/watch/login.js` | B 站 passport 扫码登录、凭证保存与权限收紧、二维码 PNG |
| `src/watch/harvest.js` | 只读抓取封装（搜索/详情/字幕/评论/弹幕/UP 投稿/推荐/榜单） |
| `src/watch/selftest.js` | 五项体检（python / server / deps / login / ffmpeg） |
| `src/watch/tools.js` | `watch_selftest`、`watch_login` 两个模型工具 |
| `tests/watch-p2.test.mjs` | P2-01–08 |

## 验收结果（2026-11-09 21:44）

```text
watch_selftest → ok: true
  python  ok    Python 3.12.14（DSH 自带运行时）
  server  ok    mcp_server.py 已复制到 <dataDir>/watch/bili-mcp/
  deps    ok    bilibili-api-python 17.4.2 / mcp 1.30.0 / aiohttp 3.14.5
  login   ok    凭证有效（已登录）
  ffmpeg  missing（可选：只影响无字幕转写与抽帧，不影响读字幕）
```

- 真实只读调用：`bili_search(keyword="信息报送", num=3)` 返回结构化 JSON（bvid / 标题 / UP / 播放 / 评论 / 时长 / 发布时间 / 简介）。
- 登录凭证：`<dataDir>/watch/bili-mcp/bili_credential.json`，ACL 仅当前用户、无继承。
- MCP 进程侧白名单：`bili_reply` / `bili_send_message` 不在 `BILI_MCP_TOOLS` 里，调用会被服务端拒绝。
- 依赖安装踩坑与修复：Windows 下 pip 写 wheel cache 被拒（WinError 5）→ `--no-cache-dir`；`qrcode_terminal` 只有源码包 → 允许源码构建；Python 子进程需 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`，且必须把 `mcp_server.py` 作为参数传入。

## 复现与手工步骤

```text
watch_selftest({ action: "check" })     # 五项体检
watch_selftest({ action: "install" })   # 首次：建 venv + 安装依赖（可选 pipIndexUrl）
watch_login({ action: "start" })        # 出二维码（qrPath / key / url）
watch_login({ action: "poll", key })    # 扫码后轮询；ok 时自动保存凭证
```

> 以上工具在 profile 切到 `link:` 后需要**重启一次 DSH** 才会出现在运行中的插件里；本验收是通过本地脚本直接调用同一套函数完成的。

## 未完成的边界

- `ffmpeg` 未安装：P3 先走字幕路径；需要无字幕转写/抽帧时再补。
- 面板上的「体检 / 扫码」按钮属于 P7，P2 只有模型工具。
- `bili_followings`（我关注了谁）上游 MCP 没有，P4.5 再补。
