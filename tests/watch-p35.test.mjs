import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directionTokens, parseCriteria } from '../src/watch/criteria.js';
import { pickCandidates } from '../src/watch/triage.js';
import { buildExploreQueries } from '../src/watch/round.js';
import { buildUnderstandingPrompt, understandVideo } from '../src/watch/understand.js';
import { appendDecisions, loadCalibration } from '../src/watch/calibration.js';
import { reportPaths, writeRoundReport } from '../src/watch/report.js';

const CRITERIA = `# 判据

## 人设

我是标准化条线的工作人员。

## 关注方向

1. 标准化、标准编写
2. 公文写作、信息报送
3. 基层减负

## 关键词

### 必含
信息报送, 标准化

### 加分
三段式, 案例

### 排除
美食, 探店
`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-watch-p35-'));
}

function video(overrides = {}) {
  return { bvid: 'BV' + Math.random().toString(36).slice(2, 8), title: '信息报送', description: '', author: 'UP', play: 100, pubdate: 0, ...overrides };
}

test('P35-01 direction tokens exclude must words for exploration queries', () => {
  const criteria = parseCriteria(CRITERIA);
  assert.ok(directionTokens(criteria).includes('公文写作'));
  const queries = buildExploreQueries(criteria, 2);
  assert.equal(queries.length, 2);
  assert.equal(queries.some((query) => query.startsWith('标准化')), false, 'must words must not seed exploration');
  assert.ok(queries.some((query) => query.includes('公文写作') || query.includes('基层减负')));
});

test('P35-01b search queries section parses comma-separated queries', () => {
  const criteria = parseCriteria(`${CRITERIA}\n## 搜索词\n信息报送, 金价走势, 显卡价格, DSH 插件\n`);
  assert.deepEqual(criteria.queries, ['信息报送', '金价走势', '显卡价格', 'DSH 插件']);
});

test('P35-02 exploration pool only takes direction-related or explicit explore candidates', () => {
  const criteria = parseCriteria(CRITERIA);
  const videos = [
    { ...video({ bvid: 'BVkw', title: '信息报送三段式' }) },
    { ...video({ bvid: 'BVdir', title: '公文写作的实用方法' }) },
    { ...video({ bvid: 'BVfood', title: '美食探店' }) },
    { ...video({ bvid: 'BVrand', title: '随便看看', description: '' }) },
  ];
  const picked = pickCandidates(videos, criteria, { scanPerRound: 3, explorationRatio: 0.34 });
  assert.equal(picked.some((item) => item.video.bvid === 'BVfood'), false, 'excluded video dropped');
  assert.equal(picked.some((item) => item.video.bvid === 'BVrand'), false, 'random zero-score video is not exploration');
  assert.equal(picked.find((item) => item.video.bvid === 'BVdir')?.bucket, 'exploration');
});

test('P35-03 low-confidence worth=true becomes pending', async () => {
  const criteria = parseCriteria(CRITERIA);
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: '{"worth":true,"confidence":0.4,"reason":"看起来相关","points":["p"],"topics":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const judgement = await understandVideo({
    ctx: {}, llm: fakeLlm, route: { provider: 'p', model: 'm' }, criteria,
    video: video({ bvid: 'BVlow' }), subtitle: '有字幕', examples: [],
  });
  assert.equal(judgement.worth, null);
  assert.match(judgement.reason, /低于 0\.5/);
  assert.equal(judgement.subtitleMissing, false);
});

test('P35-07 a missing subtitle always becomes pending, even at high confidence', async () => {
  const criteria = parseCriteria(CRITERIA);
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: '{"worth":true,"confidence":0.95,"reason":"标题很相关","points":["p"],"topics":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const judgement = await understandVideo({
    ctx: {}, llm: fakeLlm, route: { provider: 'p', model: 'm' }, criteria,
    video: video({ bvid: 'BVnosub' }), subtitle: '', examples: [],
  });
  assert.equal(judgement.worth, null);
  assert.match(judgement.reason, /无字幕/);
  assert.equal(judgement.subtitleMissing, true);
});

test('P35-04 prompt carries past choices as few-shot', () => {
  const criteria = parseCriteria(CRITERIA);
  const { user } = buildUnderstandingPrompt({
    criteria,
    video: video({ title: '信息报送选题' }),
    subtitle: '字幕',
    examples: [{ decision: 'received', title: '公文写作六条路径' }, { decision: 'rejected', title: '电商涉税' }],
  });
  assert.match(user, /你过去的选择/);
  assert.match(user, /收：公文写作六条路径/);
  assert.match(user, /扔：电商涉税/);
});

test('P35-05 calibration appends and loads with invalid rows skipped', () => {
  const dataDir = tempDir();
  const result = appendDecisions(dataDir, [
    { bvid: 'BV1', decision: 'received', title: 'A' },
    { bvid: 'BV2', decision: 'rejected', title: 'B' },
    { bvid: '', decision: 'received' },
    { bvid: 'BV3', decision: 'maybe' },
    { bvid: 'BV1', decision: 'rejected', title: 'A（改判）' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  const loaded = loadCalibration(dataDir);
  assert.equal(loaded.entries.length, 2, 'same video keeps only the latest decision');
  assert.deepEqual(loaded.entries.map((item) => item.bvid), ['BV2', 'BV1']);
  assert.equal(loaded.entries.find((item) => item.bvid === 'BV1').decision, 'rejected');
});

test('P35-06 report carries subtitle_missing', () => {
  const dataDir = tempDir();
  const picked = [{
    video: video({ bvid: 'BVsub', title: '无字幕视频' }),
    triage: { score: 10, hits: ['信息报送'], excluded: false, reason: '必含词', directionHits: [] },
    bucket: 'keyword',
  }];
  const deepById = new Map([['BVsub', { worth: null, confidence: 0.4, reason: '低置信', points: [], subtitleMissing: true }]]);
  const result = writeRoundReport({ dataDir, date: '2026-11-09', picked, deepById, route: { provider: 'p', model: 'm' }, criteriaFile: 'criteria.md' });
  const record = JSON.parse(fs.readFileSync(reportPaths(dataDir, '2026-11-09').jsonl, 'utf8').trim());
  assert.equal(record.subtitle_missing, true);
  assert.equal(result.markdown, reportPaths(dataDir, '2026-11-09').markdown);
});
