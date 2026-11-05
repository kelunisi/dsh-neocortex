import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from './src/ledger.js';
import { NeocortexRuntime } from './src/runtime.js';
import { DEFAULT_CONFIG, resolveConfig } from './src/defaults.js';
import { runP1HostProbe } from './src/p1-host-probe.js';
import { MemoryWriter } from './src/writer.js';
import { routeRecallMiss } from './src/recall.js';
import { LifecycleEngine } from './src/lifecycle.js';
import { memoryPolicy } from './src/policy.js';
import { WeeklyReview } from './src/review.js';
import { loadSettings, PanelStateService } from './src/panel-service.js';
import { NeocortexRemoteService } from './src/remote-service.js';
import { executePanelTool, isPanelReadAction } from './src/panel-tool.js';

export const inject = ['agents', 'sessions', 'tools', 'systemPrompt'];

// Priority: brainroot.json written by the setup wizard > cordis patch config > ~/智脑.
function resolveBrainRoot(rawConfig, dataDir) {
  try {
    const overrideFile = path.join(dataDir, 'brainroot.json');
    if (fs.existsSync(overrideFile)) {
      const parsed = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
      if (parsed && typeof parsed.brainRoot === 'string' && parsed.brainRoot.trim()) {
        return path.resolve(parsed.brainRoot.trim());
      }
    }
  } catch { /* malformed override is ignored; fall through */ }
  if (rawConfig.brainRoot) return path.resolve(rawConfig.brainRoot);
  return path.join(os.homedir(), '智脑');
}

