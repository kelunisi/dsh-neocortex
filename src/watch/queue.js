/**
 * 待确认队列：一轮跑完后把 5 条候选存下来，等用户点收/扔。
 * 队列按天存放；同一天重复跑会按 bvid 合并，已判定的状态保留。
 */

import fs from 'node:fs';
import path from 'node:path';

export const QUEUE_FILE = 'queue.json';
export const QUEUE_LIMIT = 40;

export function queueFile(dataDir) {
  return path.join(dataDir, 'watch', QUEUE_FILE);
}

export function loadQueue(dataDir) {
  const file = queueFile(dataDir);
  if (!fs.existsSync(file)) return { file, date: null, updatedAt: null, items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      file,
      date: typeof parsed?.date === 'string' ? parsed.date : null,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      items: Array.isArray(parsed?.items) ? parsed.items : [],
    };
  } catch (error) {
    return { file, date: null, updatedAt: null, items: [], error: String(error?.message || error) };
  }
}

export function saveQueue(dataDir, queue) {
  const file = queueFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    date: queue.date,
    updatedAt: new Date().toISOString(),
    items: (queue.items || []).slice(0, QUEUE_LIMIT),
  };
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
  return { ok: true, file, count: payload.items.length };
}

/**
 * Build/merge today's queue from a round result.
 * @param {{dataDir:string,date:string,picked:object[],deepById:Map<string,object>}} input
 */
export function buildQueue({ dataDir, date, picked, deepById }) {
  const existing = loadQueue(dataDir);
  const items = existing.date === date ? [...existing.items] : [];
  const index = new Map(items.map((item) => [item.bvid, item]));
  for (const entry of picked || []) {
    const { video, triage, bucket } = entry;
    const deep = deepById?.get?.(video.bvid);
    const prior = index.get(video.bvid);
    if (prior) continue;
    const item = {
      id: `${date}-${video.bvid}`,
      date,
      bvid: video.bvid,
      title: video.title,
      up: video.author || '',
      url: `https://www.bilibili.com/video/${video.bvid}`,
      duration: video.duration || '',
      points: deep?.points || [],
      reason: deep?.reason || triage?.reason || '',
      worth: deep ? deep.worth : null,
      confidence: deep ? deep.confidence : null,
      subtitleMissing: deep ? Boolean(deep.subtitleMissing) : null,
      bucket: bucket || 'keyword',
      status: 'pending',
      decidedAt: null,
      note: null,
    };
    items.push(item);
    index.set(video.bvid, item);
  }
  const saved = saveQueue(dataDir, { date, items });
  return { ...saved, date, items };
}

export function pendingItems(queue) {
  return (queue?.items || []).filter((item) => item.status === 'pending');
}

export function markItems(dataDir, queue, ids, status, note) {
  const wanted = new Set(ids);
  const now = new Date().toISOString();
  for (const item of queue.items) {
    if (!wanted.has(item.id) && !wanted.has(item.bvid)) continue;
    item.status = status;
    item.decidedAt = now;
    item.note = note ? String(note).slice(0, 300) : item.note;
  }
  saveQueue(dataDir, queue);
  return queue;
}
