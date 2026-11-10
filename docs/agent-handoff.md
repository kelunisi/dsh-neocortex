# P4.5 `agent` 档交接文档（未跑通）

> 日期：2026-11-10 21:55 · 状态：**agent 档未接通；code 档全部正常**  
> 接手对象：另一个 AI 或后续维护者。请先读“结论”和“已试路径”，再看“证据与复现”。

## 一句话结论

`ctx.agents.create()` 能成功建出受限会话，preset 也能挂上（standard/minimal 都试过），`parentAgent` 也传了，但**每一次模型请求都在 provider 层以 `DeepSeek Messages transport failed`（`TRANSPORT`）失败**，重试 5 次后 `turn/end: error`。

同一台机器、同一个 `deepseek-account / deepseek-flash` 路由下，**普通 subagent 工具能正常回复**，所以不是账号凭证或模型不可用；问题限定在“手工 `agents.create` 出来的会话如何拿到可用的模型传输”。

## 已确认正常的部分

- 插件 `dsh-neocortex@0.5.0-dev.0`，profile 用 `link:` 指到 `E:\AI-workspace\DSH sp\智脑项目区\dsh-neocortex`。
- `code` 档：搜索、深读、判读、队列、L2/L3 入库、悬浮球、关注建议、关注写操作、调度器、预算，全部可用。
- 全量测试 **110/110**。
- 普通 subagent（工具 `subagent`）在同 profile 下能正常回复；对照会话 `296a3beb-9370-4367-a84a-c677a1ff509e`，请求头是：
  `provider=deepseek-account, model=deepseek-flash, maxTokens=256000`，有正常 `assistant/message`。
- 探针 `watch_run action=agent_probe` 能创建会话：
  - 返回 `ok:true`、`keys` 含 `session/ctx/dispatch` 等；
  - `setup.hasOn/hasTools/hasSystemPrompt` 都是 true；
  - 会话里能写 `system/message`、多条 `user/message`、`request/header`、`request/context`。

## 已试路径（全部失败在同一处）

| # | 装配 | 会话 ID | 结果 |
|---|---|---|---|
| 1 | 无 preset、无 parentAgent | `watch-probe-1794313662184-cf6f70` | 5 条消息，`assistant/attempt` 全部 TRANSPORT |
| 2 | `standard` preset、无 parentAgent | `watch-probe-1794315032085-283da1` | 8 条消息，同样 TRANSPORT |
| 3 | `standard` preset + `parentAgent` | `watch-probe-1794317913348-038b43` | `parentAgent:true`，同样 TRANSPORT |
| 4 | `minimal` preset + `parentAgent` | `watch-probe-1794318777588-94285e` | `presetId:minimal`、`parentAgent:true`，同样 TRANSPORT |

共同错误序列（每个会话都相同）：

```text
assistant/attempt → finish { kind:'error', failure:{ message:'DeepSeek Messages transport failed', code:'TRANSPORT' } }
llm/retry ×5（policy 允许 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）
turn/end → error
```

## 关键证据位置

会话日志（zstd 多帧 JSONL）：

```text
E:\AI-workspace\.dsh\sessions\--E-AI-workspace-DSH~0020sp-dsh-neocortex-.data--\<sessionId>\session.v4.jsonl.zstd
```

解压方法：文件是多个 zstd frame 拼接；按 magic `28 B5 2F FD` 切帧，逐帧 `zstdDecompressSync`。  
工作区 `sandbox/read-probe3.mjs` 是本次用的脚本，可直接改 session 路径复用。

对照成功会话：

```text
E:\AI-workspace\.dsh\sessions\--E-AI-workspace-DSH~0020sp-~667A~8111~9879~76EE~533A--\296a3beb-9370-4367-a84a-c677a1ff509e\session.v4.jsonl.zstd
```

## 涉及代码

- `src/watch/agent-probe.js`：探针。做四件事：
  1. `ctx.get('agents')`、`ctx.get('agentPresets')`；
  2. `presets.resolve('minimal')` / `mount(agentCtx, id)`；
  3. `ctx.agents.currentInitiator()` 作为 `parentAgent`；
  4. `agents.create()` + `agent.followup()` + `whenIdle()`，在 `setup` 里监听 `agent/assistant-stream` 收 `text-delta`。
