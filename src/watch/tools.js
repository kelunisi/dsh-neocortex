/**
 * 模型可调用的喂养工具（P2）：体检 + 扫码登录。
 * 面板按钮和悬浮球在 P7 接同一套函数。
 */

import fs from 'node:fs';
import { sanitize } from '../defaults.js';
import { appendDecisions } from './calibration.js';
import { loginPoll, loginStart, qrDataUrl, renderQrPng, saveCredential } from './login.js';
import { credentialFile, readCredential, resolvePython, venvPython } from './python.js';
import { runDryRound } from './round.js';
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

function createRunTool(context) {
  return {
    name: 'watch_run',
    description: '手动跑一轮喂养（P3 离线试跑）：抓取 B 站候选、代码粗筛、深读 2–3 条、写日报与 JSONL；不写智脑、不发评论。需要先把开关切到 code 或 agent。',
    timeoutMs: 900000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dry'], description: 'P3 只支持 dry（离线试跑）。' },
        queries: { type: 'array', items: { type: 'string' }, description: '可选：覆盖判据里的搜索词。' },
        deep: { type: 'integer', minimum: 1, maximum: 5, description: '可选：深读条数，默认 3。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      try {
        if (!context.watch?.enabled?.()) return sanitize({ ok: false, reason: 'mode-off', message: '喂养开关是 off；先在面板切到 code 模式。' });
        const result = await runDryRound({
          ctx: context.ctx,
          dataDir: context.dataDir,
          config: {
            ...context.config,
            queries: args?.queries,
            deepPerRound: args?.deep ?? context.config?.deepPerRound,
          },
          vendorDir: context.vendorDir,
          signal: exec?.signal,
          log: (line) => console.error('[watch]', line),
        });
        return sanitize(result);
      } catch (error) {
        return sanitize({ ok: false, reason: 'run-failed', message: String(error?.message || error) });
      }
    },
  };
}

function createFeedbackTool(context) {
  return {
    name: 'watch_feedback',
    description: '记录用户对知识点的"收/扔"判定，写入 <dataDir>/watch/calibration.jsonl；下一轮判读会把这些例子作为 few-shot。',
    parameters: {
      type: 'object',
      properties: {
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bvid: { type: 'string' },
              decision: { type: 'string', enum: ['received', 'rejected'] },
              title: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['bvid', 'decision'],
            additionalProperties: false,
          },
          description: '每条视频一个判定；received=收，rejected=扔。',
        },
      },
      required: ['decisions'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => sanitize(appendDecisions(context.dataDir, args?.decisions)),
  };
}

export function registerWatchTools(ctx, { dataDir, config = {}, vendorDir = defaultVendorDir(), watch } = {}) {
  if (!ctx?.tools?.register) return [];
  const context = { ctx, dataDir, config, vendorDir, watch };
  const tools = [createSelftestTool(context), createLoginTool(context), createRunTool(context), createFeedbackTool(context)];
  for (const tool of tools) {
    try { ctx.tools.register(tool); } catch (error) { console.error('[dsh-neocortex] watch tool registration failed', error); }
  }
  return tools.map((tool) => tool.name);
}
