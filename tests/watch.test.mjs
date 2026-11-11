import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchService } from '../src/watch/service.js';
import { mountWatch } from '../src/watch/index.js';
import { WATCH_DEFAULTS, normalizeWatchConfig } from '../src/watch/defaults.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-watch-'));
}

const now = () => new Date('2026-11-09T01:00:00.000Z');

test('WATCH-01 a fresh data dir starts off and creates nothing at construction', () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, now });
  assert.equal(watch.mode, 'off');
  assert.equal(watch.enabled(), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'watch.json')), false, 'loading the module must not write watch.json');
  const state = watch.state();
  assert.equal(state.phase, 'P1');
  assert.equal(state.mode, 'off');
  assert.deepEqual(state.modes, ['off', 'code']);
  assert.deepEqual(state.capabilities, { scheduler: false, harvest: false, interaction: false });
});

test('WATCH-02 switching mode persists atomically and a restart reads it back', () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, now });
  const updated = watch.setMode('code');
  assert.equal(updated.status, 'updated');
  assert.equal(updated.mode, 'code');
  assert.equal(updated.persisted, true);
  assert.equal(updated.updatedAt, '2026-11-09T01:00:00.000Z');
  const file = path.join(dataDir, 'watch.json');
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.mode, 'code');
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.scanPerRound, WATCH_DEFAULTS.scanPerRound, 'frozen budgets are written with defaults');
  assert.equal(fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp')), false, 'no temp file is left behind');
  const restarted = new WatchService({ dataDir, now });
  assert.equal(restarted.mode, 'code');
  assert.equal(restarted.enabled(), true);
});

test('WATCH-03 an unknown mode is rejected without touching the file or memory', () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, now });
  assert.throws(() => watch.setMode('agent'), /Invalid watch mode/);
  watch.setMode('code');
  const file = path.join(dataDir, 'watch.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => watch.setMode('always'), /Invalid watch mode/);
  assert.equal(watch.mode, 'code');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('WATCH-04 a malformed watch.json falls back to off, is reported, and is never rewritten', () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, 'watch.json');
  fs.writeFileSync(file, '{ this is not json\n', 'utf8');
  const watch = new WatchService({ dataDir, now });
  assert.equal(watch.mode, 'off');
  assert.ok(watch.state().repaired.includes('corrupt-file-ignored'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json\n', 'the broken file is left for inspection');
  assert.doesNotThrow(() => watch.setMode('code'), 'a later write repairs the state');
  assert.equal(watch.mode, 'code');
});

test('WATCH-05 cordis initialMode only seeds a directory that was never configured', () => {
  const seededDir = tempDir();
  assert.equal(new WatchService({ dataDir: seededDir, initialMode: 'code', now }).mode, 'code');

  const configuredDir = tempDir();
  fs.writeFileSync(path.join(configuredDir, 'watch.json'), JSON.stringify({ schema: 1, mode: 'off' }), 'utf8');
  assert.equal(new WatchService({ dataDir: configuredDir, initialMode: 'code', now }).mode, 'off', 'the persisted switch wins');

  const invalidDir = tempDir();
  assert.equal(new WatchService({ dataDir: invalidDir, initialMode: 'turbo', now }).mode, 'off', 'an invalid seed is ignored');
});

test('WATCH-06 budgets out of range are clamped and reported, mode stays valid', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'watch.json'), JSON.stringify({
    schema: 1, mode: 'code', scanPerRound: 99, deepPerRound: 0, mentionPerDay: -3, tokenBudgetPerDay: 12,
  }), 'utf8');
  const watch = new WatchService({ dataDir, now });
  assert.equal(watch.mode, 'code');
  assert.equal(watch.config.scanPerRound, 10);
  assert.equal(watch.config.deepPerRound, 1);
  assert.equal(watch.config.mentionPerDay, 0);
  assert.equal(watch.config.tokenBudgetPerDay, 100000);
  assert.deepEqual(watch.state().repaired.sort(), ['deepPerRound:0', 'mentionPerDay:-3', 'scanPerRound:99', 'tokenBudgetPerDay:12'].sort());
});

test('WATCH-07 mountWatch wires disposal once and starts nothing while off', () => {
  const dataDir = tempDir();
  const effects = [];
  const ctx = { effect: (factory) => { effects.push(factory); return () => {}; } };
  const watch = mountWatch({ ctx, dataDir, initialMode: 'off' });
  assert.equal(effects.length, 1);
  assert.equal(watch.mode, 'off');
  const disposer = effects[0]();
  assert.deepEqual(disposer(), { disposed: true, timers: 0 });
  assert.equal(fs.existsSync(path.join(dataDir, 'watch.json')), false);
});

test('WATCH-08 panel state is lossless JSON', () => {
  const dataDir = tempDir();
  const watch = new WatchService({ dataDir, now });
  watch.setMode('code');
  const cloned = JSON.parse(JSON.stringify(watch.state()));
  assert.deepEqual(cloned, watch.state());
});

test('WATCH-09 normalizeWatchConfig drops unknown keys and keeps defaults', () => {
  const { config, repaired } = normalizeWatchConfig({ mode: 'code', mystery: true, schema: 1 });
  assert.deepEqual(repaired, []);
  assert.equal('mystery' in config, false);
  assert.equal(config.mode, 'code');
  assert.equal(config.followingsPerRound, WATCH_DEFAULTS.followingsPerRound);
});

test('WATCH-10 an old agent mode migrates to code instead of blocking the plugin', () => {
  const { config, repaired } = normalizeWatchConfig({ mode: 'agent', schema: 1 });
  assert.equal(config.mode, 'code');
  assert.deepEqual(repaired, ['mode:agent->code']);
});
