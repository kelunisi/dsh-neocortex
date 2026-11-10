/**
 * P4.5 关注建议：从当前队列里已收/待判的视频，按 UP 主聚合，
 * 用判据方向打分，排除已关注的人，给出 3–5 个建议。
 * 只读；不写关注。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createBiliClient } from './bili.js';
import { scoreCandidate } from './criteria.js';

export function suggestionsFile(dataDir) {
  return path.join(dataDir, 'watch', 'suggestions.json');
}

export function loadSuggestions(dataDir) {
  const file = suggestionsFile(dataDir);
  if (!fs.existsSync(file)) return { file, generatedAt: null, items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, generatedAt: parsed.generatedAt || null, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { file, generatedAt: null, items: [], error: 'read-failed' };
  }
}

export function saveSuggestions(dataDir, suggestions) {
  const file = suggestionsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), items: suggestions.items || [] };
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
  return { file, ...payload };
}

export async function fetchFollowings({ dataDir, config = {}, vendorDir, pages = 2, signal, log = () => {}, clientFactory = createBiliClient, client: provided } = {}) {
  const own = !provided;
  const client = provided || clientFactory({ dataDir, config, vendorDir, log }).client;
  const all = [];
  try {
    for (let page = 1; page <= pages; page += 1) {
      if (signal?.aborted) break;
      const result = await client.call('bili_followings', { page, page_size: 50 }, { timeoutMs: 60000, signal });
      if (page === 1 && Number(result?.self_mid) > 0) {
        Object.defineProperty(all, 'selfMid', { value: Number(result.self_mid), enumerable: false });
      }
      const list = Array.isArray(result?.followings) ? result.followings : [];
      all.push(...list);
      if (list.length < 50) break;
    }
  } finally {
    if (own) {
      try { client.stop(); } catch { /* ignore */ }
    }
  }
  return all;
}

export function removeSuggestion(dataDir, { mid, up }) {
  const current = loadSuggestions(dataDir);
  const keyMid = Number(mid) || 0;
  const name = String(up || '').trim();
  const items = current.items.filter((entry) => {
    if (keyMid && Number(entry.mid) === keyMid) return false;
    if (!keyMid && name && entry.up === name) return false;
    return true;
  });
  saveSuggestions(dataDir, { items });
  return items;
}

export async function resolveUpMid({ uname, title, dataDir, config = {}, vendorDir, signal, clientFactory = createBiliClient }) {
  const name = String(uname || '').trim();
  const titleKey = String(title || '').trim().slice(0, 20);
  if (!name && !titleKey) return 0;
  const { client } = clientFactory({ dataDir, config, vendorDir });
  try {
    for (const keyword of [name, titleKey].filter(Boolean)) {
      const result = await client.call('bili_search', { keyword, num: 20 }, { timeoutMs: 60000, signal });
      const videos = Array.isArray(result?.videos) ? result.videos : [];
      const match = videos.find((video) => Number(video.mid) > 0
        && (video.author === name || (titleKey && String(video.title || '').includes(titleKey))));
      if (match) return Number(match.mid);
    }
  } finally {
    try { client.stop(); } catch { /* ignore */ }
  }
  return 0;
}

export function buildSuggestions({ queue, followings = [], criteria, limit = 5 }) {
  const selfMid = Number(followings.selfMid || 0);
  const peers = selfMid ? followings.filter((entry) => Number(entry.mid) !== selfMid) : followings;
  const followedMids = new Set(peers.map((entry) => String(entry.mid || '')).filter(Boolean));
  const followedNames = new Set(peers.map((entry) => String(entry.uname || '').trim()).filter(Boolean));
  const groups = new Map();
  for (const item of queue?.items || []) {
    if (!['accepted', 'pending', 'error'].includes(item.status)) continue;
    const mid = Number(item.mid) || 0;
    const up = String(item.up || '').trim();
    if (mid && followedMids.has(String(mid))) continue;
    if (!mid && up && followedNames.has(up)) continue;
    const key = mid ? `mid:${mid}` : `up:${up}`;
    if (!key || key === 'up:') continue;
    const scored = scoreCandidate({ title: item.title, description: item.reason || '' }, criteria);
    if (scored.excluded) continue;
    let group = groups.get(key);
    if (!group) {
      group = { mid, up, count: 0, score: 0, topics: new Set(), examples: [] };
      groups.set(key, group);
    }
    group.count += 1;
    group.score += Math.max(0, scored.score);
    for (const topic of scored.directionHits || []) group.topics.add(topic);
    if (group.examples.length < 2) group.examples.push({ bvid: item.bvid, title: item.title });
  }
  return [...groups.values()]
    .map((group) => ({
      mid: group.mid,
      up: group.up || '未命名 UP',
      count: group.count,
      score: group.score,
      topics: [...group.topics].slice(0, 4),
      examples: group.examples,
      reason: group.count > 1
        ? `最近 ${group.count} 条命中${group.topics.size ? `（${[...group.topics].slice(0, 3).join('/')}）` : ''}`
        : `《${group.examples[0]?.title || '视频'}》符合你的方向`,
    }))
    .filter((entry) => entry.count >= 1 && (entry.score > 0 || entry.topics.length))
    .sort((a, b) => b.count - a.count || b.score - a.score)
    .slice(0, limit);
}
