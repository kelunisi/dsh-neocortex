/** 内部喂养会话不会读取或隐式注入个人记忆。 */
export function isWatchAgentSession(agentOrId) {
  const id = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id;
  return typeof id === 'string' && /^watch-(?:agent|probe)-/.test(id);
}
