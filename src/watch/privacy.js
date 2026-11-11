/**
 * P8 安全闸：公开写操作前的隐私检查、评论额度、写工具白名单。
 * 这里只做纯函数和规则，不发送任何内容。
 */

export const DEFAULT_PRIVACY_TERMS = Object.freeze([
  '市场监督管理局',
  '市场监管局',
  '标准化科',
  '区局',
]);

export const WRITE_TOOL_ALLOWLIST = Object.freeze(['bili_follow']);

const PATTERNS = Object.freeze([
  { id: 'phone', label: '手机号', regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { id: 'idcard', label: '身份证号', regex: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { id: 'email', label: '邮箱', regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { id: 'long-number', label: '长数字（可能为卡号/编号）', regex: /(?<!\d)\d{16,19}(?!\d)/g },
]);

export function scanPrivacy(text, { terms = [] } = {}) {
  const source = String(text || '');
  const findings = [];
  for (const pattern of PATTERNS) {
    const matches = source.match(pattern.regex) || [];
    for (const value of matches) findings.push({ id: pattern.id, label: pattern.label, value });
  }
  for (const term of [...DEFAULT_PRIVACY_TERMS, ...(terms || [])]) {
    const key = String(term || '').trim();
    if (key && source.includes(key)) findings.push({ id: 'term', label: '身份/单位关键词', value: key });
  }
  return findings;
}

export function redactPrivacy(text, { terms = [] } = {}) {
  let output = String(text || '');
  for (const pattern of PATTERNS) output = output.replace(pattern.regex, `[已隐藏:${pattern.label}]`);
  for (const term of [...DEFAULT_PRIVACY_TERMS, ...(terms || [])]) {
    const key = String(term || '').trim();
    if (key) output = output.split(key).join('[已隐藏:单位]');
  }
  return output;
}

/** @returns {{ok:boolean, findings:Array, redacted:string}} */
export function checkOutboundText(text, { terms = [] } = {}) {
  const findings = scanPrivacy(text, { terms });
  return { ok: findings.length === 0, findings, redacted: redactPrivacy(text, { terms }) };
}

export function commentQuota({ mentionPerDay = 3, usedToday = 0 } = {}) {
  const limit = Math.max(0, Math.min(10, Number(mentionPerDay) || 0));
  const used = Math.max(0, Number(usedToday) || 0);
  return { limit, used, remaining: Math.max(0, limit - used), canComment: limit - used > 0, stopped: limit <= 0 || used >= limit };
}

export function checkCommentAllowed({ text, terms = [], mentionPerDay = 3, usedToday = 0 } = {}) {
  const quota = commentQuota({ mentionPerDay, usedToday });
  if (!quota.canComment) return { ok: false, reason: 'quota', quota, findings: [] };
  const privacy = checkOutboundText(text, { terms });
  if (!privacy.ok) return { ok: false, reason: 'privacy', quota, findings: privacy.findings, redacted: privacy.redacted };
  return { ok: true, reason: null, quota, findings: [] };
}

export function assertWriteToolAllowed(name) {
  if (WRITE_TOOL_ALLOWLIST.includes(name)) return true;
  throw new Error(`写工具 ${name} 不在白名单（允许：${WRITE_TOOL_ALLOWLIST.join(', ')}）`);
}

export function assertFollowApproved(approved) {
  if (approved !== true) throw new Error('关注是写操作：必须先得到用户明确批准');
  return true;
}

const INJECTION_SIGNALS = Object.freeze([
  /忽略(?:之前|以上|前面|先前)的?(?:所有)?(?:指令|提示|规则)/i,
  /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions?/i,
  /忽略.*(?:系统提示|system prompt)/i,
  /你现在是.*(?:助手|系统|管理员)/i,
  /(?:输出|返回).*(?:格式|JSON).*(?:改为|改成)/i,
  /(?:调用|使用).*(?:工具|tool).*(?:删除|写入|发送)/i,
]);

export function looksLikeInjection(text) {
  const source = String(text || '');
  return INJECTION_SIGNALS.some((pattern) => pattern.test(source));
}
