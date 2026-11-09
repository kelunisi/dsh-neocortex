import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCriteria, parseCriteria, scoreCandidate } from '../src/watch/criteria.js';
import { dedupeVideos, pickCandidates, selectDeep } from '../src/watch/triage.js';
import { buildUnderstandingPrompt, extractJudgement, normalizeJudgement, normalizeSubtitle } from '../src/watch/understand.js';
import { reportPaths, writeRoundReport } from '../src/watch/report.js';
import { runDryRound } from '../src/watch/round.js';

const CRITERIA = `# 判据\n\n## 人设（喂给模型的一句话）\n\n我是标准化条线的工作人员。\n\n## 关注方向\n\n1. 标准化\n2. 信息报送\n\n## 关键词\n\n### 必含\n信息报送, 标准化\n\n### 加分\n三段式, 退稿\n\n### 排除\n鸡汤, 带货\n`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-watch-p3-'));
}

function video(overrides = {}) {
  return {
    bvid: 'BV' + Math.random().toString(36).slice(2, 10),
    title: '信息报送三段式怎么写',
    description: '讲退稿原因',
    author: '测试UP',
    play: 1000,
    review: 10,
    danmaku: 1,
    duration: '10:00',
    pubdate: Math.floor(Date.now() / 1000) - 86400,
    ...overrides,
  };
}

test('P3-01 criteria parser reads persona, directions and keyword groups', () => {
  const criteria = parseCriteria(CRITERIA);
  assert.equal(criteria.persona, '我是标准化条线的工作人员。');
  assert.deepEqual(criteria.directions, ['标准化', '信息报送']);
  assert.deepEqual(criteria.must, ['信息报送', '标准化']);
  assert.deepEqual(criteria.plus, ['三段式', '退稿']);
  assert.deepEqual(criteria.exclude, ['鸡汤', '带货']);
});

test('P3-02 scoreCandidate: must/plus add, exclude vetoes', () => {
  const criteria = parseCriteria(CRITERIA);
  const hit = scoreCandidate({ title: '信息报送三段式', description: '退稿原因' }, criteria);
  assert.equal(hit.excluded, false);
  assert.equal(hit.score, 10 + 2 + 2, 'must 10 + 三段式 2 + 退稿 2');
  const veto = scoreCandidate({ title: '信息报送鸡汤', description: '' }, criteria);
  assert.equal(veto.excluded, true);
  assert.equal(veto.score, -1);
  const neutral = scoreCandidate({ title: '随便看看', description: '' }, criteria);
  assert.equal(neutral.score, 0);
});

test('P3-03 pickCandidates reserves one exploration slot and drops excluded videos', () => {
  const criteria = parseCriteria(CRITERIA);
  const keywordVideos = Array.from({ length: 6 }, (_, index) => video({ bvid: `BVkw${index}`, title: `信息报送技巧 ${index}`, play: 1000 + index }));
  const exploreVideos = [
    video({ bvid: 'BVex1', title: '一个陌生但可能有用的方法', play: 90000, description: '' }),
    video({ bvid: 'BVex2', title: '鸡汤一条', description: '', play: 99999 }),
  ];
  const picked = pickCandidates([...keywordVideos, ...exploreVideos], criteria, { scanPerRound: 5, explorationRatio: 0.2 });
  assert.equal(picked.length, 5);
  assert.equal(picked.filter((item) => item.bucket === 'exploration').length, 1);
  assert.equal(picked.some((item) => item.video.bvid === 'BVex2'), false, 'excluded video never enters');
  assert.equal(new Set(picked.map((item) => item.video.bvid)).size, 5);
});

test('P3-04 selectDeep takes the highest triage scores', () => {
  const criteria = parseCriteria(CRITERIA);
  const videos = [
    video({ title: '信息报送三段式', bvid: 'BVa' }),
    video({ title: '标准化试点', bvid: 'BVb' }),
    video({ title: '信息报送', bvid: 'BVc' }),
  ];
  const picked = pickCandidates(videos, criteria, { scanPerRound: 3 });
  const deep = selectDeep(picked, 2);
  assert.equal(deep.length, 2);
  assert.equal(deep[0].triage.score >= deep[1].triage.score, true);
});

