# Watch agent 档交接（2026-11-11）

## 当前结论

- 旧 `minimal` 探针已在 `kimi-code-cn/k3.1-pro` 成功回复“收到”，`turn/end=completed`。它只证明手工 `agents.create` 能获得模型文本，**不是只读或完整 agent 跑轮验收**。
- 该旧请求的 `request/header.tools` 实际包含 83 个宿主工具（PowerShell、watch_ingest、watch_login、neocortex_remember 等），所以旧探针不满足安全边界。
- 正式 `watch-duty`、真实 agent 跑轮、统一分流和显式降级已实现，离线全量 **139/139**、语法检查 **42 个 JS 文件**通过。
- 运行中的 Host 仍使用旧模块。修改已经加载的 Cordis 插件源码后，禁用/启用不会重新 import；**必须完整退出并重开 DSH Host**，才能做新代码的真实验收。
- 旧 `deepseek-account/deepseek-flash` 的 TRANSPORT 是否已修复仍未知；新探针支持临时指定该路由复测，不改部署默认。

## 已实现

1. `cordis.patch.yml` 声明 `preset-watch-duty`，只挂 persona，不把 preset 当沙箱。
2. `src/watch/agent-round.js`：
   - setup 先 mount `watch-duty`，再 `tools.restrict({allow:[]})` 清空继承工具；
   - 仅注册 `watch_bili_followings`、`watch_bili_search`、`watch_bili_user_videos`、`watch_bili_subtitle`，并用 `schemas(agent)` 验证恰好四个；
   - 最多 30 次工具调用，搜索/关注/字幕参数与输出有界；
   - 最终 BV 和元数据必须来自本轮实际候选工具结果；deep 必须有同 BV 的实际非空字幕；
   - 无字幕/低置信度接受转待定，排除已判定/排除词，执行 scan/deep 限额；
   - 非 completed（包括 error、aborted、max-tokens）失败；超时/外部取消调用 `agent.cancel()`，finally dispose 并停 MCP；
   - 复用日报、JSONL、queue、预算产物；usage 优先真实 provider usage，失败轮次记录实测部分用量。
3. `src/watch/runner.js` 统一手动与定时分流。创建/模型/解析失败可带 `degraded` 降级 code；取消、预算耗尽、`WATCH_COMMIT_FAILED` 不重跑。降级前再次检查预算。
4. `src/watch/agent-probe.js` 只有同时满足 watch-duty、零可见工具、回复“收到”、turn completed 才 `ok:true`；支持临时 provider/model。
5. `index.js` 跳过 `watch-agent-*` / `watch-probe-*` 的个人记忆 pre-step，并不给这些会话显示记忆操作指令。
6. 没有给 agent 文件、shell、关注、评论、私信、记忆写入或入库工具；没有新增第 6 个全局 watch 工具。

## 证据

- 旧成功探针：`E:\AI-workspace\.dsh\sessions\--E-AI-workspace-DSH~0020sp-dsh-neocortex-.data--\watch-probe-1794400848778-52390d\session.v4.jsonl.zstd`。
- 核心测试：`tests/watch-agent.test.mjs`（16 项）、`watch-agent-probe.test.mjs`、`watch-dispatcher.test.mjs`、`watch-session.test.mjs`。
- 执行：
  ```powershell
  & 'C:\Users\kelunisi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test tests/*.test.mjs
  & 'C:\Users\kelunisi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' scripts/check.mjs
  ```

## 重启后的验收顺序

1. 用 `plugin_manager` 对当前工作树执行一次 bundle 安装，使 `preset-watch-duty` 进入 Host 组合；确认没有版本/引擎错误。
2. 完整退出并重开 DSH（不是只刷新网页，也不是 disable/enable）。
3. 调 `watch_run {action:'agent_probe'}`：要求 `ok:true`、`setup.presetId='watch-duty'`、`setup.toolNames=[]`、turn completed。
4. 调 `watch_run {action:'agent_probe',provider:'deepseek-account',model:'deepseek-flash'}` 复测旧路由；失败则记录为路由特有问题，不影响当前可用路由的结论。
5. 面板切到 agent，跑一次 `watch_run {action:'dry',deep:1}`。检查真实 session request 工具恰好四个、无个人记忆注入、无写工具调用，日报/JSONL/queue 存在且字段同构，临时 agent 最终 dispose。
6. 若 agent 在提交前失败，允许显式 code 降级，但结果必须有 `degraded`；不能把降级结果当成 agent 验收成功。
7. 验收通过后再继续 P5（互动/隐私）与 P8（发布）；验证过程不实际发评论、私信或关注。
