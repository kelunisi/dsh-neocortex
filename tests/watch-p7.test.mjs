import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchService } from '../src/watch/service.js';
import { loadBudget, recordUsage, remainingBudget } from '../src/watch/budget.js';
import { WatchScheduler } from '../src/watch/scheduler.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-p7-'));
}

test('P7-01 watch config clamps and persists', () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, initialMode: 'off' });
  const result = watch.setConfig({ scanPerRound: 99, deepPerRound: 0, tokenBudgetPerDay: 1 });
  assert.equal(result.status, 'updated');
  assert.equal(result.config.scanPerRound, 10);
  assert.equal(result.config.deepPerRound, 1);
  assert.equal(result.config.tokenBudgetPerDay, 100000);
  const restarted = new WatchService({ dataDir, initialMode: 'off' });
  assert.equal(restarted.config.scanPerRound, 10);
  assert.equal(restarted.config.tokenBudgetPerDay, 100000);
  assert.equal(restarted.mode, 'off', 'config change must not flip the switch');
});

test('P7-02 token budget records and resets on a new day', () => {
  const dataDir = tempDir();
  const day1 = new Date('2026-11-09T12:00:00+08:00');
  recordUsage(dataDir, 100, day1);
  recordUsage(dataDir, 50, day1);
  assert.equal(loadBudget(dataDir, day1).used, 150);
  assert.equal(remainingBudget(dataDir, 200, day1), 50);
  const day2 = new Date('2026-11-10T01:00:00+08:00');
  assert.equal(loadBudget(dataDir, day2).used, 0, 'a new local day starts from zero');
  assert.equal(remainingBudget(dataDir, 200, day2), 200);
});

test('P7-03 scheduler stops when the daily token budget is exhausted', () => {
  const dataDir = tempDir();
  const watch = { enabled: () => true, mode: 'code' };
  let runs = 0;
  const scheduler = new WatchScheduler({
    dataDir,
    watch,
    now: () => new Date('2026-11-10T20:30:00+08:00'),
    random: (() => { const seq = [0.5, 0.9]; return () => seq.shift() ?? 0.99; })(),
    pendingCount: () => 0,
    budgetRemaining: () => 0,
    run: async () => { runs += 1; },
  });
  scheduler.tick();
  scheduler.tick();
  assert.equal(runs, 0);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'watch', 'scheduler.json'), 'utf8'));
  assert.equal(state.lastResult.kind, 'budget-stop');
  scheduler.stop();
});
