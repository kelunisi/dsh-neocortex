/**
 * Python / MCP 依赖体检。
 *
 * 这里不做任何"自动装 Python"的花活：只按顺序找可用的解释器，
 * 找不到就明确告诉用户缺什么、怎么补。装依赖是显式动作（watch_selftest action=install）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MCP_DIR_NAME = 'bili-mcp';
export const SERVER_FILE_NAME = 'mcp_server.py';
export const REQUIREMENTS_FILE_NAME = 'requirements.txt';
export const LICENSE_FILE_NAME = 'LICENSE';

const isWindows = process.platform === 'win32';

export function serverDir(dataDir) {
  return path.join(dataDir, 'watch', MCP_DIR_NAME);
}

export function venvDir(dataDir) {
  return path.join(serverDir(dataDir), '.venv');
}

export function venvPython(dataDir) {
  return isWindows
    ? path.join(venvDir(dataDir), 'Scripts', 'python.exe')
    : path.join(venvDir(dataDir), 'bin', 'python3');
}

export function serverScriptFile(dataDir) {
  return path.join(serverDir(dataDir), SERVER_FILE_NAME);
}

export function requirementsFile(dataDir) {
  return path.join(serverDir(dataDir), REQUIREMENTS_FILE_NAME);
}

export function credentialFile(dataDir) {
  return path.join(serverDir(dataDir), 'bili_credential.json');
}

export function qrFile(dataDir) {
  return path.join(serverDir(dataDir), 'qrcode_login.png');
}

/** Bundled DSH runtime interpreters, if the app ships one. */
export function bundledPythonCandidates(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const root = path.join(dshHome, 'dsh-runtimes');
  const exe = isWindows ? 'python.exe' : path.join('bin', 'python3');
  const found = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, 'dependencies', 'python', exe);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  } catch { /* no bundled runtime */ }
  return found;
}

/**
 * Ordered candidates. `configPath` wins when it actually runs; a broken
 * configured path falls through instead of leaving the module dead.
 */
export function candidatePythons({ configPath, dshHome, env = process.env } = {}) {
  const out = [];
  const push = (command, args = [], source) => {
    if (!command) return;
    if (out.some((item) => item.command === command && item.args.join(' ') === args.join(' '))) return;
    out.push({ command, args, source });
  };
  push(configPath, [], 'config');
  push(env.DSH_PYTHON, [], 'env:DSH_PYTHON');
  for (const file of bundledPythonCandidates(dshHome || env.DSH_HOME)) push(file, [], 'bundled-runtime');
  if (isWindows) {
    push('py', ['-3'], 'py-launcher');
    push('python', [], 'PATH');
  } else {
    push('python3', [], 'PATH');
    push('python', [], 'PATH');
  }
  return out;
}

export function probePython(candidate, { timeoutMs = 8000 } = {}) {
  const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  });
  const text = `${result.stdout || ''} ${result.stderr || ''}`.trim();
  const ok = result.status === 0 && /Python\s+3\./i.test(text);
  return {
    ok,
    command: candidate.command,
    args: candidate.args,
    source: candidate.source,
    version: ok ? (text.match(/Python\s+([\d.]+)/i)?.[1] ?? text.slice(0, 60)) : undefined,
    detail: ok ? text : (text || result.error?.message || `exit ${result.status}`),
  };
}

/** First interpreter that actually answers `--version`. */
export function resolvePython({ configPath, dshHome, env } = {}) {
  const attempts = [];
  for (const candidate of candidatePythons({ configPath, dshHome, env })) {
    const probe = probePython(candidate);
    attempts.push({ command: candidate.command, source: candidate.source, ok: probe.ok, detail: probe.detail });
    if (probe.ok) return { ok: true, ...probe, attempts };
  }
  return { ok: false, attempts, detail: attempts.map((item) => `${item.source}:${item.command} (${item.detail})`).join(' / ') };
}

export function run(command, args, { cwd, env, timeoutMs = 60000 } = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...(env || {}) }, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? String(result.error.message || result.error) : undefined,
  };
}

export function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/**
 * Copy the vendored MCP server into the writable data dir. The server writes
 * `bili_credential.json` next to itself, so it must never run from the repo.
 */
export function ensureServerScript({ vendorDir, dataDir }) {
  const source = path.join(vendorDir, SERVER_FILE_NAME);
  const sourceRequirements = path.join(vendorDir, REQUIREMENTS_FILE_NAME);
  const sourceLicense = path.join(vendorDir, LICENSE_FILE_NAME);
  if (!fs.existsSync(source)) {
    return { ok: false, reason: `vendor 缺失：${source}` };
  }
  const dir = serverDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, SERVER_FILE_NAME);
  const same = fs.existsSync(target) && sha256File(target) === sha256File(source);
  if (!same) fs.copyFileSync(source, target);
  for (const [from, name] of [[sourceRequirements, REQUIREMENTS_FILE_NAME], [sourceLicense, LICENSE_FILE_NAME]]) {
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, name));
  }
  return { ok: true, script: target, copied: !same, dir };
}

export function ensureVenv({ pythonPath, args = [], dataDir, timeoutMs = 180000 }) {
  const target = venvPython(dataDir);
  if (fs.existsSync(target)) return { ok: true, python: target, created: false };
  const result = run(pythonPath, [...args, '-m', 'venv', venvDir(dataDir)], { timeoutMs });
  if (!result.ok || !fs.existsSync(target)) {
    return { ok: false, python: target, created: false, detail: result.stderr || result.stdout || result.error || 'venv 创建失败' };
  }
  return { ok: true, python: target, created: true };
}

/** Import the five runtime packages in one interpreter run. */
export function checkDeps(pythonPath, { timeoutMs = 60000 } = {}) {
  const code = 'import bilibili_api, mcp, aiohttp, qrcode, PIL; print("ok", getattr(bilibili_api, "__version__", "?"))';
  const result = run(pythonPath, ['-c', code], { timeoutMs });
  return {
    ok: result.ok,
    python: pythonPath,
    detail: result.ok ? result.stdout : (result.stderr.split('\n').filter(Boolean).slice(-3).join(' | ') || result.error || 'import 失败'),
  };
}

export function installDeps({ pythonPath, dataDir, timeoutMs = 900000 }) {
  const requirements = requirementsFile(dataDir);
  if (!fs.existsSync(requirements)) return { ok: false, detail: `缺少 ${requirements}` };
  const result = run(pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements], { timeoutMs });
  return { ok: result.ok, detail: (result.stdout || result.stderr || result.error || '').split('\n').slice(-6).join('\n') };
}

export function checkFfmpeg() {
  const result = isWindows ? run('where', ['ffmpeg'], { timeoutMs: 8000 }) : run('which', ['ffmpeg'], { timeoutMs: 8000 });
  return { ok: result.ok && Boolean(result.stdout), path: result.stdout.split(/\r?\n/)[0] || undefined };
}

export function readCredential(dataDir) {
  const file = credentialFile(dataDir);
  if (!fs.existsSync(file)) return { exists: false, file, credential: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const credential = {
      sessdata: String(parsed?.sessdata ?? ''),
      bili_jct: String(parsed?.bili_jct ?? ''),
      buvid3: String(parsed?.buvid3 ?? ''),
      dedeuserid: String(parsed?.dedeuserid ?? ''),
    };
    return { exists: true, file, credential, complete: Boolean(credential.sessdata && credential.bili_jct) };
  } catch (error) {
    return { exists: true, file, credential: null, error: String(error?.message || error) };
  }
}
