import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCandidates } from '../src/watch/triage.js';
import { fetchFollowings } from '../src/watch/suggestions.js';

const criteria = { must: ['金价'], plus: [], exclude: [], directions: [] };

function video(overrides) {
  return {
    bvid: 'BV1',
    title: '金价走势',
    author: 'UP',
    duration: '1:00',
    pubdate: 100,
    ...overrides,
  };
}

test('S8-01 a followed UP gets a reserved slot and a score boost', () => {
  const videos = [
    video({ bvid: 'BV1', title: '金价日常', author: '普通A' }),
    video({ bvid: 'BV2', title: '金价分析', author: '普通B' }),
    video({ bvid: 'BV3', title: '金价走势', author: '关注的人', following: true, mid: 42 }),
    video({ bvid: 'BV4', title: '金价复盘', author: '普通C' }),
    video({ bvid: 'BV5', title: '金价早报', author: '普通D' }),
  ];
  const picked = pickCandidates(videos, criteria, { scanPerRound: 4, explorationRatio: 0.25 });
  const followed = picked.find((entry) => entry.video.bvid === 'BV3');
  assert.ok(followed, 'followed video must survive triage');
  assert.equal(followed.bucket, 'following');
  assert.ok(followed.triage.score >= 16, 'followed video gets the +6 priority boost');
});

test('S8-02 fetchFollowings reuses a provided client and does not stop it', async () => {
  let stopped = false;
  const client = {
    async call(name, args) {
      assert.equal(name, 'bili_followings');
      assert.equal(args.page, 1);
      return { total: 1, followings: [{ mid: 7, uname: 'A' }] };
    },
    stop() { stopped = true; },
  };
  const followings = await fetchFollowings({ dataDir: 'unused', client, pages: 1 });
  assert.deepEqual(followings, [{ mid: 7, uname: 'A' }]);
  assert.equal(stopped, false);
});
