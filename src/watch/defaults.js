// Watch (喂养) module — defaults and config normalization.
//
// P1 scope: the three-way mode switch is the only value the panel may write.
// Every other budget below is a frozen default until the panel sliders land in
// P7; keeping them here means the contract (names and clamps) is fixed before
// the pipeline that consumes them exists.

export const WATCH_PHASE = 'P1';

export const WATCH_SCHEMA = 1;

export const WATCH_MODES = Object.freeze(['off', 'code', 'agent']);

export const WATCH_DEFAULTS = Object.freeze({
  mode: 'off',
  scanPerRound: 5,
  deepPerRound: 3,
  mentionPerDay: 3,
  dmPerDay: 2,
  followingsPerRound: 10,
  tokenBudgetPerDay: 2000000,
});

// P7 will move these into the panel; the clamps are declared now so the
// persisted file can never drift outside the numbers the pipeline expects.
export const WATCH_RANGES = Object.freeze({
  scanPerRound: [1, 10],
  deepPerRound: [1, 5],
  mentionPerDay: [0, 3],
  dmPerDay: [0, 2],
  followingsPerRound: [1, 30],
  tokenBudgetPerDay: [100000, 5000000],
});

const MODE_LABELS = Object.freeze({
  off: '关闭',
  code: '代码模式',
  agent: 'Agent 模式',
});

export function isWatchMode(value) {
  return typeof value === 'string' && WATCH_MODES.includes(value);
}

export function watchModeLabel(mode) {
  return MODE_LABELS[mode] ?? '未知';
}

function clampInteger(value, [min, max], fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalize a parsed watch.json payload. Tolerant by design: a future version,
 * a hand edit, or a corrupted field must never stop the plugin from loading —
 * unknown keys are dropped and out-of-range numbers are clamped.
 *
 * @param {unknown} raw
 * @returns {{ config: typeof WATCH_DEFAULTS, repaired: string[] }}
 */
export function normalizeWatchConfig(raw) {
  const repaired = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const config = { ...WATCH_DEFAULTS };
  if (source.mode !== undefined) {
    if (isWatchMode(source.mode)) config.mode = source.mode;
    else repaired.push(`mode:${String(source.mode)}`);
  }
  for (const [key, range] of Object.entries(WATCH_RANGES)) {
    if (source[key] === undefined) continue;
    const next = clampInteger(source[key], range, WATCH_DEFAULTS[key]);
    if (next !== source[key]) repaired.push(`${key}:${String(source[key])}`);
    config[key] = next;
  }
  if (source.schema !== undefined && source.schema !== WATCH_SCHEMA) {
    repaired.push(`schema:${String(source.schema)}`);
  }
  return { config, repaired };
}
