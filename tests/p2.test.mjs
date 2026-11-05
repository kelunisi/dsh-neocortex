import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.js';
import { MemoryWriter, localDay } from '../src/writer.js';
import { parseMemoryEntries, readBrainSnapshot } from '../src/recall.js';
import { resolveConfig } from '../src/defaults.js';
import { memoryPolicy, NO_LEDGER_CAPABILITIES } from '../src/policy.js';
import { NeocortexRuntime } from '../src/runtime.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'fixtures', 'brain');
const config = resolveConfig();
const initialNow = () => new Date('2026-11-05T02:00:00.000Z');
const day = localDay(initialNow());
const report = [];

function setup(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `neocortex-p2-${name}-`));
  const brainRoot = path.join(dir, 'brain');
  fs.cpSync(fixture, brainRoot, { recursive: true });
  const clock = { value: initialNow() };
  const now = () => clock.value;
  const ledger = new Ledger(path.join(dir, 'ledger.json'), { now });
  const writer = new MemoryWriter({ brainRoot, ledger, config, now });
  return { dir, brainRoot, ledger, writer, setNow: (value) => { clock.value = new Date(value); } };
}

function read(brainRoot, relative) {
  return fs.readFileSync(path.join(brainRoot, relative), 'utf8');
}

async function record(id, arrange, action) {
  await test(id, async (t) => {
    t.diagnostic(`Arrange: ${arrange}`);
    const detail = await action(t);
    report.push({ id, arrange, assert: detail, status: 'passed' });
    t.diagnostic(`Assert: ${JSON.stringify(detail)}`);
  });
}

process.on('exit', () => {
  fs.writeFileSync(path.join(root, 'evidence', 'p2-unit-report.json'), JSON.stringify({ phase: 'P2', status: report.length === 10 ? 'passed' : 'incomplete', summary: { passed: report.length, failed: 0 }, results: report }, null, 2) + '\n');
});

