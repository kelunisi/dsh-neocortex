# P0 技术结论：`agent` 模式能不能拉起"受限会话"

> 结论日期：2026-11-09 · 对应 `智脑插件-v0.5-喂养模块.md` §4 / 决策台账 D3
> 验证对象：本机 DeepSeek Harness `0.2.2-rc.1`（`D:\AI\DeepSeek\resources\app.asar\dsh`）

## 一句话结论

**能做，但要用两样东西换：一个随插件交付的 preset 声明，和一次对 Host 内部服务方法 `agentPresets.mount()` 的依赖。**

`code` 模式不依赖这些，所以默认仍推荐 `code`；`agent` 保留为可选档。

## 证据链

### 1. 宿主本来就有"指定 preset 创建会话"的入口

`@deepseek-ai/dsh-api-session-controller`（Web/API 层）在创建会话时做的正是我们想做的事：

- `lib/index.js:235` `createSession()` → `createMinted(cwd, await this.composeAgent(request.agentPreset))`
- `lib/index.js:264-277` `composeAgent(presetId)`：`agentPresets.resolve(id)` 拿 preset，再返回 `setup(agentCtx) { await presets.mount(agentCtx, resolvedId) }`
- `lib/index.js:424-439` `createAgent()`：

```js
await this.ctx.agents.create({
  sessionId,
  agentOptions: this.agentOptions(),
  meta: { cwd, agentPreset: composition.agentPreset },
  setup: composition.setup,
});
```

也就是说：**`ctx.agents.create` 接受 `meta.agentPreset` + `setup`**，这就是受限会话的装配口。

### 2. 插件侧可以直接复用同样的调用

- `@deepseek-ai/dsh-agent` README.zh.md:35-43 明确公开了 `ctx.agents.create({ sessionId, agentOptions, setup })`；
- 同文件 72-75 行：`Agent.ctx` 的"作用域注册"就是 agent preset 给单个会话不同能力集的方式；
- `@deepseek-ai/dsh-agent-preset-registry/lib/index.js:702` 的 `mount(ctx, id)` 带 JSDoc：
  "Bind an unpublished Agent to the current preset revision. @param ctx Agent context from its setup callback."
- 同文件 612 行 `resolve(id)`、586 行 `list()`、640 行 `readDocument(id)` 都是可调用方法。

所以插件代码可以照抄 API 控制器那 10 行：

```js
const presets = ctx.get('agentPresets');           // 不可用时返回 undefined → 降级到 code
const { id } = await presets.resolve('watch-duty');
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: ctx.agentDefaultModel.currentSelection(), // 走部署默认模型，不硬编码
  meta: { cwd: dataDir, agentPreset: id },
  setup: async (agentCtx) => { await presets.mount(agentCtx, id); },
});
```

### 3. 当前 profile 里 registry 确实在

- `profiles/desktop/package.json` 的 bundles 含 `@deepseek-ai/dsh-web-app`；
- `@deepseek-ai/dsh-web-app/cordis.patch.yml:589-593` 挂载了 `agent-preset-registry`（`default: standard`）；
- 内置 preset 声明在 `dsh-web-app/presets/*.patch.yml`，形状就是普通 Cordis 行：

```yaml
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        plugins: [...]
```

## 代价与风险（必须写进决策）

| # | 代价 | 说明 |
|---|---|---|
| 1 | **要交付一个 preset 行** | `dsh-agent-preset-registry` README.zh.md:46-48：注册表不扫描目录、不接受路径；新增 preset 只能作为 bundle patch 插入一行 `@deepseek-ai/dsh-agent-preset`。dsh-neocortex 自己的 `cordis.patch.yml` 正好是这个入口，但装上后会在 preset 列表里多一个"喂养"预设 |
| 2 | **依赖宿主体内方法** | `agentPresets.resolve/mount` 有 JSDoc 但未出现在面向第三方插件的公开契约里；DSH 升级可能改签名。需要 P8 加一条"preset 装配"回归测试，不可用就自动降级 code |
| 3 | **preset 不是安全沙箱** | 注册表 README.zh.md:99 明确写着 preset 的 YAML 与插件可以执行 Host 代码。"只读工具面"是声明出来的，不是隔离出来的 |
| 4 | **成本** | `agent` 每轮是一条完整 DSH 会话（多步、多工具），token 与耗时都高于 `code` 的两问式 |
| 5 | **会话可见性** | `agents.create` 产生的 session 会进入会话列表；需要命名/过滤，否则用户会看到"自己没发起过的会话" |

## 对 P1 的落地要求

1. 三档开关保留 `off / code / agent`，但 `agent` 的 `capabilities.agentMode` 标 `planned`，P1 不实现装配；
2. 真正接 `agent` 时先做一个 spike：在 `dsh-neocortex/cordis.patch.yml` 插入 `watch-duty` preset 行 → 启动能在 `agentPresets.list()` 里看到 → 用上面的 10 行创建一条会话并收到一轮回复；
3. spike 不通过就砍 `agent`，只保留 `code`——**这不影响 P1 的开关与持久化**。

## 复现方式

读取 `app.asar` 内文件需要 Electron 以 Node 方式运行；工作区 `sandbox/` 下的
`asar-grep.cjs` / `asar-ls.cjs`（临时脚本，不随包发布）就是为此写的，命令形如：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\AI\DeepSeek\DeepSeek Harness.exe" "E:\AI-workspace\DSH sp\智脑项目区\sandbox\asar-grep.cjs" `
  "D:\AI\DeepSeek\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset-registry" "mount\(" ".js" 20
```
