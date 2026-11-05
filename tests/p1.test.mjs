import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Ledger, LedgerCorruptionError } from '../src/ledger.js';
import { NeocortexRuntime, appendProbe } from '../src/runtime.js';
import { buildRecallPayload, readBrainSnapshot, routeRecallMiss } from '../src/recall.js';
import { resolveConfig, unicodeLength } from '../src/defaults.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'fixtures', 'brain');
const config = resolveConfig();
const report = [];
const now = () => new Date('2026-11-05T02:00:00.000Z');

function workspace(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `neocortex-${name}-`));
}

function runtimeAt(directory, brainRoot = fixture) {
  const ledger = new Ledger(path.join(directory, 'ledger.json'), { now });
  const runtime = new NeocortexRuntime({
    ledger,
    brainRoot,
    config,
    probeFile: path.join(directory, 'events.jsonl'),
    ignoreSessionPrefix: '',
  });
  return { ledger, runtime };
}

function message(text) {
  return { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function record(id, arrange, action) {
  return async (t) => {
    t.diagnostic(`Arrange: ${arrange}`);
    const detail = await action(t);
    report.push({ id, arrange, assert: detail, status: 'passed' });
  };
}

process.on('exit', () => {
  const file = path.join(root, 'evidence', 'p1-unit-report.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ phase: 'P1', status: report.length === 9 ? 'passed' : 'incomplete', summary: { passed: report.length, failed: 0 }, results: report }, null, 2) + '\n');
});

test('P1-01 ordinary turn does not dispose; disposal is counted once', record('P1-01', 'A live runtime and one session with a completed turn.', (t) => {
  const dir = workspace('dispose');
  const { ledger, runtime } = runtimeAt(dir);
  const session = { id: 'session-dispose' };
  runtime.observeEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(ledger.state.sessions[session.id], undefined);
  runtime.dispose(session);
  assert.equal(ledger.state.sessions[session.id].disposedEvents, 1);
  t.diagnostic('Act: commit turn/end, then dispose once; Assert: no disposal at turn end and exactly one at disposal.');
  return { turnEndDisposals: 0, sessionDisposals: 1 };
}));

test('P1-02 only completed turns settle used, at most once', record('P1-02', 'Seven used memories, one for every frozen turn ending.', () => {
  const dir = workspace('endings');
  const { ledger, runtime } = runtimeAt(dir);
  const session = { id: 'session-endings' };
  const reasons = ['completed', 'aborted', 'interrupted', 'error', 'blocked', 'max-tokens', 'forked'];
  const entries = reasons.map((kind, i) => ({ id: `memory-${kind}`, text: kind, date: '2026-11-05' }));
  ledger.registerMemories(entries);
  reasons.forEach((kind, i) => {
    ledger.recordInjection({ sessionId: session.id, turn: i + 1, memoryIds: [entries[i].id], scene: '通用', reason: 'test', payload: kind });
    runtime.observeEvent(session, { type: 'turn/end', seq: i * 2 + 1, data: { turn: i + 1, reason: { kind } } });
    runtime.observeEvent(session, { type: 'turn/end', seq: i * 2 + 2, data: { turn: i + 1, reason: { kind } } });
  });
  for (const kind of reasons) assert.equal(ledger.state.memories[`memory-${kind}`].useCount, kind === 'completed' ? 1 : 0);
  return { completed: 1, aborted: 0, interrupted: 0, error: 0, blocked: 0, maxTokens: 0, forked: 0 };
}));

test('P1-03 recovery completes only completed pending turns', record('P1-03', 'A persisted pending completed turn and a pending interrupted turn, with no live settlement.', () => {
  const dir = workspace('recovery');
  const { ledger, runtime } = runtimeAt(dir);
  ledger.registerMemories([{ id: 'done', text: 'done', date: '2026-11-05' }, { id: 'stop', text: 'stop', date: '2026-11-05' }]);
  ledger.recordInjection({ sessionId: 'recover', turn: 1, memoryIds: ['done'], scene: '通用', reason: 'test', payload: 'done' });
  ledger.recordInjection({ sessionId: 'recover', turn: 2, memoryIds: ['stop'], scene: '通用', reason: 'test', payload: 'stop' });
  appendProbe(runtime.probeFile, { sessionId: 'recover', event: 'turn/end', seq: 10, data: { turn: 1, reason: { kind: 'completed' } } });
  appendProbe(runtime.probeFile, { sessionId: 'recover', event: 'turn/end', seq: 11, data: { turn: 2, reason: { kind: 'interrupted' } } });
  const restarted = runtimeAt(dir);
  restarted.runtime.recoverFromJournal();
  restarted.runtime.recoverFromJournal();
  assert.equal(restarted.ledger.state.memories.done.useCount, 1);
  assert.equal(restarted.ledger.state.memories.stop.useCount, 0);
  return { completedAfterRestart: 1, interruptedAfterRestart: 0, idempotent: true };
}));

test('P1-04 successful compaction restores recall on the next admitted request only once', record('P1-04', 'An initialized session and a successful compaction/end event.', () => {
  const dir = workspace('compaction');
  const { runtime } = runtimeAt(dir);
  const agent = { id: 'compact-ok' };
  const state = runtime.state(agent.id);
  state.initialInjected = true;
  state.injectedScenes.add('通用');
  const event = { type: 'compaction/end', seq: 5, data: { trigger: 'manual' } };
  runtime.observeEvent(agent, event);
  const first = runtime.prepareInjection(agent, [message('继续')], 1);
  runtime.observeEvent(agent, event);
  const duplicate = runtime.prepareInjection(agent, [message('继续')], 2);
  assert.equal(first.injected, true);
  assert.equal(duplicate.injected, false);
  assert.equal(first.payload.chars <= 800, true);
  return { nextRequestInjected: true, duplicateNotificationInjected: false, chars: first.payload.chars };
}));

test('P1-05 failed compaction does not trigger successful compensation', record('P1-05', 'An initialized session and compaction/end carrying an error.', () => {
  const dir = workspace('compaction-error');
  const { runtime } = runtimeAt(dir);
  const agent = { id: 'compact-fail' };
  const state = runtime.state(agent.id);
  state.initialInjected = true;
  state.injectedScenes.add('通用');
  runtime.observeEvent(agent, { type: 'compaction/end', seq: 8, data: { error: { message: 'failed' } } });
  const result = runtime.prepareInjection(agent, [message('继续')], 1);
  assert.equal(result.injected, false);
  assert.equal(state.failedCompactions, 1);
  return { injected: false, failedCompactions: 1 };
}));

test('P1-06 first turn includes global indexes; unchanged scene is silent; scene switch is scoped', record('P1-06', 'The fixture brain has active Standardization and sleeping Travel scenes.', () => {
  const dir = workspace('scene');
  const { runtime } = runtimeAt(dir);
  const agent = { id: 'scene-agent' };
  const first = runtime.prepareInjection(agent, [message('你好')], 1);
  const same = runtime.prepareInjection(agent, [message('继续聊')], 2);
  const changed = runtime.prepareInjection(agent, [message('说说标准化工作')], 3);
  const unchangedAgain = runtime.prepareInjection(agent, [message('继续标准化')], 4);
  assert.match(first.payload.text, /个人模型总览/);
  assert.match(first.payload.text, /活跃\/沉睡场景索引/);
  assert.equal(same.injected, false);
  assert.equal(changed.injected, true);
  assert.doesNotMatch(changed.payload.text, /个人模型总览/);
  assert.match(changed.payload.text, /正在整理标准体系/);
  assert.equal(unchangedAgain.injected, false);
  return { first: true, sameScene: false, switchedScene: true, repeatSwitch: false };
}));

test('P1-07 recall respects item/Unicode budgets and exposes descending score explanations', record('P1-07', 'Twelve same-scene entries with distinct importance values.', () => {
  const dir = workspace('budget');
  const { ledger } = runtimeAt(dir);
  const snapshot = readBrainSnapshot(fixture);
  snapshot.memories = Array.from({ length: 12 }, (_, i) => ({
    id: `budget-${i}`,
    date: '2026-11-05',
    text: `条目${i} 标准化`,
    scene: '标准化',
    sourcePath: 'fixture',
    status: 'active',
    importance: 1 + i / 10,
  }));
  const result = buildRecallPayload({ snapshot, ledger, scene: '标准化', includeGlobal: true, maxItems: 10, maxChars: 800 });
  assert.equal(result.selected.length <= 10, true);
  assert.equal(unicodeLength(result.text) <= 800, true);
  assert.equal(result.explanations.length, result.selected.length);
  for (let i = 1; i < result.explanations.length; i++) assert.equal(result.explanations[i - 1].score >= result.explanations[i].score, true);
  assert.equal(result.selected[0].id, 'budget-11');
  return { items: result.selected.length, chars: unicodeLength(result.text), ranked: true };
}));

test('P1-08 miss routes external questions to search and personal history to general/sleeping pages', record('P1-08', 'One external query, one personal query with a sleeping hit, and one unknown personal query.', async () => {
  let externalCalls = 0;
  const external = await routeRecallMiss({ brainRoot: fixture, query: '今天的人工智能新闻', externalSearch: async () => { externalCalls += 1; return ['source']; } });
  const personal = await routeRecallMiss({ brainRoot: fixture, query: '我之前在海边住过吗' });
  const unknown = await routeRecallMiss({ brainRoot: fixture, query: '我小时候养过什么动物' });
  assert.equal(external.action, 'web_search');
  assert.equal(externalCalls, 1);
  assert.equal(personal.kind, 'personal');
  assert.match(personal.results[0].text, /海边/);
  assert.equal(unknown.kind, 'unknown');
  return { externalSearch: true, personalSleepingHit: true, unknownHonest: true };
}));

function markdownHashes(rootPath) {
  const result = {};
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.md')) result[path.relative(rootPath, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(rootPath);
  return result;
}

test('P1-09 Markdown remains byte-identical; ledger restarts and corruption fails closed', record('P1-09', 'A copied fixture brain, a reusable ledger, then a separately corrupted ledger.', () => {
  const dir = workspace('readonly');
  const brain = path.join(dir, 'brain');
  fs.cpSync(fixture, brain, { recursive: true });
  const before = markdownHashes(brain);
  const { runtime } = runtimeAt(dir, brain);
  runtime.prepareInjection({ id: 'readonly' }, [message('标准化')], 1);
  assert.deepEqual(markdownHashes(brain), before);
  const restarted = runtimeAt(dir, brain);
  assert.equal(Object.keys(restarted.ledger.state.turns).length, 1);
  const corruptFile = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptFile, '{broken');
  assert.throws(() => new Ledger(corruptFile), LedgerCorruptionError);
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{broken');
  assert.deepEqual(markdownHashes(brain), before);
  return { markdownUnchanged: true, restartTurns: 1, corruptPreserved: true };
}));
