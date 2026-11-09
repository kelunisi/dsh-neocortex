import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.js';
import { MemoryWriter } from '../src/writer.js';
import { resolveConfig } from '../src/defaults.js';
import { buildQueue, loadQueue, pendingItems, saveQueue } from '../src/watch/queue.js';
import { acceptItems, rejectItems, targetPathFor } from '../src/watch/ingest.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'fixtures', 'brain');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-watch-p4-'));
}

function workspace() {
  const dir = tempDir();
  const brain = path.join(dir, 'brain');
  fs.cpSync(fixture, brain, { recursive: true });
  const ledger = new Ledger(path.join(dir, 'ledger.json'));
  const writer = new MemoryWriter({ brainRoot: brain, ledger, config: resolveConfig() });
  return { dir, brain, writer };
}

function item(overrides = {}) {
  return {
    id: '2026-11-09-BVtest',
    bvid: 'BVtest',
    title: '测试视频：公文模板',
    url: 'https://www.bilibili.com/video/BVtest',
    points: ['要点一', '要点二'],
    status: 'pending',
    ...overrides,
  };
}

test('P4-01 queue builds from a round and merges by bvid', () => {
  const dataDir = tempDir();
  const picked = [
    { video: { bvid: 'BV1', title: 'A', author: 'UP', duration: '1:00' }, triage: { reason: '必含', score: 10 }, bucket: 'keyword' },
    { video: { bvid: 'BV2', title: 'B', author: 'UP', duration: '2:00' }, triage: { reason: '探索', score: 0 }, bucket: 'exploration' },
  ];
  const deepById = new Map([['BV1', { points: ['p1'], worth: true, confidence: 0.9, subtitleMissing: false }]]);
  const built = buildQueue({ dataDir, date: '2026-11-09', picked, deepById });
  assert.equal(built.items.length, 2);
  assert.equal(pendingItems(loadQueue(dataDir)).length, 2);
  const again = buildQueue({ dataDir, date: '2026-11-09', picked, deepById });
  assert.equal(again.items.length, 2, 'same bvid is merged, not duplicated');
});

test('P4-02 accept writes L2 source page and L3 recent entry', () => {
  const { dir, brain, writer } = workspace();
  const queue = { file: '', date: '2026-11-09', items: [item()] };
  const result = acceptItems({ writer, queue, dataDir: dir, sessionId: 'test' });
  assert.equal(result.accepted.length, 1);
  const target = path.join(brain, targetPathFor(item()));
  assert.equal(fs.existsSync(target), true);
  const page = fs.readFileSync(target, 'utf8');
  assert.match(page, /来源：https:\/\/www\.bilibili\.com\/video\/BVtest/);
  assert.match(page, /要点一/);
  const general = fs.readFileSync(path.join(brain, '个人模型/近况/通用.md'), 'utf8');
  assert.match(general, /测试视频：公文模板/);
  assert.equal(queue.items[0].status, 'accepted');
});

test('P4-03 reject has zero side effects', () => {
  const { dir, brain, writer } = workspace();
  const before = fs.readFileSync(path.join(brain, '个人模型/近况/通用.md'), 'utf8');
  const queue = { file: '', date: '2026-11-09', items: [item()] };
  const result = rejectItems({ queue, ids: [queue.items[0].id] });
  assert.equal(result.rejected.length, 1);
  assert.equal(queue.items[0].status, 'rejected');
  assert.equal(fs.readFileSync(path.join(brain, '个人模型/近况/通用.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(brain, targetPathFor(item()))), false);
});

test('P4-04 accepting the same source twice is a duplicate', () => {
  const { dir, brain, writer } = workspace();
  const queue = { file: '', date: '2026-11-09', items: [item()] };
  acceptItems({ writer, queue, dataDir: dir, sessionId: 'test' });
  queue.items[0].status = 'pending';
  const second = acceptItems({ writer, queue, dataDir: dir, sessionId: 'test' });
  assert.equal(second.duplicates.length, 1);
  const page = fs.readFileSync(path.join(brain, targetPathFor(item())), 'utf8');
  assert.equal((page.match(/来源：https:\/\/www\.bilibili\.com\/video\/BVtest/g) || []).length, 1);
});

test('P4-05 queue save/load round-trips and keeps decided status', () => {
  const dataDir = tempDir();
  const queue = { date: '2026-11-09', items: [item(), item({ id: '2026-11-09-BVtwo', bvid: 'BVtwo' })] };
  saveQueue(dataDir, queue);
  const loaded = loadQueue(dataDir);
  assert.equal(loaded.items.length, 2);
  loaded.items[0].status = 'accepted';
  saveQueue(dataDir, loaded);
  assert.equal(loadQueue(dataDir).items[0].status, 'accepted');
});
