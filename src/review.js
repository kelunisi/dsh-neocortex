import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readBrainSnapshot } from './recall.js';
import { atomicWrite, isoWeek, localDay, readPage, sha256, updateFooter } from './writer.js';

const GENERAL = '个人模型/近况/通用.md';
const SLEEPING_ITEMS = '个人模型/近况/沉睡条目.md';
const INDEX = '个人模型/近况/索引.md';
const DAY = 86400000;

export class ReviewConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewConflictError';
    this.code = 'review_conflict';
  }
}

function candidateId(week, type, ids, extra = '') {
  return crypto.createHash('sha256').update(JSON.stringify([week, type, ids, extra])).digest('hex').slice(0, 24);
}

function entryLine(entry) {
  return `- [${entry.date}] ${entry.text}`;
}

export function isMondayAfterNine(date, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return parts.weekday === 'Mon' && Number(parts.hour) >= 9;
}

export class WeeklyReview {
  constructor({ brainRoot, ledger, writer, lifecycle, config, now = () => new Date() }) {
    this.brainRoot = brainRoot;
    this.ledger = ledger;
    this.writer = writer;
    this.lifecycle = lifecycle;
    this.config = config;
    this.now = now;
    this.ledger.state.reviews ||= {};
    this.ledger.state.reviewRuns ||= {};
    this.ledger.state.l2Audit ||= {};
  }

  hashesFor(entries) {
    const hashes = {};
    for (const entry of entries) {
      if (!hashes[entry.sourcePath]) hashes[entry.sourcePath] = readPage(this.lifecycle.file(entry.sourcePath)).hash;
    }
    return hashes;
  }

  addCandidate(week, type, entries, details) {
    const ids = entries.map((entry) => entry.id).sort();
    const id = candidateId(week, type, ids, details.queueId || details.factKey || details.scene || '');
    const existing = this.ledger.state.reviews[id];
    if (existing) return existing;
    const candidate = {
      id,
      week,
      type,
      status: 'pending',
      targetIds: ids,
      createdAt: this.now().toISOString(),
      hashes: entries.length ? this.hashesFor(entries) : {},
      ...details,
    };
    this.ledger.state.reviews[id] = candidate;
    return candidate;
  }

  generate() {
    const now = this.now();
    const week = isoWeek(now);
    const snapshot = readBrainSnapshot(this.brainRoot);
    const candidates = [];
    for (const entry of snapshot.memories.filter((item) => item.sourcePath === SLEEPING_ITEMS)) {
      candidates.push(this.addCandidate(week, 'sleeping-item', [entry], {
        text: entry.text,
        reason: '无场景沉睡条目可由用户决定唤醒或删除。',
        suggestedAction: 'wake',
      }));
    }
    for (const scene of snapshot.scenes.filter((item) => item.status === 'sleeping')) {
      const entries = snapshot.memories.filter((item) => item.scene === scene.name && item.status === 'sleeping');
      candidates.push(this.addCandidate(week, 'sleeping-scene', entries, {
        text: scene.name,
        scene: scene.name,
        reason: '沉睡场景可由用户决定复活、继续沉睡或下沉索引。',
        suggestedAction: 'revive',
      }));
    }
    for (const entry of snapshot.memories.filter((item) => item.sourcePath === GENERAL)) {
      candidates.push(this.addCandidate(week, 'general-item', [entry], {
        text: entry.text,
        scene: entry.scene,
        reason: entry.scene ? `通用条目带有场景倾向“${entry.scene}”，可确认归档。` : '无场景通用条目可由用户指定场景或继续保留。',
        suggestedAction: entry.scene ? 'assign' : 'keep',
      }));
    }
    for (const item of this.ledger.state.pendingQueue.filter((entry) => entry.week === week)) {
      candidates.push(this.addCandidate(week, 'queue-item', [], {
        queueId: item.id,
        createdAt: item.queuedAt,
        text: item.text,
        request: { text: item.text, layer: item.layer, scene: item.scene, factKey: item.factKey },
        reason: `该候选因${item.reason}进入待择队列，需要用户决定写入或放弃。`,
        suggestedAction: 'write',
      }));
    }
    for (const entry of snapshot.memories.filter((item) => item.sourcePath === GENERAL)) {
      const memory = this.ledger.state.memories[entry.id];
      const last = Math.max(Date.parse(memory?.lastUsedAt || '') || 0, Date.parse(`${entry.date}T00:00:00Z`) || 0);
      const age = now.getTime() - last;
      if (age > (this.config.generalSleepDays - 3) * DAY && age <= this.config.generalSleepDays * DAY) {
        candidates.push(this.addCandidate(week, 'expiring-item', [entry], {
          text: entry.text,
          reason: `该通用条目将在 ${this.config.generalSleepDays} 天入睡线附近，可确认保留。`,
          suggestedAction: 'keep',
        }));
      }
    }
    const factGroups = {};
    for (const entry of snapshot.memories.filter((item) => item.factKey)) {
      const key = entry.factKey;
      factGroups[key] ||= [];
      factGroups[key].push(entry);
    }
    for (const [factKey, entries] of Object.entries(factGroups)) {
      if (new Set(entries.map((entry) => entry.text)).size < 2) continue;
      candidates.push(this.addCandidate(week, 'fact-conflict', entries, {
        factKey,
        text: entries.map((entry) => entry.text).join(' / '),
        reason: `同一事实键“${factKey}”存在多个值，必须选择保留项。`,
        suggestedAction: 'resolve',
      }));
    }
    this.ledger.save();
    return candidates;
  }

