import fs from 'node:fs';
import path from 'node:path';
import { parseMemoryEntries, readBrainSnapshot } from './recall.js';
import { atomicWrite, insertUnderHeading, localDay, readPage, resolveMarkdown, sha256, updateFooter } from './writer.js';

const DAY = 86400000;
const GENERAL = '个人模型/近况/通用.md';
const SLEEPING_ITEMS = '个人模型/近况/沉睡条目.md';
const INDEX = '个人模型/近况/索引.md';

function timeOf(entry, ledger) {
  const memory = ledger.state.memories[entry.id];
  return Math.max(
    Date.parse(`${entry.date}T00:00:00Z`) || 0,
    Date.parse(memory?.lastUsedAt || '') || 0,
    Date.parse(memory?.addedAt || '') || 0,
  );
}

function dayString(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function validSceneName(name) {
  return name && name !== '..' && !/[\\/|<>:"*?]/.test(name);
}

function normalizedScene(name) {
  return name.toLowerCase().replace(/[\s_\-—·，,。.!！?？]/g, '').replace(/(工作|事项|相关|计划|安排|活动)$/, '');
}

export function equivalentScenes(a, b) {
  return normalizedScene(a) === normalizedScene(b);
}

function replaceTable(content, heading, headers, rows) {
  const lines = content.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`Scene index heading is missing: ${heading}`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  const table = [
    `## ${heading}`,
    '',
    `| ${headers.join(' | ')} |`,
    `|${headers.map((_, index) => index === 2 || (heading === '沉睡场景' && index === 3) ? '---:' : '---').join('|')}|`,
    ...(rows.length ? rows : [`| 暂无 | ${headers.slice(1).map(() => '').join(' | ')} |`]),
    '',
  ];
  return [...lines.slice(0, start), ...table, ...lines.slice(end)].join('\n');
}

export function renderSceneIndex(content, scenes, date = localDay(new Date())) {
  const active = scenes.filter((scene) => scene.status === 'active')
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '') || a.name.localeCompare(b.name));
  const sleeping = scenes.filter((scene) => scene.status === 'sleeping')
    .sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || '') || a.name.localeCompare(b.name));
  const activeRows = active.map((scene) => `| ${scene.name} | ${scene.lastActivity || ''} | ${scene.count ?? (parseMemoryEntries(scene.entries || '').length || 0)} | [${scene.name}](活跃/${scene.name}.md) |`);
  const sleepingRows = sleeping.map((scene) => `| ${scene.name} | ${scene.sleepDate || ''} | ${scene.lastUsed || ''} | ${scene.revivalCount || 0} | [${scene.name}](沉睡场景/${scene.name}.md) |`);
  return updateFooter(replaceTable(replaceTable(content, '活跃场景', ['场景', '最近活动', '条目数', '页面'], activeRows), '沉睡场景', ['场景', '入睡日期', '最近想起', '窗口内唤醒计数', '页面'], sleepingRows), date);
}

export class LifecycleEngine {
  constructor({ brainRoot, ledger, writer, config, now = () => new Date() }) {
    this.brainRoot = brainRoot;
    this.ledger = ledger;
    this.writer = writer;
    this.config = config;
    this.now = now;
    this.ledger.state.lifecycle ||= { scenes: {}, revivalWindows: {} };
    this.ledger.state.lifecycle.scenes ||= {};
    this.ledger.state.lifecycle.revivalWindows ||= {};
    this.reconcile();
  }

  reconcile() {
    const snapshot = readBrainSnapshot(this.brainRoot);
    this.ledger.registerMemories(snapshot.memories, { halfLifeDays: this.config.halfLifeDays });
    for (const entry of snapshot.memories) {
      Object.assign(this.ledger.state.memories[entry.id], {
        scene: entry.scene,
        sourcePath: entry.sourcePath,
        status: entry.status,
      });
    }
    this.ledger.save();
    return { memories: snapshot.memories.length, scenes: snapshot.scenes.length };
  }

  file(relative) {
    return resolveMarkdown(this.brainRoot, relative, ['个人模型/近况/']);
  }

  indexFile() {
    return this.file(INDEX);
  }

  sceneMeta(name) {
    return this.ledger.state.lifecycle.scenes[name] || {};
  }

  setSceneMeta(name, patch) {
    this.ledger.state.lifecycle.scenes[name] = { ...this.sceneMeta(name), ...patch };
  }

  writeIndex(scenes, sessionId) {
    const file = this.indexFile();
    const page = readPage(file);
    atomicWrite(file, renderSceneIndex(page.content, scenes, localDay(this.now())), page.hash);
    this.ledger.save();
    this.writer.log('更新近况场景索引', INDEX, sessionId, '生命周期状态变化');
  }

