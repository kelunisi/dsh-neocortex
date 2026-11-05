export function memoryPolicy(userText = '') {
  return {
    allowRead: !/这次不用智脑/.test(userText),
    allowSave: !/这次不用智脑|这个不要记/.test(userText),
    explicit: /(记住这个|请记住|帮我记住|以后照这个做|以后按这个做|以后都)/.test(userText),
  };
}

export const NO_LEDGER_CAPABILITIES = Object.freeze({
  realtimeRanking: false,
  realtimeQuota: false,
  automaticLifecycle: false,
  weeklyWriteback: true,
  inPlaceRefresh: true,
  claims: '仅按既有 Markdown 协议进行周回写与就地刷新，不宣称实时排序、实时配额或自动生命周期。',
});
