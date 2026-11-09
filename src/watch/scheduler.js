/**
 * P6 调度：每天在谷时窗口里随机挑一个时刻跑一轮；30% 概率开摆。
 *
 * 规则（已与用户确认）：
 * - 窗口：每天 19:00–22:00（本地时区），这段时间一定不是峰时；
 * - 每天最多一轮；30% 概率跳过（记录原因）；
 * - 电脑/DSH 不在线错过窗口 → 不补跑（默认）；
 * - 21:00 若队列有待判，记一条 judgment-due（P7 用它弹悬浮球）。
 *
 * 纯函数负责可复现的决策；WatchScheduler 负责定时器与持久化。
 */

import fs from 'node:fs';
import path from 'node:path';

export const RUN_WINDOW = Object.freeze({ startHour: 19, endHour: 22 });
export const SKIP_RATE = 0.3;
export const GRACE_MS = 10 * 60 * 1000;
export const JUDGMENT_HOUR = 21;

export function localDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function isPeakHour(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export function isValley(date) {
  return !isPeakHour(date);
}

export function schedulerFile(dataDir) {
  return path.join(dataDir, 'watch', 'scheduler.json');
}

export function loadSchedulerState(dataDir) {
  const file = schedulerFile(dataDir);
  if (!fs.existsSync(file)) return { file, plans: {}, lastRunDay: null, lastRunAt: null, lastResult: null, judgmentNotified: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, plans: parsed.plans || {}, lastRunDay: parsed.lastRunDay || null, lastRunAt: parsed.lastRunAt || null, lastResult: parsed.lastResult || null, judgmentNotified: parsed.judgmentNotified || {} };
  } catch {
    return { file, plans: {}, lastRunDay: null, lastRunAt: null, lastResult: null, judgmentNotified: {} };
  }
}

export function saveSchedulerState(dataDir, state) {
  const file = schedulerFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ plans: state.plans, lastRunDay: state.lastRunDay, lastRunAt: state.lastRunAt, lastResult: state.lastResult, judgmentNotified: state.judgmentNotified }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
}

/** Create today's plan once and keep it (reproducible). */
export function ensureDayPlan(state, day, random = Math.random) {
  if (state.plans[day]) return state.plans[day];
  const start = new Date(`${day}T00:00:00`);
  start.setHours(RUN_WINDOW.startHour, 0, 0, 0);
  const end = new Date(`${day}T00:00:00`);
  end.setHours(RUN_WINDOW.endHour, 0, 0, 0);
  const spanMinutes = Math.max(1, Math.floor((end.getTime() - start.getTime()) / 60000));
  const minute = Math.floor(random() * spanMinutes);
  const skip = random() < SKIP_RATE;
  const runAt = new Date(start.getTime() + minute * 60000);
  const plan = {
    day,
    runAt: runAt.toISOString(),
    skip,
    reason: skip ? 'skip-30%' : 'scheduled',
    createdAt: new Date().toISOString(),
  };
  state.plans[day] = plan;
  return plan;
}

export function planDue(plan, now, graceMs = GRACE_MS) {
  const at = new Date(plan.runAt).getTime();
  return now.getTime() >= at && now.getTime() <= at + graceMs;
}

export function planMissed(plan, now, graceMs = GRACE_MS) {
  return now.getTime() > new Date(plan.runAt).getTime() + graceMs;
}

export class WatchScheduler {
  constructor({ dataDir, watch, run, now = () => new Date(), random = Math.random, log = () => {}, pendingCount = () => 0 }) {
    this.dataDir = dataDir;
    this.watch = watch;
    this.run = run;
    this.now = now;
    this.random = random;
    this.log = log;
    this.pendingCount = pendingCount;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60 * 1000);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (!this.watch?.enabled?.()) return;
    if (this.running) return;
    const now = this.now();
    const day = localDay(now);
    const state = loadSchedulerState(this.dataDir);
    const plan = ensureDayPlan(state, day, this.random);
    saveSchedulerState(this.dataDir, state);

    // 21:00 判定提醒（队列有待判才记）
    if (now.getHours() >= JUDGMENT_HOUR && !state.judgmentNotified[day] && this.pendingCount() > 0) {
      state.judgmentNotified[day] = new Date().toISOString();
      state.lastResult = { kind: 'judgment-due', day, pending: this.pendingCount(), at: new Date().toISOString() };
      saveSchedulerState(this.dataDir, state);
      this.log(`21:00 判定提醒：${this.pendingCount()} 条待判`);
    }

    if (state.lastRunDay === day) return;
    if (plan.skip) {
      if (planDue(plan, now) || planMissed(plan, now)) {
        state.lastRunDay = day;
        state.lastResult = { kind: 'skipped', day, reason: plan.reason, at: new Date().toISOString() };
        saveSchedulerState(this.dataDir, state);
        this.log(`今天开摆（30%），不跑`);
      }
      return;
    }
    if (planMissed(plan, now)) {
      state.lastRunDay = day;
      state.lastResult = { kind: 'missed', day, runAt: plan.runAt, at: new Date().toISOString() };
      saveSchedulerState(this.dataDir, state);
      this.log(`错过 ${plan.runAt} 的窗口，按策略不补跑`);
      return;
    }
    if (!planDue(plan, now)) return;

    this.running = true;
    this.log(`到点，开始跑一轮（${plan.runAt}）`);
    Promise.resolve()
      .then(() => this.run({ reason: 'scheduled', plan, day }))
      .then((result) => {
        state.lastRunDay = day;
        state.lastRunAt = new Date().toISOString();
        state.lastResult = { kind: 'ran', day, ok: result?.ok !== false, summary: result?.summary || null, at: new Date().toISOString() };
        saveSchedulerState(this.dataDir, state);
      })
      .catch((error) => {
        state.lastRunDay = day;
        state.lastResult = { kind: 'error', day, error: String(error?.message || error).slice(0, 300), at: new Date().toISOString() };
        saveSchedulerState(this.dataDir, state);
        this.log(`自动跑失败：${String(error?.message || error)}`);
      })
      .finally(() => { this.running = false; });
  }
}
