import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { truncateUnicode, unicodeLength } from './defaults.js';

function readIfPresent(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export function compactMarkdown(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const output = [];
  let inCode = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode || line.trim() === '---' || /^\s*最近修订:/.test(line)) continue;
    let value = line.trim()
      .replace(/^\|[-:\s|]+\|?$/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#+\s*/, '')
      .replace(/[*_`]/g, '')
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .replace(/\s*\|\s*/g, ' / ')
      .trim();
    if (value && value !== '暂无' && value !== '暂无。') output.push(value);
  }
  return output.join('\n');
}

export function parseSceneIndex(markdown) {
  const scenes = [];
  let mode;
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      mode = line.includes('活跃场景') ? 'active' : line.includes('沉睡场景') ? 'sleeping' : undefined;
      continue;
    }
    if (!mode || !line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (!cells[0] || cells[0] === '场景' || cells[0] === '暂无' || /^-+$/.test(cells[0])) continue;
    const link = cells[cells.length - 1].match(/\[([^\]]+)\]\(([^)]+)\)/);
    scenes.push({
      name: cells[0],
      status: mode,
      page: link?.[2] || '',
      lastActivity: mode === 'active' ? (cells[1] || '') : '',
      count: mode === 'active' ? (Number(cells[2]) || 0) : undefined,
      sleepDate: mode === 'sleeping' ? (cells[1] || '') : undefined,
      lastUsed: mode === 'sleeping' ? (cells[2] || '') : undefined,
      revivalCount: mode === 'sleeping' ? (Number(cells[3]) || 0) : 0,
      raw: line,
    });
  }
  return scenes;
}

export function parseMemoryEntries(markdown, { sourcePath, scene = null, status = 'active' } = {}) {
  const entries = [];
  let inCode = false;
  for (const line of markdown.replace(/\r/g, '').split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const match = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/);
    if (!match) continue;
    const [, date, body] = match;
    const attributes = {};
    const attributeMatch = body.match(/\{([^}]+)\}\s*$/);
    if (attributeMatch) {
      for (const pair of attributeMatch[1].split(',')) {
        const colon = pair.indexOf(':');
        if (colon > 0) attributes[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
      }
    }
    const id = crypto.createHash('sha256').update(`${date}|${body}`).digest('hex').slice(0, 24);
    entries.push({
      id,
      date,
      text: body,
      scene: scene || attributes['场景倾向'] || null,
      factKey: attributes['键'],
      status,
      sourcePath,
      importance: Number(attributes['重要度']) || 1,
    });
  }
  return entries;
}

function resolveWithin(root, relative) {
  const resolved = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) throw new Error(`Memory page escapes brain root: ${relative}`);
  return resolved;
}

export function readBrainSnapshot(brainRoot) {
  const personalPath = path.join(brainRoot, '个人模型', '_索引.md');
  const indexPath = path.join(brainRoot, '个人模型', '近况', '索引.md');
  const overview = readIfPresent(personalPath);
  const sceneIndex = readIfPresent(indexPath);
  const scenes = parseSceneIndex(sceneIndex);
  const memories = [];
  const generalPath = '个人模型/近况/通用.md';
  const sleepingPath = '个人模型/近况/沉睡条目.md';
  memories.push(...parseMemoryEntries(readIfPresent(resolveWithin(brainRoot, generalPath)), {
    sourcePath: generalPath,
    status: 'active',
  }));
  memories.push(...parseMemoryEntries(readIfPresent(resolveWithin(brainRoot, sleepingPath)), {
    sourcePath: sleepingPath,
    status: 'sleeping',
  }));
  for (const scene of scenes) {
    if (!scene.page) continue;
    const relative = `个人模型/近况/${scene.page}`;
    memories.push(...parseMemoryEntries(readIfPresent(resolveWithin(brainRoot, relative)), {
      sourcePath: relative,
      scene: scene.name,
      status: scene.status,
    }));
  }
  return { overview, sceneIndex, scenes, memories };
}

export function readAllMemoryEntries(brainRoot) {
  const snapshot = readBrainSnapshot(brainRoot);
  const entries = [...snapshot.memories];
  const knownPaths = new Set(entries.map((entry) => entry.sourcePath));
  const directory = resolveWithin(brainRoot, '个人模型/近况/沉睡场景');
  if (fs.existsSync(directory)) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith('.md')) continue;
      const sourcePath = `个人模型/近况/沉睡场景/${item.name}`;
      if (knownPaths.has(sourcePath)) continue;
      const scene = item.name.slice(0, -3);
      entries.push(...parseMemoryEntries(fs.readFileSync(path.join(directory, item.name), 'utf8'), { sourcePath, scene, status: 'sleeping' }));
    }
  }
  return entries;
}

export function detectScene(query, scenes, currentScene = '通用') {
  const matches = scenes.filter((scene) => scene.name && query.includes(scene.name));
  if (!matches.length) return currentScene;
  return matches.sort((a, b) => b.name.length - a.name.length)[0].name;
}

function section(label, text, maxChars) {
  const prefix = `${label}\n`;
  const body = truncateUnicode(compactMarkdown(text), Math.max(0, maxChars - unicodeLength(prefix)));
  return prefix + body;
}

export function buildRecallPayload({ snapshot, ledger, scene = '通用', includeGlobal = true, reason = 'first', maxItems = 10, maxChars = 800 }) {
  const candidates = snapshot.memories.filter((entry) => scene === '通用'
    ? !entry.scene || entry.scene === '通用'
    : entry.scene === scene);
  const ranked = ledger.rank(candidates);
  let text = '';
  if (includeGlobal) {
    const globalBudget = Math.min(maxChars, 560);
    const overviewBudget = Math.floor(globalBudget * 0.42);
    const indexBudget = globalBudget - overviewBudget - 24;
    text += section('[智脑] 个人模型总览', snapshot.overview, overviewBudget) + '\n';
    text += section('[智脑] 活跃/沉睡场景索引', snapshot.sceneIndex, Math.max(40, indexBudget)) + '\n';
  }
  text += `[召回场景] ${scene}\n[原因] ${reason}\n`;
  const selected = [];
  for (const entry of ranked) {
    if (selected.length >= maxItems) break;
    const line = `- ${entry.text}\n`;
    if (unicodeLength(text + line) > maxChars) continue;
    text += line;
    selected.push(entry);
  }
  return {
    text: truncateUnicode(text, maxChars),
    selected,
    explanations: selected.map((entry) => ({ id: entry.id, scene: entry.scene, ...entry.explanation })),
    chars: unicodeLength(text),
  };
}

export function isPersonalHistoryQuery(query) {
  return /(我|我的|上次|之前|曾经|近况|心情|约定|还记得)/.test(query);
}

export function searchPersonalHistory(brainRoot, query) {
  const words = query.split(/[\s，。？！,.?!、]+/).filter((token) => token.length >= 2);
  const chinese = query.match(/[\u3400-\u9fff]+/g) || [];
  const bigrams = chinese.flatMap((part) => Array.from({ length: Math.max(0, Array.from(part).length - 1) }, (_, index) => Array.from(part).slice(index, index + 2).join('')));
  const stop = new Set(['我的', '我们', '之前', '以前', '曾经', '记得', '什么', '怎么', '是否', '小时候', '现在']);
  const tokens = Array.from(new Set([...words, ...bigrams])).filter((token) => !stop.has(token));
  const entries = readAllMemoryEntries(brainRoot);
  return entries.filter((entry) => tokens.length === 0 || tokens.some((token) => entry.text.includes(token)));
}

export async function routeRecallMiss({ brainRoot, query, externalSearch }) {
  if (isPersonalHistoryQuery(query)) {
    const results = searchPersonalHistory(brainRoot, query);
    return results.length
      ? { kind: 'personal', results }
      : { kind: 'unknown', message: '现有智脑记录中没有找到这段个人往事，我不能确认。' };
  }
  const results = externalSearch ? await externalSearch(query) : [];
  return { kind: 'external', action: 'web_search', results };
}