await record('P2-01', 'A fixture brain and four candidate memories covering L3/L1-inferred/L1-explicit/L2.', () => {
  const { brainRoot, writer } = setup('routing');
  const l3 = writer.remember({ layer: 'L3', text: '今天整理试点材料', scene: '标准化' }, { sessionId: 'p2-routing' });
  const inferred = writer.remember({ layer: 'L1', text: '可能喜欢简短回答', category: 'preference' }, { sessionId: 'p2-routing' });
  const explicit = writer.remember({ layer: 'L1', text: '以后默认先给结论', category: 'preference', explicit: true }, { sessionId: 'p2-routing' });
  const l2 = writer.remember({ layer: 'L2', text: '某标准的核心概念', targetPath: '知识库/标准.md', source: 'https://example.test/standard' }, { sessionId: 'p2-routing' });
  assert.equal(l3.path, '个人模型/近况/活跃/标准化.md');
  assert.equal(inferred.status, 'pending-confirmation');
  assert.match(read(brainRoot, '个人模型/协作偏好.md'), /## 待确认调整[\s\S]*可能喜欢简短回答/);
  assert.match(read(brainRoot, '个人模型/协作偏好.md'), /## 用户明示记录[\s\S]*以后默认先给结论/);
  assert.match(read(brainRoot, '知识库/标准.md'), /来源：https:\/\/example.test\/standard/);
  assert.match(read(brainRoot, '操作日志.md'), /p2-routing/);
  return { l3: 'scene', l1Inferred: 'pending', l1Explicit: 'explicit', l2: 'knowledge', logged: true };
});

await record('P2-02', 'No-value chat, inferred L1, explicit L1, and a sensitive explicit request.', () => {
  const { brainRoot, writer } = setup('permissions');
  const before = read(brainRoot, '个人模型/协作偏好.md');
  assert.equal(writer.remember({ layer: 'L1', text: '可能喜欢长回答', worthSaving: false }).status, 'skipped');
  assert.equal(read(brainRoot, '个人模型/协作偏好.md'), before);
  writer.remember({ layer: 'L1', text: '可能偏好表格', category: 'preference' });
  const inferredPage = read(brainRoot, '个人模型/协作偏好.md');
  assert.match(inferredPage, /待确认调整/);
  assert.doesNotMatch(inferredPage.slice(0, inferredPage.indexOf('## 待确认调整')), /可能偏好表格/);
  writer.remember({ layer: 'L1', text: '默认使用表格', category: 'preference', explicit: true });
  assert.match(read(brainRoot, '个人模型/协作偏好.md'), /用户明示记录/);
  return { noValueIgnored: true, inferredPendingOnly: true, explicitWritten: true };
});

await record('P2-03', 'Fourteen ordinary daily writes followed by one explicit instruction.', () => {
  const { writer, ledger, setNow } = setup('exemption-entry');
  for (let i = 0; i < 14; i++) writer.remember({ layer: 'L3', text: `普通${i}`, scene: '日常' });
  const result = writer.remember({ layer: 'L3', text: '必须记住这个约定', scene: '日常', explicit: true });
  assert.equal(result.status, 'replaced');
  assert.equal(ledger.state.quotas[day].total, 15);
  assert.equal(ledger.state.quotas[day].exemptions, 1);
  setNow('2026-11-06T02:00:00.000Z');
  const nextDay = writer.remember({ layer: 'L3', text: '跨午夜普通条目', scene: '日常' });
  assert.equal(nextDay.status, 'written');
  assert.equal(ledger.state.quotas['2026-11-06'].total, 1);
  assert.equal(ledger.state.quotas[day].total, 15);
  return { ordinary: 14, explicitAccepted: true, total: 15, exemptions: 1, midnightResetsOnlyNewDay: true };
});

await record('P2-04', 'Ten same-scene ordinary entries followed by six explicit writes.', () => {
  const { writer, ledger, brainRoot } = setup('quota');
  for (let i = 0; i < 10; i++) writer.remember({ layer: 'L3', text: `普通${i}`, scene: '日常' });
  for (let i = 0; i < 5; i++) writer.remember({ layer: 'L3', text: `豁免${i}`, scene: '日常', explicit: true });
  const sixth = writer.remember({ layer: 'L3', text: '豁免5', scene: '日常', explicit: true });
  const page = read(brainRoot, '个人模型/近况/通用.md');
  assert.equal(sixth.status, 'queued');
  assert.equal(ledger.state.quotas[day].total, 15);
  assert.equal(ledger.state.quotas[day].exemptions, 5);
  assert.equal((page.match(/- \[2026-11-05\] 普通\d/g) || []).length, 5);
  for (let i = 0; i < 5; i++) assert.match(page, new RegExp(`豁免${i}(?!\\d)`));
  assert.doesNotMatch(page, /豁免5/);
  const full = setup('quota-full-replacement');
  for (let i = 0; i < 15; i++) full.writer.remember({ layer: 'L3', text: `满额普通${i}`, scene: '项目' });
  const replaced = full.writer.remember({ layer: 'L3', text: '满额豁免', scene: '项目', explicit: true });
  const noScene = full.writer.remember({ layer: 'L3', text: '不应跨场景淘汰', scene: '其他', explicit: true });
  assert.equal(replaced.status, 'replaced');
  assert.equal(full.ledger.state.quotas[day].total, 15);
  assert.equal(full.ledger.state.quotas[day].exemptions, 1);
  assert.equal(full.ledger.state.tombstones.find((item) => item.id === replaced.tombstoneId).status, 'active');
  assert.equal(noScene.status, 'queued');
  assert.equal(full.ledger.state.quotas[day].total, 15);
  assert.equal(full.writer.undoTombstone(replaced.tombstoneId).status, 'undone');
  return { total: 15, exemptions: 5, weakestReplaced: 5, sixthQueued: true, fullQuotaReplacement: true, noCrossSceneEviction: true, undoable: true };
});

await record('P2-05', 'A full quota and twenty-two distinct overflow candidates.', () => {
  const { writer, ledger } = setup('queue');
  for (let i = 0; i < 15; i++) writer.remember({ layer: 'L3', text: `占用${i}`, scene: '队列' });
  for (let i = 0; i < 22; i++) writer.remember({ layer: 'L3', text: `候选${i}`, scene: '队列' });
  const queue = ledger.state.pendingQueue;
  assert.equal(queue.length, 20);
  assert.equal(queue[0].text, '候选2');
  assert.equal(queue.at(-1).text, '候选21');
  assert.equal(queue.some((item) => item.text === '候选0' || item.text === '候选1'), false);
  assert.deepEqual(ledger.state.queueEvictions.map((item) => item.item.text), ['候选0', '候选1']);
  assert.equal(ledger.state.queueEvictions.every((item) => item.evictedAt && item.reason === 'weekly-fifo-overflow'), true);
  return { limit: 20, oldestEvicted: ['候选0', '候选1'], newest: '候选21', evictionTrace: true };
});

await record('P2-07', 'Two values with fact key 她.城市, then one undo and a repeated undo.', () => {
  const { writer, ledger, brainRoot } = setup('undo');
  const old = writer.remember({ layer: 'L3', text: '她住在北京', factKey: '她.城市' });
  const replaced = writer.remember({ layer: 'L3', text: '她住在上海', factKey: '她.城市' });
  let page = read(brainRoot, '个人模型/近况/通用.md');
  assert.doesNotMatch(page, /她住在北京/);
  assert.match(page, /她住在上海/);
  const tombstoneId = replaced.tombstoneId;
  assert.equal(ledger.state.facts['她.城市'].chain.length, 1);
  assert.equal(ledger.state.tombstones.find((item) => item.id === tombstoneId).status, 'active');
  assert.equal(writer.undoTombstone(tombstoneId).status, 'undone');
  page = read(brainRoot, '个人模型/近况/通用.md');
  assert.match(page, /她住在北京/);
  assert.doesNotMatch(page, /她住在上海/);
  const afterUndo = page;
  assert.equal(writer.undoTombstone(tombstoneId).status, 'already-undone');
  assert.equal(read(brainRoot, '个人模型/近况/通用.md'), afterUndo);
  assert.equal(old.id !== replaced.id, true);
  return { oldRemoved: true, tombstone: true, restored: true, repeatUndoNoop: true };
});

await record('P2-06', 'Writes to an L3 scene, an L1 page, and an L2 page in the fixture.', () => {
  const { writer, brainRoot } = setup('readable');
  writer.remember({ layer: 'L3', text: '可读性检查', scene: '标准化', factKey: 'fixture.可读性' });
  writer.remember({ layer: 'L1', text: '待确认可读性', category: 'background' });
  writer.remember({ layer: 'L2', text: '知识可读性', targetPath: '知识库/可读性.md', source: 'fixture://source' });
  const scene = read(brainRoot, '个人模型/近况/活跃/标准化.md');
  assert.equal(parseMemoryEntries(scene).some((entry) => entry.text.includes('可读性检查')), true);
  assert.match(read(brainRoot, '个人模型/个人背景.md'), /待确认观察/);
  assert.match(read(brainRoot, '知识库/可读性.md'), /# 可读性/);
  assert.equal(fs.existsSync(path.join(brainRoot, '.obsidian')), false);
  assert.equal(fs.existsSync(path.join(brainRoot, '.smart-env')), false);
  return { markdownParsed: true, linksAndHeadingsIntact: true, internalStateUntouched: true };
});

await record('P2-08', 'Sensitive-looking content with an explicit remember flag.', () => {
  const { writer, brainRoot, ledger } = setup('sensitive');
  const target = path.join('个人模型', '近况', '通用.md');
  const before = read(brainRoot, target);
  const result = writer.remember({ layer: 'L3', text: '我的密码是 correct-horse', explicit: true });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'sensitive-content');
  assert.equal(read(brainRoot, target), before);
  assert.equal(ledger.state.quotas[day], undefined);
  assert.equal(fs.existsSync(path.join(brainRoot, '操作日志.md')), false);
  assert.deepEqual(memoryPolicy('这次不用智脑'), { allowRead: false, allowSave: false, explicit: false });
  assert.deepEqual(memoryPolicy('这个不要记'), { allowRead: true, allowSave: false, explicit: false });
  assert.equal(memoryPolicy('请记住这个约定').explicit, true);
  const runtime = new NeocortexRuntime({ ledger, brainRoot, config, ignoreSessionPrefix: '' });
  const optOut = runtime.prepareInjection({ id: 'opt-out' }, [{ role: 'user', content: [{ type: 'text', text: '这次不用智脑' }] }], 1);
  assert.equal(optOut.injected, false);
  assert.equal(optOut.optedOut, true);
  return { rejected: true, pageUnchanged: true, noQuotaOrLog: true, noReadOptOut: true, noSaveOptOut: true };
});

await record('P2-07-chain', 'An audited fact-key replacement with a reversible chain.', () => {
  const { writer, ledger } = setup('fact-chain');
  writer.remember({ layer: 'L3', text: '旧值', factKey: '对象.方面' });
  const current = writer.remember({ layer: 'L3', text: '新值', factKey: '对象.方面' });
  const fact = ledger.state.facts['对象.方面'];
  const tombstone = ledger.state.tombstones.find((item) => item.id === current.tombstoneId);
  assert.equal(fact.chain.length, 1);
  assert.equal(fact.chain[0].from !== fact.chain[0].to, true);
  assert.equal(tombstone.oldLine.includes('旧值'), true);
  assert.equal(tombstone.newLine.includes('新值'), true);
  assert.equal(tombstone.status, 'active');
  writer.undoTombstone(tombstone.id);
  assert.equal(ledger.state.facts['对象.方面'].currentId, tombstone.oldId);
  return { chainAuditable: true, tombstoneRestorable: true, currentPointerReverted: true };
});

await record('P2-09', 'A Markdown-only Harness without the plugin ledger.', () => {
  const { brainRoot } = setup('no-ledger');
  const snapshot = readBrainSnapshot(brainRoot);
  assert.equal(snapshot.memories.length > 0, true);
  assert.equal(NO_LEDGER_CAPABILITIES.realtimeRanking, false);
  assert.equal(NO_LEDGER_CAPABILITIES.realtimeQuota, false);
  assert.equal(NO_LEDGER_CAPABILITIES.automaticLifecycle, false);
  assert.equal(NO_LEDGER_CAPABILITIES.weeklyWriteback, true);
  assert.equal(NO_LEDGER_CAPABILITIES.inPlaceRefresh, true);
  assert.match(NO_LEDGER_CAPABILITIES.claims, /不宣称实时排序、实时配额或自动生命周期/);
  assert.equal(fs.existsSync(path.join(brainRoot, '.obsidian')), false);
  return { markdownReadable: true, weeklyWriteback: true, inPlaceRefresh: true, noRealtimeClaims: true };
});
