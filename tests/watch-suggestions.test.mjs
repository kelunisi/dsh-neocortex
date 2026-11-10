import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSuggestions, removeSuggestion, resolveUpMid } from '../src/watch/suggestions.js';

const criteria = { must: ['显卡', '金价', '信息报送'], plus: [], exclude: [], directions: [] };

function item(overrides) {
  return { status: 'accepted', mid: 0, up: '', title: '', reason: '', bvid: 'BV1', ...overrides };
}

test('S7-01 groups by UP, counts hits and excludes already followed', () => {
  const queue = {
    items: [
      item({ mid: 1, up: 'A', title: '显卡价格日报', bvid: 'BV1' }),
      item({ mid: 1, up: 'A', title: '显卡又降价', bvid: 'BV2' }),
      item({ mid: 2, up: 'B', title: '金价走势', bvid: 'BV3' }),
      item({ mid: 3, up: 'C', title: '信息报送模板', bvid: 'BV4' }),
      item({ mid: 4, up: 'D', title: '做饭教程', bvid: 'BV5' }),
    ],
  };
  const suggestions = buildSuggestions({
    queue,
    followings: [{ mid: 2, uname: 'B' }],
    criteria,
    limit: 5,
  });
  assert.deepEqual(suggestions.map((entry) => entry.up), ['A', 'C']);
  assert.equal(suggestions[0].count, 2);
  assert.equal(suggestions[0].examples.length, 2);
  assert.equal(suggestions.some((entry) => entry.up === 'B'), false, 'followed UP is excluded');
  assert.equal(suggestions.some((entry) => entry.up === 'D'), false, 'unrelated UP is filtered');
});

test('S7-02 followed name without mid is still excluded', () => {
  const queue = { items: [item({ mid: 0, up: '老陈聊黄金', title: '金价走势' })] };
  const suggestions = buildSuggestions({ queue, followings: [{ mid: 0, uname: '老陈聊黄金' }], criteria });
  assert.equal(suggestions.length, 0);
});

test('S7-03 limit is respected', () => {
  const queue = {
    items: [
      item({ mid: 1, up: 'A', title: '显卡' }),
      item({ mid: 2, up: 'B', title: '金价' }),
      item({ mid: 3, up: 'C', title: '信息报送' }),
    ],
  };
  assert.equal(buildSuggestions({ queue, followings: [], criteria, limit: 2 }).length, 2);
});

test('S7-04 resolve a missing UP UID through a title search', async () => {
  const mid = await resolveUpMid({
    uname: '惊叹号diy电脑',
    title: 'A卡降价',
    dataDir: os.tmpdir(),
    config: {},
    vendorDir: 'unused',
    clientFactory: () => ({
      client: {
        async call(name, args) {
          assert.equal(name, 'bili_search');
          assert.equal(args.keyword, '惊叹号diy电脑');
          return { videos: [{ mid: 65401107, author: '惊叹号diy电脑', title: 'A卡降价' }] };
        },
        stop() {},
      },
    }),
  });
  assert.equal(mid, 65401107);
});

test('S7-05 removing a suggestion drops it from the saved file', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-suggest-'));
  fs.mkdirSync(path.join(dataDir, 'watch'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'watch', 'suggestions.json'), JSON.stringify({
    generatedAt: '2026-11-10T00:00:00Z',
    items: [{ mid: 1, up: 'A' }, { mid: 2, up: 'B' }],
  }), 'utf8');
  const left = removeSuggestion(dataDir, { mid: 2, up: 'B' });
  assert.deepEqual(left.map((entry) => entry.up), ['A']);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'watch', 'suggestions.json'), 'utf8'));
  assert.equal(saved.items.length, 1);
});