  list({ week = isoWeek(this.now()), status } = {}) {
    return Object.values(this.ledger.state.reviews)
      .filter((candidate) => candidate.week === week && (!status || candidate.status === status))
      .sort((a, b) => Number(b.type === 'queue-item') - Number(a.type === 'queue-item') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  preview(id) {
    const candidate = this.ledger.state.reviews[id];
    if (!candidate) return { status: 'not-found', id };
    return {
      ...candidate,
      hashes: undefined,
      targets: candidate.targetIds.map((targetId) => {
        const entry = readBrainSnapshot(this.brainRoot).memories.find((item) => item.id === targetId);
        return entry ? { id: entry.id, date: entry.date, text: entry.text, path: entry.sourcePath, status: entry.status } : { id: targetId, missing: true };
      }),
    };
  }

  assertFresh(candidate) {
    for (const [relative, expected] of Object.entries(candidate.hashes || {})) {
      const file = this.lifecycle.file(relative);
      if (!fs.existsSync(file) || readPage(file).hash !== expected) {
        throw new ReviewConflictError(`页面在候选生成后已变化，请重新生成周报：${relative}`);
      }
    }
  }

  reject(id, { sessionId } = {}) {
    const candidate = this.ledger.state.reviews[id];
    if (!candidate) return { status: 'not-found', id };
    if (candidate.status === 'rejected') return { status: 'already-rejected', id };
    if (candidate.status !== 'pending') return { status: 'already-resolved', id };
    candidate.status = 'rejected';
    candidate.resolvedAt = this.now().toISOString();
    if (candidate.queueId) this.ledger.state.pendingQueue = this.ledger.state.pendingQueue.filter((item) => item.id !== candidate.queueId);
    this.ledger.save();
    this.writer.log('拒绝周报候选', candidate.type, sessionId, id);
    return { status: 'rejected', id };
  }

  deleteEntry(entry, candidate) {
    const file = this.lifecycle.file(entry.sourcePath);
    const page = readPage(file);
    const line = entryLine(entry);
    if (!page.content.includes(line)) throw new ReviewConflictError('待删除条目已变化或不存在。');
    const content = updateFooter(page.content.replace(`${line}\n`, '').replace(line, ''), localDay(this.now()));
    const hashes = atomicWrite(file, content, page.hash);
    delete this.ledger.state.memories[entry.id];
    candidate.deletions ||= [];
    candidate.deletions.push({ sourcePath: entry.sourcePath, oldLine: line, ...hashes });
  }

  accept(id, { action, targetScene, winnerId, sessionId } = {}) {
    const candidate = this.ledger.state.reviews[id];
    if (!candidate) return { status: 'not-found', id };
    if (candidate.status === 'accepted') return { status: 'already-accepted', id, result: candidate.result };
    if (candidate.status !== 'pending') return { status: 'already-resolved', id };
    this.assertFresh(candidate);
    const operation = action || candidate.suggestedAction;
    const snapshot = readBrainSnapshot(this.brainRoot);
    const entries = candidate.targetIds.map((targetId) => snapshot.memories.find((entry) => entry.id === targetId)).filter(Boolean);
    let result;
    if (operation === 'write' && candidate.queueId) {
      const queued = this.ledger.state.pendingQueue.find((item) => item.id === candidate.queueId);
      if (!queued) return { status: 'queue-missing', id };
      result = this.writer.remember({ ...candidate.request, explicit: true }, { sessionId });
      if (result.status === 'queued') return { status: 'still-queued', id, result };
      this.ledger.state.pendingQueue = this.ledger.state.pendingQueue.filter((item) => item.id !== candidate.queueId);
    } else if (operation === 'wake' && entries.length === 1) {
      this.lifecycle.moveEntry(entries[0], GENERAL, { sessionId, reason: '周报用户同意唤醒', targetStatus: 'active', touched: true });
      result = { moved: entries[0].id, to: GENERAL };
    } else if (operation === 'delete' && entries.length) {
      for (const entry of entries) this.deleteEntry(entry, candidate);
      result = { deleted: entries.map((entry) => entry.id) };
    } else if (operation === 'keep' && entries.length) {
      for (const entry of entries) {
        const memory = this.ledger.state.memories[entry.id];
        if (memory) memory.lastUsedAt = this.now().toISOString();
      }
      result = { kept: entries.map((entry) => entry.id) };
    } else if (operation === 'revive' && candidate.scene) {
      const scene = snapshot.scenes.find((item) => item.name === candidate.scene && item.status === 'sleeping');
      if (!scene) throw new ReviewConflictError('沉睡场景已变化，无法按旧候选复活。');
      result = this.lifecycle.moveScene(scene, 'active', { sessionId, reason: '周报用户同意复活' });
    } else if (operation === 'sink' && candidate.scene) {
      const scenes = snapshot.scenes.filter((item) => item.name !== candidate.scene);
      this.lifecycle.writeIndex(scenes, sessionId);
      this.lifecycle.setSceneMeta(candidate.scene, { sunkAt: this.now().toISOString() });
      result = { sunk: candidate.scene };
    } else if ((operation === 'assign' || operation === 'merge') && entries.length && (targetScene || candidate.scene)) {
      const name = targetScene || candidate.scene;
      const scene = this.lifecycle.ensurePromotedScene(name, snapshot, sessionId);
      for (const entry of entries) this.lifecycle.moveEntry(entry, `个人模型/近况/活跃/${scene.name}.md`, { sessionId, reason: '周报用户确认归档', targetScene: scene.name, targetStatus: 'active' });
      result = { assigned: entries.map((entry) => entry.id), scene: scene.name };
    } else if (operation === 'resolve' && candidate.type === 'fact-conflict' && winnerId) {
      if (!entries.some((entry) => entry.id === winnerId)) throw new Error('winnerId must be one of the conflicting entries.');
      const losers = entries.filter((entry) => entry.id !== winnerId);
      for (const entry of losers) this.deleteEntry(entry, candidate);
      if (this.ledger.state.facts[candidate.factKey]) this.ledger.state.facts[candidate.factKey].currentId = winnerId;
      result = { winnerId, removed: losers.map((entry) => entry.id) };
    } else {
      throw new Error(`Unsupported or incomplete review operation: ${operation}`);
    }
    candidate.status = 'accepted';
    candidate.resolvedAt = this.now().toISOString();
    candidate.result = result;
    this.ledger.save();
    this.writer.log('同意周报候选', candidate.type, sessionId, `${id} / ${operation}`);
    return { status: 'accepted', id, operation, result };
  }

  auditL2() {
    const root = path.join(this.brainRoot, '知识库');
    if (!fs.existsSync(root)) return [];
    const results = [];
    const visit = (directory) => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, item.name);
        if (item.isDirectory()) visit(absolute);
        else if (item.isFile() && item.name.endsWith('.md')) {
          const content = fs.readFileSync(absolute, 'utf8');
          results.push({
            path: path.relative(this.brainRoot, absolute).split(path.sep).join('/'),
            sha256: sha256(content),
            title: content.match(/^#\s+(.+)$/m)?.[1] || item.name.slice(0, -3),
          });
        }
      }
    };
    visit(root);
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  run({ sessionId, trigger = 'manual', runLifecycle = true } = {}) {
    const week = isoWeek(this.now());
    const previous = this.ledger.state.reviewRuns[week];
    if (previous?.status === 'completed') return { ...previous.summary, week, trigger, reused: true, candidates: this.list({ week }) };
    this.ledger.state.reviewRuns[week] = { status: 'running', trigger, startedAt: this.now().toISOString() };
    this.ledger.save();
    try {
      const lifecycle = runLifecycle ? this.lifecycle.runReview({ sessionId }) : undefined;
      const candidates = this.generate();
      const l2Audit = this.auditL2();
      const reconciliation = this.lifecycle.reconcile();
      const summary = {
        trigger,
        completedAt: this.now().toISOString(),
        lifecycle,
        candidateIds: candidates.map((candidate) => candidate.id),
        l2Audit,
        reconciliation,
      };
      this.ledger.state.reviewRuns[week] = { status: 'completed', summary };
      this.ledger.state.l2Audit[week] = l2Audit;
      this.ledger.save();
      return { ...summary, week, reused: false, candidates };
    } catch (error) {
      this.ledger.state.reviewRuns[week] = {
        status: 'failed',
        trigger,
        startedAt: this.ledger.state.reviewRuns[week].startedAt,
        failedAt: this.now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.ledger.save();
      throw error;
    }
  }

  manual(options = {}) {
    return this.run({ ...options, trigger: 'manual' });
  }

  ensureWeekly({ sessionId, runLifecycle = true } = {}) {
    const week = isoWeek(this.now());
    if (!isMondayAfterNine(this.now()) || this.ledger.state.reviewRuns[week]?.status === 'completed') {
      const completed = this.ledger.state.reviewRuns[week]?.status === 'completed';
      if (completed) this.ledger.state.lastWeeklyWeek = week;
      this.ledger.save();
      return { generated: false, week, candidates: this.list({ week }) };
    }
    const result = this.run({ sessionId, trigger: 'schedule', runLifecycle });
    this.ledger.state.lastWeeklyWeek = week;
    this.ledger.save();
    return { generated: true, ...result };
  }
}
