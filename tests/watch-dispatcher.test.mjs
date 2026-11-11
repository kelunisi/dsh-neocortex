import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveWatchConfig, runWatchRound } from '../src/watch/runner.js';
import { recordUsage } from '../src/watch/budget.js';

test('AGENT-DISPATCH-01 code mode never invokes the agent runner', async () => {
  let agentCalled = false;
  const result = await runWatchRound({
    mode: 'code',
    config: { pythonPath: 'python', scanPerRound: 2 },
    watch: { config: { scanPerRound: 7 } },
    codeRunner: async ({ config }) => ({ ok: true, config }),
    agentRunner: async () => { agentCalled = true; },
  });
  assert.equal(agentCalled, false);
  assert.equal(result.config.pythonPath, 'python');
  assert.equal(result.config.scanPerRound, 7, 'runtime slider wins over static config');
});

test('AGENT-DISPATCH-02 agent success stays in agent mode', async () => {
  const result = await runWatchRound({
    mode: 'agent',
    agentRunner: async () => ({ ok: true, mode: 'agent', summary: { picked: 1 } }),
    codeRunner: async () => { throw new Error('must not fall back'); },
  });
  assert.equal(result.mode, 'agent');
  assert.equal(result.degraded, undefined);
});

test('AGENT-DISPATCH-03 agent failure falls back explicitly to code', async () => {
  const logs = [];
  const failure = new Error('transport unavailable');
  failure.code = 'TRANSPORT';
  const result = await runWatchRound({
    mode: 'agent',
    log: (line) => logs.push(line),
    agentRunner: async () => { throw failure; },
    codeRunner: async () => ({ ok: true, summary: { picked: 2 } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'code');
  assert.equal(result.requestedMode, 'agent');
  assert.deepEqual(result.degraded, { from: 'agent', reason: 'TRANSPORT', message: 'transport unavailable' });
  assert.match(logs.join('\n'), /显式降级 code/);
});

test('AGENT-DISPATCH-04 effective config tolerates an absent watch service', () => {
  assert.deepEqual(effectiveWatchConfig(undefined, { deepPerRound: 2 }), { deepPerRound: 2 });
});

test('AGENT-DISPATCH-05 commit failures and cancellation never trigger a second round', async () => {
  for (const code of ['WATCH_COMMIT_FAILED', 'AGENT_ABORTED', 'WATCH_DAILY_LIMIT']) {
    let codeCalled = false;
    const failure = new Error(code);
    failure.code = code;
    await assert.rejects(runWatchRound({
      mode: 'agent',
      agentRunner: async () => { throw failure; },
      codeRunner: async () => { codeCalled = true; },
    }), { code });
    assert.equal(codeCalled, false);
  }
});

test('AGENT-DISPATCH-06 an unsuccessful agent result is still a failure', async () => {
  const result = await runWatchRound({
    mode: 'agent',
    agentRunner: async () => ({ ok: false, reason: 'AGENT_INVALID_OUTPUT', message: 'bad JSON' }),
    codeRunner: async () => ({ ok: true }),
  });
  assert.equal(result.mode, 'code');
  assert.equal(result.degraded.reason, 'AGENT_INVALID_OUTPUT');
});

test('AGENT-DISPATCH-07 fallback rechecks budget after failed-agent usage', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-dispatch-budget-'));
  const now = new Date('2026-11-11T12:00:00+08:00');
  recordUsage(dataDir, 10, now);
  let codeCalled = false;
  await assert.rejects(runWatchRound({
    mode: 'agent',
    dataDir,
    now,
    config: { tokenBudgetPerDay: 20 },
    agentRunner: async () => {
      recordUsage(dataDir, 10, now);
      const error = new Error('bad output');
      error.code = 'AGENT_INVALID_OUTPUT';
      throw error;
    },
    codeRunner: async () => { codeCalled = true; },
  }), { code: 'WATCH_DAILY_LIMIT' });
  assert.equal(codeCalled, false);
});
