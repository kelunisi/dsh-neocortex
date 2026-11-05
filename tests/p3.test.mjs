import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.js';
import { MemoryWriter } from '../src/writer.js';
import { LifecycleEngine, equivalentScenes } from '../src/lifecycle.js';
import { readAllMemoryEntries, readBrainSnapshot, searchPersonalHistory } from '../src/recall.js';
import { resolveConfig } from '../src/defaults.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'fixtures', 'brain');
const config = resolveConfig();
const report = [];
const GENERAL = '个人模型/近况/通用.md';
const SLEEPING = '个人模型/近况/沉睡条目.md';
const INDEX = '个人模型/近况/索引.md';

function setup(name, initial = '2026-11-05T00:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `neocortex-p3-${name}-`));
  const brainRoot = path.join(dir, 'brain');
  fs.cpSync(fixture, brainRoot, { recursive: true });
  const clock = { value: new Date(initial) };
  const now = () => clock.value;
  const ledger = new Ledger(path.join(dir, 'ledger.json'), { now });
  const writer = new MemoryWriter({ brainRoot, ledger, config, now });
  const lifecycle = new LifecycleEngine({ brainRoot, ledger, writer, config, now });
  return { brainRoot, ledger, writer, lifecycle, setNow: (value) => { clock.value = new Date(value); } };
}

function read(brainRoot, relative) {
  return fs.readFileSync(path.join(brainRoot, relative), 'utf8');
}

function prependGeneral(brainRoot, lines) {
  const file = path.join(brainRoot, GENERAL);
  const content = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, content.replace('## 条目\n\n', `## 条目\n\n${lines.join('\n')}\n`), 'utf8');
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
  fs.writeFileSync(path.join(root, 'evidence', 'p3-unit-report.json'), JSON.stringify({ phase: 'P3', status: report.length === 8 ? 'passed' : 'incomplete', summary: { passed: report.length, failed: 0 }, results: report }, null, 2) + '\n');
});

await record('P3-01', 'One active scene at exactly thirty days, then beyond thirty days.', () => {
  const env = setup('scene-sleep', '2026-12-05T00:00:00.000Z');
  assert.deepEqual(env.lifecycle.runSceneSleep(), []);
  assert.equal(fs.existsSync(path.join(env.brainRoot, '个人模型/近况/活跃/标准化.md')), true);
  env.setNow('2026-12-06T00:00:00.000Z');
  const activeEntry = readBrainSnapshot(env.brainRoot).memories.find((entry) => entry.scene === '标准化');
  env.lifecycle.recordHits([activeEntry.id], { at: new Date('2026-12-06T00:00:00.000Z') });
  assert.deepEqual(env.lifecycle.runSceneSleep(), []);
  env.setNow('2027-01-06T00:00:00.000Z');
  const moved = env.lifecycle.runSceneSleep();
  assert.deepEqual(moved.map((scene) => scene.name), ['标准化']);
  assert.equal(fs.existsSync(path.join(env.brainRoot, '个人模型/近况/活跃/标准化.md')), false);
  assert.equal(fs.existsSync(path.join(env.brainRoot, '个人模型/近况/沉睡场景/标准化.md')), true);
  const snapshot = readBrainSnapshot(env.brainRoot);
  assert.equal(snapshot.scenes.find((scene) => scene.name === '标准化').status, 'sleeping');
  assert.equal(env.ledger.state.lifecycle.scenes['标准化'].status, 'sleeping');
  return { exactlyThirtyStays: true, legitimateHitRefreshes: true, beyondThirtyAfterHitMoves: true, indexAndLedgerAgree: true };
});

await record('P3-02', 'Old general entries with and without a newer same-scene entry.', () => {
  const env = setup('general-sleep', '2026-11-16T00:00:00.000Z');
  prependGeneral(env.brainRoot, [
    '- [2026-11-01] 项目旧条目 {场景倾向:项目}',
    '- [2026-11-01] 其他旧条目 {场景倾向:其他}',
    '- [2026-11-01] 无场景旧条目',
  ]);
  assert.deepEqual(env.lifecycle.runGeneralSleep(), []);
  env.setNow('2026-11-20T00:00:00.000Z');
  prependGeneral(env.brainRoot, ['- [2026-11-19] 项目新条目 {场景倾向:项目}']);
  const moved = env.lifecycle.runGeneralSleep();
  const snapshot = readBrainSnapshot(env.brainRoot);
  assert.equal(snapshot.memories.some((entry) => entry.text === '项目旧条目 {场景倾向:项目}' && entry.sourcePath === GENERAL), true);
  assert.equal(snapshot.memories.some((entry) => entry.text === '其他旧条目 {场景倾向:其他}' && entry.sourcePath === SLEEPING), true);
  assert.equal(snapshot.memories.some((entry) => entry.text === '无场景旧条目' && entry.sourcePath === SLEEPING), true);
  assert.equal(moved.length, 3);
  return { exactThresholdStays: true, freshSameSceneProtects: true, oldOthersAndFixtureMove: 3 };
});

