// Watch (喂养) module entry.
//
// Wire the module into the plugin from here. P1 mounts the state service and
// owns nothing else: no timer, no network, no writes at load time. P2 adds the
// MCP data layer, and P6 starts the scheduler — both behind `service.enabled()`
// so an `off` profile stays inert.

import { WatchService } from './service.js';
import { WatchScheduler } from './scheduler.js';
import { remainingBudget } from './budget.js';
import { pendingItems, loadQueue } from './queue.js';
import { runWatchRound } from './runner.js';
import { runAutoComments } from './auto-comments.js';
import { registerWatchTools } from './tools.js';

/**
 * @param {object} options
 * @param {object} [options.ctx] plugin context; when it exposes `effect`, disposal is wired there
 * @param {string} options.dataDir
 * @param {string} [options.initialMode]
 * @param {object} [options.config] watch config (pythonPath etc.)
 * @param {string} [options.vendorDir]
 * @returns {WatchService}
 */
export function mountWatch({ ctx, dataDir, initialMode, config = {}, vendorDir, writer }) {
  const watch = new WatchService({ dataDir, initialMode });
  const scheduler = new WatchScheduler({
    dataDir,
    watch,
    pendingCount: () => pendingItems(loadQueue(dataDir)).length,
    budgetRemaining: () => remainingBudget(dataDir, watch.config.tokenBudgetPerDay ?? 2000000),
    log: (line) => console.error('[watch]', line),
    run: async () => {
      const result = await runWatchRound({
        mode: watch.mode,
        watch,
        ctx,
        dataDir,
        config,
        vendorDir,
        log: (line) => console.error('[watch]', line),
      });
      let autoComments;
      try {
        autoComments = await runAutoComments({
          ctx,
          dataDir,
          config: { ...config, ...(watch.config || {}) },
          vendorDir,
          log: (line) => console.error('[watch]', line),
        });
      } catch (error) {
        autoComments = { ok: false, error: String(error?.message || error).slice(0, 300) };
        console.error('[watch] 自动评论失败', error);
      }
      return { ...result, autoComments };
    },
  });
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      scheduler.stop();
      return watch.dispose();
    }, 'dsh-neocortex: watch module');
  }
  // 只有开关不是 off 时才起定时器；切回 off 会立刻停掉。
  watch.onModeChange = (mode) => {
    if (mode === 'off') scheduler.stop();
    else scheduler.start();
  };
  // 体检、扫码登录、离线跑一轮、收/扔入库：被动注册，不调用就不产生任何网络/文件行为。
  registerWatchTools(ctx, { dataDir, config, vendorDir, watch, writer });
  if (watch.enabled()) scheduler.start();
  return watch;
}
