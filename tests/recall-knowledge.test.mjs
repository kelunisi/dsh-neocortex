import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.js';
import { NeocortexRuntime } from '../src/runtime.js';
import { resolveConfig } from '../src/defaults.js';
import { clearKnowledgeCache, searchKnowledge } from '../src/knowledge.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'fixtures', 'brain');
const config = resolveConfig();

function makeBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-recall-l2-'));
  const brain = path.join(dir, 'brain');
  fs.cpSync(fixture, brain, { recursive: true });
  const pages = {
    '知识库/来源摘要/B站-信息报送三段式.md': '# 信息报送三段式\n\n> 摘要：背景、做法、成效三段式写法，缺一段容易被退。\n\n正文：信息报送要写清楚背景、做法、成效。\n',
    '知识库/概念知识/基层减负.md': '# 基层减负\n\n> 摘要：数据一次采集、多口复用，减少基层重复填报。\n\n正文：基层减负的抓手是数据复用。\n',
    '知识库/综合分析/公文写作六条路径.md': '# 公文写作六条路径\n\n> 摘要：从领导讲话派生选题的六条路径。\n\n正文：政策热点、市场需求、技术创新等。\n',
    '知识库/来源摘要/B站-每日金价 黄金走势.md': '# 每日金价 黄金走势\n\n> 摘要：金价与黄金走势的每日跟踪。\n\n正文：金价 黄金 走势。\n',
    '知识库/来源摘要/技能库.md': '# 技能库\n\n> 摘要：技能、插件、工作区、工具。\n\n正文：技能 插件 工作区 工具。\n',
    '知识库/概念知识/流程说明.md': '# 流程说明\n\n> 摘要：一段与标题无关的正文。\n\n正文：这里顺便提到金价和走势，但标题不是这个主题。\n',
  };
  for (const [relative, content] of Object.entries(pages)) {
    const file = path.join(brain, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return { dir, brain };
}

function message(text) {
  return { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function runtimeAt(directory, brainRoot) {
  const ledger = new Ledger(path.join(directory, 'ledger.json'));
  return new NeocortexRuntime({
    ledger,
    brainRoot,
    config,
    probeFile: path.join(directory, 'events.jsonl'),
    ignoreSessionPrefix: '',
  });
}

test('R1-01 knowledge search ranks title hits and returns summaries only', () => {
  clearKnowledgeCache();
  const { brain } = makeBrain();
  const results = searchKnowledge(brain, '信息报送怎么写', { limit: 5 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].path, '知识库/来源摘要/B站-信息报送三段式.md');
  assert.match(results[0].summary, /三段式/);
  assert.equal(results[0].content, undefined, 'only summary/title/hits are returned');
});

test('R1-02 first turn injects personal payload plus knowledge recall', () => {
  clearKnowledgeCache();
  const { dir, brain } = makeBrain();
  const runtime = runtimeAt(dir, brain);
  const agent = { id: 'session-r1-first' };
  const result = runtime.prepareInjection(agent, [message('信息报送三段式怎么写')], 1);
  assert.equal(result.injected, true);
  assert.ok(result.payload, 'personal payload still present');
  assert.ok(result.recall, 'knowledge recall present');
  assert.ok(result.recall.paths.includes('知识库/来源摘要/B站-信息报送三段式.md'));
  assert.ok(result.messages.length >= 3, 'user message + personal + knowledge');
  const knowledgeMessage = result.messages.at(-1);
  assert.match(knowledgeMessage.content[0].text, /\[知识库\]/);
});

test('R1-03 turns 2-4 inject query-relevant knowledge without repeating pages', () => {
  clearKnowledgeCache();
  const { dir, brain } = makeBrain();
  const runtime = runtimeAt(dir, brain);
  const agent = { id: 'session-r1-turns' };
  runtime.prepareInjection(agent, [message('信息报送三段式怎么写')], 1);
  const second = runtime.prepareInjection(agent, [message('公文写作六条路径')], 2);
  assert.equal(second.injected, true);
  assert.equal(second.payload, undefined, 'no personal overview on later turns');
  assert.ok(second.recall.paths.includes('知识库/综合分析/公文写作六条路径.md'));
  assert.equal(second.recall.paths.includes('知识库/来源摘要/B站-信息报送三段式.md'), false, 'already injected page is skipped');
  assert.ok(second.messages.at(-1).content[0].text.length <= 600);
});

test('R1-04 turn five stops proactive recall', () => {
  clearKnowledgeCache();
  const { dir, brain } = makeBrain();
  const runtime = runtimeAt(dir, brain);
  const agent = { id: 'session-r1-stop' };
  runtime.prepareInjection(agent, [message('信息报送')], 1);
  runtime.prepareInjection(agent, [message('公文写作')], 2);
  runtime.prepareInjection(agent, [message('基层减负')], 3);
  runtime.prepareInjection(agent, [message('标准化')], 4);
  const fifth = runtime.prepareInjection(agent, [message('信息报送')], 5);
  assert.equal(fifth.injected, false);
});

test('R1-05 compaction re-opens knowledge recall', () => {
  clearKnowledgeCache();
  const { dir, brain } = makeBrain();
  const runtime = runtimeAt(dir, brain);
  const agent = { id: 'session-r1-compaction' };
  runtime.prepareInjection(agent, [message('信息报送')], 1);
  runtime.observeEvent(agent, { type: 'compaction/end', seq: 5, data: { trigger: 'manual' } });
  const after = runtime.prepareInjection(agent, [message('基层减负')], 6);
  assert.equal(after.injected, true);
  assert.ok(after.recall.paths.includes('知识库/概念知识/基层减负.md'));
});

test('R1-06 runtime context text does not pollute the recall query', () => {
  clearKnowledgeCache();
  const { dir, brain } = makeBrain();
  const runtime = runtimeAt(dir, brain);
  const agent = { id: 'session-r1-context' };
  const contextMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    source: { kind: 'runtime-context' },
    content: [{ type: 'text', text: '技能 插件 工作区 工具 知识库' }],
  };
  const result = runtime.prepareInjection(agent, [contextMessage, message('金价走势怎么样')], 1);
  assert.equal(result.injected, true);
  assert.ok(result.recall.paths.includes('知识库/来源摘要/B站-每日金价 黄金走势.md'));
  assert.equal(result.recall.paths.includes('知识库/来源摘要/技能库.md'), false, 'runtime-context words must not steer recall');
});

test('R1-07 body-only mentions and generic process words do not trigger recall', () => {
  clearKnowledgeCache();
  const { brain } = makeBrain();
  const byGold = searchKnowledge(brain, '金价走势', { limit: 10 });
  assert.equal(byGold.some((page) => page.path === '知识库/概念知识/流程说明.md'), false, 'title must match, body-only mentions are not enough');
  assert.equal(searchKnowledge(brain, '流程 继续 需要', { limit: 10 }).length, 0, 'generic process words produce no recall');
});
