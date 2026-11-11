export const WATCH_SUBAGENT_DESCRIPTOR = Object.freeze({
  version: 3,
  mode: 'one-shot',
  provider: 'dsh-neocortex',
  label: 'watch-duty',
});

/** Host 原生 subagent 标记：避免 Agent Teams 把内部会话误认为 Team Lead。 */
export function markWatchSubagent(agent) {
  if (!agent?.session?.append) throw new Error('watch agent requires session.append');
  agent.session.append('subagent/descriptor', { ...WATCH_SUBAGENT_DESCRIPTOR });
}

/** 真实发给模型的工具，而不只是 setup 完成时看到的工具。 */
export function requestHeaderTools(agent) {
  let events = [];
  try { events = agent?.session?.snapshotEvents?.() || []; } catch { events = []; }
  return events.filter((event) => event?.type === 'request/header').map((event) => ({
    seq: event.seq,
    tools: (event?.data?.header?.tools || []).map((tool) => tool.name),
  }));
}

/** 内部喂养会话不会读取或隐式注入个人记忆。 */
export function isWatchAgentSession(agentOrId) {
  const id = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id;
  return typeof id === 'string' && /^watch-(?:agent|probe)-/.test(id);
}
