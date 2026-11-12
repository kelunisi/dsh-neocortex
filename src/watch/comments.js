/**
 * P5 第一步：评论淘金（只读）。
 * 从已收视频抓热门评论，挑出值得回复的问题/纠错/讨论，写成报告；
 * 不生成也不发送任何回复。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createBiliClient } from './bili.js';

const QUESTION = /怎么|如何|请问|求问|有没有|能不能|为什么|为啥|哪款|哪个|选哪个|值得吗|多少钱|多少[?？]|多久|吗[?？]|呢[?？]/;
const CORRECTION = /不对|其实|不是吧|应该是|错了|纠正|补充一下/;
const SPAM = /加微信|私信我|广告|推广|点击链接|https?:\/\/|扫码|代购/;

export function commentSignals(text) {
  const source = String(text || '').trim();
  const signals = [];
  if (QUESTION.test(source)) signals.push('问题');
  if (CORRECTION.test(source)) signals.push('纠错/补充');
  if (SPAM.test(source)) signals.push('广告/引流');
  return signals;
}

export function isWorthReplying(comment) {
  const text = String(comment?.content || '').trim();
  if (text.length < 6) return false;
  const signals = commentSignals(text);
  if (signals.includes('广告/引流')) return false;
  return signals.length > 0 || Number(comment?.like || 0) >= 5;
}

export function scoreComment(comment) {
  const text = String(comment?.content || '');
  const signals = commentSignals(text);
  let score = 0;
  if (signals.includes('问题')) score += 3;
  if (signals.includes('纠错/补充')) score += 2;
  if (Number(comment?.like || 0) >= 5) score += 1;
  if (Number(comment?.reply_count || 0) > 0) score += 1;
  return score;
}

/** 每条公开回复都先 @ 自己的账号；没有配置昵称时原样返回。 */
export function withOwnerMention(text, owner) {
  const name = String(owner || '').trim().replace(/^@+/, '');
  const body = String(text || '').trim();
  if (!name) return body;
  if (body.startsWith(`@${name}`)) return body;
  return `@${name} ${body}`;
}

export function commentLink(bvid, rpid) {  const base = `https://www.bilibili.com/video/${encodeURIComponent(String(bvid || ''))}`;
  return rpid ? `${base}/#reply${encodeURIComponent(String(rpid))}` : base;
}

export async function fetchAcceptedComments({
  queue,
  dataDir,
  config = {},
  vendorDir,
  maxVideos = 3,
  perVideo = 20,
  maxItems = 15,
  signal,
  clientFactory = createBiliClient,
  log = () => {},
}) {
  const accepted = (queue?.items || []).filter((item) => item.status === 'accepted').slice(-maxVideos);
  const { client } = clientFactory({ dataDir, config, vendorDir, log });
  const videos = [];
  const picked = [];
  try {
    for (const item of accepted) {
      if (signal?.aborted) break;
      try {
        const result = await client.call('bili_comments', { bvid: item.bvid, num: perVideo }, { timeoutMs: 60000, signal });
        const comments = Array.isArray(result?.comments) ? result.comments : [];
        videos.push({ bvid: item.bvid, title: item.title, up: item.up, comments: comments.length, error: result?.error || null });
        for (const comment of comments) {
          if (!isWorthReplying(comment)) continue;
          picked.push({
            bvid: item.bvid,
            videoTitle: item.title,
            up: item.up,
            rpid: comment.rpid,
            user: comment.user,
            content: comment.content,
            like: comment.like,
            replyCount: comment.reply_count,
            signal: commentSignals(comment.content).filter((label) => label !== '广告/引流'),
            score: scoreComment(comment),
            link: commentLink(item.bvid, comment.rpid),
          });
        }
      } catch (error) {
        videos.push({ bvid: item.bvid, title: item.title, up: item.up, comments: 0, error: String(error?.message || error) });
      }
    }
  } finally {
    try { client.stop(); } catch { /* ignore */ }
  }
  picked.sort((a, b) => b.score - a.score || b.like - a.like);
  return { videos, comments: picked.slice(0, Math.max(1, Number(maxItems) || 15)) };
}

export function renderCommentReport({ date, videos = [], comments = [] }) {
  const lines = [
    '# 评论淘金（只读）',
    '',
    `- 日期：${date}`,
    `- 视频：${videos.length} 个；入选评论：${comments.length} 条`,
    '- 状态：只读采集，**没有生成或发送任何回复**',
    '',
    '## 视频',
    '',
  ];
  for (const video of videos) {
    const link = `https://www.bilibili.com/video/${encodeURIComponent(video.bvid)}`;
    lines.push(`- [${video.title || video.bvid}](${link}) — ${video.up || ''}；抓到 ${video.comments} 条${video.error ? `；错误：${video.error}` : ''}`);
  }
  lines.push('', '## 入选评论', '');
  if (!comments.length) lines.push('- 本轮没有找到值得回复的问题/纠错；可以换一个视频或过几天再看。');
  for (const [index, comment] of comments.entries()) {
    lines.push(`### ${index + 1}. ${comment.signal.join(' / ') || '讨论'}`);
    lines.push('');
    lines.push(`- 视频：${comment.videoTitle || comment.bvid}（${comment.up || ''}）`);
    lines.push(`- 评论：${comment.content}`);
    lines.push(`- 点赞 ${comment.like} / 回复 ${comment.replyCount}`);
    lines.push(`- 评论链接：${comment.link}`);
    lines.push(`- 为什么入选：${comment.signal.join('、') || '点赞较高'}`);
    lines.push('');
  }
  lines.push('---', '', '生成：dsh-neocortex / 评论淘金（未发送）', '');
  return lines.join('\n');
}

export function commentReportFile(dataDir, date) {
  return path.join(dataDir, 'watch', 'out', `comments-${date}.md`);
}

export function saveCommentReport({ dataDir, date, videos, comments }) {
  const file = commentReportFile(dataDir, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderCommentReport({ date, videos, comments }), 'utf8');
  return { file };
}
