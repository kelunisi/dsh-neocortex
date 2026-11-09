/**
 * 判据文件（watch/criteria.md）：人设 + 关注方向 + 关键词 + 探索规则。
 * 解析是宽容的：少一段、写错格式都不会让整轮失败，只是那一段当空。
 */

import fs from 'node:fs';
import path from 'node:path';

export const CRITERIA_FILE = 'criteria.md';

export const DEFAULT_CRITERIA = `# 喂养判据 v0.1

## 人设（喂给模型的一句话）

我是一个需要持续吸收可落地知识的人。

## 关注方向（按优先级）

1. 我的工作与专业
2. 我在做的项目

## 关键词

### 必含
知识, 方法

### 加分
实操, 案例

### 排除
鸡汤, 带货
`;

export function criteriaFile(dataDir) {
  return path.join(dataDir, 'watch', CRITERIA_FILE);
}

export function ensureCriteria(dataDir) {
  const file = criteriaFile(dataDir);
  if (fs.existsSync(file)) return { file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DEFAULT_CRITERIA, 'utf8');
  return { file, created: true };
}

function splitKeywords(text) {
  return String(text || '')
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseCriteria(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const result = { persona: '', directions: [], queries: [], must: [], plus: [], exclude: [], exploration: [], raw: markdown };
  let section = '';
  let keywordGroup = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^##\s+/.test(line)) {
      section = line.replace(/^##\s+/, '').trim();
      keywordGroup = '';
      continue;
    }
    if (/^###\s+/.test(line)) {
      keywordGroup = line.replace(/^###\s+/, '').trim();
      continue;
    }
    if (line.startsWith('>') || line.startsWith('#')) continue;
    if (/^人设/.test(section)) {
      result.persona = result.persona ? `${result.persona} ${line}` : line;
    } else if (/^关注方向/.test(section) && /^(\d+[.、]|[-*])\s*/.test(line)) {
      result.directions.push(line.replace(/^(\d+[.、]|[-*])\s*/, '').trim());
    } else if (/^搜索词/.test(section)) {
      result.queries.push(...splitKeywords(line.replace(/^(\d+[.、]|[-*])\s*/, '')));
    } else if (/^关键词/.test(section)) {
      if (/必含/.test(keywordGroup)) result.must.push(...splitKeywords(line));
      else if (/加分/.test(keywordGroup)) result.plus.push(...splitKeywords(line));
      else if (/排除/.test(keywordGroup)) result.exclude.push(...splitKeywords(line));
    } else if (/^探索/.test(section) && /^[-*]\s*/.test(line)) {
      result.exploration.push(line.replace(/^[-*]\s*/, '').trim());
    }
  }
  return result;
}

export function loadCriteria(dataDir) {
  const { file } = ensureCriteria(dataDir);
  try {
    return { file, criteria: parseCriteria(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { file, criteria: parseCriteria(DEFAULT_CRITERIA), error: String(error?.message || error) };
  }
}

export function directionTokens(criteria) {
  const out = [];
  for (const direction of criteria?.directions || []) {
    for (const token of String(direction).split(/[、，,;；/\s]+/)) {
      const value = token.trim();
      if (value.length >= 2 && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

const UTILITY_TERMS = ['教程', '模板', '模版', '设置', '步骤', '实操', '方法', '案例', '清单', '流程', '指南', '技巧'];

/**
 * @returns {{score:number, hits:string[], excluded:boolean, reason:string, directionHits:string[], utilityHits:string[]}}
 */
export function scoreCandidate(video, criteria) {
  const haystack = `${video?.title || ''} ${video?.description || ''}`.toLowerCase();
  const excludedHits = (criteria.exclude || []).filter((word) => word && haystack.includes(String(word).toLowerCase()));
  if (excludedHits.length) {
    return { score: -1, hits: excludedHits, excluded: true, reason: `命中排除词：${excludedHits.join('/')}`, directionHits: [], utilityHits: [] };
  }
  const mustHits = (criteria.must || []).filter((word) => word && haystack.includes(String(word).toLowerCase()));
  const plusHits = (criteria.plus || []).filter((word) => word && haystack.includes(String(word).toLowerCase()));
  const directionHits = directionTokens(criteria).filter((word) => haystack.includes(word.toLowerCase()));
  // 只认标题里的"方法/教程/模板"信号：简介里的词太容易把资讯/广告带进来。
  const utilityHits = UTILITY_TERMS.filter((word) => String(video?.title || '').toLowerCase().includes(word));
  const score = mustHits.length * 10 + plusHits.length * 2;
  const reason = mustHits.length
    ? `必含词 ${mustHits.slice(0, 4).join('/')}${plusHits.length ? `；加分 ${plusHits.slice(0, 3).join('/')}` : ''}`
    : plusHits.length ? `加分词 ${plusHits.slice(0, 4).join('/')}` : '无关键词命中（探索候选）';
  return { score, hits: [...mustHits, ...plusHits], excluded: false, reason, directionHits, utilityHits };
}
