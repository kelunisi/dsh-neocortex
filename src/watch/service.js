// Watch (喂养) module — persisted state for the three-way mode switch.
//
// P1 deliberately stops here: no scheduler, no network, no file outside
// `watch.json`, and no timer. When the mode is `off` the module is inert, which
// is the acceptance property "关着时零行为零报错".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  WATCH_DEFAULTS,
  WATCH_MODES,
  WATCH_PHASE,
  WATCH_RANGES,
  WATCH_SCHEMA,
  isWatchMode,
  normalizeWatchConfig,
  watchModeLabel,
} from './defaults.js';

/**
 * Read watch.json without throwing. A missing file is the normal first-run
 * case; a malformed one is reported (never silently rewritten) so the user can
 * look at it.
 *
 * @param {string} file
 */
export function readWatchFile(file) {
  if (!fs.existsSync(file)) return { exists: false, config: {}, repaired: [], updatedAt: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { config, repaired } = normalizeWatchConfig(parsed);
    return { exists: true, config, repaired, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null };
  } catch (error) {
    return { exists: true, config: {}, repaired: ['corrupt-file-ignored'], updatedAt: null, error: String(error?.message || error) };
  }
}

export class WatchService {
  /**
   * @param {object} options
   * @param {string} options.dataDir directory shared with the rest of the plugin (ledger/settings)
   * @param {string} [options.initialMode] cordis config fallback used only when no watch.json exists
   * @param {() => Date} [options.now] injectable clock for tests
   */
  constructor({ dataDir, initialMode, now = () => new Date() }) {
    if (!dataDir || typeof dataDir !== 'string') throw new Error('WatchService requires a dataDir');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'watch.json');
    this.now = now;
    const stored = readWatchFile(this.file);
    this.persisted = stored.exists;
    this.repaired = stored.repaired;
    this.readError = stored.error;
    this.config = { ...WATCH_DEFAULTS, ...stored.config };
    // A valid persisted mode always wins. The cordis value only seeds a
    // directory that has never been configured.
    if (!stored.exists && isWatchMode(initialMode)) this.config.mode = initialMode;
    this.updatedAt = stored.updatedAt;
  }

  get mode() {
    return this.config.mode;
  }

  /** True only when the pipeline may do something. P1 has no pipeline, so this is a pure read. */
  enabled() {
    return this.config.mode !== 'off';
  }

  /** Panel projection. Everything here is safe to render when the mode is off. */
  state() {
    return {
      phase: WATCH_PHASE,
      schema: WATCH_SCHEMA,
      mode: this.config.mode,
      modeLabel: watchModeLabel(this.config.mode),
      modes: [...WATCH_MODES],
      enabled: this.enabled(),
      persisted: this.persisted,
      updatedAt: this.updatedAt,
      file: this.file,
      repaired: [...this.repaired],
      defaults: { ...WATCH_DEFAULTS },
      config: { ...this.config },
      ranges: Object.fromEntries(Object.entries(WATCH_RANGES).map(([key, range]) => [key, [...range]])),
      capabilities: {
        scheduler: false,
        harvest: false,
        interaction: false,
      },
      note: 'P1 骨架：开关能存能读；调度、抓取、发送均未接入。',
    };
  }

  /**
   * Persist one mode. Atomic and synchronous: a failed write leaves the old
   * file untouched and the in-memory mode unchanged.
   *
   * @param {string} mode
   */
  setMode(mode) {
    if (!isWatchMode(mode)) {
      throw new Error(`Invalid watch mode: ${String(mode)}; expected one of ${WATCH_MODES.join(', ')}`);
    }
    if (mode === this.config.mode) {
      return { status: 'unchanged', ...this.state() };
    }
    const next = { ...this.config, mode };
    const updatedAt = this.now().toISOString();
    this.write({ schema: WATCH_SCHEMA, ...next, updatedAt });
    this.config = next;
    this.persisted = true;
    this.updatedAt = updatedAt;
    this.repaired = [];
    this.readError = undefined;
    try { this.onModeChange?.(mode); } catch { /* listener failures must not break the switch */ }
    return { status: 'updated', ...this.state() };
  }

  /** P7 sliders: scan/deep/mention/dm/followings/token budget, clamped by WATCH_RANGES. */
  setConfig(patch = {}) {
    const next = { ...this.config };
    const changed = [];
    for (const [key, [min, max]] of Object.entries(WATCH_RANGES)) {
      if (patch[key] === undefined) continue;
      const value = Number(patch[key]);
      if (!Number.isInteger(value)) continue;
      const clamped = Math.min(max, Math.max(min, value));
      if (clamped !== next[key]) changed.push(key);
      next[key] = clamped;
    }
    if (patch.tokenBudgetPerDay !== undefined) {
      const value = Math.max(100000, Math.min(5000000, Math.round(Number(patch.tokenBudgetPerDay) || 0)));
      if (value !== next.tokenBudgetPerDay) changed.push('tokenBudgetPerDay');
      next.tokenBudgetPerDay = value;
    }
    if (!changed.length) return { status: 'unchanged', ...this.state() };
    const updatedAt = this.now().toISOString();
    this.write({ schema: WATCH_SCHEMA, ...next, updatedAt });
    this.config = next;
    this.persisted = true;
    this.updatedAt = updatedAt;
    return { status: 'updated', changed, ...this.state() };
  }

  /** Release anything owned by the module. P1 owns no timer, so this is a no-op kept for P2+. */
  dispose() {
    return { disposed: true, timers: 0 };
  }

  write(payload) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    try {
      fs.renameSync(temp, this.file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }
}
