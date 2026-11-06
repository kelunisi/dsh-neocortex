import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseMemoryEntries, parseSceneIndex, readBrainSnapshot } from './recall.js';

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const asPosix = (value) => value.split(path.sep).join('/');

export function localDay(date, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function isoWeek(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function containsSensitive(text) {
  return /(密码|口令|密钥|凭据|身份证号|银行卡号|password|passwd|api[-_ ]?key|access[-_ ]?token|secret|bearer\s+[a-z0-9._-]+)/i.test(text);
}

export function validateFactKey(key) {
  if (!key) return;
  if (!/^[^.\s:{},]+\.[^.\s:{},]+$/.test(key)) throw new Error('事实键必须使用“对象.方面”格式，键中不能包含值。');
}

export function resolveMarkdown(root, relative, allowedPrefixes) {
  if (!relative || path.isAbsolute(relative)) throw new Error('Target must be a relative Markdown path inside Zhinao.');
  const normalized = asPosix(path.normalize(relative));
  if (!normalized.endsWith('.md') || !allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) {
    throw new Error(`Target is outside the allowed Markdown areas: ${normalized}`);
  }
  const resolved = path.resolve(root, normalized);
  const prefix = path.resolve(root) + path.sep;
  if (!resolved.startsWith(prefix)) throw new Error('Target escapes Zhinao.');
  return resolved;
}

export function readPage(file) {
  const content = fs.readFileSync(file, 'utf8');
  return { content, hash: sha256(content) };
}

function ensurePage(file) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${path.basename(file, '.md')}\n`, 'utf8');
}

export function atomicWrite(file, content, expectedHash) {
  const latest = readPage(file);
  if (latest.hash !== expectedHash) throw new Error(`Page changed before writing; refusing stale overwrite: ${file}`);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
  return { beforeHash: expectedHash, afterHash: sha256(content) };
}

export function updateFooter(content, date) {
  const signature = `最近修订: dsh-neocortex (DSH) @ ${date}`;
  if (/^最近修订:/m.test(content)) return content.replace(/^最近修订:.*$/m, signature);
  return content.trimEnd() + `\n\n---\n\n${signature}\n`;
}

export function insertUnderHeading(content, line, heading) {
  let value = content.replace(/^\s*暂无。\s*$/m, '');
  const marker = `## ${heading}`;
  if (value.includes(marker)) {
    const index = value.indexOf(marker) + marker.length;
    return value.slice(0, index) + `\n\n${line}` + value.slice(index).replace(/^\r?\n+/, '\n');
  }
  const footer = value.match(/\n---\n\n最近修订:/);
  if (footer?.index !== undefined) {
    return value.slice(0, footer.index) + `\n\n${marker}\n\n${line}\n` + value.slice(footer.index);
  }
  return value.trimEnd() + `\n\n${marker}\n\n${line}\n`;
}

function rawEntryLine(entry) {
  return `- [${entry.date}] ${entry.text}`;
}

function weekQueue(state, week) {
  return state.pendingQueue.filter((item) => item.week === week);
}

export class MemoryWriter {
  constructor({ brainRoot, ledger, config, now = () => new Date(), timeZone = 'Asia/Shanghai' }) {
    this.brainRoot = brainRoot;
    this.ledger = ledger;
    this.config = config;
    this.now = now;
    this.timeZone = timeZone;
    this.ledger.state.tombstones ||= [];
    this.ledger.state.queueEvictions ||= [];
  }

  queue(request, reason) {
    const now = this.now();
    const week = isoWeek(now);
    const item = {
      id: crypto.randomUUID(),
      text: request.text,
      layer: request.layer,
      scene: request.scene,
      factKey: request.factKey,
      explicit: Boolean(request.explicit),
      reason,
      week,
      queuedAt: now.toISOString(),
    };
    const duplicate = weekQueue(this.ledger.state, week).some((entry) => entry.text === item.text && entry.scene === item.scene);
    if (!duplicate) {
      this.ledger.state.pendingQueue.push(item);
      const sameWeek = weekQueue(this.ledger.state, week);
      if (sameWeek.length > this.config.pendingQueueLimit) {
        const oldest = sameWeek[0];
        this.ledger.state.pendingQueue.splice(this.ledger.state.pendingQueue.indexOf(oldest), 1);
        this.ledger.state.queueEvictions.push({ item: oldest, evictedAt: now.toISOString(), reason: 'weekly-fifo-overflow' });
      }
      this.ledger.save();
    }
    return { status: 'queued', queueLength: weekQueue(this.ledger.state, week).length, id: item.id };
  }

  log(action, targetPath, sessionId, reason) {
    const file = resolveMarkdown(this.brainRoot, '操作日志.md', ['操作日志.md']);
    const current = fs.existsSync(file) ? readPage(file) : { content: '# 操作日志\n', hash: sha256('# 操作日志\n') };
    if (!fs.existsSync(file)) fs.writeFileSync(file, current.content, 'utf8');
    const at = this.now().toISOString();
    const line = `- ${at} | DSH + dsh-neocortex | ${action} | ${targetPath} | ${reason} | ${sessionId || 'unknown-session'}`;
    atomicWrite(file, current.content.trimEnd() + `\n${line}\n`, current.hash);
  }

  remember(request, { sessionId } = {}) {
    if (!request || typeof request.text !== 'string' || !request.text.trim()) return { status: 'skipped', reason: 'empty' };
    if (request.worthSaving === false) return { status: 'skipped', reason: 'no-recall-value' };
    if (containsSensitive(request.text)) return { status: 'rejected', reason: 'sensitive-content' };
    const normalized = { ...request, text: request.text.trim(), layer: request.layer || 'L3' };
    validateFactKey(normalized.factKey);
    if (normalized.layer === 'L3') return this.rememberL3(normalized, { sessionId });
    if (normalized.layer === 'L1') return this.rememberL1(normalized, { sessionId });
    if (normalized.layer === 'L2') return this.rememberL2(normalized, { sessionId });
    return { status: 'rejected', reason: 'unknown-layer' };
  }

  quota(day) {
    return this.ledger.state.quotas[day] || { total: 0, exemptions: 0, writes: [] };
  }

  commitQuota(day, entry, explicit, { preserveTotal = false } = {}) {
    const quota = this.quota(day);
    if (!preserveTotal) quota.total += 1;
    if (explicit) quota.exemptions += 1;
    quota.writes.push({ id: entry.id, scene: entry.scene, explicit, at: this.now().toISOString() });
    this.ledger.state.quotas[day] = quota;
  }

  rememberL3(request, { sessionId }) {
    const now = this.now();
    const day = localDay(now, this.timeZone);
    const quota = this.quota(day);
    const snapshot = readBrainSnapshot(this.brainRoot);
    const activeScene = snapshot.scenes.find((scene) => scene.name === request.scene && scene.status === 'active');
    const relative = activeScene
      ? asPosix(path.join('个人模型', '近况', activeScene.page))
      : '个人模型/近况/通用.md';
    const attributes = [];
    if (!activeScene && request.scene) attributes.push(`场景倾向:${request.scene}`);
    if (request.factKey) attributes.push(`键:${request.factKey}`);
    const line = `- [${day}] ${request.text}${attributes.length ? ` {${attributes.join(', ')}}` : ''}`;
    const entry = parseMemoryEntries(line, { sourcePath: relative, scene: activeScene?.name, status: 'active' })[0];
    const duplicate = snapshot.memories.some((item) => item.id === entry.id);
    if (duplicate) return { status: 'duplicate', id: entry.id, path: relative };
    const factPrevious = request.factKey ? snapshot.memories.find((item) => item.factKey === request.factKey) : undefined;
    const explicit = Boolean(request.explicit);
    let replaced;
    if (explicit) {
      let candidates = snapshot.memories.filter((item) => item.date === day && (item.scene || '通用') === (activeScene?.name || request.scene || '通用') && item.id !== factPrevious?.id);
      const priorExemptions = new Set(quota.writes.filter((write) => write.explicit).map((write) => write.id));
      const nonExempt = candidates.filter((item) => !priorExemptions.has(item.id));
      if (nonExempt.length) candidates = nonExempt;
      if (candidates.length) {
        this.ledger.registerMemories(candidates, { halfLifeDays: this.config.halfLifeDays });
        replaced = candidates.sort((a, b) => this.ledger.score(a.id, now).score - this.ledger.score(b.id, now).score)[0];
      }
    }
    const previous = factPrevious || replaced;
    const fullQuotaReplacement = explicit && quota.total >= this.config.dailyWriteQuota && Boolean(previous);
    if ((explicit && quota.exemptions >= this.config.dailyExemptionQuota) || (quota.total >= this.config.dailyWriteQuota && !fullQuotaReplacement)) {
      return this.queue(request, explicit && quota.exemptions >= this.config.dailyExemptionQuota ? 'exemption-quota' : 'daily-quota');
    }
    const result = this.replaceOrInsert({ previous, line, targetPath: relative, date: day, sessionId, action: previous ? '取代近况条目' : '写入近况条目' });
    this.commitQuota(day, entry, explicit, { preserveTotal: fullQuotaReplacement });
    this.ledger.registerMemories([entry], { halfLifeDays: this.config.halfLifeDays });
    if (request.factKey) {
      const fact = this.ledger.state.facts[request.factKey] || { chain: [] };
      fact.currentId = entry.id;
      if (factPrevious) fact.chain.push({ from: factPrevious.id, to: entry.id, tombstoneId: result.tombstoneId, at: now.toISOString() });
      this.ledger.state.facts[request.factKey] = fact;
    }
    this.ledger.save();
    const report = { status: previous ? 'replaced' : 'written', id: entry.id, path: relative, quota: this.quota(day) };
    if (result.tombstoneId) report.tombstoneId = result.tombstoneId;
    return report;
  }

  replaceOrInsert({ previous, line, targetPath, date, sessionId, action }) {
    const targetFile = resolveMarkdown(this.brainRoot, targetPath, ['个人模型/近况/', '知识库/', '个人模型/个人背景.md', '个人模型/协作偏好.md', '个人模型/任务标准/']);
    ensurePage(targetFile);
    const target = readPage(targetFile);
    const previousPath = previous?.sourcePath;
    const previousFile = previousPath ? resolveMarkdown(this.brainRoot, previousPath, ['个人模型/近况/']) : undefined;
    const source = previousFile && fs.existsSync(previousFile) ? readPage(previousFile) : undefined;
    const oldLine = previous ? rawEntryLine(previous) : undefined;
    if (previous && (!source || !source.content.includes(oldLine))) throw new Error('Previous fact line is missing; refusing implicit overwrite.');
    const sameFile = previousFile === targetFile;
    let targetContent = target.content;
    let sourceContent = source?.content;
    if (previous && sameFile) {
      targetContent = targetContent.replace(oldLine, line);
    } else {
      targetContent = insertUnderHeading(targetContent, line, '条目');
      if (previous && sourceContent) sourceContent = sourceContent.replace(oldLine + '\n', '').replace(oldLine, '');
    }
    targetContent = updateFooter(targetContent, date);
    if (sourceContent !== undefined && !sameFile) sourceContent = updateFooter(sourceContent, date);
    const tombstone = previous ? {
      id: crypto.randomUUID(),
      factKey: previous.factKey,
      oldId: previous.id,
      oldLine,
      newLine: line,
      sourcePath: previousPath,
      targetPath,
      status: 'pending',
      createdAt: this.now().toISOString(),
    } : undefined;
    if (tombstone) {
      this.ledger.state.tombstones.push(tombstone);
      this.ledger.save();
    }
    let sourceHashes;
    if (sourceContent !== undefined && !sameFile) sourceHashes = atomicWrite(previousFile, sourceContent, source.hash);
    const targetHashes = atomicWrite(targetFile, targetContent, target.hash);
    if (tombstone) {
      Object.assign(tombstone, {
        status: 'active',
        sourceBeforeHash: sourceHashes?.beforeHash ?? (sameFile ? targetHashes.beforeHash : undefined),
        sourceAfterHash: sourceHashes?.afterHash,
        targetBeforeHash: targetHashes.beforeHash,
        targetAfterHash: targetHashes.afterHash,
      });
    }
    this.log(action, targetPath, sessionId, previous ? `取代 ${previous.id}` : '有后续召回价值');
    this.ledger.save();
    return { tombstoneId: tombstone?.id };
  }

  rememberL1(request, { sessionId }) {
    const targetPath = request.category === 'background'
      ? '个人模型/个人背景.md'
      : request.category === 'task' && request.targetPath
        ? request.targetPath
        : '个人模型/协作偏好.md';
    const file = resolveMarkdown(this.brainRoot, targetPath, ['个人模型/个人背景.md', '个人模型/协作偏好.md', '个人模型/任务标准/']);
    const page = readPage(file);
    const heading = request.explicit
      ? '用户明示记录'
      : targetPath.includes('个人背景') ? '待确认观察' : targetPath.includes('协作偏好') ? '待确认调整' : '待确认规则';
    const line = `- [${localDay(this.now(), this.timeZone)}] ${request.text}`;
    const content = updateFooter(insertUnderHeading(page.content, line, heading), localDay(this.now(), this.timeZone));
    atomicWrite(file, content, page.hash);
    this.log(request.explicit ? '写入用户明示 L1' : '写入 L1 待确认区', targetPath, sessionId, request.explicit ? '用户明确指令' : '推断待用户确认');
    return { status: request.explicit ? 'written' : 'pending-confirmation', path: targetPath, heading };
  }

  rememberL2(request, { sessionId }) {
    if (!request.targetPath || !request.source) return { status: 'rejected', reason: 'L2-requires-target-and-source' };
    const targetPath = asPosix(request.targetPath);
    const file = resolveMarkdown(this.brainRoot, targetPath, ['知识库/']);
    ensurePage(file);
    const page = readPage(file);
    const line = `- [${localDay(this.now(), this.timeZone)}] ${request.text}（来源：${request.source}）`;
    const content = updateFooter(insertUnderHeading(page.content, line, '自动沉淀'), localDay(this.now(), this.timeZone));
    atomicWrite(file, content, page.hash);
    this.log('按自动化规则写入 L2', targetPath, sessionId, String(request.source));
    return { status: 'written', path: targetPath };
  }

  undoTombstone(id, { sessionId } = {}) {
    const tombstone = this.ledger.state.tombstones.find((item) => item.id === id);
    if (!tombstone) return { status: 'not-found' };
    if (tombstone.status === 'undone') return { status: 'already-undone', id };
    if (tombstone.status !== 'active') throw new Error(`Tombstone is not active: ${tombstone.status}`);
    const targetFile = resolveMarkdown(this.brainRoot, tombstone.targetPath, ['个人模型/近况/']);
    const sourceFile = resolveMarkdown(this.brainRoot, tombstone.sourcePath, ['个人模型/近况/']);
    const target = readPage(targetFile);
    const source = sourceFile === targetFile ? target : readPage(sourceFile);
    if (target.hash !== tombstone.targetAfterHash || source.hash !== (tombstone.sourceAfterHash || tombstone.targetAfterHash)) {
      throw new Error('Pages changed after the replacement; automatic undo stopped to preserve newer edits.');
    }
    if (!target.content.includes(tombstone.newLine)) throw new Error('Replacement line is missing; undo stopped.');
    let targetContent;
    let sourceContent;
    if (targetFile === sourceFile) {
      targetContent = updateFooter(target.content.replace(tombstone.newLine, tombstone.oldLine), localDay(this.now(), this.timeZone));
    } else {
      targetContent = updateFooter(target.content.replace(tombstone.newLine + '\n', '').replace(tombstone.newLine, ''), localDay(this.now(), this.timeZone));
      sourceContent = updateFooter(insertUnderHeading(source.content, tombstone.oldLine, '条目'), localDay(this.now(), this.timeZone));
    }
    const targetHashes = atomicWrite(targetFile, targetContent, target.hash);
    if (sourceContent !== undefined) atomicWrite(sourceFile, sourceContent, source.hash);
    tombstone.status = 'undone';
    tombstone.undoneAt = this.now().toISOString();
    tombstone.undoTargetHash = targetHashes.afterHash;
    const factKey = tombstone.factKey;
    if (factKey && this.ledger.state.facts[factKey]) this.ledger.state.facts[factKey].currentId = tombstone.oldId;
    this.ledger.save();
    this.log('撤销事实键取代', tombstone.targetPath, sessionId, id);
    return { status: 'undone', id };
  }
}
