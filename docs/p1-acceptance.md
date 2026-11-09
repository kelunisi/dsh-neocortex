# P1 验收记录：喂养模块骨架

> 日期：2026-11-09 · 对应 `智脑插件-v0.5-喂养模块.md` §7 的 P1

## 交付物

| 文件 | 作用 |
|---|---|
| `src/watch/defaults.js` | 三档模式、默认预算、上下限；`normalizeWatchConfig()` 容错归一 |
| `src/watch/service.js` | `WatchService`：读/写 `<dataDir>/watch.json`，原子写、损坏容错、`state()` 面板投影 |
| `src/watch/index.js` | `mountWatch()`：注册模块与释放钩子；P1 不启动任何定时器 |
| `src/remote-service.js` | `state()` 合并 `watch`；新增 `updateWatch` Remote 方法 |
| `client.js` | 设置页新增「喂养」页签：三档按钮 + 状态文件路径 + 空队列占位 |
| `index.js` | 装配 `mountWatch`；`off` 时零行为 |
| `cordis.patch.yml` | `watch.mode` 默认 `off`（只做首次种子，之后以 `watch.json` 为准） |
| `tests/watch.test.mjs` | WATCH-01–09 |

## 自动验收

```text
node --test tests/*.test.mjs   → 53/53 通过（含 WATCH-01–09）
node scripts/check.mjs         → Syntax checked: 18 JavaScript files
```

关键性质：

1. 全新 dataDir 构造模块**不创建** `watch.json`（WATCH-01/07）；
2. `setMode()` 原子写、不留临时文件，重启读回（WATCH-02）；
3. 非法模式抛错且内存/文件都不变（WATCH-03）；
4. `watch.json` 损坏时回退 `off`、报告 `corrupt-file-ignored`、**不重写原文件**（WATCH-04）；
5. 持久化开关优先于 cordis 种子（WATCH-05）；
6. 预算越界自动钳制（WATCH-06）；
7. 面板 state 可无损 JSON 往返（WATCH-08）。

展示手册同步更新并实测：8 章、16 张能力卡、10 个阶段（2 个已完成）、4 个闸块、无横向溢出。

## 安装验收（本机）

- 打包：`dsh-neocortex-0.5.0-dev.0.tgz`（`*.tgz` 已被 `.gitignore` 忽略）
- 装入：desktop profile 依赖改为 `file:E:/AI-workspace/DSH sp/智脑项目区/dsh-neocortex/dsh-neocortex-0.5.0-dev.0.tgz`
- 重启后：插件加载正常，`neocortex_panel` 三工具与周回顾定时器均正常；安装版本 `0.5.0-dev.0`
- 运行期数据目录仍为 `E:\AI-workspace\DSH sp\dsh-neocortex\.data`（profile patch 中显式配置，未迁移）
  → 开关状态文件落在 `E:\AI-workspace\DSH sp\dsh-neocortex\.data\watch.json`

## 手工验收（30 秒）

**2026-11-09 20:30 用户确认：设置 → 插件 → 智脑 → 「喂养」页签可见，P1 验收通过。**

1. 打开 **设置 → 插件 → 智脑 → 喂养**；
2. 点 `代码模式`，页面提示"喂养开关已保存"；
3. 打开 `E:\AI-workspace\DSH sp\dsh-neocortex\.data\watch.json`，应看到 `"mode": "code"` 与 `schema: 1`；
4. 点回 `关闭`，文件同步变回 `"mode": "off"`；
5. 刷新或重启后页签显示的仍是最后保存的模式。

## 边界（P1 明确不做）

- 没有任何抓取、定时器、网络请求、评论/私信、隐私扫描；
- `agent` 档只占位（`capabilities.agentMode: "planned"`），装配方案见 `docs/p0-agent-mode.md`；
- 其余预算（扫 5 / 深读 3 / @ 3 / 私信 2 / token 200 万）只写入默认值，面板滑块要到 P7。
