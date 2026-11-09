/**
 * `watch_selftest` 的核心：五项体检，缺什么就说什么，不静默。
 *
 * 1 python   —— 能不能找到可用的 Python 3
 * 2 server   —— vendored mcp_server.py 是否已复制到可写数据目录
 * 3 deps     —— venv 里五个依赖能不能 import
 * 4 login    —— B 站凭证是否存在且能通过 MCP 验证
 * 5 ffmpeg   —— 可选：无字幕转写/抽帧才需要
 */

import fs from 'node:fs';
import { createBiliClient } from './bili.js';
import {
  checkDeps,
  checkFfmpeg,
  credentialFile,
  ensureServerScript,
  ensureVenv,
  installDeps,
  readCredential,
  resolvePython,
  venvPython,
} from './python.js';

function check(id, status, detail, extra = {}) {
  return { id, status, detail, ...extra };
}

function summarize(checks) {
  const required = checks.filter((item) => !item.optional);
  return required.every((item) => item.status === 'ok');
}

export async function runSelftest({ dataDir, config = {}, vendorDir, install = false, log = () => {} } = {}) {
  const checks = [];
  const python = resolvePython({ configPath: config.pythonPath });
  checks.push(python.ok
    ? check('python', 'ok', `Python ${python.version}（${python.source}：${python.command}）`, { path: python.command })
    : check('python', 'missing', python.detail || '找不到可用的 Python 3', {
      hint: '安装 Python 3.10+，或在设置里填 pythonPath；DSH 自带运行时的机器会自动找到。',
    }));

  const script = ensureServerScript({ vendorDir, dataDir });
  checks.push(script.ok
    ? check('server', 'ok', `${script.copied ? '已复制到' : '已存在'} ${script.script}`, { path: script.script })
    : check('server', 'missing', script.reason || 'vendor/bilibili-mcp 缺失', {
      hint: '仓库里 vendor/bilibili-mcp 必须存在；重新安装或检查打包是否包含 vendor。',
    }));

  let deps = { ok: false, detail: '未检查' };
  const targetVenv = venvPython(dataDir);
  if (install) {
    if (!python.ok) {
      deps = { ok: false, detail: 'Python 不可用，无法安装依赖' };
    } else {
      log('创建 venv…');
      const venv = ensureVenv({ pythonPath: python.command, args: python.args, dataDir });
      if (!venv.ok) {
        deps = { ok: false, detail: venv.detail || 'venv 创建失败' };
      } else {
        log('安装依赖（可能需要几分钟）…');
        const installed = installDeps({ pythonPath: venv.python, dataDir, indexUrl: config.pipIndexUrl });
        const checked = checkDeps(venv.python);
        deps = { ...checked, install: installed };
      }
    }
  } else {
    const interpreter = fs.existsSync(targetVenv) ? targetVenv : (python.ok ? python.command : null);
    deps = interpreter ? checkDeps(interpreter) : { ok: false, detail: '没有可用的解释器' };
  }
  checks.push(deps.ok
    ? check('deps', 'ok', `依赖可导入：${deps.detail}`)
    : check('deps', 'missing', deps.detail || '依赖缺失', {
      hint: '调用 watch_selftest 时带 action="install" 创建 venv 并安装 requirements.txt。',
    }));

  const credential = readCredential(dataDir);
  let login = { status: 'missing', detail: `未登录（${credentialFile(dataDir)} 不存在）` };
  if (!credential.exists) {
    login = { status: 'missing', detail: '还没有扫码登录', hint: '调用 watch_login action="start" 获取二维码，用 B 站 App 扫码。' };
  } else if (!credential.complete) {
    login = { status: 'missing', detail: '凭证文件存在但字段不完整，可能写入失败', hint: '重新扫码登录一次。' };
  } else if (!deps.ok) {
    login = { status: 'warn', detail: '凭证文件存在；依赖未装好，暂时无法在线验证', hint: '先安装依赖，再体检一次。' };
  } else {
    let client;
    try {
      const created = createBiliClient({ dataDir, config, vendorDir, log });
      client = created.client;
      const result = await client.call('bili_check_credential', {}, { timeoutMs: 45000 });
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      const looksLoggedIn = /未登录|not\s*login|登录失效/i.test(text) ? false : true;
      login = looksLoggedIn
        ? { status: 'ok', detail: `凭证有效：${text.slice(0, 160)}` }
        : { status: 'missing', detail: `凭证失效：${text.slice(0, 160)}`, hint: '重新扫码登录。' };
    } catch (error) {
      login = { status: 'warn', detail: `凭证存在，但在线验证失败：${String(error?.message || error).slice(0, 200)}`, hint: '检查网络或 MCP 依赖后重试。' };
    } finally {
      try { client?.stop(); } catch { /* ignore */ }
    }
  }
  checks.push(check('login', login.status, login.detail, { hint: login.hint, file: credentialFile(dataDir) }));

  const ffmpeg = checkFfmpeg();
  checks.push(ffmpeg.ok
    ? check('ffmpeg', 'ok', ffmpeg.path || '已安装', { optional: true })
    : check('ffmpeg', 'missing', '未找到 ffmpeg（只影响无字幕转写与抽帧，不影响读字幕）', {
      optional: true,
      hint: '需要时安装 ffmpeg 并加入 PATH；P3 先用字幕路径即可。',
    }));

  const nextActions = checks.filter((item) => item.status !== 'ok' && item.hint).map((item) => `${item.id}: ${item.hint}`);
  return {
    ok: summarize(checks),
    checkedAt: new Date().toISOString(),
    dataDir,
    installed: install,
    checks,
    nextActions,
  };
}
