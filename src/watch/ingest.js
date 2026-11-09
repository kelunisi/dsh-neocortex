/**
 * 入库桥：把用户点"收"的条目写进智脑。
 * L2：知识库/来源摘要/B站-<标题>.md，一行要点 + 来源链接；
 * L3：个人模型/近况/通用.md 一条近况（配额由 MemoryWriter 管）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readPage, resolveMarkdown } from '../writer.js';

function safeTitle(title) {
  return String(title || '未命名')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50) || '未命名';
}

function targetPathFor(item) {
  return `知识库/来源摘要/B站-${safeTitle(item.title)}.md`;
}

function l2Text(item) {
  const points = (item.points || []).filter(Boolean).slice(0, 3);
  if (points.length) return `《${item.title}》：${points.join('；')}`;
  return `《${item.title}》（B站视频，暂无要点）`;
}

function l3Text(item) {
  const first = (item.points || []).filter(Boolean)[0];
  return first ? `从B站收了《${item.title}》：${first}` : `从B站收了《${item.title}》（暂无要点，已存来源页）`;
}

function alreadyIngested(writer, item, targetPath) {
  try {
    const file = resolveMarkdown(writer.brainRoot, targetPath, ['知识库/']);
    if (!fs.existsSync(file)) return false;
    const page = readPage(file);
    return page.content.includes(item.url || item.bvid);
  } catch {
    return false;
  }
}

export function acceptItems({ writer, queue, dataDir, sessionId, ids }) {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const accepted = [];
  const duplicates = [];
  const errors = [];
  for (const item of queue.items) {
    if (item.status !== 'pending') continue;
    if (wanted && !wanted.has(item.id) && !wanted.has(item.bvid)) continue;
    const targetPath = targetPathFor(item);
    if (alreadyIngested(writer, item, targetPath)) {
      item.status = 'accepted';
      item.decidedAt = new Date().toISOString();
      item.note = '已存在同来源页面，跳过重复写入';
      duplicates.push({ bvid: item.bvid, targetPath });
      continue;
    }
    try {
      const l2 = writer.remember({
        text: l2Text(item),
        layer: 'L2',
        targetPath,
        source: item.url,
      }, { sessionId });
      const l3 = writer.remember({
        text: l3Text(item),
        layer: 'L3',
        scene: '通用',
      }, { sessionId });
      item.status = 'accepted';
      item.decidedAt = new Date().toISOString();
      item.l2 = l2;
      item.l3 = l3;
      item.targetPath = targetPath;
      accepted.push({ bvid: item.bvid, title: item.title, l2, l3, targetPath });
    } catch (error) {
      item.status = 'error';
      item.note = String(error?.message || error).slice(0, 300);
      errors.push({ bvid: item.bvid, error: item.note });
    }
  }
  return { accepted, duplicates, errors };
}

export function retryItems({ writer, queue, sessionId, ids }) {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const retried = [];
  const errors = [];
  for (const item of queue.items) {
    if (item.status !== 'error') continue;
    if (wanted && !wanted.has(item.id) && !wanted.has(item.bvid)) continue;
    const targetPath = targetPathFor(item);
    try {
      let l2 = item.l2;
      if (!alreadyIngested(writer, item, targetPath)) {
        l2 = writer.remember({
          text: l2Text(item),
          layer: 'L2',
          targetPath,
          source: item.url,
        }, { sessionId });
      }
      const l3 = writer.remember({
        text: l3Text(item),
        layer: 'L3',
        scene: '通用',
      }, { sessionId });
      item.status = 'accepted';
      item.note = null;
      item.decidedAt = new Date().toISOString();
      item.l2 = l2;
      item.l3 = l3;
      item.targetPath = targetPath;
      retried.push({ bvid: item.bvid, title: item.title, l2, l3, targetPath });
    } catch (error) {
      item.note = String(error?.message || error).slice(0, 300);
      errors.push({ bvid: item.bvid, error: item.note });
    }
  }
  return { retried, errors };
}

export function rejectItems({ queue, ids, note }) {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const rejected = [];
  for (const item of queue.items) {
    if (item.status !== 'pending') continue;
    if (wanted && !wanted.has(item.id) && !wanted.has(item.bvid)) continue;
    item.status = 'rejected';
    item.decidedAt = new Date().toISOString();
    item.note = note ? String(note).slice(0, 300) : '用户选择扔';
    rejected.push({ bvid: item.bvid, title: item.title });
  }
  return { rejected };
}

export { targetPathFor };
