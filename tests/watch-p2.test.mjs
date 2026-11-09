import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_ONLY_TOOLS, resolveBiliRuntime } from '../src/watch/bili.js';
import { candidatePythons, credentialFile, ensureServerScript, readCredential, serverDir, venvPython } from '../src/watch/python.js';
import { mapPollState } from '../src/watch/login.js';
import { runSelftest } from '../src/watch/selftest.js';
import { registerWatchTools } from '../src/watch/tools.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(root, 'vendor', 'bilibili-mcp');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-watch-p2-'));
}

test('P2-01 read-only whitelist excludes every write tool', () => {
  assert.ok(READ_ONLY_TOOLS.includes('bili_subtitle'));
  assert.ok(READ_ONLY_TOOLS.includes('bili_search'));
  assert.equal(READ_ONLY_TOOLS.includes('bili_reply'), false);
  assert.equal(READ_ONLY_TOOLS.includes('bili_send_message'), false);
  assert.equal(READ_ONLY_TOOLS.includes('bili_login'), false, 'login is handled by our own passport client');
});

test('P2-02 python candidates prefer config, then bundled runtime, then PATH', () => {
  const dshHome = tempDir();
  const runtime = path.join(dshHome, 'dsh-runtimes', 'rt', 'dependencies', 'python');
  fs.mkdirSync(runtime, { recursive: true });
  const exe = path.join(runtime, process.platform === 'win32' ? 'python.exe' : 'python3');
  fs.writeFileSync(exe, '');
  const candidates = candidatePythons({ configPath: 'C:\\custom\\python.exe', dshHome });
  assert.equal(candidates[0].command, 'C:\\custom\\python.exe');
  assert.equal(candidates[0].source, 'config');
  assert.ok(candidates.some((item) => item.source === 'bundled-runtime' && item.command.includes('dsh-runtimes')));
  const bundledIndex = candidates.findIndex((item) => item.source === 'bundled-runtime');
  const pathIndex = candidates.findIndex((item) => item.source === 'PATH');
  assert.ok(bundledIndex < pathIndex, 'bundled runtime must win over PATH');
});

test('P2-03 vendor script is copied into the writable data dir once', () => {
  const dataDir = tempDir();
  const first = ensureServerScript({ vendorDir, dataDir });
  assert.equal(first.ok, true);
  assert.equal(first.copied, true);
  const target = path.join(serverDir(dataDir), 'mcp_server.py');
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.statSync(target).size, fs.statSync(path.join(vendorDir, 'mcp_server.py')).size);
  const second = ensureServerScript({ vendorDir, dataDir });
  assert.equal(second.copied, false, 'same hash must not recopy');
  assert.equal(fs.existsSync(path.join(serverDir(dataDir), 'LICENSE')), true);
});

test('P2-04 credential reader distinguishes missing, incomplete and corrupt', () => {
  const dataDir = tempDir();
  assert.equal(readCredential(dataDir).exists, false);
  fs.mkdirSync(path.dirname(credentialFile(dataDir)), { recursive: true });
  fs.writeFileSync(credentialFile(dataDir), JSON.stringify({ sessdata: 'a' }));
  const incomplete = readCredential(dataDir);
  assert.equal(incomplete.exists, true);
  assert.equal(incomplete.complete, false);
  fs.writeFileSync(credentialFile(dataDir), '{bad json');
  const corrupt = readCredential(dataDir);
  assert.equal(corrupt.exists, true);
  assert.ok(corrupt.error);
});

test('P2-05 poll codes map to the four UI states', () => {
  assert.equal(mapPollState(0), 'ok');
  assert.equal(mapPollState(86101), 'waiting');
  assert.equal(mapPollState(86090), 'scanned');
  assert.equal(mapPollState(86038), 'expired');
  assert.equal(mapPollState(12345), 'unknown');
});

test('P2-06 selftest reports five named checks without network', async () => {
  const dataDir = tempDir();
  const result = await runSelftest({ dataDir, config: {}, vendorDir });
  assert.equal(result.checkedAt.length > 0, true);
  assert.deepEqual(result.checks.map((item) => item.id), ['python', 'server', 'deps', 'login', 'ffmpeg']);
  const byId = Object.fromEntries(result.checks.map((item) => [item.id, item]));
  assert.equal(byId.server.status, 'ok');
  assert.equal(byId.login.status, 'missing');
  assert.equal(byId.ffmpeg.optional, true);
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.nextActions));
});

test('P2-07 resolveBiliRuntime wires the runtime dir and credential path', () => {
  const dataDir = tempDir();
  const runtime = resolveBiliRuntime({ dataDir, config: {}, vendorDir });
  if (!runtime.ok) {
    // A machine without any Python still gets a stable failure reason.
    assert.ok(['python-missing', 'server-missing'].includes(runtime.reason));
    return;
  }
  assert.equal(path.dirname(runtime.credential), serverDir(dataDir));
  assert.equal(path.basename(runtime.credential), 'bili_credential.json');
  assert.ok(fs.existsSync(runtime.script));
  assert.equal(venvPython(dataDir).includes('.venv'), true);
});

test('P2-08 watch tools register selftest, login, run, feedback and ingest', () => {
  const registered = [];
  const ctx = { tools: { register: (tool) => registered.push(tool.name) } };
  const names = registerWatchTools(ctx, { dataDir: tempDir(), config: {}, vendorDir });
  assert.deepEqual(names, ['watch_selftest', 'watch_login', 'watch_run', 'watch_feedback', 'watch_ingest']);
  assert.deepEqual(registered, ['watch_selftest', 'watch_login', 'watch_run', 'watch_feedback', 'watch_ingest']);
});