await record('P3-03', 'Three general entries for a near-synonym sleeping scene and three for a new scene.', () => {
  const env = setup('promotion');
  prependGeneral(env.brainRoot, [
    '- [2026-11-05] 旅行一 {场景倾向:旅行安排}',
    '- [2026-11-05] 旅行二 {场景倾向:旅行安排}',
    '- [2026-11-05] 旅行三 {场景倾向:旅行安排}',
    '- [2026-11-05] 运动一 {场景倾向:运动}',
    '- [2026-11-05] 运动二 {场景倾向:运动}',
    '- [2026-11-05] 运动三 {场景倾向:运动}',
  ]);
  assert.equal(equivalentScenes('旅行安排', '旅行'), true);
  const promoted = env.lifecycle.onSessionEnd('p3-promotion').promoted;
  assert.deepEqual(promoted.sort(), ['旅行', '运动']);
  const snapshot = readBrainSnapshot(env.brainRoot);
  const travel = snapshot.scenes.filter((scene) => equivalentScenes(scene.name, '旅行'));
  assert.equal(travel.length, 1);
  assert.equal(travel[0].status, 'active');
  const travelPage = read(env.brainRoot, '个人模型/近况/活跃/旅行.md');
  for (const text of ['旅行一', '旅行二', '旅行三', '曾去青岛旅行']) assert.match(travelPage, new RegExp(text));
  const sport = snapshot.scenes.find((scene) => scene.name === '运动');
  assert.equal(sport.status, 'active');
  assert.doesNotMatch(read(env.brainRoot, GENERAL), /旅行一|运动一/);
  return { nearSynonymRevived: true, duplicateSceneAvoided: true, newSceneCreated: true, generalMerged: true };
});

await record('P3-04', 'One hit on an unscoped item in 沉睡条目.md.', () => {
  const env = setup('item-wake');
  const before = readBrainSnapshot(env.brainRoot);
  const item = before.memories.find((entry) => entry.sourcePath === SLEEPING);
  const result = env.lifecycle.recordHits([item.id], { sessionId: 'p3-item' });
  assert.deepEqual(result.itemWakes, [item.id]);
  const after = readBrainSnapshot(env.brainRoot);
  const moved = after.memories.find((entry) => entry.id === item.id);
  assert.equal(moved.sourcePath, GENERAL);
  assert.equal(moved.status, 'active');
  assert.equal(moved.scene, null);
  assert.equal(result.revived.length, 0);
  assert.equal(Object.keys(env.ledger.state.lifecycle.revivalWindows).every((key) => env.ledger.state.lifecycle.revivalWindows[key].length === 0), true);
  return { movedToGeneral: true, sceneWindowUnaffected: true, scopedItemNotMisrouted: true };
});

await record('P3-05', 'Three hits on a sleeping scene where the first is outside the three-day window.', () => {
  const env = setup('below-threshold', '2026-11-01T00:00:00.000Z');
  const file = path.join(env.brainRoot, '个人模型/近况/沉睡场景/旅行.md');
  fs.writeFileSync(file, '# 旅行\n\n## 条目\n\n- [2026-11-01] 旅行一\n- [2026-11-01] 旅行二\n- [2026-11-01] 旅行三\n', 'utf8');
  const ids = readBrainSnapshot(env.brainRoot).memories.filter((entry) => entry.scene === '旅行').map((entry) => entry.id);
  env.lifecycle.recordHits([ids[0]], { at: new Date('2026-11-01T00:00:00.000Z') });
  env.lifecycle.recordHits([ids[1]], { at: new Date('2026-11-02T00:00:00.000Z') });
  const result = env.lifecycle.recordHits([ids[2]], { at: new Date('2026-11-05T00:00:00.000Z') });
  const snapshot = readBrainSnapshot(env.brainRoot);
  assert.equal(snapshot.scenes.find((scene) => scene.name === '旅行').status, 'sleeping');
  assert.equal(fs.existsSync(file), true);
  assert.equal(result.revived.length, 0);
  assert.equal(env.ledger.state.lifecycle.revivalWindows['旅行'].length, 2);
  assert.match(read(env.brainRoot, INDEX), /旅行 \| 2026-10-01 \| 2026-11-05 \| 2/);
  return { outsideWindowExcluded: true, belowThresholdStays: true, indexCount: 2, fileUnmoved: true };
});

await record('P3-06', 'Three distinct sleeping-scene hits within the revival window.', () => {
  const env = setup('scene-revival', '2026-11-01T00:00:00.000Z');
  const sleepingFile = path.join(env.brainRoot, '个人模型/近况/沉睡场景/旅行.md');
  fs.writeFileSync(sleepingFile, '# 旅行\n\n## 条目\n\n- [2026-11-01] 旅行一\n- [2026-11-01] 旅行二\n- [2026-11-01] 旅行三\n', 'utf8');
  const ids = readBrainSnapshot(env.brainRoot).memories.filter((entry) => entry.scene === '旅行').map((entry) => entry.id);
  env.lifecycle.recordHits([ids[0]], { at: new Date('2026-11-01T00:00:00.000Z') });
  env.lifecycle.recordHits([ids[1]], { at: new Date('2026-11-02T00:00:00.000Z') });
  const result = env.lifecycle.recordHits([ids[2]], { at: new Date('2026-11-03T00:00:00.000Z') });
  assert.deepEqual(result.revived, ['旅行']);
  const snapshot = readBrainSnapshot(env.brainRoot);
  const scene = snapshot.scenes.find((item) => item.name === '旅行');
  assert.equal(scene.status, 'active');
  assert.equal(fs.existsSync(sleepingFile), false);
  assert.equal(fs.existsSync(path.join(env.brainRoot, '个人模型/近况/活跃/旅行.md')), true);
  assert.equal(snapshot.memories.filter((entry) => entry.scene === '旅行' && entry.status === 'active').length, 3);
  assert.equal(env.ledger.state.lifecycle.revivalWindows['旅行'].length, 0);
  return { thresholdReached: true, wholePageActive: true, allThreeEntriesActive: true, windowReset: true };
});

