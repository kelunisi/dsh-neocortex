import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestions } from '../src/watch/suggestions.js';

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