- 入口：`watch_run action=agent_probe`（**没有**新增工具名，原因见下）。
- 相关提交：
  - `6b4bd1c` 初版探针（新增 `watch_agent_probe` 工具）
  - `9e2a84e` 挂 standard preset
  - `cd63dac` 加 parentAgent
  - `adb60c2` 改 minimal preset

## 两个宿主层“坑”（接手必读）

1. **新增工具名不会生效**  
   在运行中的宿主里给 `registerWatchTools` 增加新工具（如 `watch_suggest`、`watch_agent_probe`），即使 disable/enable 插件也不会出现；`ctx.tools.register` 到第 6 个就断，后面的都没有。  
   **规避**：把功能挂到已存在的 `watch_run` 的 `action` 上。当前 `watch_run` 支持 `dry/suggest/agent_probe`。

2. **插件代码改动需要完整重启宿主**  
   `plugin_manager` 的 disable/enable 只重新挂载已加载模块，不重新 import 代码。  
   必须完全退出 DSH 宿主（托盘退出/任务管理器结束所有 `DeepSeek Harness` 进程）再打开；只关窗口或刷新页面不算。  
   判断是否真的重启：`Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'"` 看 `dsh-desktop-host` 的 `CreationDate` 是否晚于代码文件 mtime。

3. **`package.json` 不要用 PowerShell `Set-Content` 写**  
   会带 UTF-8 BOM，loader 解析失败会**静默丢掉整个插件**（设置页签和工具一起消失）。用 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`。

## 给接手 AI 的建议方向（按优先级）

1. **先读正常 subagent 的创建路径**  
   读 `@deepseek-ai/dsh-tool-subagent`（app.asar 内）如何调用 `agents.create`：它传了哪些 `agentOptions`、`setup`、`parentAgent`、`meta`，以及是否额外安装了 provider/transport 相关插件。把它的组合**逐项对齐**到 `agent-probe.js`，这是最可能直接修好的路。

2. **检查 provider 是否属于“宿主级服务”**  
   `deepseek-account` 可能依赖宿主进程里的账号桥接，而新 agent 的 ctx 里没有这个桥接。可试：
   - 在 preset 里显式挂载 `@deepseek-ai/dsh-deepseek-account-platform`（或对应 provider 插件）；
   - 或用 `ctx.llm` 的实际适配器/路由对象，而不是只传 `{provider, model}` 字符串；
   - 或让子会话继承父会话的 `llm` 服务（`ctx.agents.create` 的 setup 里挂一个转发工具/provider）。

3. **做最小化隔离实验**  
   在 `agents.create` 的 `setup` 里，直接用该会话的 `llm` 服务发一次 `stream({messages:[{role:'user',text:'收到'}]})`，看是否也 TRANSPORT：
   - 如果 `ctx.llm` 直连成功 → 问题在 agent loop 的请求组装（工具/系统提示/上下文）；
   - 如果直连也失败 → 问题在 provider/transport 的会话绑定。

4. **保底方案**  
   如果上述都不通，`agent` 档保持“自动降级 code”，P5 用 code 档 + 工具白名单实现；不要为了 agent 档阻塞 P5/P8。当前 `agent` 按钮已明确：切到 `agent` 时自动跑仍走 code，并写日志。

## 当前产品状态（交接后可直接继续）

- `code` 档完整可用；调度器 19:00–22:00 随机跑，30% 开摆，错过不补；
- 悬浮球「待判 / 关注建议」、关注按钮、评论条数滑块都已上线；
- 队列 0 待判；关注建议 1 条（惊叹号diy电脑）；
- 全量测试 110/110；工作区干净（以 `git status` 为准）。

## 复现命令

```powershell
# 1. 确认宿主已完整重启（CreationDate 晚于代码 mtime）
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -match 'dsh-desktop-host' } |
  Select-Object ProcessId,CreationDate

# 2. 调探针（在 DSH 会话里）
#    watch_run { "action": "agent_probe" }

# 3. 看该会话日志
#    E:\AI-workspace\.dsh\sessions\--E-AI-workspace-DSH~0020sp-dsh-neocortex-.data--\<sessionId>\
```

**如果修好，请把结论补回 `docs/p4.5-follow.md`，并把 `agent-probe.js` 的 preset 从 `minimal` 改成最终的只读 preset。**
