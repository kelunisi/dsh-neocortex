import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hydrateItems } from '../src/watch/hydrate.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-hydrate-'));
}

function fakeClient(subtitle = '字幕：背景、做法、成效。') {
  return {
    async call(name) {
      if (name === 'bili_subtitle') return { subtitles: [{ text: subtitle }] };
      return {};
    },
    stop() {},
  };
}

test('H-01 hydrate fills points for a queue item without deep read', async () => {
  const dataDir = tempDir();
  const items = [{ bvid: 'BV1', title: '标准公文模板教程', up: 'UP', points: [] }];
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: '{"worth":true,"confidence":0.8,"reason":"模板可复用","points":["模板一","模板二"],"topics":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const result = await hydrateItems({
    ctx: {},
    dataDir,
    config: {},
    items,
    clientFactory: () => ({ client: fakeClient() }),
    llm: fakeLlm,
    route: { provider: 'p', model: 'm' },
  });
  assert.equal(result.hydrated, 1);
  assert.deepEqual(items[0].points, ['模板一', '模板二']);
  assert.equal(items[0].hydrated, true);
});

test('H-02 items that already have points are skipped', async () => {
  const dataDir = tempDir();
  const items = [{ bvid: 'BV2', title: '已有要点', points: ['p1'] }];
  const result = await hydrateItems({
    ctx: {},
    dataDir,
    config: {},
    items,
    clientFactory: () => ({ client: fakeClient() }),
    llm: { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; } },
    route: { provider: 'p', model: 'm' },
  });
  assert.equal(result.hydrated, 0);
  assert.equal(result.failed, 0);
});

test('H-03 no points in the model reply is reported, not invented', async () => {
  const dataDir = tempDir();
  const items = [{ bvid: 'BV3', title: '无要点视频', points: [] }];
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: '{"worth":false,"confidence":0.2,"reason":"没有可入库要点","points":[],"topics":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const result = await hydrateItems({
    ctx: {},
    dataDir,
    config: {},
    items,
    clientFactory: () => ({ client: fakeClient('') }),
    llm: fakeLlm,
    route: { provider: 'p', model: 'm' },
  });
  assert.equal(result.hydrated, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(items[0].points, []);
});