  moveScene(scene, status, { sessionId, reason } = {}) {
    if (!validSceneName(scene.name)) throw new Error(`Invalid scene name: ${scene.name}`);
    const fromRelative = `个人模型/近况/${status === 'active' ? '沉睡场景' : '活跃'}/${scene.name}.md`;
    const toRelative = `个人模型/近况/${status === 'active' ? '活跃' : '沉睡场景'}/${scene.name}.md`;
    const from = this.file(fromRelative);
    const to = this.file(toRelative);
    if (!fs.existsSync(from)) throw new Error(`Scene page is missing: ${fromRelative}`);
    if (fs.existsSync(to)) throw new Error(`Refusing to overwrite existing scene page: ${toRelative}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    const now = this.now();
    const today = localDay(now);
    const scenes = readBrainSnapshot(this.brainRoot).scenes.filter((item) => item.name !== scene.name);
    const count = parseMemoryEntries(fs.readFileSync(to, 'utf8')).length;
    const next = {
      ...scene,
      name: scene.name,
      status,
      page: `${status === 'active' ? '活跃' : '沉睡场景'}/${scene.name}.md`,
      lastActivity: status === 'active' ? today : scene.lastActivity,
      sleepDate: status === 'sleeping' ? today : undefined,
      lastUsed: status === 'sleeping' ? (scene.lastUsed || scene.lastActivity || today) : undefined,
      revivalCount: 0,
      count,
    };
    scenes.push(next);
    try {
      this.writeIndex(scenes, sessionId);
    } catch (error) {
      fs.renameSync(to, from);
      throw error;
    }
    this.setSceneMeta(scene.name, {
      status,
      sourcePath: toRelative,
      sleepDate: next.sleepDate,
      lastUsedAt: status === 'sleeping' ? (scene.lastUsed ? `${scene.lastUsed}T00:00:00.000Z` : this.sceneMeta(scene.name).lastUsedAt) : now.toISOString(),
      lastActivityAt: status === 'active' ? now.toISOString() : (scene.lastActivity ? `${scene.lastActivity}T00:00:00.000Z` : this.sceneMeta(scene.name).lastActivityAt),
    });
    if (status === 'active') this.ledger.state.lifecycle.revivalWindows[scene.name] = [];
    const movedEntries = parseMemoryEntries(fs.readFileSync(to, 'utf8'), { sourcePath: toRelative, scene: scene.name, status });
    this.ledger.registerMemories(movedEntries, { halfLifeDays: this.config.halfLifeDays });
    for (const entry of movedEntries) {
      const memory = this.ledger.state.memories[entry.id];
      memory.status = status;
      memory.sourcePath = toRelative;
      memory.scene = scene.name;
    }
    for (const memory of Object.values(this.ledger.state.memories)) {
      if (memory.scene === scene.name) {
        memory.status = status;
        memory.sourcePath = toRelative;
      }
    }
    this.ledger.save();
    this.writer.log(status === 'active' ? '复活场景' : '场景入睡', toRelative, sessionId, reason || '生命周期规则');
    return { ...next, sourcePath: toRelative };
  }

  moveEntry(entry, targetPath, { sessionId, reason, targetScene, targetStatus = 'active', touched = false } = {}) {
    const sourcePath = entry.sourcePath;
    if (sourcePath === targetPath) return;
    const sourceFile = this.file(sourcePath);
    const targetFile = this.file(targetPath);
    if (!fs.existsSync(targetFile)) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, `# ${path.basename(targetFile, '.md')}\n\n## 条目\n\n暂无。\n`, 'utf8');
    }
    const source = readPage(sourceFile);
    const target = readPage(targetFile);
    const line = `- [${entry.date}] ${entry.text}`;
    if (!source.content.includes(line)) throw new Error(`Entry line changed before lifecycle move: ${entry.id}`);
    const today = localDay(this.now());
    const sourceContent = updateFooter(source.content.replace(`${line}\n`, '').replace(line, ''), today);
    const targetContent = updateFooter(insertUnderHeading(target.content, line, '条目'), today);
    atomicWrite(sourceFile, sourceContent, source.hash);
    try {
      atomicWrite(targetFile, targetContent, target.hash);
    } catch (error) {
      atomicWrite(sourceFile, source.content, sha256(sourceContent));
      throw error;
    }
    const memory = this.ledger.state.memories[entry.id] || { id: entry.id, useCount: 0 };
    Object.assign(memory, {
      text: entry.text,
      scene: targetScene === undefined ? entry.scene : targetScene,
      sourcePath: targetPath,
      status: targetStatus,
    });
    memory.addedAt ||= `${entry.date}T00:00:00.000Z`;
    if (touched) memory.lastUsedAt = this.now().toISOString();
    this.ledger.state.memories[entry.id] = memory;
    this.ledger.save();
    this.writer.log('迁移近况条目', `${sourcePath} -> ${targetPath}`, sessionId, reason);
  }

