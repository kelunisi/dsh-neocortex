/**
 * 收之前补深读：队列里没有要点的条目（非深读入选），
 * 在写 L2 之前补一次字幕 + 模型判读，避免来源页只有标题。
 */

import { createBiliClient } from './bili.js';
import { loadCalibration } from './calibration.js';
import { loadCriteria } from './criteria.js';
import { normalizeSubtitle, resolveModelRoute, understandVideo } from './understand.js';

export async function hydrateItems({
  ctx,
  dataDir,
  config = {},
  vendorDir,
  items = [],
  signal,
  log = () => {},
  clientFactory = createBiliClient,
  llm,
  route,
}) {
  const targets = (items || []).filter((item) => item && (!Array.isArray(item.points) || item.points.length === 0));
  if (!targets.length) return { hydrated: 0, failed: 0, details: [] };
  const model = llm || ctx?.get?.('llm');
  if (!model?.stream) return { hydrated: 0, failed: targets.length, details: [], error: 'no-llm' };
  const { criteria } = loadCriteria(dataDir);
  const modelRoute = route || resolveModelRoute(ctx, config);
  const examples = loadCalibration(dataDir, { limit: 8 }).entries;
  const { client } = clientFactory({ dataDir, config, vendorDir, log });
  let hydrated = 0;
  let failed = 0;
  const details = [];
  try {
    for (const item of targets) {
      if (signal?.aborted) break;
      try {
        const subtitleResult = await client.call('bili_subtitle', { bvid: item.bvid }, { timeoutMs: 60000, signal });
        const subtitle = normalizeSubtitle(subtitleResult);
        const judgement = await understandVideo({
          ctx,
          llm: model,
          route: modelRoute,
          criteria,
          video: { bvid: item.bvid, title: item.title, author: item.up, play: 0, description: '' },
          subtitle,
          examples,
          signal,
        });
        if (judgement.points?.length) {
          item.points = judgement.points;
          item.reason = judgement.reason || item.reason;
          item.confidence = judgement.confidence;
          item.subtitleMissing = Boolean(judgement.subtitleMissing);
          item.hydrated = true;
          hydrated += 1;
          details.push({ bvid: item.bvid, status: 'hydrated', points: judgement.points.length });
        } else {
          failed += 1;
          details.push({ bvid: item.bvid, status: 'no-points', reason: judgement.reason });
        }
      } catch (error) {
        failed += 1;
        details.push({ bvid: item.bvid, status: 'error', error: String(error?.message || error).slice(0, 160) });
      }
    }
  } finally {
    try { client.stop(); } catch { /* ignore */ }
  }
  return { hydrated, failed, details };
}
