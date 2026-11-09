import path from 'node:path';
import { createRequire } from 'node:module';
import { loadQueue, saveQueue } from './watch/queue.js';
import { acceptItems, rejectItems } from './watch/ingest.js';
import { hydrateItems } from './watch/hydrate.js';
import { loadSchedulerState } from './watch/scheduler.js';
import { loadBudget } from './watch/budget.js';
import { buildSuggestions, fetchFollowings, loadSuggestions, saveSuggestions } from './watch/suggestions.js';
import { loadCriteria } from './watch/criteria.js';

function loadProtocol() {
  const localRequire = createRequire(import.meta.url);
  try { return localRequire('@deepseek-ai/dsh-typert-protocol'); }
  catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' || !process.resourcesPath) throw error;
    // Electron's Host can resolve built-in packages inside app.asar. A linked
    // external bundle must reuse that copy rather than loading another Cordis.
    const hostRequire = createRequire(path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'));
    return hostRequire('@deepseek-ai/dsh-typert-protocol');
  }
}

const { Remote, TypertRemoteService } = loadProtocol();

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

// The current Gateway supports SRC markers. Apply the standard decorator without
// requiring TypeScript syntax in this dependency-light, plain-JavaScript bundle.
function remoteMethod(Type, name) {
  const initializers = [];
  Remote(Type.prototype[name], {
    kind: 'method',
    name,
    private: false,
    static: false,
    addInitializer(initializer) { initializers.push(initializer); },
  });
  const markerReceiver = Object.create(Type.prototype);
  for (const initialize of initializers) initialize.call(markerReceiver);
}

export class NeocortexRemoteService extends TypertRemoteService {
  constructor(ctx, panel, watch, { dataDir, writer, config = {}, vendorDir } = {}) {
    super(ctx, 'neocortex', { namespace: 'neocortex' });
    this.panel = panel;
    this.watch = watch;
    this.dataDir = dataDir;
    this.writer = writer;
    this.ctx = ctx;
    this.config = config;
    this.vendorDir = vendorDir;
  }

  state() {
    return json({
      ...this.panel.state(),
      watch: this.watch.state(),
      watchQueue: loadQueue(this.dataDir),
      watchScheduler: loadSchedulerState(this.dataDir),
      watchBudget: loadBudget(this.dataDir),
      watchSuggestions: loadSuggestions(this.dataDir),
    });
  }

  async watchDecide(request) {
    const queue = loadQueue(this.dataDir);
    const ids = Array.isArray(request?.ids) && request.ids.length ? request.ids : (request?.all ? null : []);
    if (!Array.isArray(ids) && !request?.all) return json({ ok: false, reason: 'ids-required' });
    if (request?.decision === 'accept') {
      if (!this.writer) return json({ ok: false, reason: 'writer-unavailable' });
      const wanted = ids ? new Set(ids) : null;
      const selected = queue.items.filter((item) => item.status === 'pending'
        && (!wanted || wanted.has(item.id) || wanted.has(item.bvid)));
      const empty = selected.filter((item) => !Array.isArray(item.points) || item.points.length === 0);
      let hydration;
      if (empty.length && this.ctx) {
        // 面板收也走同一条“先补深读再写 L2”的路径；用户不需要多点一步。
        hydration = await hydrateItems({
          ctx: this.ctx,
          dataDir: this.dataDir,
          config: this.config,
          vendorDir: this.vendorDir,
          items: empty,
        });
      }
      const result = acceptItems({ writer: this.writer, queue, dataDir: this.dataDir, sessionId: 'watch-panel', ids: ids || undefined });
      saveQueue(this.dataDir, queue);
      return json({ ok: true, decision: 'accept', ...result, hydration, remaining: queue.items.filter((item) => item.status === 'pending').length });
    }
    if (request?.decision === 'reject') {
      const result = rejectItems({ queue, ids: ids || undefined, note: request?.note });
      saveQueue(this.dataDir, queue);
      return json({ ok: true, decision: 'reject', ...result, remaining: queue.items.filter((item) => item.status === 'pending').length });
    }
    return json({ ok: false, reason: 'unknown-decision' });
  }

  updateWatchConfig(request) {
    return json(this.watch.setConfig(request || {}));
  }

  updateWatch(request) {
    return json(this.watch.setMode(request?.mode));
  }

  watchOverview() {
    return json({
      watch: this.watch.state(),
      queue: loadQueue(this.dataDir),
      scheduler: loadSchedulerState(this.dataDir),
      budget: loadBudget(this.dataDir),
      suggestions: loadSuggestions(this.dataDir),
    });
  }

  async watchRefreshSuggestions() {
    let followings = [];
    let warning;
    try {
      followings = await fetchFollowings({
        dataDir: this.dataDir,
        config: this.config,
        vendorDir: this.vendorDir,
      });
    } catch (error) {
      warning = `关注列表读取失败：${String(error?.message || error).slice(0, 160)}`;
    }
    const { criteria } = loadCriteria(this.dataDir);
    const items = buildSuggestions({ queue: loadQueue(this.dataDir), followings, criteria });
    const saved = saveSuggestions(this.dataDir, { items });
    return json({ ok: true, generatedAt: saved.generatedAt, items, count: items.length, followings: followings.length, warning });
  }

  previewReview(request) {
    return json(this.panel.review.preview(request.id));
  }

  confirmL1(request) {
    return json(this.panel.confirmL1(request, 'web-panel'));
  }

  undo(request) {
    return json(this.panel.undo(request, 'web-panel'));
  }

  acceptReview(request) {
    return json(this.panel.acceptReview(request, 'web-panel'));
  }

  rejectReview(request) {
    return json(this.panel.rejectReview(request, 'web-panel'));
  }

  manualReview() {
    return json(this.panel.manualReview({}, 'web-panel'));
  }

  retryReview() {
    return json(this.panel.retryReview({}, 'web-panel'));
  }

  updateSettings(request) {
    return json(this.panel.updateSettings(request));
  }

  initializeBrain(request) {
    return json(this.panel.initializeBrain(request, 'web-panel'));
  }
}

for (const name of ['state', 'previewReview', 'confirmL1', 'undo', 'acceptReview', 'rejectReview', 'manualReview', 'retryReview', 'updateSettings', 'initializeBrain', 'updateWatch', 'watchOverview', 'watchDecide', 'updateWatchConfig', 'watchRefreshSuggestions']) {
  remoteMethod(NeocortexRemoteService, name);
}