  runSceneSleep({ sessionId } = {}) {
    const now = this.now();
    const moved = [];
    const snapshot = readBrainSnapshot(this.brainRoot);
    for (const scene of snapshot.scenes.filter((item) => item.status === 'active')) {
      const entries = snapshot.memories.filter((entry) => entry.scene === scene.name && entry.status === 'active');
      const meta = this.sceneMeta(scene.name);
      const candidates = [Date.parse(meta.lastActivityAt || '') || 0, Date.parse(meta.lastUsedAt || '') || 0, ...entries.map((entry) => timeOf(entry, this.ledger))];
      const indexActivity = Date.parse(`${scene.lastActivity}T00:00:00Z`) || 0;
      const last = Math.max(indexActivity, ...candidates);
      if (now.getTime() - last > 30 * DAY) {
        moved.push(this.moveScene(scene, 'sleeping', { sessionId, reason: '超过 30 天无新增或想起' }));
      }
    }
    return moved;
  }

  runGeneralSleep({ sessionId } = {}) {
    const now = this.now();
    const snapshot = readBrainSnapshot(this.brainRoot);
    const general = snapshot.memories.filter((entry) => entry.sourcePath === GENERAL);
    const latestByScene = {};
    for (const entry of general) {
      if (!entry.scene) continue;
      latestByScene[entry.scene] = Math.max(latestByScene[entry.scene] || 0, timeOf(entry, this.ledger));
    }
    const eligible = general.filter((entry) => {
      const last = timeOf(entry, this.ledger);
      if (now.getTime() - last <= this.config.generalSleepDays * DAY) return false;
      if (entry.scene && now.getTime() - latestByScene[entry.scene] <= this.config.generalSleepDays * DAY) return false;
      return true;
    });
    for (const entry of eligible) this.moveEntry(entry, SLEEPING_ITEMS, { sessionId, reason: '超过通用入睡线', targetStatus: 'sleeping' });
    return eligible.map((entry) => entry.id);
  }

