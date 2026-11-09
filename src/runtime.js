import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildRecallPayload, detectScene, readBrainSnapshot } from './recall.js';
import { searchKnowledge, queryTokens } from './knowledge.js';
import { memoryPolicy } from './policy.js';
import { truncateUnicode, unicodeLength } from './defaults.js';

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
        injectedKnowledge: new Set(),
        injectedMemoryIds: new Set(),
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

  /**
   * 前 N 轮/首轮/压缩后的"回忆"：知识库（L2）+ 当前场景里与问题相关的近况（L3）。
   * 只给摘要，不给全文；同一页/同一条整个会话只出现一次。
   */
  buildRecallMessage({ snapshot, query, scene, state, turn, budgetChars }) {
    const header = `[智脑] 回忆 · 第${turn || 1}轮`;
    const knowledgeLines = [];
    const memoryLines = [];
    const paths = [];
    const memoryIds = [];
    const compose = () => {
      let text = header;
      if (knowledgeLines.length) text += `\n[知识库]\n${knowledgeLines.join('\n')}`;
      if (memoryLines.length) text += `\n[近况]\n${memoryLines.join('\n')}`;
      return text;
    };
    const fits = (next) => unicodeLength(next) <= budgetChars;

    const knowledge = searchKnowledge(this.brainRoot, query, { limit: 8, paths: state.injectedKnowledge });
    const maxKnowledge = this.config.recallKnowledgeItems ?? 3;
    for (const page of knowledge) {
      if (knowledgeLines.length >= maxKnowledge) break;
      const summary = page.summary ? `：${truncateUnicode(page.summary, 110)}` : '';
      const line = `- ${page.title}（${page.path}）${summary}`;
      knowledgeLines.push(line);
      if (!fits(compose())) { knowledgeLines.pop(); break; }
      paths.push(page.path);
    }

    const tokens = queryTokens(query);
    const relevant = snapshot.memories
      .filter((entry) => (entry.scene || '通用') === scene && !state.injectedMemoryIds.has(entry.id))
      .filter((entry) => tokens.length === 0 || tokens.some((token) => entry.text.includes(token)))
      .slice(0, 2);
    for (const entry of relevant) {
      if (memoryLines.length >= 2) break;
      const line = `- ${truncateUnicode(entry.text, 120)}`;
      memoryLines.push(line);
      if (!fits(compose())) { memoryLines.pop(); break; }
      memoryIds.push(entry.id);
    }

    if (!knowledgeLines.length && !memoryLines.length) return null;
    return { text: compose(), paths, memoryIds, knowledgeCount: knowledgeLines.length, memoryCount: memoryLines.length };
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
    const recallTurns = Number.isInteger(this.config.recallTurns) ? this.config.recallTurns : 4;
    const recallTurn = Number.isInteger(turn) && turn <= recallTurns;
    if (!first && !compaction && !sceneIsNew && !recallTurn) return { messages, injected: false, scene: nextScene };

    if (compaction) {
      state.injectedKnowledge.clear();
      state.injectedMemoryIds.clear();
    }

    const injectedMessages = [];
    const reason = compaction ? 'compaction' : first ? 'first' : sceneIsNew ? 'scene-change' : 'recall';
    let payload;
    const personalWanted = first || compaction || sceneIsNew;
    if (personalWanted) {
      payload = buildRecallPayload({
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
      for (const entry of payload.selected) state.injectedMemoryIds.add(entry.id);
      state.initialInjected = true;
      state.currentScene = nextScene;
      state.injectedScenes.add(nextScene);
      state.needsReinject = false;
      injectedMessages.push(createMemoryMessage(payload.text));
    }

    const budget = (first || compaction || sceneIsNew)
      ? (this.config.recallKnowledgeChars ?? 360)
      : (this.config.recallTurnChars ?? 600);
    const recall = this.buildRecallMessage({ snapshot, query, scene: nextScene, state, turn, budgetChars: budget });
    if (recall) {
      injectedMessages.push(createMemoryMessage(recall.text));
      for (const pagePath of recall.paths) state.injectedKnowledge.add(pagePath);
      for (const id of recall.memoryIds) state.injectedMemoryIds.add(id);
    }

    if (!injectedMessages.length) return { messages, injected: false, scene: nextScene };
    this.probe(sessionId, { type: 'neocortex/injection', seq: null }, {
      turn,
      reason,
      scene: nextScene,
      memoryIds: payload?.selected.map((entry) => entry.id) ?? [],
      knowledgePaths: recall?.paths ?? [],
      chars: payload?.chars ?? 0,
      recallChars: recall ? unicodeLength(recall.text) : 0,
      explanations: payload?.explanations ?? [],
    });
    return {
      messages: [...messages, ...injectedMessages],
      injected: true,
      payload,
      recall,
      scene: nextScene,
      reason,
    };
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
