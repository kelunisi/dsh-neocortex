import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentProbe } from '../src/watch/agent-probe.js';

function fakeHost({ turnKind = 'completed', failure = null, reply = '收到', requestTools = [] } = {}) {
  const calls = { restrictions: [], mounts: [], creates: [], descriptors: [] };
  let streamListener;
  const events = [];
  const session = {
    deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: reply }] }],
    snapshotEvents: () => [...events, { type: 'turn/end', data: { reason: { kind: turnKind, ...(failure ? { error: failure } : {}) } } }],
    append(type, data) {
      if (type === 'subagent/descriptor') calls.descriptors.push(data);
      events.push({ type, data });
    },
  };
  const handle = {
    agent: {
      followup() {
        session.append('request/header', { header: { tools: requestTools.map((name) => ({ name })) } });
        streamListener?.({ frame: { type: 'chunk', chunk: { type: 'text-delta', text: reply } } });
      },
      async whenIdle() {},
      session,
    },
    async dispose() { calls.disposed = true; },
  };
  const agents = {
    currentInitiator: () => ({ id: 'parent' }),
    async create(options) {
      calls.creates.push(options);
      const tools = {
        restrict(filter) { calls.restrictions.push(filter); },
        schemas: () => [],
      };
      await options.setup({
        tools,
        get: (name) => ({ tools, systemPrompt: {} })[name],
        on: (name, listener) => { if (name === 'agent/assistant-stream') streamListener = listener; },
      }, handle.agent);
      return handle;
    },
  };
  const ctx = {
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'agentPresets') return {
        resolve: async (id) => ({ id }),
        mount: async (_ctx, id) => { calls.mounts.push(id); },
      };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) };
      return undefined;
    },
  };
  return { ctx, calls };
}

test('AGENT-PROBE-01 watch-duty probe requires completed turn and zero visible tools', async () => {
  const { ctx, calls } = fakeHost();
  const result = await runAgentProbe({ ctx, dataDir: 'unused' });
  assert.equal(result.ok, true);
  assert.equal(result.setup.presetId, 'watch-duty');
  assert.equal(result.setup.restricted, true);
  assert.deepEqual(result.setup.toolNames, []);
  assert.deepEqual(result.requestToolNames, []);
  assert.equal(result.requestHeaderCount, 1);
  assert.deepEqual(calls.descriptors, [{ version: 3, mode: 'one-shot', provider: 'dsh-neocortex', label: 'watch-duty' }]);
  assert.equal(calls.creates[0].meta.origin, 'subagent');
  assert.equal(calls.creates[0].meta.parentSession, 'parent');
  assert.deepEqual(calls.restrictions, [{ allow: [] }]);
  assert.deepEqual(calls.mounts, ['watch-duty']);
  assert.equal(result.parentAgent, true);
  assert.equal(result.turn.kind, 'completed');
  assert.equal(calls.disposed, true);
});

test('AGENT-PROBE-02 an idle transport failure is not reported as success', async () => {
  const { ctx } = fakeHost({ turnKind: 'error', failure: { code: 'TRANSPORT', message: 'failed' }, reply: '' });
  const result = await runAgentProbe({ ctx, dataDir: 'unused' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe-turn-error');
  assert.equal(result.turn.failure.code, 'TRANSPORT');
});

test('AGENT-PROBE-03 explicit provider/model only override the probe route', async () => {
  const { ctx, calls } = fakeHost();
  const result = await runAgentProbe({ ctx, dataDir: 'unused', config: { provider: 'deepseek-account', model: 'deepseek-flash' } });
  assert.equal(result.route.provider, 'deepseek-account');
  assert.equal(calls.creates[0].agentOptions.provider, 'deepseek-account');
  assert.equal(calls.creates[0].agentOptions.model, 'deepseek-flash');
});

test('AGENT-PROBE-04 an aborted probe does not fake completion and still disposes', async () => {
  const { ctx, calls } = fakeHost();
  const controller = new AbortController();
  controller.abort();
  const result = await runAgentProbe({ ctx, dataDir: 'unused', signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe-aborted');
  assert.equal(calls.disposed, true);
});

test('AGENT-PROBE-05 a broken preset fails before creating a model session', async () => {
  const { ctx, calls } = fakeHost();
  const originalGet = ctx.get;
  ctx.get = (name) => name === 'agentPresets'
    ? { resolve: async () => ({ id: 'watch-duty', broken: 'missing persona' }), mount: async () => {} }
    : originalGet(name);
  const result = await runAgentProbe({ ctx, dataDir: 'unused' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preset-broken');
  assert.equal(calls.creates.length, 0);
});

test('AGENT-PROBE-06 late team tools in the real request fail a previously clean setup', async () => {
  const { ctx, calls } = fakeHost({ requestTools: ['spawn_teammate', 'send_message'] });
  const result = await runAgentProbe({ ctx, dataDir: 'unused' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'probe-tool-leak');
  assert.deepEqual(result.requestToolNames, ['send_message', 'spawn_teammate']);
  assert.deepEqual(result.setup.toolNames, []);
  assert.equal(calls.disposed, true);
});
