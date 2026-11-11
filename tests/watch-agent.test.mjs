import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WATCH_AGENT_PRESET,
  buildAgentRoundPrompt,
  normalizeAgentRoundPayload,
  runAgentRound,
} from '../src/watch/agent-round.js';
import { loadQueue } from '../src/watch/queue.js';
import { loadBudget } from '../src/watch/budget.js';
import { reportPaths } from '../src/watch/report.js';

const NOW = new Date('2026-11-11T12:00:00+08:00');
const DAY = '2026-11-11';
const ROUTE = { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'low', source: 'test' };

const CRITERIA = `# 判据

## 人设

我是测试用知识采集员。

## 关注方向

1. 标准化、公文写作
2. 方法、案例

## 搜索词

标准化, 公文写作

## 关键词

### 必含
知识, 标准化

### 加分
实操, 案例

### 排除
带货, 探店
`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-watch-agent-'));
}

function prepareData(calibration = []) {
  const dataDir = tempDir();
  fs.mkdirSync(path.join(dataDir, 'watch'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'watch', 'criteria.md'), CRITERIA, 'utf8');
  if (calibration.length) {
    fs.writeFileSync(path.join(dataDir, 'watch', 'calibration.jsonl'), `${calibration.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  }
  return dataDir;
}

function video(bvid, overrides = {}) {
  return {
    bvid,
    title: `知识方法 ${bvid}`,
    author: '公开 UP',
    mid: 42,
    play: 100,
    duration: '08:00',
    pubdate: 1760000000,
    description: '实操案例',
    origin: 'keyword',
    originQuery: '知识',
    deep: false,
    ...overrides,
  };
}

function judgement(overrides = {}) {
  return { worth: true, confidence: 0.9, reason: '有可操作要点', points: ['要点一'], topics: ['知识'], ...overrides };
}

function makeClient(handler) {
  const state = { calls: [], stopped: false };
  const client = {
    async call(method, args, options) {
      state.calls.push({ method, args, options });
      if (handler) return handler(method, args, options, state);
      if (method === 'bili_followings') return { self_mid: 999, followings: [{ mid: 42, uname: '公开 UP', secret: 'do-not-forward' }] };
      if (method === 'bili_user_videos') return { videos: [video('BVUSER')], secret: 'do-not-forward' };
      if (method === 'bili_search') return { videos: [video('BVSEARCH')], secret: 'do-not-forward' };
      if (method === 'bili_subtitle') return { subtitle: '真实字幕', secret: 'do-not-forward' };
      throw new Error(`unexpected method ${method}`);
    },
    stop() { state.stopped = true; },
  };
  return { client, state };
}

function makeHost({ reply = '{"items":[]}', events, usageEvents = [], onFollowup, onCancel, whenIdle, derive = true, parent = true } = {}) {
  const state = {
    order: [],
    restrictions: [],
    registered: [],
    creates: [],
    prompts: [],
    disposed: false,
    toolResults: {},
    cancellations: [],
    descriptors: [],
    reply,
  };
  const registry = new Map();
  let streamListener;
  const tools = {
    restrict(filter) {
      state.order.push('restrict');
      state.restrictions.push(filter);
      registry.clear();
    },
    register(tool) {
      state.order.push(`register:${tool.name}`);
      state.registered.push(tool.name);
      registry.set(tool.name, tool);
    },
    schemas: () => [...registry.values()].map((tool) => ({ name: tool.name })),
  };
  const session = {
    messages: [],
    events: [],
    deriveMessages: () => session.messages,
    snapshotEvents: () => session.events,
    append(type, data) {
      if (type === 'subagent/descriptor') state.descriptors.push(data);
      session.events.push({ type, data, seq: session.events.length });
    },
  };
  const agent = {
    session,
    async followup(input) {
      state.prompts.push(input);
      if (onFollowup) await onFollowup({ state, tools: registry, input });
      const text = typeof state.reply === 'function' ? state.reply(state) : state.reply;
      if (derive) session.messages = [{ role: 'assistant', content: [{ type: 'text', text }] }];
      else streamListener?.({ frame: { type: 'chunk', chunk: { type: 'text-delta', text } } });
      session.append('request/header', { header: { tools: tools.schemas() } });
      session.events.push(
        ...usageEvents,
        ...(events || [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]),
      );
    },
    whenIdle: whenIdle || (async () => {}),
    cancel(cause) { state.cancellations.push(cause); onCancel?.(cause); },
  };
  const handle = { agent, async dispose() { state.disposed = true; } };
  const agents = {
    currentInitiator: () => (parent ? { id: 'parent-agent' } : undefined),
    async create(options) {
      state.creates.push(options);
      const agentCtx = {
        tools,
        on(name, listener) { if (name === 'agent/assistant-stream') streamListener = listener; },
      };
      await options.setup(agentCtx, agent);
      return handle;
    },
  };
  const presets = {
    async resolve(id) { return { id }; },
    async mount(agentCtx, id) {
      state.order.push(`mount:${id}`);
      // Simulate an inherited capability; restrict must remove it before scoped registration.
      registry.set('inherited_shell', { name: 'inherited_shell' });
    },
  };
  const ctx = { get: (name) => ({ agents, agentPresets: presets })[name] };
  return { ctx, state, registry };
}

async function runWithFakes({ dataDir = prepareData(), hostOptions = {}, clientHandler, config = {}, now = NOW } = {}) {
  let replyItems = [];
  try { replyItems = JSON.parse(hostOptions.reply || '{"items":[]}').items || []; } catch { /* invalid-output tests */ }
  const originalFollowup = hostOptions.onFollowup;
  const host = makeHost({
    ...hostOptions,
    onFollowup: async (context) => {
      if (replyItems.length) await context.tools.get('watch_bili_search').execute({ keyword: '知识' });
      return originalFollowup?.(context);
    },
  });
  const effectiveHandler = replyItems.length ? (method, args, options, state) => {
    if (method === 'bili_search') return { videos: replyItems };
    if (clientHandler) return clientHandler(method, args, options, state);
    if (method === 'bili_subtitle') return { subtitle: '真实字幕' };
    if (method === 'bili_followings') return { followings: [{ mid: 42, uname: '公开 UP' }] };
    if (method === 'bili_user_videos') return { videos: replyItems };
    throw new Error(`unexpected method ${method}`);
  } : clientHandler;
  const fake = makeClient(effectiveHandler);
  const result = await runAgentRound({
    ctx: host.ctx,
    dataDir,
    config,
    route: ROUTE,
    now,
    clientFactory: () => ({ client: fake.client }),
  });
  return { result, host, fake, dataDir };
}

function assertNoRoundArtifacts(dataDir) {
  assert.equal(fs.existsSync(reportPaths(dataDir, DAY).markdown), false);
  assert.equal(fs.existsSync(reportPaths(dataDir, DAY).jsonl), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'watch', 'queue.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'watch', 'budget.json')), false);
}

test('WATCH-AGENT-01 setup clears inherited tools and registers exactly four bounded read-only tools', async () => {
  const longSubtitle = '字'.repeat(8500);
  const { result, host, fake } = await runWithFakes({
    hostOptions: {
      onFollowup: async ({ state, tools }) => {
        assert.equal(tools.has('inherited_shell'), false);
        state.toolResults.followings = await tools.get('watch_bili_followings').execute({ page: 9 });
        state.toolResults.search = await tools.get('watch_bili_search').execute({ keyword: '知识', num: 99, page: 9, order: 'pubdate' });
        state.toolResults.user = await tools.get('watch_bili_user_videos').execute({ uid: 42, pn: 9, ps: 50, order: 'oldest' });
        state.toolResults.subtitle = await tools.get('watch_bili_subtitle').execute({ bvid: 'BVLONG' });
      },
    },
    clientHandler: (method) => {
      if (method === 'bili_followings') return {
        self_mid: 999,
        secret: 'do-not-forward',
        followings: Array.from({ length: 55 }, (_, index) => ({ mid: index + 1, uname: `UP${index + 1}`, secret: 'do-not-forward' })),
      };
      if (method === 'bili_search') return { videos: Array.from({ length: 12 }, (_, index) => video(`BVS${index}`, { secret: 'do-not-forward' })) };
      if (method === 'bili_user_videos') return { videos: Array.from({ length: 8 }, (_, index) => video(`BVU${index}`, { secret: 'do-not-forward' })) };
      if (method === 'bili_subtitle') return { subtitle: longSubtitle, secret: 'do-not-forward' };
      throw new Error('unexpected call');
    },
  });
  assert.equal(WATCH_AGENT_PRESET, 'watch-duty');
  assert.deepEqual(host.state.descriptors, [{ version: 3, mode: 'one-shot', provider: 'dsh-neocortex', label: 'watch-duty' }]);
  assert.equal(host.state.creates[0].meta.origin, 'subagent');
  assert.equal(host.state.creates[0].meta.parentSession, 'parent-agent');
  assert.deepEqual(result.requestToolNames, [...host.state.registered].sort());
  assert.deepEqual(host.state.restrictions, [{ allow: [] }]);
  assert.deepEqual(host.state.registered, ['watch_bili_followings', 'watch_bili_search', 'watch_bili_user_videos', 'watch_bili_subtitle']);
  assert.equal(host.state.order[0], 'mount:watch-duty');
  assert.equal(host.state.order[1], 'restrict');
  assert.deepEqual([...host.registry.keys()], host.state.registered);
  assert.equal(host.state.toolResults.followings.followings.length, 50);
  assert.equal(host.state.toolResults.search.videos.length, 10);
  assert.equal(host.state.toolResults.user.videos.length, 5);
  assert.equal(host.state.toolResults.subtitle.subtitle.length, 8000);
  assert.equal(host.state.toolResults.subtitle.truncated, true);
  assert.equal('secret' in host.state.toolResults.followings, false);
  assert.equal('secret' in host.state.toolResults.followings.followings[0], false);
  assert.equal('secret' in host.state.toolResults.search.videos[0], false);
  assert.deepEqual(fake.state.calls.map((call) => call.args), [
    { page: 1, page_size: 50 },
    { keyword: '知识', num: 10, page: 1, order: 'totalrank' },
    { uid: 42, pn: 1, ps: 5, order: 'pubdate' },
    { bvid: 'BVLONG' },
  ]);
  for (const call of fake.state.calls) assert.ok(call.options.timeoutMs > 0);
  for (const name of host.state.registered) {
    const tool = host.registry.get(name);
    assert.deepEqual(tool.output.schema, { type: 'object' });
    assert.equal(tool.output.render(null, { ok: true })[0].text, '{"ok":true}');
  }
  assert.equal(host.state.creates[0].meta.agentPreset, 'watch-duty');
  assert.equal(host.state.creates[0].meta.origin, 'subagent');
  assert.equal(host.state.creates[0].meta.delegationDepth, undefined);
  assert.deepEqual(host.state.creates[0].agentOptions, { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'low' });
  assert.equal(result.toolCallCount, 4);
  assert.ok(result.usage.estimated > 0);
  assert.equal(result.usage.measured, false);
  assert.equal(result.ok, true);
});

test('WATCH-AGENT-02 a verified round writes report, JSONL, queue and records measured usage', async () => {
  const items = [
    video('BVFOLLOW', { origin: 'following', originQuery: 'following:42', deep: true, judgement: judgement() }),
    video('BVEXPLORE', { title: '公文写作实用教程', origin: 'explore', originQuery: '公文写作 方法', description: '' }),
  ];
  const { result, host, fake, dataDir } = await runWithFakes({
    hostOptions: {
      reply: JSON.stringify({ items }),
      usageEvents: [
        { type: 'assistant/message', data: { usage: { totalTokens: 100 } } },
        { type: 'assistant/message', data: { message: { usage: { inputTokens: 30, outputTokens: 20 } } } },
      ],
      onFollowup: async ({ tools }) => { await tools.get('watch_bili_subtitle').execute({ bvid: 'BVFOLLOW' }); },
    },
  });
  assert.equal(result.mode, 'agent');
  assert.equal(result.summary.picked, 2);
  assert.equal(result.summary.deep, 1);
  assert.equal(result.summary.worth, 1);
  assert.equal(result.totalCandidates, 2);
  assert.deepEqual(result.picked.map((item) => item.bucket), ['following', 'exploration']);
  assert.deepEqual(result.picked.map((item) => item.deep), [true, false]);
  assert.deepEqual(result.usage, { tokens: 150, estimated: 0, measured: true, day: DAY, used: 150 });
  const paths = reportPaths(dataDir, DAY);
  assert.equal(fs.existsSync(paths.markdown), true);
  const records = fs.readFileSync(paths.jsonl, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[0].bvid, 'BVFOLLOW');
  assert.equal(records[0].worth, true);
  assert.equal(records[0].subtitle_missing, false);
  assert.equal(records[1].picked, 'scan');
  const queue = loadQueue(dataDir);
  assert.equal(queue.items.length, 2);
  assert.equal(queue.items[0].points[0], '要点一');
  assert.equal(result.queue.count, 2);
  assert.equal(host.state.disposed, true);
  assert.equal(fake.state.stopped, true);
});

test('WATCH-AGENT-03 missing subtitles and low confidence can never survive as worth=true', async () => {
  const items = [
    video('BVNOSUB', { deep: true, judgement: { ...judgement({ confidence: 0.99 }), subtitleMissing: false } }),
    video('BVLOW', { deep: true, judgement: judgement({ confidence: 0.4 }) }),
    video('BVHIGH', { deep: true, judgement: judgement() }),
    video('BVCLAIM', { deep: false, judgement: judgement() }),
  ];
  const { result, dataDir } = await runWithFakes({
    config: { deepPerRound: 2 },
    hostOptions: {
      reply: JSON.stringify({ items }),
      onFollowup: async ({ tools }) => {
        await tools.get('watch_bili_subtitle').execute({ bvid: 'BVNOSUB' });
        await tools.get('watch_bili_subtitle').execute({ bvid: 'BVLOW' });
        await tools.get('watch_bili_subtitle').execute({ bvid: 'BVHIGH' });
      },
    },
    clientHandler: (_method, args) => ({ subtitle: args.bvid === 'BVNOSUB' ? '' : '实际非空字幕' }),
  });
  const byId = new Map(result.picked.map((item) => [item.bvid, item]));
  assert.equal(byId.get('BVNOSUB').deep, false, 'empty subtitle is not deep-read evidence');
  assert.equal(byId.get('BVNOSUB').worth, null);
  assert.equal(byId.get('BVLOW').deep, true);
  assert.equal(byId.get('BVLOW').worth, null);
  assert.equal(byId.get('BVHIGH').worth, true);
  assert.equal(byId.get('BVCLAIM').worth, null, 'deep:false model judgement is ignored');
  const records = fs.readFileSync(reportPaths(dataDir, DAY).jsonl, 'utf8').trim().split('\n').map(JSON.parse);
  const low = records.find((item) => item.bvid === 'BVLOW');
  assert.match(low.reason, /低于 0\.5/);
  const missing = records.find((item) => item.bvid === 'BVNOSUB');
  assert.equal(missing.subtitle_missing, null);
  assert.equal(records.some((item) => item.bvid === 'BVNOSUB' && item.worth === true), false);
});

test('WATCH-AGENT-04 normalization filters judged, excluded and duplicate BV and enforces scan/deep limits', () => {
  const payload = {
    items: [
      { title: '没有 BV' },
      video('BVJUDGED'),
      video('BVEXCLUDED', { title: '知识带货专场' }),
      video('BVONE', { deep: true, judgement: judgement() }),
      video('BVONE', { deep: true, judgement: judgement() }),
      video('BVTWO', { origin: 'explore', deep: true, judgement: judgement() }),
      video('BVTHREE', { origin: 'following', deep: true, judgement: judgement() }),
      video('BVFOUR', { deep: true, judgement: judgement() }),
    ],
  };
  const result = normalizeAgentRoundPayload(payload, {
    criteria: {
      persona: '', directions: ['标准化'], queries: [], must: ['知识'], plus: [], exclude: ['带货'],
    },
    judged: new Set(['BVJUDGED']),
    scanPerRound: 2,
    deepPerRound: 1,
    subtitles: new Map(['BVONE', 'BVTWO', 'BVTHREE', 'BVFOUR'].map((bvid) => [bvid, '字幕'])),
  });
  assert.equal(result.totalCandidates, 7);
  assert.deepEqual(result.picked.map((entry) => entry.video.bvid), ['BVONE', 'BVTWO']);
  assert.deepEqual(result.picked.map((entry) => entry.bucket), ['keyword', 'exploration']);
  assert.deepEqual([...result.deepById.keys()], ['BVONE']);
});

test('WATCH-AGENT-05 turn/end error is fatal even when idle and final JSON exist', async () => {
  const dataDir = prepareData();
  const host = makeHost({
    reply: JSON.stringify({ items: [video('BVERROR')] }),
    events: [{ type: 'turn/end', data: { reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'synthetic transport boom' } } } }],
  });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => {
    assert.equal(error.code, 'TRANSPORT');
    assert.match(error.message, /synthetic transport boom/);
    return true;
  });
  assertNoRoundArtifacts(dataDir);
  assert.equal(host.state.disposed, true);
  assert.equal(fake.state.stopped, true);
});

test('WATCH-AGENT-06 invalid final JSON produces no round artifacts', async () => {
  const dataDir = prepareData();
  const host = makeHost({ reply: '这不是 JSON，也不应被当成成功' });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'AGENT_INVALID_OUTPUT');
  assertNoRoundArtifacts(dataDir);
  assert.equal(host.state.disposed, true);
  assert.equal(fake.state.stopped, true);
});

test('WATCH-AGENT-07 the thirtieth tool call is allowed and the thirty-first is rejected', async () => {
  const dataDir = prepareData();
  let observedCode;
  const host = makeHost({
    onFollowup: async ({ tools }) => {
      for (let index = 0; index < 31; index += 1) {
        try { await tools.get('watch_bili_subtitle').execute({ bvid: `BV${index}` }); }
        catch (error) { observedCode = error.code; throw error; }
      }
    },
  });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'AGENT_TOOL_LIMIT');
  assert.equal(observedCode, 'AGENT_TOOL_LIMIT');
  assert.equal(fake.state.calls.length, 30);
  assertNoRoundArtifacts(dataDir);
  assert.equal(host.state.disposed, true);
  assert.equal(fake.state.stopped, true);
});

test('WATCH-AGENT-08 prompt carries criteria, exploration, eight examples, limits and untrusted-data rules', () => {
  const prompt = buildAgentRoundPrompt({
    criteria: {
      persona: '测试人设', directions: ['方向甲'], must: ['必含甲'], plus: ['加分乙'], exclude: ['排除丙'],
    },
    queries: ['搜索甲'],
    exploreQueries: ['方向甲 方法'],
    examples: Array.from({ length: 10 }, (_, index) => ({ bvid: `BV${index}`, title: `例子${index}`, decision: index % 2 ? 'rejected' : 'received' })),
    judged: new Set(['BVOLD']),
    scanPerRound: 4,
    deepPerRound: 2,
  });
  assert.match(prompt, /测试人设/);
  assert.match(prompt, /方向甲/);
  assert.match(prompt, /必含甲/);
  assert.match(prompt, /加分乙/);
  assert.match(prompt, /排除丙/);
  assert.match(prompt, /搜索甲/);
  assert.match(prompt, /方向甲 方法/);
  assert.match(prompt, /例子7/);
  assert.equal(prompt.includes('例子8'), false);
  assert.match(prompt, /BVOLD/);
  assert.match(prompt, /最多选择 4 条/);
  assert.match(prompt, /最多 2 条/);
  assert.match(prompt, /不可信数据/);
  assert.match(prompt, /不得输出 Markdown/);
  assert.match(prompt, /watch_bili_followings/);
});

test('WATCH-AGENT-09 unavailable Host services fail before creating a client', async () => {
  let clientCreated = false;
  await assert.rejects(runAgentRound({
    ctx: { get: () => undefined },
    dataDir: prepareData(),
    route: ROUTE,
    clientFactory: () => { clientCreated = true; return { client: makeClient().client }; },
  }), (error) => error.code === 'AGENT_UNAVAILABLE');
  assert.equal(clientCreated, false);
});

test('WATCH-AGENT-10 idle timeout cancels the agent and always disposes agent and client', async () => {
  const dataDir = prepareData();
  let rejectIdle;
  const host = makeHost({
    whenIdle: () => new Promise((_, reject) => { rejectIdle = reject; }),
    onCancel: () => rejectIdle?.(new Error('cancelled')),
  });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx,
    dataDir,
    route: ROUTE,
    now: NOW,
    timeoutMs: 10,
    clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'AGENT_TIMEOUT');
  assert.deepEqual(host.state.cancellations, [{ kind: 'hook', reason: 'watch-agent-timeout' }]);
  assertNoRoundArtifacts(dataDir);
  assert.equal(host.state.disposed, true);
  assert.equal(fake.state.stopped, true);
});

test('WATCH-AGENT-11 final items must come from fetched candidates and use fetched metadata', () => {
  const result = normalizeAgentRoundPayload({
    items: [
      video('BVREAL', { title: '模型伪造标题' }),
      video('BVHALLUCINATED', { title: '知识伪造视频' }),
    ],
  }, {
    criteria: { persona: '', directions: [], queries: [], must: ['知识'], plus: [], exclude: [] },
    candidates: new Map([['BVREAL', video('BVREAL', { title: '知识真实标题', play: 321 })]]),
  });
  assert.equal(result.picked.length, 1);
  assert.equal(result.picked[0].video.bvid, 'BVREAL');
  assert.equal(result.picked[0].video.title, '知识真实标题');
  assert.equal(result.picked[0].video.play, 321);
});

test('WATCH-AGENT-12 valid JSON without any successful fetch is not a completed round', async () => {
  const dataDir = prepareData();
  const host = makeHost({ reply: '{"items":[]}' });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'AGENT_NO_EVIDENCE');
  assertNoRoundArtifacts(dataDir);
  assert.equal(host.state.disposed, true);
});

test('WATCH-AGENT-13 failed agent rounds record measured partial usage once', async () => {
  const dataDir = prepareData();
  const host = makeHost({ reply: 'bad json', usageEvents: [{ type: 'assistant/message', data: { usage: { totalTokens: 25 } } }] });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'AGENT_INVALID_OUTPUT' && error.partialUsage?.tokens === 25);
  assert.equal(loadBudget(dataDir, NOW).used, 25);
  assert.equal(fs.existsSync(reportPaths(dataDir, DAY).markdown), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'watch', 'queue.json')), false);
});

test('WATCH-AGENT-14 artifact I/O errors are commit failures, not fallback-safe model failures', async () => {
  const dataDir = prepareData();
  fs.writeFileSync(path.join(dataDir, 'watch', 'out'), 'blocks directory creation', 'utf8');
  const host = makeHost({
    reply: '{"items":[]}',
    onFollowup: async ({ tools }) => { await tools.get('watch_bili_followings').execute({}); },
  });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'WATCH_COMMIT_FAILED');
});

test('WATCH-AGENT-15 scheduled parentless rounds keep a truthful descriptor without a runtime parent', async () => {
  const { result, host } = await runWithFakes({
    hostOptions: {
      parent: false,
      onFollowup: async ({ tools }) => { await tools.get('watch_bili_followings').execute({}); },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(host.state.creates[0].parentAgent, undefined);
  assert.equal(host.state.creates[0].meta.origin, 'subagent');
  assert.equal(host.state.creates[0].meta.parentSession, undefined);
  assert.equal(host.state.creates[0].meta.delegationDepth, undefined);
});

test('WATCH-AGENT-16 max-tokens is incomplete even when final JSON happens to parse', async () => {
  const dataDir = prepareData();
  const host = makeHost({
    reply: '{"items":[]}',
    events: [{ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }],
    onFollowup: async ({ tools }) => { await tools.get('watch_bili_followings').execute({}); },
  });
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'max-tokens');
  assertNoRoundArtifacts(dataDir);
});

test('WATCH-AGENT-17 late Host team-tool injection fails the real request contract', async () => {
  const dataDir = prepareData();
  const host = makeHost({
    onFollowup: async () => { registryLeak(); },
  });
  function registryLeak() {
    host.registry.set('spawn_teammate', { name: 'spawn_teammate' });
  }
  const fake = makeClient();
  await assert.rejects(runAgentRound({
    ctx: host.ctx, dataDir, route: ROUTE, now: NOW, clientFactory: () => ({ client: fake.client }),
  }), (error) => error.code === 'AGENT_TOOL_LEAK' && error.nonFallback === true);
  assertNoRoundArtifacts(dataDir);
  assert.equal(host.state.disposed, true);
});
