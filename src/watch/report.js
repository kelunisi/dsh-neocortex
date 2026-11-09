/**
 * 产物：人看日报（md）+ 机器读流水（jsonl）。
 * P3 是离线试跑：只写 <dataDir>/watch/out/，不碰智脑、不发送。
 */

import fs from 'node:fs';
import path from 'node:path';

export function outDir(dataDir) {
  return path.join(dataDir, 'watch', 'out');
}

export function localDay(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return date.toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
}

export function reportPaths(dataDir, date) {
  const dir = outDir(dataDir);
  return { dir, markdown: path.join(dir, `${date}.md`), jsonl: path.join(dir, `${date}.jsonl`) };
}

export function writeRoundReport({ dataDir, date, picked, deepById, route, criteriaFile, verdict = 'dry-run', now = new Date() }) {
  const paths = reportPaths(dataDir, date);
  fs.mkdirSync(paths.dir, { recursive: true });
  const lines = [
    `# ${date} 刷到的（离线试跑）`,
    '',
    `> 判据：${criteriaFile}`,
    `> 模型：${route?.provider || '?'} / ${route?.model || '?'}`,
    `> 说明：本轮不写智脑、不发评论；只产出日报与 JSONL。`,
    '',
  ];
  const records = [];
  for (const entry of picked) {
    const { video, triage } = entry;
    const deep = deepById.get(video.bvid);
    lines.push(`### ${video.bvid}`);
    lines.push(`**标题**：${video.title}`);
    lines.push(`**UP**：${video.author || '未知'} ｜ 时长 ${video.duration || '未知'} ｜ 播放 ${video.play ?? 0}`);
    lines.push(`**判据**：${triage.reason}（${entry.bucket === 'exploration' ? '探索位' : '关键词'}）`);
    if (deep) {
      lines.push('**要点**');
      if (deep.points?.length) for (const point of deep.points) lines.push(`- ${point}`);
      else lines.push('- （模型未给出要点）');
      lines.push(`**结论**：${deep.worth === true ? '值得收' : deep.worth === false ? '跳过' : '待定'}（置信度 ${Number(deep.confidence || 0).toFixed(2)}）`);
      lines.push(`**判读**：${deep.reason || '—'}`);
      lines.push(`**字幕**：${deep.subtitleMissing ? '无（仅凭标题与简介）' : '有'}`);
    } else {
      lines.push('**结论**：粗筛入选，未深读');
    }
    lines.push('');
    records.push({
      date,
      bvid: video.bvid,
      title: video.title,
      up: video.author || '',
      mid: video.aid ?? null,
      duration: video.duration || '',
      pubdate: video.pubdate || null,
      picked: deep ? 'deep' : 'scan',
      worth: deep ? deep.worth : null,
      reason: deep ? deep.reason : triage.reason,
      points: deep?.points || [],
      comments_picked: [],
      ingested: false,
      mentioned: false,
      dry: verdict === 'dry-run',
      triage: { score: triage.score, bucket: entry.bucket, hits: triage.hits },
      confidence: deep ? deep.confidence : null,
      subtitle_missing: deep ? Boolean(deep.subtitleMissing) : null,
      ts: new Date(now).toISOString(),
    });
  }
  const summary = {
    date,
    picked: picked.length,
    deep: [...deepById.values()].length,
    worth: [...deepById.values()].filter((item) => item.worth === true).length,
    skipped: [...deepById.values()].filter((item) => item.worth === false).length,
    route,
  };
  lines.push('---');
  lines.push(`## 本轮汇总`);
  lines.push('');
  lines.push(`- 粗筛：${summary.picked} 条`);
  lines.push(`- 深读：${summary.deep} 条`);
  lines.push(`- 值得收：${summary.worth} 条；跳过：${summary.skipped} 条`);
  lines.push(`- 产物：${paths.markdown}`);
  lines.push('');
  fs.writeFileSync(paths.markdown, lines.join('\n'), 'utf8');
  fs.writeFileSync(paths.jsonl, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return { ...paths, summary };
}
