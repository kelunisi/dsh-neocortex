/**
 * 判定校准：你每次点"收/扔"都写一行，下一轮判读时取最近几条做 few-shot。
 * 文件是本地 JSONL，不进 git。
 */

import fs from 'node:fs';
import path from 'node:path';

export const CALIBRATION_FILE = 'calibration.jsonl';
export const DECISIONS = Object.freeze(['received', 'rejected']);

export function calibrationFile(dataDir) {
  return path.join(dataDir, 'watch', CALIBRATION_FILE);
}

export function appendDecisions(dataDir, decisions, now = new Date()) {
  const list = Array.isArray(decisions) ? decisions : [];
  const valid = [];
  for (const item of list) {
    if (!item || typeof item.bvid !== 'string' || !item.bvid.trim()) continue;
    if (!DECISIONS.includes(item.decision)) continue;
    valid.push({
      ts: new Date(now).toISOString(),
      bvid: item.bvid.trim(),
      decision: item.decision,
      ...(item.title ? { title: String(item.title).slice(0, 200) } : {}),
      ...(item.note ? { note: String(item.note).slice(0, 300) } : {}),
    });
  }
  if (!valid.length) return { ok: false, count: 0, reason: 'no-valid-decisions' };
  const file = calibrationFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, valid.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return { ok: true, count: valid.length, file };
}

export function loadCalibration(dataDir, { limit = 8 } = {}) {
  const file = calibrationFile(dataDir);
  if (!fs.existsSync(file)) return { file, entries: [] };
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record?.bvid && DECISIONS.includes(record.decision)) entries.push(record);
      } catch { /* skip malformed line */ }
    }
    return { file, entries: entries.slice(-Math.max(1, limit)) };
  } catch (error) {
    return { file, entries: [], error: String(error?.message || error) };
  }
}
