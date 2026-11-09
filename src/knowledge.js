/**
 * 知识库（L2）检索：把"看过但不进对话"的来源摘要/概念页/综合分析/对象档案
 * 变成按问题可召回的小段摘要。
 *
 * 纯本地、零模型调用：中文 bigram + 英文词，标题/小标题/正文分层加权。
 */

import fs from 'node:fs';
import path from 'node:path';

const KNOWLEDGE_ROOT = '知识库';
const PAGE_CACHE = new Map(); // absolute path -> { mtimeMs, size, page }
const STOPWORDS = new Set([
  '我的', '我们', '之前', '以前', '曾经', '记得', '什么', '怎么', '是否', '现在', '这个', '那个', '可以', '如何', '一下', '就是', '还是', '以及', '因为', '所以',
  // 通用词：在多数页面里都会出现，拿来做检索只会产生噪声
  '默认', '内容', '需要', '没有', '情况', '判定', '深读', '浅度', '悬浮', '面板', '提示', '忘记', '也就是说', '还有', '如果', '但是', '一个', '进行', '使用', '问题', '时候', '知道', '看看',
]);

function walkMarkdown(root, dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(root, full, out);
    else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_索引.md') out.push(full);
  }
  return out;
}

function stripFrontmatter(lines) {
  if (lines[0]?.trim() !== '---') return lines;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return end > 0 ? lines.slice(end + 1) : lines;
}

function summarize(content) {
  const lines = stripFrontmatter(content.replace(/\r/g, '').split('\n'));
  for (const line of lines) {
    const match = line.match(/^>\s*(?:摘要[:：]\s*)?(.+)$/);
    if (match) return match[1].trim().slice(0, 180);
  }
  let inCode = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) continue;
    const value = line.trim();
    if (!value || value.startsWith('#') || value === '---' || value.startsWith('|') || /^最近修订[:：]/.test(value)) continue;
    if (/^(type|kind|tags|description|title|date|source|created|updated|author)\s*:/i.test(value)) continue;
    return value
      .replace(/^[-*]\s*/, '')
      .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '')
      .replace(/（来源：.*$/i, '')
      .slice(0, 180);
  }
  return '';
}

function parsePage(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const content = stripFrontmatter(raw.replace(/\r/g, '').split('\n')).join('\n');
  const lines = content.split('\n');
  const titleLine = lines.find((line) => /^#\s+/.test(line.trim()));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : path.basename(file, '.md');
  const headings = lines.filter((line) => /^#{2,3}\s+/.test(line.trim())).map((line) => line.replace(/^#{2,3}\s+/, '').trim()).join(' ');
  return { title, headings, summary: summarize(raw), content };
}

function cachedPage(file) {
  try {
    const stat = fs.statSync(file);
    const hit = PAGE_CACHE.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.page;
    const page = parsePage(file);
    PAGE_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, page });
    return page;
  } catch {
    PAGE_CACHE.delete(file);
    return null;
  }
}

export function queryTokens(query) {
  const text = String(query || '');
  const tokens = new Set();
  for (const word of text.toLowerCase().split(/[\s，。？！、,.?!;；:：()（）\[\]【】"“”'']+/)) {
    if (word.length >= 2 && word.length <= 12 && !STOPWORDS.has(word)) tokens.add(word);
  }
  const chinese = text.match(/[\u3400-\u9fff]+/g) || [];
  for (const part of chinese) {
    const chars = Array.from(part);
    for (let index = 0; index < chars.length - 1; index += 1) {
      const bigram = chars[index] + chars[index + 1];
      if (!STOPWORDS.has(bigram)) tokens.add(bigram);
    }
  }
  return [...tokens].slice(0, 40);
}

/**
 * @param {string} brainRoot
 * @param {string} query
 * @param {{limit?:number, paths?:Set<string>}} options
 * @returns {Array<{path:string,title:string,summary:string,score:number,hits:string[]}>}
 */
export function searchKnowledge(brainRoot, query, { limit = 6, paths, minScore = 5 } = {}) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const root = path.join(brainRoot, KNOWLEDGE_ROOT);
  const files = walkMarkdown(root, root);
  const now = Date.now();
  const results = [];
  for (const file of files) {
    const relative = path.relative(brainRoot, file).split(path.sep).join('/');
    if (paths && paths.has(relative)) continue;
    const page = cachedPage(file);
    if (!page) continue;
    const title = page.title.toLowerCase();
    const headings = page.headings.toLowerCase();
    const summary = page.summary.toLowerCase();
    const body = page.content.toLowerCase();
    let score = 0;
    const hits = [];
    for (const token of tokens) {
      let weight = 0;
      if (title.includes(token)) weight += 5;
      if (headings.includes(token)) weight += 3;
      if (summary.includes(token)) weight += 2;
      if (body.includes(token)) weight += 1;
      if (weight) { score += weight; hits.push(token); }
    }
    if (!score) continue;
    try {
      const ageDays = (now - fs.statSync(file).mtimeMs) / 86400000;
      if (ageDays <= 30) score += 2;
    } catch { /* ignore */ }
    if (score < minScore) continue;
    results.push({ path: relative, title: page.title, summary: page.summary, score, hits });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function clearKnowledgeCache() {
  PAGE_CACHE.clear();
}
