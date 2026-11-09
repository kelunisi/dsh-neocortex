/**
 * 模型可调用的喂养工具（P2）：体检 + 扫码登录。
 * 面板按钮和悬浮球在 P7 接同一套函数。
 */

import fs from 'node:fs';
import { sanitize } from '../defaults.js';
import { loginPoll, loginStart, qrDataUrl, renderQrPng, saveCredential } from './login.js';
import { credentialFile, readCredential, resolvePython, venvPython } from './python.js';
import { runSelftest } from './selftest.js';
import { defaultVendorDir } from './bili.js';

function pythonForQr(dataDir) {
  const venv = venvPython(dataDir);
  if (fs.existsSync(venv)) return venv;
  const resolved = resolvePython();
  return resolved.ok ? resolved.command : null;
}

function createSelftestTool(context) {
  return {
    name: 'watch_selftest',
    description: '喂养模块体检：Python、MCP 脚本、依赖、B 站登录态、ffmpeg 五项；action=install 会创建 venv 并安装依赖（可能需要几分钟）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'install'], description: 'check 只体检；install 创建 venv 并安装依赖后复检。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => sanitize(await runSelftest({
      dataDir: context.dataDir,
      config: context.config,
      vendorDir: context.vendorDir,
      install: args?.action === 'install',
    })),
  };
}

function createLoginTool(context) {
  return {
    name: 'watch_login',
    description: 'B 站扫码登录：action=start 生成二维码（返回 qrPath/url 和 qrcode key）；action=poll 用 key 轮询，成功后把凭证写入本地并收紧权限；action=status 只读检查。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'poll', 'status'], description: 'start 出码；poll 轮询；status 查本地凭证。' },
        key: { type: 'string', description: 'action=poll 时必填，start 返回的 qrcode key。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { state: { type: 'string' } }, required: ['state'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      try {
        if (args.action === 'status') {
          const credential = readCredential(context.dataDir);
          return sanitize({
            state: credential.complete ? 'ok' : 'missing',
            file: credentialFile(context.dataDir),
            exists: credential.exists,
            complete: Boolean(credential.complete),
          });
        }
        if (args.action === 'start') {
          const { key, url } = await loginStart();
          const python = pythonForQr(context.dataDir);
          const qrPath = python ? await renderQrPng(python, context.dataDir, url) : null;
          return sanitize({
            state: 'waiting',
            key,
            url,
            qrPath: qrPath || undefined,
            qrDataUrl: qrPath ? qrDataUrl(qrPath) : undefined,
            hint: qrPath ? '把二维码给用户扫；扫完调用 action=poll。' : '二维码图片生成失败（qrcode 未安装？），先跑 watch_selftest action=install。',
          });
        }
        if (args.action === 'poll') {
          if (!args.key) return sanitize({ state: 'error', message: 'action=poll 需要 key' });
          const result = await loginPoll(args.key);
          if (result.state === 'ok' && result.credential) {
            const file = saveCredential(context.dataDir, result.credential);
            return sanitize({ state: 'ok', file, saved: true });
          }
          return sanitize({ state: result.state, code: result.code, message: result.message || undefined });
        }
        return sanitize({ state: 'error', message: `未知 action：${args.action}` });
      } catch (error) {
        return sanitize({ state: 'error', message: String(error?.message || error) });
      }
    },
  };
}

export function registerWatchTools(ctx, { dataDir, config = {}, vendorDir = defaultVendorDir() }) {
  if (!ctx?.tools?.register) return [];
  const context = { dataDir, config, vendorDir };
  const tools = [createSelftestTool(context), createLoginTool(context)];
  for (const tool of tools) {
    try { ctx.tools.register(tool); } catch (error) { console.error('[dsh-neocortex] watch tool registration failed', error); }
  }
  return tools.map((tool) => tool.name);
}
