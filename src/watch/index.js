// Watch (喂养) module entry.
//
// Wire the module into the plugin from here. P1 mounts the state service and
// owns nothing else: no timer, no network, no writes at load time. P2 adds the
// MCP data layer, and P6 starts the scheduler — both behind `service.enabled()`
// so an `off` profile stays inert.

import { WatchService } from './service.js';
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
export function mountWatch({ ctx, dataDir, initialMode, config = {}, vendorDir }) {
  const watch = new WatchService({ dataDir, initialMode });
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => watch.dispose(), 'dsh-neocortex: watch module');
  }
  // 体检、扫码登录、离线跑一轮：被动注册，不调用就不产生任何网络/文件行为。
  registerWatchTools(ctx, { dataDir, config, vendorDir, watch });
  // P1 keeps the module inert even when the mode is on: the switch is stored and
  // readable, but no timer or pipeline exists yet. P2 (harvest) and P6
  // (scheduler) start from `watch.enabled()` here.
  return watch;
}
