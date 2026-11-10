/**
 * 模型可调用的喂养工具（P2）：体检 + 扫码登录。
 * 面板按钮和悬浮球在 P7 接同一套函数。
 */

import fs from 'node:fs';
import { sanitize } from '../defaults.js';
import { appendDecisions } from './calibration.js';
import { hydrateItems } from './hydrate.js';
import { acceptItems, rejectItems, retryItems } from './ingest.js';
import { loadCriteria } from './criteria.js';
import { buildSuggestions, fetchFollowings, saveSuggestions } from './suggestions.js';
import { runAgentProbe } from './agent-probe.js';
import { loginPoll, loginStart, qrDataUrl, renderQrPng, saveCredential } from './login.js';
import { credentialFile, readCredential, resolvePython, venvPython } from './python.js';
import { loadQueue, saveQueue } from './queue.js';
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
    description: '手动喂养：dry=跑一轮离线试跑；suggest=读关注列表生成关注建议；agent_probe=验证受限 agent 会话。dry/suggest 不写智脑，agent_probe 只建临时会话。',
    timeoutMs: 900000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dry', 'suggest', 'agent_probe'], description: 'dry 跑一轮；suggest 生成关注建议；agent_probe 验证 agent 会话。' },
        queries: { type: 'array', items: { type: 'string' }, description: '可选：覆盖判据里的搜索词。' },
        deep: { type: 'integer', minimum: 1, maximum: 5, description: '可选：深读条数，默认 3。' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'suggest 时最多返回几条，默认 5。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      try {
        if (args?.action === 'agent_probe') {
          return sanitize(await runAgentProbe({ ctx: context.ctx, dataDir: context.dataDir, config: context.config }));
        }
        if (args?.action === 'suggest') {
          let followings = [];
          let warning;
          try {
            followings = await fetchFollowings({ dataDir: context.dataDir, config: context.config, vendorDir: context.vendorDir, log: (line) => console.error('[watch]', line) });
          } catch (error) {
            warning = `关注列表读取失败：${String(error?.message || error).slice(0, 160)}`;
          }
          const { criteria } = loadCriteria(context.dataDir);
          const items = buildSuggestions({
            queue: loadQueue(context.dataDir),
            followings,
            criteria,
            limit: Math.max(1, Math.min(10, Number(args?.limit) || 5)),
          });
          saveSuggestions(context.dataDir, { items });
          return sanitize({ ok: true, action: 'suggest', count: items.length, followings: followings.length, items, warning });
        }
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

function createIngestTool(context) {
  return {
    name: 'watch_ingest',
    description: '处理待确认队列：accept 把条目写进智脑（L2 来源摘要 + L3 近况），reject 只留跳过原因。ids 省略或 all=true 时处理全部待判条目；accept 默认先给没有要点的条目补一次深读。',
    timeoutMs: 900000,
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['accept', 'reject', 'retry'], description: 'accept 收、reject 扔、retry 重试之前写失败的条目。' },
        ids: { type: 'array', items: { type: 'string' }, description: '队列条目 id 或 bvid；省略时配合 all=true。' },
        all: { type: 'boolean', description: 'true 表示处理全部待判条目。' },
        note: { type: 'string', description: '可选备注，写进队列。' },
        hydrate: { type: 'boolean', description: 'accept 时是否给无要点条目补深读，默认 true。' },
      },
      required: ['decision'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      try {
        const queue = loadQueue(context.dataDir);
        if (!queue.items.length) return sanitize({ ok: false, reason: 'queue-empty', message: '待确认队列是空的。' });
        const ids = Array.isArray(args?.ids) && args.ids.length ? args.ids : (!args?.all ? undefined : null);
        if (!ids && args?.all !== true) return sanitize({ ok: false, reason: 'ids-required', message: '给 ids，或 all=true。' });
        const idSet = ids ? new Set(ids) : null;
        const selected = queue.items.filter((item) => item.status === 'pending'
          && (!idSet || idSet.has(item.id) || idSet.has(item.bvid)));
        if (args.decision === 'accept') {
          if (!context.writer) return sanitize({ ok: false, reason: 'writer-unavailable' });
          let hydration;
          const empty = selected.filter((item) => !Array.isArray(item.points) || item.points.length === 0);
          if (args.hydrate !== false && context.ctx && empty.length) {
            hydration = await hydrateItems({
              ctx: context.ctx,
              dataDir: context.dataDir,
              config: context.config,
              vendorDir: context.vendorDir,
              items: empty,
              signal: exec?.signal,
              log: (line) => console.error('[watch]', line),
            });
          }
          const result = acceptItems({ writer: context.writer, queue, dataDir: context.dataDir, sessionId: 'watch-ingest', ids: ids || undefined });
          saveQueue(context.dataDir, queue);
          const remaining = queue.items.filter((item) => item.status === 'pending').length;
          return sanitize({ ok: true, decision: 'accept', ...result, hydration, remaining, queueFile: queue.file });
        }
        if (args.decision === 'retry') {
          if (!context.writer) return sanitize({ ok: false, reason: 'writer-unavailable' });
          const result = retryItems({ writer: context.writer, queue, dataDir: context.dataDir, sessionId: 'watch-ingest-retry', ids: ids || undefined });
          saveQueue(context.dataDir, queue);
          const remaining = queue.items.filter((item) => item.status === 'pending').length;
          return sanitize({ ok: true, decision: 'retry', ...result, remaining, queueFile: queue.file });
        }
        const result = rejectItems({ queue, ids: ids || undefined, note: args?.note });
        saveQueue(context.dataDir, queue);
        const remaining = queue.items.filter((item) => item.status === 'pending').length;
        return sanitize({ ok: true, decision: 'reject', ...result, remaining, queueFile: queue.file });
      } catch (error) {
        return sanitize({ ok: false, reason: 'ingest-failed', message: String(error?.message || error) });
      }
    },
  };
}

