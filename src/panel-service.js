import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readBrainSnapshot } from './recall.js';
import { atomicWrite, insertUnderHeading, localDay, readPage, resolveMarkdown, updateFooter } from './writer.js';
import { DEFAULT_CONFIG, resolveConfig } from './defaults.js';
import { brainState, defaultBrainDir, initializeBrain } from './setup.js';
import { isoWeek } from './writer.js';

const L1_TARGETS = [
  '个人模型/个人背景.md',
  '个人模型/协作偏好.md',
];

export const SETTING_RANGES = Object.freeze({
  halfLifeDays: [15, 45],
  firstInjectionMaxItems: [3, 15],
  firstInjectionMaxChars: [600, 1200],
  generalSleepDays: [10, 30],
  revivalWindowDays: [1, 3],
  revivalThreshold: [2, 5],
});

export function loadSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return resolveConfig(parsed);
}

function pendingItems(content, sourcePath) {
  const result = [];
  let pending = false;
  for (const line of content.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('## ')) pending = /^## 待确认/.test(line);
    if (!pending || !line.startsWith('- ')) continue;
    result.push({
      id: crypto.createHash('sha256').update(`${sourcePath}|${line}`).digest('hex').slice(0, 24),
      text: line.slice(2).replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, ''),
      line,
      sourcePath,
    });
  }
  return result;
}

export class PanelStateService {
  constructor({ brainRoot, dataDir, ledger, writer, lifecycle, review, config, templateRoot }) {
    this.brainRoot = brainRoot;
    this.dataDir = dataDir;
    this.ledger = ledger;
    this.writer = writer;
    this.lifecycle = lifecycle;
    this.review = review;
    this.config = config;
    this.templateRoot = templateRoot;
  }

  listL1Pending() {
    const taskRoot = path.join(this.brainRoot, '个人模型', '任务标准');
    const taskFiles = fs.existsSync(taskRoot)
      ? fs.readdirSync(taskRoot, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.md')).map((item) => `个人模型/任务标准/${item.name}`)
      : [];
    return [...L1_TARGETS, ...taskFiles].flatMap((relative) => {
      const file = resolveMarkdown(this.brainRoot, relative, ['个人模型/']);
      if (!fs.existsSync(file)) return [];
      const page = readPage(file);
      return pendingItems(page.content, relative).map((item) => ({ ...item, sha256: page.hash }));
    });
  }

  state() {
    const snapshot = readBrainSnapshot(this.brainRoot);
    const week = isoWeek(this.review.now());
    const today = localDay(this.review.now());
    const quota = this.writer.quota(today);
    return {
      generatedAt: this.review.now().toISOString(),
      memories: snapshot.memories.slice(0, 200).map((entry) => ({
        id: entry.id,
        date: entry.date,
        text: entry.text,
        scene: entry.scene,
        status: entry.status,
        path: entry.sourcePath,
        explanation: this.ledger.score(entry.id, this.review.now()),
      })),
      l1Pending: this.listL1Pending(),
      l2Audit: this.ledger.state.l2Audit?.[week] || [],
      quota: {
        day: today,
        total: quota.total,
        limit: this.config.dailyWriteQuota,
        exemptions: quota.exemptions,
        exemptionLimit: this.config.dailyExemptionQuota,
      },
      queue: {
        items: this.ledger.state.pendingQueue,
        limit: this.config.pendingQueueLimit,
        evictions: this.ledger.state.queueEvictions || [],
      },
      reviews: this.review.list({ week }).map(({ hashes, ...candidate }) => candidate),
      reviewRun: this.ledger.state.reviewRuns?.[week] || null,
      tombstones: this.ledger.state.tombstones.filter((item) => item.status === 'active'),
      settings: { ...this.config },
      settingRanges: SETTING_RANGES,
      setup: {
        brainRoot: this.brainRoot,
        status: brainState(this.brainRoot).status,
        defaultDir: defaultBrainDir(),
      },
      capabilities: { realtimeRanking: true, realtimeQuota: true, automaticLifecycle: true },
      empty: { memories: snapshot.memories.length === 0, reviews: this.review.list({ week }).length === 0 },
    };
  }

  confirmL1({ id, expectedHash }, sessionId) {
    const item = this.listL1Pending().find((candidate) => candidate.id === id);
    if (!item) return { status: 'not-found', id };
    if (expectedHash && expectedHash !== item.sha256) throw new Error('L1 页面已变化，请刷新后再确认。');
    const file = resolveMarkdown(this.brainRoot, item.sourcePath, ['个人模型/']);
    const page = readPage(file);
    if (page.hash !== item.sha256) throw new Error('L1 页面已变化，确认已停止。');
    const contentWithout = page.content.replace(`${item.line}\n`, '').replace(item.line, '');
    const formal = updateFooter(insertUnderHeading(contentWithout, item.line, item.sourcePath.includes('任务标准') ? '已确认规则' : '用户明示记录'), localDay(this.review.now()));
    atomicWrite(file, formal, page.hash);
    const overviewPath = '个人模型/_索引.md';
    const overviewFile = resolveMarkdown(this.brainRoot, overviewPath, ['个人模型/']);
    if (fs.existsSync(overviewFile)) {
      const overview = readPage(overviewFile);
      if (!overview.content.includes(item.text)) {
        const next = updateFooter(insertUnderHeading(overview.content, `- ${item.text}（来源：${item.sourcePath}）`, '用户明示记录'), localDay(this.review.now()));
        atomicWrite(overviewFile, next, overview.hash);
      }
    }
    this.writer.log('用户确认 L1 待确认项', item.sourcePath, sessionId, id);
    return { status: 'confirmed', id, path: item.sourcePath };
  }

  undo({ id }, sessionId) {
    return this.writer.undoTombstone(id, { sessionId });
  }

  acceptReview(request, sessionId) {
    return this.review.accept(request.id, { ...request, sessionId });
  }

  rejectReview(request, sessionId) {
    return this.review.reject(request.id, { sessionId });
  }

  manualReview(_request, sessionId) {
    return this.review.manual({ sessionId });
  }

  retryReview(_request, sessionId) {
    return this.review.run({ sessionId, trigger: 'retry' });
  }

  updateSettings(patch) {
    const allowed = Object.keys(SETTING_RANGES);
    const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new Error(`Unknown or frozen settings: ${unknown.join(', ')}`);
    const next = resolveConfig({ ...this.config, ...patch });
    const previous = { ...this.config };
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, 'settings.json');
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
    Object.assign(this.config, next);
    return { status: 'updated', previous, settings: next, historyUnchanged: true };
  }

  defaults() {
    return { ...DEFAULT_CONFIG };
  }

  initializeBrain(request, sessionId) {
    const mode = request?.mode;
    const targetDir = request?.targetDir;
    const result = initializeBrain({ mode, targetDir, templateRoot: this.templateRoot });
    if (['initialized', 'takeover-ready', 'upgraded', 'nothing-to-do'].includes(result.status)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const override = path.join(this.dataDir, 'brainroot.json');
      const temp = `${override}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ brainRoot: result.targetDir }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, override);
      const action = mode === 'new' ? '初始化新建智脑' : mode === 'takeover' ? '接管已有智脑' : '升级补齐智脑骨架';
      this.writer.log(action, result.targetDir, sessionId, result.status);
    }
    return result;
  }
}
