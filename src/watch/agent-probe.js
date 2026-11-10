/**
 * P4.5 的 agent 档 spike：只验证“宿主能不能拉起一个受限会话并拿到文本”，
 * 不参与正常的 code 档跑轮。失败只返回诊断，不影响已工作的功能。
 */

import crypto from 'node:crypto';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAgentProbe({ ctx, dataDir, config = {} }) {
  const agents = ctx?.get?.('agents');
  if (!agents?.create) return { ok: false, reason: 'agents-service-missing' };
  const route = ctx.get?.('agentDefaultModel')?.currentSelection?.() || {};
  let streamed = '';
  let setupInfo = {};
  let handle;
  const sessionId = `watch-probe-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  try {
    handle = await agents.create({
      sessionId,
      agentOptions: route.provider && route.model ? { provider: route.provider, model: route.model } : undefined,
      meta: { cwd: dataDir, origin: 'subagent' },
      setup: (agentCtx) => {
        setupInfo = {
          hasOn: typeof agentCtx?.on === 'function',
          hasTools: Boolean(agentCtx?.get?.('tools')),
          hasSystemPrompt: Boolean(agentCtx?.get?.('systemPrompt')),
        };
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
    if (typeof handle.agent?.followup === 'function') {
      handle.agent.followup({
        content: [{ type: 'text', text: '只回答两个字：收到。不要调用任何工具。' }],
        source: { kind: 'dsh-neocortex' },
      });
      await Promise.race([
        Promise.resolve(handle.agent.whenIdle()).then(() => { idle = true; }),
        wait(45000),
      ]);
    }
    let messages = [];
    try { messages = handle.agent?.session?.deriveMessages?.() || []; } catch { messages = []; }
    const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
    return {
      ok: true,
      sessionId,
      keys: Object.keys(handle.agent || {}),
      setup: setupInfo,
      idle,
      streamed: streamed.slice(0, 500),
      messageCount: messages.length,
      lastAssistant: lastAssistant ? JSON.stringify(lastAssistant.content).slice(0, 500) : null,
      route: { provider: route.provider || null, model: route.model || null },
    };
  } catch (error) {
    return { ok: false, reason: 'create-or-run-failed', message: String(error?.stack || error).slice(0, 800) };
  } finally {
    try { await handle?.dispose?.(); } catch { /* ignore */ }
    if (!config?.keepProbeSession) {
      // dispose 会移除会话；保留会话只用于人工排查
    }
  }
}