  ensurePromotedScene(name, snapshot, sessionId) {
    const existing = snapshot.scenes.find((scene) => equivalentScenes(scene.name, name));
    if (existing?.status === 'sleeping') return this.moveScene(existing, 'active', { sessionId, reason: '通用条目升格防重' });
    if (existing?.status === 'active') return existing;
    if (!validSceneName(name)) throw new Error(`Invalid promotion scene: ${name}`);
    const relative = `个人模型/近况/活跃/${name}.md`;
    const file = this.file(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${name}\n\n## 条目\n\n暂无。\n\n---\n\n最近修订: dsh-neocortex (DSH) @ ${localDay(this.now())}\n`, 'utf8');
    const scenes = [...snapshot.scenes, { name, status: 'active', page: `活跃/${name}.md`, lastActivity: localDay(this.now()), count: 0 }];
    this.writeIndex(scenes, sessionId);
    this.setSceneMeta(name, { status: 'active', sourcePath: relative, lastActivityAt: this.now().toISOString() });
    this.ledger.save();
    this.writer.log('通用条目自动升格', relative, sessionId, '同场景倾向达到 3 条');
    return scenes.at(-1);
  }

  runPromotion({ sessionId } = {}) {
    const promoted = [];
    let snapshot = readBrainSnapshot(this.brainRoot);
    const groups = {};
    for (const entry of snapshot.memories.filter((item) => item.sourcePath === GENERAL && item.scene)) {
      groups[entry.scene] ||= [];
      groups[entry.scene].push(entry);
    }
    for (const [name, entries] of Object.entries(groups)) {
      if (entries.length < 3) continue;
      const scene = this.ensurePromotedScene(name, snapshot, sessionId);
      const targetPath = `个人模型/近况/活跃/${scene.name}.md`;
      for (const entry of entries) this.moveEntry(entry, targetPath, { sessionId, reason: '同场景倾向自动升格', targetScene: scene.name, targetStatus: 'active' });
      promoted.push(scene.name);
      snapshot = readBrainSnapshot(this.brainRoot);
    }
    return promoted;
  }

  findUnindexedSleepingEntry(id) {
    const directory = path.join(this.brainRoot, '个人模型', '近况', '沉睡场景');
    if (!fs.existsSync(directory)) return undefined;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith('.md')) continue;
      const name = item.name.slice(0, -3);
      const sourcePath = `个人模型/近况/沉睡场景/${item.name}`;
      const entry = parseMemoryEntries(fs.readFileSync(path.join(directory, item.name), 'utf8'), { sourcePath, scene: name, status: 'sleeping' }).find((candidate) => candidate.id === id);
      if (entry) return entry;
    }
    return undefined;
  }

  recordHits(ids, { sessionId, at = this.now() } = {}) {
    const unique = [...new Set(ids)];
    const result = { itemWakes: [], sceneHits: [], revived: [] };
    for (const id of unique) {
      let snapshot = readBrainSnapshot(this.brainRoot);
      const entry = snapshot.memories.find((item) => item.id === id) || this.findUnindexedSleepingEntry(id);
      if (!entry) continue;
      if (!snapshot.memories.some((item) => item.id === id)) snapshot.memories.push(entry);
      if (entry.sourcePath === SLEEPING_ITEMS && !entry.scene) {
        this.moveEntry(entry, GENERAL, { sessionId, reason: '无场景沉睡条目被命中', targetStatus: 'active', touched: true });
        result.itemWakes.push(id);
        continue;
      }
      if (!entry.scene) continue;
      let scene = snapshot.scenes.find((item) => item.name === entry.scene);
      if (!scene && entry.sourcePath.startsWith('个人模型/近况/沉睡场景/')) {
        const meta = this.sceneMeta(entry.scene);
        scene = {
          name: entry.scene,
          status: 'sleeping',
          page: `沉睡场景/${entry.scene}.md`,
          sleepDate: meta.sleepDate || '',
          lastUsed: meta.lastUsedAt?.slice(0, 10) || '',
          revivalCount: 0,
        };
        snapshot.scenes.push(scene);
      }
      if (!scene) continue;
      if (scene.status === 'active') {
        this.setSceneMeta(scene.name, { lastActivityAt: at.toISOString(), lastUsedAt: at.toISOString() });
        this.ledger.save();
        const scenes = snapshot.scenes.map((item) => item.name === scene.name ? { ...item, lastActivity: localDay(at) } : item);
        this.writeIndex(scenes, sessionId);
        result.sceneHits.push({ id, scene: scene.name, status: 'active' });
        continue;
      }
      const window = (this.ledger.state.lifecycle.revivalWindows[scene.name] || [])
        .filter((hit) => at.getTime() - Date.parse(hit.at) <= this.config.revivalWindowDays * DAY);
      window.push({ id, at: at.toISOString() });
      this.ledger.state.lifecycle.revivalWindows[scene.name] = window;
      this.setSceneMeta(scene.name, { lastUsedAt: at.toISOString(), revivalCount: window.length, sunkAt: undefined });
      this.ledger.save();
      if (window.length >= this.config.revivalThreshold) {
        this.moveScene(scene, 'active', { sessionId, reason: '复活窗口内达到阈值' });
        result.revived.push(scene.name);
      } else {
        const scenes = snapshot.scenes.map((item) => item.name === scene.name ? { ...item, lastUsed: localDay(at), revivalCount: window.length } : item);
        this.writeIndex(scenes, sessionId);
        result.sceneHits.push({ id, scene: scene.name, status: 'sleeping', count: window.length });
      }
    }
    return result;
  }

  sinkSleepingIndex({ sessionId } = {}) {
    const now = this.now();
    const snapshot = readBrainSnapshot(this.brainRoot);
    const sunk = [];
    const retained = [];
    for (const scene of snapshot.scenes) {
      if (scene.status !== 'sleeping') { retained.push(scene); continue; }
      const meta = this.sceneMeta(scene.name);
      const last = Math.max(Date.parse(meta.lastUsedAt || '') || 0, Date.parse(`${scene.lastUsed || scene.sleepDate}T00:00:00Z`) || 0);
      if (now.getTime() - last > 365 * DAY) {
        sunk.push(scene.name);
        this.setSceneMeta(scene.name, {
          status: 'sleeping',
          sourcePath: `个人模型/近况/沉睡场景/${scene.name}.md`,
          sleepDate: scene.sleepDate,
          lastUsedAt: scene.lastUsed ? `${scene.lastUsed}T00:00:00.000Z` : undefined,
          sunkAt: now.toISOString(),
        });
      } else retained.push(scene);
    }
    if (sunk.length) {
      this.writeIndex(retained, sessionId);
      this.writer.log('沉睡索引行下沉', INDEX, sessionId, sunk.join(', '));
    }
    this.ledger.save();
    return sunk;
  }

  runReview({ sessionId } = {}) {
    const sunk = this.sinkSleepingIndex({ sessionId });
    const scenes = this.runSceneSleep({ sessionId });
    const general = this.runGeneralSleep({ sessionId });
    const promoted = this.runPromotion({ sessionId });
    return { sunk, scenes: scenes.map((scene) => scene.name), general, promoted };
  }

  onSessionEnd(sessionId) {
    return { promoted: this.runPromotion({ sessionId }) };
  }
}
