import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchScheduler, ensureDayPlan, isPeakHour, isValley, loadSchedulerState, planDue, planMissed } from '../src/watch/scheduler.js';
import { WatchService } from '../src/watch/service.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-scheduler-'));
}

function fakeWatch(enabled = true) {
  return { enabled: () => enabled, mode: 'code' };
}

test('S6-01 peak/valley classification follows the pricing calendar', () => {
  assert.equal(isPeakHour(new Date('2026-11-10T10:00:00+08:00')), true, 'weekday 10:00 is peak');
  assert.equal(isPeakHour(new Date('2026-11-10T13:00:00+08:00')), false, 'weekday 13:00 is valley');
  assert.equal(isPeakHour(new Date('2026-11-14T10:00:00+08:00')), false, 'weekend is valley');
  assert.equal(isValley(new Date('2026-11-10T20:00:00+08:00')), true);
});

test('S6-02 day plan is stable and 30% skip is reproducible', () => {
  const state = { plans: {} };
  const plan = ensureDayPlan(state, '2026-11-10', (() => { const seq = [0.5, 0.1]; return () => seq.shift(); })());
  assert.equal(plan.skip, true);
  assert.equal(state.plans['2026-11-10'], plan);
  const again = ensureDayPlan(state, '2026-11-10', () => 0.99);
  assert.equal(again, plan, 'existing plan is reused');
});

test('S6-03 due/missed boundaries use the 10 minute grace window', () => {
  const plan = { runAt: '2026-11-10T20:00:00+08:00' };
  assert.equal(planDue(plan, new Date('2026-11-10T19:59:00+08:00')), false);
  assert.equal(planDue(plan, new Date('2026-11-10T20:05:00+08:00')), true);
  assert.equal(planMissed(plan, new Date('2026-11-10T20:11:00+08:00')), true);
});

test('S6-04 scheduler runs once at the planned minute', async () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, initialMode: 'code' });
  const state = { plans: {} };
  const plan = ensureDayPlan(state, '2026-11-10', (() => { const seq = [0.5, 0.9]; return () => seq.shift(); })());
  let runs = 0;
  const scheduler = new WatchScheduler({
    dataDir,
    watch,
    now: () => new Date(plan.runAt),
    random: (() => { const seq = [0.5, 0.9]; return () => seq.shift() ?? 0.9; })(),
    pendingCount: () => 0,
    run: async () => { runs += 1; return { ok: true }; },
  });
  scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  const saved = loadSchedulerState(dataDir);
  assert.equal(saved.lastRunDay, '2026-11-10');
  scheduler.stop();
});

test('S6-05 skipped day never runs and records the reason', () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, initialMode: 'code' });
  let runs = 0;
  const scheduler = new WatchScheduler({
    dataDir,
    watch,
    now: () => new Date('2026-11-10T20:30:00+08:00'),
    random: (() => { const seq = [0.5, 0.05]; return () => seq.shift() || 0.99; })(),
    pendingCount: () => 0,
    run: async () => { runs += 1; },
  });
  // First tick creates the plan with skip=true; second tick sees the due window.
  scheduler.tick();
  scheduler.tick();
  assert.equal(runs, 0);
  const saved = loadSchedulerState(dataDir);
  assert.equal(saved.lastResult.kind, 'skipped');
  scheduler.stop();
});

test('S6-06 missed window does not catch up', () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, initialMode: 'code' });
  let runs = 0;
  const scheduler = new WatchScheduler({
    dataDir,
    watch,
    now: () => new Date('2026-11-10T21:30:00+08:00'),
    random: (() => { const seq = [0.1, 0.9]; return () => seq.shift() || 0.99; })(),
    pendingCount: () => 0,
    run: async () => { runs += 1; },
  });
  scheduler.tick();
  scheduler.tick();
  assert.equal(runs, 0);
  const saved = loadSchedulerState(dataDir);
  assert.equal(saved.lastResult.kind, 'missed');
  scheduler.stop();
});

test('S6-07 mode off means no scheduler work at all', () => {
  const dataDir = tempDir();
  const watch = { enabled: () => false, mode: 'off' };
  let runs = 0;
  const scheduler = new WatchScheduler({
    dataDir,
    watch,
    now: () => new Date('2026-11-10T20:30:00+08:00'),
    pendingCount: () => 0,
    run: async () => { runs += 1; },
  });
  scheduler.tick();
  assert.equal(runs, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'watch', 'scheduler.json')), false);
});