await record('P3-07', 'A sleeping scene whose index row has not been hit for over one year.', () => {
  const env = setup('index-sink');
  const indexFile = path.join(env.brainRoot, INDEX);
  fs.writeFileSync(indexFile, read(env.brainRoot, INDEX).replace(/\| 旅行 \|[^\n]+\|/, '| 旅行 | 2025-01-02 | 2025-01-01 | 0 | [旅行](沉睡场景/旅行.md) |'), 'utf8');
  const sunk = env.lifecycle.sinkSleepingIndex();
  assert.deepEqual(sunk, ['旅行']);
  assert.doesNotMatch(read(env.brainRoot, INDEX), /\| 旅行 \|/);
  assert.equal(fs.existsSync(path.join(env.brainRoot, '个人模型/近况/沉睡场景/旅行.md')), true);
  assert.equal(env.ledger.state.lifecycle.scenes['旅行'].sunkAt.startsWith('2026-11-05'), true);
  const entry = readAllMemoryEntries(env.brainRoot).find((item) => item.sourcePath === '个人模型/近况/沉睡场景/旅行.md');
  assert.equal(searchPersonalHistory(env.brainRoot, '我曾经去青岛旅行').some((item) => item.id === entry.id), true);
  const hit = env.lifecycle.recordHits([entry.id], { at: new Date('2026-11-06T00:00:00.000Z') });
  assert.equal(hit.sceneHits[0].status, 'sleeping');
  assert.match(read(env.brainRoot, INDEX), /\| 旅行 \| 2025-01-02 \| 2026-11-06 \| 1 \|/);
  assert.equal(fs.existsSync(path.join(env.brainRoot, '个人模型/近况/沉睡场景/旅行.md')), true);
  assert.equal(readBrainSnapshot(env.brainRoot).scenes.filter((scene) => scene.name === '旅行').length, 1);
  return { rowSunk: true, pageRetainedAndSearchable: true, validHitRestoresIndex: true, noDuplicatePage: true };
});

await record('P3-08', 'A review combining scene sleep, general sleep, promotion, and recall reconciliation.', () => {
  const env = setup('reconcile', '2026-12-20T00:00:00.000Z');
  prependGeneral(env.brainRoot, [
    '- [2026-12-20] 阅读一 {场景倾向:阅读}',
    '- [2026-12-20] 阅读二 {场景倾向:阅读}',
    '- [2026-12-20] 阅读三 {场景倾向:阅读}',
    '- [2026-11-01] 待沉睡无场景',
  ]);
  const review = env.lifecycle.runReview({ sessionId: 'p3-review' });
  assert.deepEqual(review.scenes, ['标准化']);
  assert.deepEqual(review.promoted, ['阅读']);
  const snapshot = readBrainSnapshot(env.brainRoot);
  assert.equal(snapshot.scenes.find((scene) => scene.name === '标准化').status, 'sleeping');
  assert.equal(snapshot.scenes.find((scene) => scene.name === '阅读').status, 'active');
  assert.equal(snapshot.memories.some((entry) => entry.text === '待沉睡无场景' && entry.sourcePath === SLEEPING), true);
  const ids = snapshot.memories.map((entry) => entry.id);
  for (const id of ids) {
    const memory = env.ledger.state.memories[id];
    const actual = snapshot.memories.find((entry) => entry.id === id);
    assert.equal(memory.status, actual.status);
    assert.equal(memory.sourcePath, actual.sourcePath);
    assert.equal(memory.scene ?? null, actual.scene);
  }
  const diskIds = snapshot.memories.map((entry) => entry.id);
  assert.equal(new Set(diskIds).size, diskIds.length);
  const watched = [INDEX, ...new Set(snapshot.memories.map((entry) => entry.sourcePath))];
  const beforeRepeat = watched.map((relative) => [relative, read(env.brainRoot, relative)]);
  const repeated = env.lifecycle.runReview({ sessionId: 'p3-review' });
  assert.deepEqual(repeated, { sunk: [], scenes: [], general: [], promoted: [] });
  for (const [relative, content] of beforeRepeat) assert.equal(read(env.brainRoot, relative), content);
  return { reviewCompleted: true, recallMatchesDisk: true, ledgerMatchesMarkdown: true, noDuplicateIds: true, repeatRunNoop: true };
});