test('P3-05 subtitle normalization tolerates strings, arrays and objects', () => {
  assert.equal(normalizeSubtitle('abc'), 'abc');
  assert.equal(normalizeSubtitle([{ text: 'a' }, { text: 'b' }]), 'a\nb');
  assert.equal(normalizeSubtitle({ subtitles: [{ text: 'x' }] }), 'x');
  assert.equal(normalizeSubtitle(null), '');
});

test('P3-06 judgement parsing tolerates code fences and prose', () => {
  const raw = '```json\n{"worth":true,"confidence":0.8,"reason":"细节够","points":["a","b"],"topics":["t"]}\n```';
  const normalized = normalizeJudgement(extractJudgement(raw), { bvid: 'BV1' });
  assert.equal(normalized.worth, true);
  assert.equal(normalized.confidence, 0.8);
  assert.deepEqual(normalized.points, ['a', 'b']);
  assert.equal(normalizeJudgement(null, { bvid: 'BV1' }).worth, null);
});

test('P3-07 report writes markdown and JSONL with fixed fields', () => {
  const dataDir = tempDir();
  const picked = [{
    video: video({ bvid: 'BVreport' }),
    triage: { score: 12, hits: ['信息报送'], excluded: false, reason: '必含词 信息报送' },
    bucket: 'keyword',
  }];
  const deepById = new Map([['BVreport', { worth: true, confidence: 0.9, reason: '实操', points: ['p1'], topics: [] }]]);
  const result = writeRoundReport({ dataDir, date: '2026-11-09', picked, deepById, route: { provider: 'p', model: 'm' }, criteriaFile: 'criteria.md' });
  const paths = reportPaths(dataDir, '2026-11-09');
  assert.equal(result.markdown, paths.markdown);
  assert.equal(fs.existsSync(paths.markdown), true);
  const lines = fs.readFileSync(paths.jsonl, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.bvid, 'BVreport');
  assert.equal(record.picked, 'deep');
  assert.equal(record.ingested, false);
  assert.equal(record.mentioned, false);
  assert.equal(record.dry, true);
});

test('P3-08 a dry round runs end to end with fake harvest and fake model', async () => {
  const dataDir = tempDir();
  fs.mkdirSync(path.join(dataDir, 'watch'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'watch', 'criteria.md'), CRITERIA, 'utf8');
  const calls = [];
  const client = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'bili_search') {
        return { videos: [video({ bvid: 'BVkw1', title: '信息报送三段式' }), video({ bvid: 'BVkw2', title: '标准化试点' })] };
      }
      if (name === 'bili_recommend') return { videos: [video({ bvid: 'BVex1', title: '一个陌生方法', description: '' })] };
      if (name === 'bili_subtitle') return { subtitles: [{ text: '字幕正文：背景、做法、成效。' }] };
      return {};
    },
    stop() {},
  };
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: '{"worth":true,"confidence":0.8,"reason":"实操细节够","points":["背景/做法/成效"],"topics":["信息报送"]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) };
      if (name === 'llm') return fakeLlm;
      return undefined;
    },
  };
  const result = await runDryRound({
    ctx,
    dataDir,
    config: { scanPerRound: 3, deepPerRound: 1 },
    clientFactory: () => ({ client }),
    route: { provider: 'deepseek-account', model: 'deepseek-flash' },
    llm: fakeLlm,
    now: new Date('2026-11-09T12:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.picked.length, 3);
  assert.equal(result.picked.filter((item) => item.deep).length, 1);
  assert.equal(fs.existsSync(result.markdown), true);
  assert.ok(calls.some((item) => item.name === 'bili_subtitle'));
});
