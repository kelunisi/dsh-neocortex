import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LEDGER_SCHEMA_VERSION = 1;

function clone(value) {
  return structuredClone(value);
}

export function emptyLedger() {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    memories: {},
    turns: {},
    sessions: {},
    recallExplanations: [],
    quotas: {},
    facts: {},
    pendingQueue: [],
    queueEvictions: [],
    tombstones: [],
    reviews: {},
    lifecycle: { scenes: {}, revivalWindows: {} },
    reviews: {},
  };
}

export class LedgerCorruptionError extends Error {
  constructor(file, cause) {
    super(`Ledger is corrupt or unsupported; refusing to overwrite it: ${file}`, { cause });
    this.name = 'LedgerCorruptionError';
    this.code = 'NEOCORTEX_LEDGER_CORRUPT';
  }
}

function validateLedger(state, file) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new LedgerCorruptionError(file);
  if (state.schemaVersion !== LEDGER_SCHEMA_VERSION) throw new LedgerCorruptionError(file);
  for (const key of ['memories', 'turns', 'sessions', 'quotas', 'facts']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new LedgerCorruptionError(file);
  }
  if (!Array.isArray(state.recallExplanations) || !Array.isArray(state.pendingQueue)) throw new LedgerCorruptionError(file);
  return state;
}

export class Ledger {
  constructor(file, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return emptyLedger();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return validateLedger(parsed, this.file);
    } catch (error) {
      if (error instanceof LedgerCorruptionError) throw error;
      throw new LedgerCorruptionError(this.file, error);
    }
  }

  save() {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const payload = JSON.stringify(this.state, null, 2) + '\n';
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, this.file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  }

  turnKey(sessionId, turn) {
    return `${sessionId}:turn:${turn}`;
  }

  recordInjection({ sessionId, turn, memoryIds, scene, reason, payload }) {
    const key = this.turnKey(sessionId, turn);
    const existing = this.state.turns[key];
    if (existing && existing.status !== 'pending') return [...(existing.used || [])];
    const used = [...new Set([...(existing?.used || []), ...memoryIds])];
    this.state.turns[key] = {
      ...(existing || {}),
      sessionId,
      turn,
      used,
      scene,
      status: existing?.status || 'pending',
      lastReason: reason,
      lastPayloadHash: crypto.createHash('sha256').update(payload || '').digest('hex'),
      updatedAt: this.now().toISOString(),
    };
    this.state.recallExplanations.push({
      sessionId,
      turn,
      scene,
      reason,
      memoryIds: [...memoryIds],
      at: this.now().toISOString(),
    });
    this.save();
    return used;
  }

  settleTurn({ sessionId, turn, reason, eventSeq }) {
    const kind = typeof reason === 'string' ? reason : reason?.kind;
    const key = this.turnKey(sessionId, turn);
    const existing = this.state.turns[key] || { sessionId, turn, used: [] };
    if (existing.status === 'completed' || existing.status === 'ignored') {
      return { changed: false, status: existing.status, used: [...existing.used] };
    }
    const completed = kind === 'completed';
    const at = this.now().toISOString();
    if (completed) {
      for (const id of existing.used) {
        const memory = this.state.memories[id];
        if (!memory) continue;
        memory.useCount = (memory.useCount || 0) + 1;
        memory.lastUsedAt = at;
      }
    }
    this.state.turns[key] = {
      ...existing,
      status: completed ? 'completed' : 'ignored',
      endReason: kind || 'unknown',
      endEventSeq: eventSeq,
      settledAt: at,
    };
    this.save();
    return { changed: true, status: this.state.turns[key].status, used: [...existing.used] };
  }

  registerMemories(entries, { halfLifeDays = 30 } = {}) {
    const at = this.now().toISOString();
    for (const entry of entries) {
      const existing = this.state.memories[entry.id] || {
        id: entry.id,
        importance: entry.importance || 1,
        halfLifeDays,
        useCount: 0,
        addedAt: entry.date ? `${entry.date}T00:00:00.000Z` : at,
      };
      this.state.memories[entry.id] = {
        ...existing,
        text: entry.text,
        scene: entry.scene,
        sourcePath: entry.sourcePath,
        status: entry.status,
        factKey: entry.factKey,
      };
    }
    this.save();
  }

  score(id, at = this.now()) {
    const memory = this.state.memories[id];
    if (!memory) return { score: 0, recency: 0, importance: 0, useCount: 0 };
    const added = Date.parse(memory.lastUsedAt || memory.addedAt || at.toISOString());
    const ageDays = Math.max(0, (at.getTime() - added) / 86400000);
    const recency = 0.5 ** (ageDays / (memory.halfLifeDays || 30));
    const importance = memory.importance || 1;
    const useCount = memory.useCount || 0;
    const score = recency * importance * (1 + Math.log1p(useCount) * 0.05);
    return { score, recency, importance, useCount, ageDays };
  }

  rank(entries) {
    this.registerMemories(entries);
    return entries.map((entry) => ({ ...entry, explanation: this.score(entry.id) }))
      .sort((a, b) => b.explanation.score - a.explanation.score || a.id.localeCompare(b.id));
  }

  recordDisposal(sessionId) {
    const session = this.state.sessions[sessionId] || { disposedEvents: 0 };
    session.disposedEvents += 1;
    session.disposedAt = this.now().toISOString();
    this.state.sessions[sessionId] = session;
    this.save();
    return session.disposedEvents;
  }

  snapshot() {
    return clone(this.state);
  }
}
