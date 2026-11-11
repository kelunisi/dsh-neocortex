/**
 * 两种喂养执行器的唯一分流口。
 *
 * code 与 agent 共用产物契约；agent 失败时可以降级 code，但返回值必须
 * 携带 degraded，不能把“实际跑了 code”伪装成一次成功的 agent 轮次。
 */

import { runDryRound } from './round.js';
import { runAgentRound } from './agent-round.js';
import { remainingBudget } from './budget.js';

export function effectiveWatchConfig(watch, config = {}) {
  // 面板/持久化滑块是运行期最新值；静态 provider/pythonPath 等仍来自 Cordis。
  return { ...config, ...(watch?.config || {}) };
}

function assertDailyBudget(options, config) {
  if (!options.dataDir) return;
  const limit = config.tokenBudgetPerDay ?? 2000000;
  if (remainingBudget(options.dataDir, limit, options.now || new Date()) > 0) return;
  const error = new Error('今日 token 预算已用完，本轮未启动');
  error.code = 'WATCH_DAILY_LIMIT';
  error.nonFallback = true;
  throw error;
}

export async function runWatchRound({
  mode = 'code',
  watch,
  config = {},
  log = () => {},
  codeRunner = runDryRound,
  agentRunner = runAgentRound,
  ...options
}) {
  const effectiveConfig = effectiveWatchConfig(watch, config);
  assertDailyBudget(options, effectiveConfig);
  if (mode !== 'agent') return codeRunner({ ...options, config: effectiveConfig, log });
  try {
    const result = await agentRunner({ ...options, config: effectiveConfig, log });
    if (result?.ok === false) {
      const error = new Error(String(result.message || result.reason || 'agent round failed'));
      error.code = String(result.reason || 'AGENT_FAILED');
      throw error;
    }
    return result;
  } catch (error) {
    const reason = String(error?.code || 'AGENT_FAILED');
    if (error?.nonFallback || ['WATCH_COMMIT_FAILED', 'WATCH_DAILY_LIMIT', 'AGENT_ABORTED', 'ABORT_ERR'].includes(reason)) throw error;
    const message = String(error?.message || error).slice(0, 500);
    log(`agent 档失败（${reason}），本轮显式降级 code：${message}`);
    assertDailyBudget(options, effectiveConfig);
    const result = await codeRunner({ ...options, config: effectiveConfig, log });
    return {
      ...result,
      mode: 'code',
      requestedMode: 'agent',
      degraded: { from: 'agent', reason, message },
    };
  }
}
