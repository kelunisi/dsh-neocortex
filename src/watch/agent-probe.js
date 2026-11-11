/**
 * P4.5 的 agent 档 spike：只验证“宿主能不能拉起一个受限会话并拿到文本”，
 * 不参与正常的 code 档跑轮。失败只返回诊断，不影响已工作的功能。
 */

import crypto from 'node:crypto';
import { WATCH_AGENT_PRESET } from './agent-round.js';

function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function runAgentProbe({ ctx, dataDir, config = {}, signal }) {
  const agents = ctx?.get?.('agents');
  if (!agents?.create) return { ok: false, reason: 'agents-service-missing' };
  const presets = ctx.get?.('agentPresets');
  if (!presets?.resolve || !presets?.mount) return { ok: false, reason: 'presets-service-missing' };
  let presetId = null;
  try {
    const preset = await presets.resolve(WATCH_AGENT_PRESET);
    presetId = preset?.id || null;
    if (!presetId) return { ok: false, reason: 'preset-unavailable', preset: WATCH_AGENT_PRESET };
    if (preset?.broken) return { ok: false, reason: 'preset-broken', preset: WATCH_AGENT_PRESET, detail: preset.broken };
  } catch (error) {
    return { ok: false, reason: 'preset-unavailable', preset: WATCH_AGENT_PRESET, message: String(error?.message || error).slice(0, 300) };
  }
  const selected = ctx.get?.('agentDefaultModel')?.currentSelection?.() || {};
  const route = config.provider && config.model
    ? { provider: config.provider, model: config.model }
    : selected;
  let parentAgent;
  try { parentAgent = ctx.get?.('agents')?.currentInitiator?.() || undefined; } catch { parentAgent = undefined; }
  let streamed = '';
  let setupInfo = {};
  let handle;
  let timedOut = false;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    handle?.agent?.cancel?.({ kind: 'hook', reason: 'watch-probe-aborted' });
  };
  const sessionId = `watch-probe-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  try {
    handle = await agents.create({
      sessionId,
      parentAgent,
      signal,
      agentOptions: route.provider && route.model ? { provider: route.provider, model: route.model } : undefined,
      meta: { cwd: dataDir, agentPreset: presetId || undefined },
      setup: async (agentCtx, agent) => {
        setupInfo = {
          hasOn: typeof agentCtx?.on === 'function',
          hasTools: Boolean(agentCtx?.get?.('tools')),
          hasSystemPrompt: Boolean(agentCtx?.get?.('systemPrompt')),
          presetId,
        };
        if (presetId && typeof presets?.mount === 'function') {
          await presets.mount(agentCtx, presetId);
        }
        if (typeof agentCtx?.tools?.restrict !== 'function') {
          throw new Error('当前宿主缺少 agent scoped tools.restrict()，无法保证只读工具面');
        }
        // preset 只是能力声明，不会自动移除 Host 的全局工具。先清空所有
        // 继承工具；探针本身不需要任何 scoped 工具。
        agentCtx.tools.restrict({ allow: [] });
        setupInfo.restricted = true;
        setupInfo.toolNames = agentCtx.tools.schemas?.(agent)?.map?.((tool) => tool.name) || [];
        if (typeof agentCtx?.on === 'function') {
          agentCtx.on('agent/assistant-stream', ({ frame } = {}) => {
            if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
              streamed += frame.chunk.text;
            }
          });
        }
      },
    });
    let idle = false;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    if (typeof handle.agent?.followup === 'function' && !aborted) {
      handle.agent.followup({
        content: [{ type: 'text', text: '只回答两个字：收到。不要调用任何工具。' }],
        source: { kind: 'dsh-neocortex' },
      });
      const outcome = await Promise.race([
        Promise.resolve(handle.agent.whenIdle()).then(() => 'idle'),
        wait(45000).then(() => 'timeout'),
      ]);
      if (outcome === 'timeout') {
        timedOut = true;
        handle.agent.cancel?.({ kind: 'hook', reason: 'watch-probe-timeout' });
        await Promise.race([Promise.resolve(handle.agent.whenIdle()), wait(5000)]);
      }
      idle = outcome === 'idle';
    }
    let messages = [];
    try { messages = handle.agent?.session?.deriveMessages?.() || []; } catch { messages = []; }
    const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
    const events = handle.agent?.session?.snapshotEvents?.() || [];
    const lastTurn = [...events].reverse().find((event) => event?.type === 'turn/end');
    const turnKind = lastTurn?.data?.reason?.kind || null;
    const turnFailure = lastTurn?.data?.reason?.error || lastTurn?.data?.reason?.failure || null;
    const ok = idle && !timedOut && !aborted && presetId === WATCH_AGENT_PRESET && setupInfo.restricted === true
      && setupInfo.toolNames?.length === 0 && streamed.trim() === '收到'
      && turnKind === 'completed';
    return {
      ok,
      ...(ok ? {} : { reason: timedOut ? 'probe-timeout' : aborted ? 'probe-aborted' : turnFailure ? 'probe-turn-error' : 'probe-contract-failed' }),
      sessionId,
      keys: Object.keys(handle.agent || {}),
      setup: setupInfo,
      parentAgent: Boolean(parentAgent),
      idle,
      streamed: streamed.slice(0, 500),
      messageCount: messages.length,
      lastAssistant: lastAssistant ? JSON.stringify(lastAssistant.content).slice(0, 500) : null,
      turn: { kind: turnKind, failure: turnFailure ? { code: turnFailure.code || null, message: String(turnFailure.message || '').slice(0, 300) } : null },
      route: { provider: route.provider || null, model: route.model || null },
    };
  } catch (error) {
    return { ok: false, reason: 'create-or-run-failed', message: String(error?.stack || error).slice(0, 800) };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    try { await handle?.dispose?.(); } catch { /* ignore */ }
  }
}
