/**
 * 代码粗筛：零 token。负责把抓回来的候选压到 scanPerRound 条，
 * 并把 20% 左右的名额留给"关键词之外"的探索候选。
 */

import { scoreCandidate } from './criteria.js';

export function normalizeVideo(item) {
  if (!item || typeof item !== 'object') return null;
  const bvid = String(item.bvid || item.bv || '').trim();
  if (!bvid) return null;
  return {
    bvid,
    aid: item.aid,
    title: String(item.title || '').trim(),
    author: String(item.author || item.up || '').trim(),
    play: Number(item.play ?? 0),
    review: Number(item.review ?? 0),
    danmaku: Number(item.danmaku ?? 0),
    duration: String(item.duration || ''),
    pubdate: Number(item.pubdate ?? 0),
    description: String(item.description || '').trim(),
    origin: item.origin === 'explore' ? 'explore' : undefined,
    originQuery: item.originQuery ? String(item.originQuery).slice(0, 80) : undefined,
  };
}

export function dedupeVideos(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const video = normalizeVideo(item);
    if (!video || seen.has(video.bvid)) continue;
    seen.add(video.bvid);
    out.push(video);
  }
  return out;
}

function pubdateDesc(a, b) {
  return (b.pubdate || 0) - (a.pubdate || 0);
}

function playDesc(a, b) {
  return (b.play || 0) - (a.play || 0);
}

/**
 * @param {object[]} videos normalized videos
 * @param {object} criteria parsed criteria
 * @param {{scanPerRound?:number, explorationRatio?:number}} options
 */
export function pickCandidates(videos, criteria, { scanPerRound = 5, explorationRatio = 0.2, maxPerQuery = 2 } = {}) {
  const scored = dedupeVideos(videos).map((video) => {
    const triage = scoreCandidate(video, criteria);
    return { video, triage };
  });
  const keyword = scored.filter((item) => !item.triage.excluded && item.triage.score > 0)
    .sort((a, b) => b.triage.score - a.triage.score || pubdateDesc(a.video, b.video));
  // 探索位只收"方向相关且标题像方法/教程"的：避免资讯汇总、vlog、美食混进来。
  const exploration = scored.filter((item) => !item.triage.excluded && item.triage.score === 0
    && item.triage.utilityHits.length > 0)
    .sort((a, b) => b.triage.utilityHits.length - a.triage.utilityHits.length || b.triage.directionHits.length - a.triage.directionHits.length || playDesc(a.video, b.video) || pubdateDesc(a.video, b.video));

  // 每个搜索词最多贡献 maxPerQuery 条，避免一个词（如"信息报送"）霸占全部名额。
  const take = (pool, slots) => {
    const out = [];
    const counts = new Map();
    for (const item of pool) {
      if (out.length >= slots) break;
      const key = item.video.originQuery || item.video.bvid;
      if ((counts.get(key) || 0) >= maxPerQuery) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      out.push(item);
    }
    return out;
  };

  const explorationSlots = Math.min(scanPerRound, Math.max(1, Math.round(scanPerRound * explorationRatio)));
  const keywordSlots = Math.max(0, scanPerRound - explorationSlots);
  const picked = [
    ...take(keyword, keywordSlots).map((item) => ({ ...item, bucket: 'keyword' })),
    ...take(exploration, explorationSlots).map((item) => ({ ...item, bucket: 'exploration' })),
  ];
  // 一边不够就从另一边补，保证尽量凑满 scanPerRound（补位不再受 maxPerQuery 限制）。
  for (const pool of [keyword, exploration]) {
    for (const item of pool) {
      if (picked.length >= scanPerRound) break;
      if (picked.some((entry) => entry.video.bvid === item.video.bvid)) continue;
      picked.push({ ...item, bucket: pool === keyword ? 'keyword' : 'exploration' });
    }
  }
  return picked;
}

/** Deep-read the highest-scoring picks first; method/tutorial titles only break ties. */
export function selectDeep(picked, deepPerRound = 3) {
  return [...picked]
    .sort((a, b) => b.triage.score - a.triage.score
      || (b.triage.utilityHits?.length || 0) - (a.triage.utilityHits?.length || 0)
      || pubdateDesc(a.video, b.video))
    .slice(0, Math.max(0, deepPerRound));
}

export function ageDays(pubdate, now = Date.now()) {
  if (!pubdate) return null;
  return Math.max(0, (now / 1000 - pubdate) / 86400);
}
