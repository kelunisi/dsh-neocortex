# P6 验收记录：调度（每天自己醒）

> 日期：2026-11-09 · 默认策略：错过窗口不补跑

## 规则

| 项 | 规则 |
|---|---|
| 窗口 | 每天 **19:00–22:00**（本地时区），必为谷时 |
| 时刻 | 每天随机一个分钟，首次生成后写进 `scheduler.json`，当天不变（可复现） |
| 开摆 | 30% 概率跳过，记录 `skip-30%` |
| 宽限 | 到点后 10 分钟内仍可跑；超过就记 `missed`，**不补跑** |
| 每天次数 | 最多 1 轮 |
| 开关联动 | 切到 `off` 立即停定时器；切到 `code/agent` 才启动 |
| 21:00 判定 | 若队列有待判，记一条 `judgment-due`（P7 用它弹悬浮球） |
| 状态文件 | `<dataDir>/watch/scheduler.json`（plans / lastRunDay / lastResult） |

## 实现

- `src/watch/scheduler.js`：纯函数 `isPeakHour` / `ensureDayPlan` / `planDue` / `planMissed` + `WatchScheduler`（每分钟 tick）。
- `src/watch/index.js`：挂载时按开关启停调度器；`off` 时零定时器。
- 自动跑走 `runDryRound`（code 管线）；`agent` 档尚未装配，自动跑会日志提示并暂用 code。

## 验证

- 测试 S6-01–07：
  - 峰谷判定（工作日 10 点峰、13 点谷、周末谷）；
  - 每日计划可复现、30% 开摆；
  - 10 分钟宽限边界；
  - 到点只跑一次；
  - 跳过不跑、记录原因；
  - 错过窗口不补跑；
  - `off` 不产生 scheduler.json。
- 线上首次加载：`scheduler.json` 显示今日计划 20:37，23:18 检测为 `missed`，未补跑——符合“关机错过就跳过”。
- 全量测试 **99/99**。

## 未包含（下一步 P7）

- 预算闸还没有真正扣 token：`tokenBudgetPerDay=200万` 已配置，但使用量记账要等 P7 的 token 统计一起做。
- 21:00 只记状态，悬浮球/卡片 UI 在 P7。
- 自动跑目前是 code 模式；agent 档装配在 P4.5。
