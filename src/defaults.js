export const DEFAULT_CONFIG = Object.freeze({
  halfLifeDays: 30,
  firstInjectionMaxItems: 10,
  firstInjectionMaxChars: 800,
  generalSleepDays: 15,
  revivalWindowDays: 3,
  revivalThreshold: 3,
  dailyWriteQuota: 15,
  dailyExemptionQuota: 5,
  pendingQueueLimit: 20,
});

export function resolveConfig(config = {}) {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const integerRanges = {
    halfLifeDays: [15, 45],
    firstInjectionMaxItems: [3, 15],
    firstInjectionMaxChars: [600, 1200],
    generalSleepDays: [10, 30],
    revivalWindowDays: [1, 3],
    revivalThreshold: [2, 5],
  };
  for (const [key, [min, max]] of Object.entries(integerRanges)) {
    const value = resolved[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${key}: expected an integer in ${min}..${max}, got ${value}`);
    }
  }
  if (resolved.dailyWriteQuota !== 15 || resolved.dailyExemptionQuota !== 5 || resolved.pendingQueueLimit !== 20) {
    throw new Error('Daily quota, exemption quota, and pending queue limit are frozen at 15, 5, and 20.');
  }
  return resolved;
}

export function unicodeLength(text) {
  return Array.from(text).length;
}

export function truncateUnicode(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, Math.max(0, maxChars)).join('');
}

// DSH 0.2.2+ validates tool results as lossless JSON and rejects undefined
// fields, NaN and Infinity. Round-trip through JSON to normalize tool outputs.
export function sanitize(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}
