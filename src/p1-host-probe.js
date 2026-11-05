import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.js';
import { NeocortexRuntime, appendProbe } from './runtime.js';
import { resolveConfig } from './defaults.js';

function userMessage(text) {
  return {
    id: `probe-${crypto.randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function runP1HostProbe(ctx, { dataDir, evidenceDir, fixtureBrainRoot }) {
  const runId = crypto.randomUUID();
  const prefix = `neocortex-p1-${runId}`;
  const ledgerFile = path.join(dataDir, `p1-host-${runId}.json`);
  const journalFile = path.join(dataDir, `p1-host-${runId}.jsonl`);
  fs.mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger(ledgerFile);
  const config = resolveConfig();
  const runtime = new NeocortexRuntime({ ledger, brainRoot: fixtureBrainRoot, config, probeFile: journalFile, ignoreSessionPrefix: '' });
  const offEvent = ctx.on('session/event', (session, event) => {
    if (session.id.startsWith(prefix)) runtime.observeEvent(session, event);
  });
  const offDisposed = ctx.on('session/disposed', (session) => {
    if (session.id.startsWith(prefix)) runtime.dispose(session);
  });
  const results = {};
  const runCase = async (id, action) => {
    try {
      const detail = await action();
      results[id] = { status: 'passed', detail };
    } catch (error) {
      results[id] = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  };
  const openSession = (label) => {
    const session = ctx.sessions.prepare(`${prefix}-${label}`);
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    return { session, detach };
  };

  await runCase('P1-01', async () => {
    const { session, detach } = openSession('dispose');
    session.append('turn/start', { turn: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await waitFor(() => ledger.state.turns[`${session.id}:turn:1`]?.status === 'completed', 'completed turn event');
    assert.equal(ledger.state.sessions[session.id], undefined, 'ordinary turn end must not dispose a session');
    detach();
    await waitFor(() => ledger.state.sessions[session.id]?.disposedEvents === 1, 'session disposal');
    detach();
    await delay(30);
    assert.equal(ledger.state.sessions[session.id]?.disposedEvents, 1);
    return { sessionId: session.id, disposedEvents: 1 };
  });

  await runCase('P1-02', async () => {
    const { session, detach } = openSession('endings');
    const reasons = ['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens', 'forked'];
    const entries = reasons.map((reason, index) => ({
      id: `ending-${runId}-${index}`,
      text: `ending ${reason}`,
      date: '2026-11-05',
      scene: null,
      sourcePath: 'fixture',
      status: 'active',
    }));
    ledger.registerMemories(entries);
    for (const [index, kind] of reasons.entries()) {
      const turn = index + 1;
      ledger.recordInjection({ sessionId: session.id, turn, memoryIds: [entries[index].id], scene: '通用', reason: 'probe', payload: kind });
      session.append('turn/start', { turn });
      session.append('turn/end', { turn, reason: { kind } });
      const expected = kind === 'completed' ? 'completed' : 'ignored';
      await waitFor(() => ledger.state.turns[`${session.id}:turn:${turn}`]?.status === expected, `${kind} settlement`);
      session.append('turn/end', { turn, reason: { kind } });
      await delay(20);
    }
    for (const [index, kind] of reasons.entries()) {
      const memory = ledger.state.memories[entries[index].id];
      assert.equal(memory.useCount, kind === 'completed' ? 1 : 0, `${kind} settlement mismatch`);
      assert.equal(ledger.state.turns[`${session.id}:turn:${index + 1}`].status, kind === 'completed' ? 'completed' : 'ignored');
    }
    detach();
    return { completedUses: 1, nonCompletedUses: 0, reasons };
  });

  await runCase('P1-03', async () => {
    const sessionId = `${prefix}-recovery`;
    ledger.registerMemories([
      { id: `recover-${runId}`, text: 'recover', date: '2026-11-05' },
      { id: `ignore-${runId}`, text: 'ignore', date: '2026-11-05' },
    ]);
    ledger.recordInjection({ sessionId, turn: 1, memoryIds: [`recover-${runId}`], scene: '通用', reason: 'probe', payload: 'recover' });
    ledger.recordInjection({ sessionId, turn: 2, memoryIds: [`ignore-${runId}`], scene: '通用', reason: 'probe', payload: 'ignore' });
    appendProbe(journalFile, { sessionId, event: 'turn/end', seq: 9001, data: { turn: 1, reason: { kind: 'completed' } } });
    appendProbe(journalFile, { sessionId, event: 'turn/end', seq: 9002, data: { turn: 2, reason: { kind: 'interrupted' } } });
    const restartedLedger = new Ledger(ledgerFile);
    const restarted = new NeocortexRuntime({ ledger: restartedLedger, brainRoot: fixtureBrainRoot, config, probeFile: journalFile });
    restarted.recoverFromJournal();
    restarted.recoverFromJournal();
    assert.equal(restartedLedger.state.memories[`recover-${runId}`].useCount, 1);
    assert.equal(restartedLedger.state.memories[`ignore-${runId}`].useCount, 0);
    return { recoveredCompleted: 1, interruptedUses: 0, duplicateRecovery: false };
  });

  await runCase('P1-04', async () => {
    const { session, detach } = openSession('compaction-success');
    const state = runtime.state(session.id);
    state.initialInjected = true;
    state.injectedScenes.add('通用');
    const compaction = session.append('compaction/end', { trigger: 'manual' });
    await waitFor(() => state.needsReinject, 'successful compaction event');
    const agent = { id: session.id };
    const first = runtime.prepareInjection(agent, [userMessage('继续当前工作')], 30);
    assert.equal(first.injected, true);
    assert.equal(first.payload.selected.length <= 10, true);
    assert.equal(first.payload.chars <= 800, true);
    runtime.observeEvent(session, compaction);
    const duplicate = runtime.prepareInjection(agent, [userMessage('继续当前工作')], 31);
    assert.equal(duplicate.injected, false);
    detach();
    return { observedSeq: compaction.seq, reason: 'compaction', duplicateInjected: false };
  });

  await runCase('P1-05', async () => {
    const { session, detach } = openSession('compaction-failure');
    const state = runtime.state(session.id);
    state.initialInjected = true;
    state.injectedScenes.add('通用');
    session.append('compaction/end', { trigger: 'manual', error: { message: 'fixture failure' } });
    await waitFor(() => state.failedCompactions === 1, 'failed compaction event');
    assert.equal(state.needsReinject, false);
    const result = runtime.prepareInjection({ id: session.id }, [userMessage('继续当前工作')], 40);
    assert.equal(result.injected, false);
    detach();
    return { failedCompactions: 1, successCompensation: false };
  });

  if (typeof offEvent === 'function') offEvent();
  if (typeof offDisposed === 'function') offDisposed();
  const evidence = {
    schemaVersion: 1,
    runId,
    runtime: 'real Cordis session store and post-commit event feed',
    ledgerFile,
    journalFile,
    results,
    passed: Object.values(results).every((result) => result.status === 'passed'),
  };
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'p1-host-probe.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return evidence;
}
