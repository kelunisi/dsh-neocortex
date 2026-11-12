import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commentLink, isWorthReplying, renderCommentReport, saveCommentReport, scoreComment, withOwnerMention } from '../src/watch/comments.js';

test('P5C-01 questions and corrections are worth replying; ads and short comments are not', () => {
  assert.equal(isWorthReplying({ content: '请问 5070 和 5080 选哪个？', like: 1 }), true);
  assert.equal(isWorthReplying({ content: '其实这里说反了，5060Ti 应该是 8G', like: 0 }), true);
  assert.equal(isWorthReplying({ content: '加微信 123456 领优惠', like: 99 }), false);
  assert.equal(isWorthReplying({ content: '好', like: 99 }), false);
  assert.equal(isWorthReplying({ content: '这条视频讲得不错', like: 8 }), true);
});

test('P5C-02 score prefers questions over plain likes', () => {
  assert.ok(scoreComment({ content: '怎么选？', like: 0, reply_count: 0 }) > scoreComment({ content: '不错', like: 8, reply_count: 0 }));
});

test('P5C-03 report contains video link, comment link and the no-send disclaimer', () => {
  const report = renderCommentReport({
    date: '2026-11-11',
    videos: [{ bvid: 'BV1xx', title: '显卡价格', up: 'UP', comments: 10 }],
    comments: [{
      bvid: 'BV1xx', videoTitle: '显卡价格', up: 'UP', rpid: 123, content: '请问 5070 值得买吗？',
      like: 3, replyCount: 1, signal: ['问题'], link: commentLink('BV1xx', 123),
    }],
  });
  assert.match(report, /bilibili\.com\/video\/BV1xx/);
  assert.match(report, /#reply123/);
  assert.match(report, /没有生成或发送任何回复/);
});

test('P5C-04 saveCommentReport writes a markdown file', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-comments-'));
  const { file } = saveCommentReport({ dataDir, date: '2026-11-11', videos: [], comments: [] });
  assert.equal(fs.existsSync(file), true);
  assert.match(fs.readFileSync(file, 'utf8'), /评论淘金/);
});

test('P5C-05 every outbound reply starts with the owner mention', () => {
  assert.equal(withOwnerMention('这条有用', 'kelunisi'), '@kelunisi 这条有用');
  assert.equal(withOwnerMention('@kelunisi 这条有用', 'kelunisi'), '@kelunisi 这条有用', 'no duplicate owner mention');
  assert.equal(withOwnerMention('这条有用', ''), '这条有用');
});
