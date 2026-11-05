import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildRecallPayload, detectScene, readBrainSnapshot } from './recall.js';
import { memoryPolicy } from './policy.js';

const OBSERVED_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
]);

export function createMemoryMessage(text) {
  return {
    id: `neocortex-${crypto.randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-neocortex' },
  };
}

function messageText(messages) {
  return messages.flatMap((message) => message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function appendProbe(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

export class NeocortexRuntime {
  constructor({ ledger, brainRoot, config, probeFile, ignoreSessionPrefix = 'neocortex-p1-', onUsed, onSessionEnd }) {
    this.ledger = ledger;
    this.brainRoot = brainRoot;
    this.config = config;
    this.probeFile = probeFile;
    this.ignoreSessionPrefix = ignoreSessionPrefix;
    this.onUsed = onUsed;
    this.onSessionEnd = onSessionEnd;
    this.states = new Map();
  }

  state(sessionId) {
    if (!this.states.has(sessionId)) {
      this.states.set(sessionId, {
        seenEvents: new Set(),
        initialInjected: false,
        currentScene: '通用',
        injectedScenes: new Set(),
        needsReinject: false,
        lastCompactionSeq: undefined,
        failedCompactions: 0,
        disposals: 0,
        optedOut: false,
      });
    }
    return this.states.get(sessionId);
  }

  probe(sessionId, event, extra = {}) {
    if (!this.probeFile) return;
    appendProbe(this.probeFile, {
      at: new Date().toISOString(),
      sessionId,
      event: event.type,
      seq: event.seq,
      ...extra,
    });
  }

  observeEvent(session, event) {
    const sessionId = session.id;
    if (this.ignoreSessionPrefix && sessionId.startsWith(this.ignoreSessionPrefix)) return;
    const state = this.state(sessionId);
    if (state.seenEvents.has(event.seq)) return;
    state.seenEvents.add(event.seq);
    if (OBSERVED_TYPES.has(event.type)) {
      this.probe(sessionId, event, { data: event.data });
    }
    if (event.type === 'turn/end') {
      const settled = this.ledger.settleTurn({
        sessionId,
        turn: event.data.turn,
        reason: event.data.reason,
        eventSeq: event.seq,
      });
      if (settled.changed && settled.status === 'completed' && settled.used?.length && this.onUsed) {
        try { this.onUsed(settled.used, sessionId); }
        catch (error) { this.probe(sessionId, { type: 'neocortex/lifecycle-error', seq: event.seq }, { error: String(error) }); }
      }
    }
    if (event.type === 'compaction/end') {
      if (event.data.error) {
        state.failedCompactions += 1;
      } else {
        state.lastCompactionSeq = event.seq;
        state.needsReinject = true;
      }
    }
  }

  dispose(session) {
    const sessionId = session.id;
    if (this.ignoreSessionPrefix && sessionId.startsWith(this.ignoreSessionPrefix)) return;
    const state = this.state(sessionId);
    state.disposals += 1;
    this.ledger.recordDisposal(sessionId);
    this.probe(sessionId, { type: 'session/disposed', seq: null }, { disposals: state.disposals });
    if (this.onSessionEnd) {
      try { this.onSessionEnd(sessionId); }
      catch (error) { this.probe(sessionId, { type: 'neocortex/lifecycle-error', seq: null }, { error: String(error) }); }
    }
  }

  recoverFromJournal() {
    if (!this.probeFile || !fs.existsSync(this.probeFile)) return { recovered: 0, ignored: 0 };
    let recovered = 0;
    let ignored = 0;
    const lines = fs.readFileSync(this.probeFile, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.event !== 'turn/end') continue;
      const result = this.ledger.settleTurn({
        sessionId: record.sessionId,
        turn: record.data.turn,
        reason: record.data.reason,
        eventSeq: record.seq,
      });
      if (result.changed && result.status === 'completed') {
        recovered += 1;
        if (result.used?.length && this.onUsed) {
          try { this.onUsed(result.used, record.sessionId); }
          catch (error) { this.probe(record.sessionId, { type: 'neocortex/lifecycle-error', seq: record.seq }, { error: String(error) }); }
        }
      } else if (result.changed) ignored += 1;
    }
    return { recovered, ignored };
  }

  prepareInjection(agent, messages, turn) {
    if (!messages.length) return { messages, injected: false };
    const sessionId = agent.id;
    const state = this.state(sessionId);
    const query = messageText(messages.filter((message) => message.source?.kind !== 'dsh-neocortex'));
    if (!memoryPolicy(query).allowRead) state.optedOut = true;
    if (state.optedOut) return { messages, injected: false, optedOut: true };
    const snapshot = readBrainSnapshot(this.brainRoot);
    const nextScene = detectScene(query, snapshot.scenes, state.currentScene);
    const first = !state.initialInjected;
    const compaction = state.needsReinject;
    const sceneChanged = nextScene !== state.currentScene;
    const sceneIsNew = sceneChanged && !state.injectedScenes.has(nextScene);
    if (!first && !compaction && !sceneIsNew) return { messages, injected: false, scene: nextScene };
    const reason = compaction ? 'compaction' : first ? 'first' : 'scene-change';
    const payload = buildRecallPayload({
      snapshot,
      ledger: this.ledger,
      scene: nextScene,
      includeGlobal: first || compaction,
      reason,
      maxItems: this.config.firstInjectionMaxItems,
      maxChars: this.config.firstInjectionMaxChars,
    });
    this.ledger.recordInjection({
      sessionId,
      turn,
      memoryIds: payload.selected.map((entry) => entry.id),
      scene: nextScene,
      reason,
      payload: payload.text,
    });
    state.initialInjected = true;
    state.currentScene = nextScene;
    state.injectedScenes.add(nextScene);
    state.needsReinject = false;
    this.probe(sessionId, { type: 'neocortex/injection', seq: null }, {
      turn,
      reason,
      scene: nextScene,
      memoryIds: payload.selected.map((entry) => entry.id),
      chars: payload.chars,
      explanations: payload.explanations,
    });
    return { messages: [...messages, createMemoryMessage(payload.text)], injected: true, payload };
  }

  async preStep(agent, payload, next) {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    try {
      const result = this.prepareInjection(agent, decision.messages, payload.turn);
      return result.injected ? { ...decision, messages: result.messages } : decision;
    } catch (error) {
      this.probe(agent.id, { type: 'neocortex/injection-error', seq: null }, {
        turn: payload.turn,
        error: error instanceof Error ? error.message : String(error),
      });
      return decision;
    }
  }
}
