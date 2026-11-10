/**
 * 离线跑一轮：抓取 → 粗筛 → 深读（模型）→ 日报 + JSONL。
 * P3 只做 dry-run：不写智脑、不发评论、不互动。
 */

import { loadCriteria, directionTokens } from './criteria.js';
import { loadCalibration } from './calibration.js';
import { buildQueue } from './queue.js';
import { recordUsage } from './budget.js';
import { fetchFollowings } from './suggestions.js';
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

/**
 * 探索位不再用首页推荐：用"关注方向里不在必含词中的词"去搜，
 * 这样捡到的是方向相关但字面没命中必含词的内容。
 */
export function buildExploreQueries(criteria, max = 2) {
  const must = (criteria.must || []).map((word) => String(word).toLowerCase());
  const tokens = directionTokens(criteria).filter((token) => {
    const value = token.toLowerCase();
    return !must.some((word) => word && (value.includes(word) || word.includes(value)));
  });
  const pool = tokens.length ? tokens : (criteria.plus || []);
  const suffixes = [' 方法', ' 案例'];
  return pool.slice(0, max).map((token, index) => `${token}${suffixes[index % suffixes.length]}`.trim());
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

  const configured = Array.isArray(config.queries) && config.queries.length
    ? config.queries.filter(Boolean)
    : (criteria.queries.length ? criteria.queries : (criteria.must.length ? criteria.must.slice(0, 3) : ['知识']));
  const queries = configured.slice(0, 10);
  const exploreQueries = buildExploreQueries(criteria, 2);
  const examples = loadCalibration(dataDir, { limit: 8 }).entries;
  const judged = new Set(loadCalibration(dataDir, { limit: 500 }).entries.map((item) => item.bvid));

  const { client } = clientFactory({ dataDir, config, vendorDir, log });
  try {
    const collected = [];
    // 关注 UP 优先：先看他们最近 5 条，再让关键词搜索补满。
    const followedUps = [];
    try {
      const followings = await fetchFollowings({ dataDir, config, vendorDir, signal, client, pages: 1 });
      const selfMid = Number(followings.selfMid || 0);
      for (const up of followings.filter((entry) => Number(entry.mid) > 0 && Number(entry.mid) !== selfMid).slice(0, 10)) {
        followedUps.push(up);
        try {
          const result = await client.call('bili_user_videos', { uid: up.mid, pn: 1, ps: 5, order: 'pubdate' }, { timeoutMs: 45000, signal });
          const videos = videosOf(result).map((video) => ({
            ...video,
            author: up.uname,
            mid: up.mid,
            following: true,
            origin: 'following',
            originQuery: `following:${up.mid}`,
            duration: video.duration || video.length,
            pubdate: video.pubdate || video.created,
          }));
          collected.push(...videos);
          log(`关注「${up.uname}」：${videos.length} 条`);
        } catch (error) {
          log(`关注「${up.uname}」拉取失败：${String(error?.message || error)}`);
        }
      }
    } catch (error) {
      log(`关注列表读取失败，本轮退回纯关键词：${String(error?.message || error)}`);
    }
    for (const keyword of queries) {
      if (signal?.aborted) throw new Error('已取消');
      const result = await client.call('bili_search', { keyword, num: 10, order: 'totalrank', page: 1 }, { timeoutMs: 45000, signal });
      const videos = videosOf(result).map((video) => ({ ...video, originQuery: keyword }));
      collected.push(...videos);
      log(`搜索「${keyword}」：${videos.length} 条`);
    }
    for (const keyword of exploreQueries) {
      if (signal?.aborted) throw new Error('已取消');
      try {
        const result = await client.call('bili_search', { keyword, num: 8, order: 'totalrank', page: 1 }, { timeoutMs: 45000, signal });
        const videos = videosOf(result).map((video) => ({ ...video, origin: 'explore', originQuery: keyword }));
        collected.push(...videos);
        log(`探索「${keyword}」：${videos.length} 条`);
      } catch (error) {
        log(`探索搜索失败「${keyword}」：${String(error?.message || error)}`);
      }
    }

    const all = dedupeVideos(collected).filter((video) => !judged.has(video.bvid));
    if (judged.size) log(`跳过已判定过的 ${judged.size} 条 BV`);
    const picked = pickCandidates(all, criteria, {
      scanPerRound: config.scanPerRound || 5,
      explorationRatio: config.explorationRatio ?? 0.2,
    });
    const deepPicks = selectDeep(picked, config.deepPerRound || 3);
    const deepById = new Map();
    let estimatedTokens = 0;
    for (const entry of deepPicks) {
      if (signal?.aborted) throw new Error('已取消');
      let subtitle = '';
      try {
        const result = await client.call('bili_subtitle', { bvid: entry.video.bvid }, { timeoutMs: 60000, signal });
        subtitle = normalizeSubtitle(result);
      } catch (error) {
        log(`字幕获取失败 ${entry.video.bvid}：${String(error?.message || error)}`);
      }
      const judgement = await understandVideo({ ctx, llm: model, route: modelRoute, criteria, video: entry.video, subtitle, examples, signal });
      deepById.set(entry.video.bvid, judgement);
      estimatedTokens += Math.ceil((subtitle.length || 0) / 2) + 1200;
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
    const queue = buildQueue({ dataDir, date: localDay(now), picked, deepById });
    const usage = recordUsage(dataDir, estimatedTokens);
    return {
      ok: true,
      ...report,
      queue: { file: queue.file, count: queue.items.length },
      usage: { estimated: estimatedTokens, day: usage.date, used: usage.used },
      route: modelRoute,
      queries,
      exploreQueries,
      followedUps: followedUps.length,
      calibrationExamples: examples.length,
      totalCandidates: all.length,
      picked: picked.map((entry) => ({
        bvid: entry.video.bvid,
        mid: entry.video.mid || 0,
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
