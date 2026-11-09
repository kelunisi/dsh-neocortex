/**
 * B 站扫码登录（直接走 passport 接口，不依赖 MCP 的 bili_login）。
 *
 * 改编自 dsh-bili-scroll（MIT, Copyright (c) 2026 c1overzz）的 lib/login.mjs：
 *   ① 生成二维码 URL + qrcode_key
 *   ② 手机扫码后轮询；成功时凭证在轮询响应的 Set-Cookie 里
 *   ③ 写成 mcp_server.py 认识的四个字段，并收紧文件权限
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { credentialFile, qrFile } from './python.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header';
const POLL = (key) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`;
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi';

export const POLL_STATES = Object.freeze({
  0: 'ok',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
});

export function mapPollState(code) {
  return POLL_STATES[code] ?? 'unknown';
}

function pickCookies(list) {
  const jar = {};
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' };
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || '';
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (want[name]) jar[want[name]] = value;
  }
  return jar;
}

async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar;
  try {
    const response = await fetch(SPI, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const json = await response.json();
    const value = json?.data?.b_3;
    if (value) jar.buvid3 = value;
  } catch { /* optional fingerprint */ }
  return jar;
}

function setCookiesOf(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const raw = response.headers.get?.('set-cookie');
  return raw ? [raw] : [];
}

export async function loginStart() {
  const response = await fetch(GEN, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  const json = await response.json();
  const data = json?.data;
  if (!data?.qrcode_key || !data?.url) throw new Error(`生成二维码失败：${json?.message || '返回里没有 qrcode_key'}`);
  return { key: data.qrcode_key, url: data.url };
}

export async function loginPoll(key) {
  if (!key) throw new Error('缺少 qrcode_key');
  const response = await fetch(POLL(key), {
    headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  let body = {};
  try { body = await response.json(); } catch { /* poll may return an empty body */ }
  const code = body?.data?.code;
  const state = mapPollState(code);
  if (state === 'ok') {
    const jar = await ensureBuvid3(pickCookies(setCookiesOf(response)));
    if (!jar.sessdata) return { state: 'unknown', code, message: '登录成功，但响应里没有 SESSDATA；请重试一次。' };
    return { state, code, credential: jar };
  }
  return { state, code, message: body?.message || '' };
}

function currentUserSid() {
  try {
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    const output = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const match = /"(S-1-[\d-]+)"/.exec(output);
    return match ? match[1] : null;
  } catch { return null; }
}

/** Tighten the credential file to the current user only; failures stay non-fatal. */
export function hardenPerms(file) {
  try {
    if (process.platform === 'win32') {
      const sid = currentUserSid();
      const who = sid ? '*' + sid : (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '');
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', who + ':F'], { stdio: 'ignore', windowsHide: true });
      try { fs.readFileSync(file); } catch {
        execFileSync('icacls', [file, '/reset'], { stdio: 'ignore', windowsHide: true });
        return false;
      }
    } else {
      execFileSync('chmod', ['600', file], { stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}

export function saveCredential(dataDir, credential) {
  const file = credentialFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    sessdata: credential.sessdata ?? '',
    bili_jct: credential.bili_jct ?? '',
    buvid3: credential.buvid3 || '',
    dedeuserid: credential.dedeuserid ?? '',
  }, null, 2), 'utf8');
  try { hardenPerms(file); } catch { /* perms are best-effort */ }
  return file;
}

/** Render the login URL into a PNG using the venv's `qrcode` package. */
export function renderQrPng(pythonPath, dataDir, url, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const target = qrFile(dataDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const code = 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])';
    let child;
    try {
      child = spawn(pythonPath, ['-c', code, url, target], { cwd: path.dirname(target), windowsHide: true });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, timeoutMs);
    timer.unref?.();
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve(status === 0 && fs.existsSync(target) ? target : null);
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

export function qrDataUrl(file) {
  try {
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch { return null; }
}
