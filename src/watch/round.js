/**
 * 离线跑一轮：抓取 → 粗筛 → 深读（模型）→ 日报 + JSONL。
 * P3 只做 dry-run：不写智脑、不发评论、不互动。
 */

import { loadCriteria } from './criteria.js';
import { createBiliClient } from './bili.js';
import { dedupeVideos, pickCandidates, selectDeep } from './triage.js';
import { normalizeSubtitle, resolveModelRoute, understandVideo } from './understand.js';
import { localDay, writeRoundReport } from './report.js';

function videosOf(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.videos)) return result.videos;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.data?.videos)) return result.data.videos;
  return [];
}

export async function runDryRound({
  ctx,
  dataDir,
  config = {},
  vendorDir,
  signal,
  now = new Date(),
  log = () => {},
  clientFactory = createBiliClient,
  llm,
  route,
}) {
  const { file, criteria } = loadCriteria(dataDir);
  const modelRoute = route || resolveModelRoute(ctx, config);
  const model = llm || ctx?.get?.('llm');
  if (!model?.stream) throw new Error('当前 profile 没有可用的 LLM 服务（ctx.llm）');

  const queries = Array.isArray(config.queries) && config.queries.length
    ? config.queries.filter(Boolean).slice(0, 4)
    : (criteria.must.length ? criteria.must.slice(0, 3) : ['知识']);

  const { client } = clientFactory({ dataDir, config, vendorDir, log });
  try {
    const collected = [];
    for (const keyword of queries) {
      if (signal?.aborted) throw new Error('已取消');
      const result = await client.call('bili_search', { keyword, num: 10, order: 'totalrank', page: 1 }, { timeoutMs: 45000, signal });
      const videos = videosOf(result);
      collected.push(...videos);
      log(`搜索「${keyword}」：${videos.length} 条`);
    }
    try {
      const recommend = await client.call('bili_recommend', { ps: 10 }, { timeoutMs: 45000, signal });
      collected.push(...videosOf(recommend));
      log(`推荐位：${videosOf(recommend).length} 条`);
    } catch (error) {
      log(`推荐位抓取失败：${String(error?.message || error)}`);
    }

    const all = dedupeVideos(collected);
    const picked = pickCandidates(all, criteria, {
      scanPerRound: config.scanPerRound || 5,
      explorationRatio: config.explorationRatio ?? 0.2,
    });
    const deepPicks = selectDeep(picked, config.deepPerRound || 3);
    const deepById = new Map();
    for (const entry of deepPicks) {
      if (signal?.aborted) throw new Error('已取消');
      let subtitle = '';
      try {
        const result = await client.call('bili_subtitle', { bvid: entry.video.bvid }, { timeoutMs: 60000, signal });
        subtitle = normalizeSubtitle(result);
      } catch (error) {
        log(`字幕获取失败 ${entry.video.bvid}：${String(error?.message || error)}`);
      }
      const judgement = await understandVideo({ ctx, llm: model, route: modelRoute, criteria, video: entry.video, subtitle, signal });
      deepById.set(entry.video.bvid, judgement);
      log(`判读 ${entry.video.bvid}：${judgement.worth === true ? '值得收' : judgement.worth === false ? '跳过' : '待定'}`);
    }

    const report = writeRoundReport({
      dataDir,
      date: localDay(now),
      picked,
      deepById,
      route: modelRoute,
      criteriaFile: file,
      now,
    });
    return {
      ok: true,
      ...report,
      route: modelRoute,
      queries,
      totalCandidates: all.length,
      picked: picked.map((entry) => ({
        bvid: entry.video.bvid,
        title: entry.video.title,
        up: entry.video.author,
        bucket: entry.bucket,
        score: entry.triage.score,
        reason: entry.triage.reason,
        deep: deepById.has(entry.video.bvid),
        worth: deepById.get(entry.video.bvid)?.worth ?? null,
        confidence: deepById.get(entry.video.bvid)?.confidence ?? null,
      })),
    };
  } finally {
    try { client.stop(); } catch { /* ignore */ }
  }
}