function createSuggestTool(context) {
  return {
    name: 'watch_suggest',
    description: '只读：读当前账号的关注列表，按判据给队列里的 UP 主打分，生成 3–5 个关注建议；不写关注。',
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回几个建议，默认 5。' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      try {
        let followings = [];
        let warning;
        try {
          followings = await fetchFollowings({
            dataDir: context.dataDir,
            config: context.config,
            vendorDir: context.vendorDir,
            log: (line) => console.error('[watch]', line),
          });
        } catch (error) {
          warning = `关注列表读取失败：${String(error?.message || error).slice(0, 160)}`;
        }
        const { criteria } = loadCriteria(context.dataDir);
        const items = buildSuggestions({
          queue: loadQueue(context.dataDir),
          followings,
          criteria,
          limit: Math.max(1, Math.min(10, Number(args?.limit) || 5)),
        });
        saveSuggestions(context.dataDir, { items });
        return sanitize({ ok: true, count: items.length, followings: followings.length, items, warning });
      } catch (error) {
        return sanitize({ ok: false, reason: 'suggest-failed', message: String(error?.message || error).slice(0, 300) });
      }
    },
  };
}

function createAgentProbeTool(context) {
  return {
    name: 'watch_agent_probe',
    description: 'P4.5 spike：尝试用宿主 agents.create 拉起一个临时会话，确认能否收集到模型文本；不改任何配置、不写知识库。',
    timeoutMs: 90000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      try {
        return sanitize(await runAgentProbe({ ctx: context.ctx, dataDir: context.dataDir, config: context.config }));
      } catch (error) {
        return sanitize({ ok: false, reason: 'probe-crashed', message: String(error?.message || error).slice(0, 500) });
      }
    },
  };
}

export function registerWatchTools(ctx, { dataDir, config = {}, vendorDir = defaultVendorDir(), watch, writer } = {}) {
  if (!ctx?.tools?.register) return [];
  const context = { ctx, dataDir, config, vendorDir, watch, writer };
  const tools = [createSelftestTool(context), createLoginTool(context), createRunTool(context), createFeedbackTool(context), createIngestTool(context)];
  for (const tool of tools) {
    try { ctx.tools.register(tool); } catch (error) { console.error('[dsh-neocortex] watch tool registration failed', error); }
  }
  return tools.map((tool) => tool.name);
}
