/**
 * 每日 token 预算记账（估算值）。P7 的硬闸：当日估算用量达到上限就不再自动跑。
 */

import fs from 'node:fs';
import path from 'node:path';

export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function budgetFile(dataDir) {
  return path.join(dataDir, 'watch', 'budget.json');
}

export function loadBudget(dataDir, now = new Date()) {
  const day = localDay(now);
  const file = budgetFile(dataDir);
  if (!fs.existsSync(file)) return { file, date: day, used: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.date !== day) return { file, date: day, used: 0, previous: parsed };
    return { file, date: day, used: Number(parsed.used) || 0 };
  } catch {
    return { file, date: day, used: 0, corrupt: true };
  }
}

export function recordUsage(dataDir, tokens, now = new Date()) {
  const value = Math.max(0, Math.round(Number(tokens) || 0));
  if (!value) return loadBudget(dataDir, now);
  const current = loadBudget(dataDir, now);
  const next = { date: current.date, used: current.used + value, updatedAt: new Date(now).toISOString() };
  const file = budgetFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
  return { file, ...next };
}

export function remainingBudget(dataDir, limit, now = new Date()) {
  const used = loadBudget(dataDir, now).used;
  return Math.max(0, Number(limit || 0) - used);
}