function textFromContent(content = []) {
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

function latestUserText(agent) {
  if (!agent?.session) return '';
  const events = agent.session.snapshotEvents();
  const latest = events.findLast((event) => event.type === 'user/message' && event.data.source?.kind === 'user');
  return latest ? textFromContent(latest.data.content) : '';
}

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

export function apply(ctx, rawConfig = {}) {
  const packageRoot = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = rawConfig.dataDir || path.join(os.homedir(), '.dsh', 'neocortex');
  const brainRoot = resolveBrainRoot(rawConfig, dataDir);
  const configured = Object.fromEntries(Object.keys(DEFAULT_CONFIG).filter((key) => key in rawConfig).map((key) => [key, rawConfig[key]]));
  const config = resolveConfig({ ...configured, ...loadSettings(dataDir) });
  const ledger = new Ledger(path.join(dataDir, 'ledger.json'));
  const writer = new MemoryWriter({ brainRoot, ledger, config });
  const lifecycle = new LifecycleEngine({ brainRoot, ledger, writer, config });
  const review = new WeeklyReview({ brainRoot, ledger, writer, lifecycle, config });
  const panel = new PanelStateService({ brainRoot, dataDir, ledger, writer, lifecycle, review, config, templateRoot: path.join(packageRoot, 'templates', 'brain') });
  new NeocortexRemoteService(ctx, panel);
  const runtime = new NeocortexRuntime({
    ledger,
    brainRoot,
    config,
    probeFile: path.join(dataDir, 'events.jsonl'),
    onUsed: (ids, sessionId) => lifecycle.recordHits(ids, { sessionId }),
    onSessionEnd: (sessionId) => lifecycle.onSessionEnd(sessionId),
  });
  runtime.recoverFromJournal();

  const runScheduledReview = () => {
    try { review.ensureWeekly({ sessionId: 'dsh-neocortex-weekly' }); }
    catch (error) { console.error('[dsh-neocortex] weekly review failed', error); }
  };
  runScheduledReview();
  const weeklyTimer = setInterval(runScheduledReview, 15 * 60 * 1000);
  weeklyTimer.unref?.();
  ctx.effect(() => () => clearInterval(weeklyTimer));

  ctx.on('session/event', (session, event) => runtime.observeEvent(session, event));
  ctx.on('session/disposed', (session) => runtime.dispose(session));

  const attached = new Set();
  const attach = (agent) => {
    if (attached.has(agent.id)) return;
    attached.add(agent.id);
    const dispose = agent.ctx.on('agent/pre-step', (payload, next) => runtime.preStep(agent, payload, next));
    ctx.effect(() => () => {
      if (typeof dispose === 'function') dispose();
      attached.delete(agent.id);
    });
  };
  ctx.on('agent/created', ({ agent }) => attach(agent));
  for (const agent of ctx.agents.list()) attach(agent);

  ctx.systemPrompt.section({
    name: 'dsh-neocortex-memory',
    order: 60,
    text: '智脑记忆：有后续召回价值时使用 neocortex_remember，普通聊天不要保存。个人往事注入未命中时使用 neocortex_recall；若返回 web_search 则改用网络检索。用户说“这次不用智脑”时不读写，说“这个不要记”时不保存指定内容。不得保存密码、凭据或无必要的敏感信息。面板状态、撤销、周回顾和参数使用 neocortex_panel；L1 确认与候选接受/拒绝不得代用户执行。',
  });

  ctx.tools.register({
    name: 'neocortex_remember',
    description: '将一条有后续召回价值的信息按 L1/L2/L3 权限写入智脑，返回去向、配额或排队结果。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要保存的一条原子信息；不要传密码、凭据或无必要的敏感信息。' },
        layer: { type: 'string', enum: ['L1', 'L2', 'L3'], description: 'L1 长期模型，L2 外部知识，L3 近况。' },
        worthSaving: { type: 'boolean', description: '无后续召回价值时设为 false，不写文件。' },
        scene: { type: 'string', description: 'L3 的已有场景名或通用条目的场景倾向。' },
        factKey: { type: 'string', description: '可选的“对象.方面”事实键；同键新值取代旧值。' },
        category: { type: 'string', enum: ['background', 'preference', 'task'], description: 'L1 分类；默认 preference。' },
        targetPath: { type: 'string', description: 'L2 知识页相对路径，或 category=task 时的任务标准页路径。' },
        source: { type: 'string', description: 'L2 必填的来源 URL 或来源标识。' },
        explicit: { type: 'boolean', description: '仅当当前用户消息确实明确要求记住或照做时设为 true；实际权限以该消息为准。' },
      },
      required: ['text', 'layer'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
      render: (_args, value) => renderJson(value),
    },
    execute: async (args, exec) => {
      const userText = latestUserText(exec.agent);
      const policy = memoryPolicy(userText);
      if (!policy.allowSave) return { status: 'rejected', reason: 'user-opt-out' };
      const verifiedExplicit = policy.explicit;
      const result = writer.remember({ ...args, explicit: verifiedExplicit }, { sessionId: exec.agent?.id });
      return { ...result, explicitVerified: verifiedExplicit };
    },
  });

  ctx.tools.register({
    name: 'neocortex_recall',
    description: '检索通用与沉睡个人往事；无结果时明确返回 unknown，外部知识问题返回 web_search 路由。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要查找的个人往事或问题。' } },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
      render: (_args, value) => renderJson(value),
    },
    execute: async (args, exec) => {
      const userText = latestUserText(exec.agent);
      if (!memoryPolicy(userText).allowRead) return { kind: 'rejected', reason: 'user-opt-out' };
      const result = await routeRecallMiss({ brainRoot, query: args.query });
      if (result.results) result.results = result.results.slice(0, 10).map((entry) => ({ date: entry.date, text: entry.text, path: entry.sourcePath, status: entry.status }));
      return result;
    },
  });

  ctx.tools.register({
    name: 'neocortex_panel',
    description: '读取智脑面板状态或预览，撤销取代，执行/重试周回顾，更新六项有界参数。L1 确认及周回顾候选接受/拒绝只能由用户在面板操作。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['state', 'preview_review', 'undo', 'manual_review', 'retry_review', 'update_settings'] },
        id: { type: 'string', description: 'preview_review 使用候选 ID；undo 使用可撤销取代 ID。' },
        settings: {
          type: 'object',
          description: 'update_settings 的参数补丁；冻结配额不可修改。',
          properties: {
            halfLifeDays: { type: 'integer', minimum: 15, maximum: 45 },
            firstInjectionMaxItems: { type: 'integer', minimum: 3, maximum: 15 },
            firstInjectionMaxChars: { type: 'integer', minimum: 600, maximum: 1200 },
            generalSleepDays: { type: 'integer', minimum: 10, maximum: 30 },
            revivalWindowDays: { type: 'integer', minimum: 1, maximum: 3 },
            revivalThreshold: { type: 'integer', minimum: 2, maximum: 5 },
          },
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderJson(value),
    },
    execute: async (args, exec) => {
      const policy = memoryPolicy(latestUserText(exec.agent));
      if (!policy.allowRead || (!isPanelReadAction(args.action) && !policy.allowSave)) {
        return { status: 'rejected', reason: 'user-opt-out' };
      }
      return executePanelTool(panel, args, exec.agent?.id);
    },
  });

  if (rawConfig.probeOnStart && fs.existsSync(path.join(packageRoot, 'evidence'))) {
    runP1HostProbe(ctx, {
      dataDir,
      evidenceDir: path.join(packageRoot, 'evidence'),
      fixtureBrainRoot: path.join(packageRoot, 'fixtures', 'brain'),
    }).then((evidence) => {
      if (!evidence.passed) console.error('[dsh-neocortex] P1 host probe failed; see evidence/p1-host-probe.json');
    }).catch((error) => {
      console.error('[dsh-neocortex] P1 host probe crashed', error);
    });
  }
}
