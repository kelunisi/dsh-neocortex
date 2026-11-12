import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAutoComments } from '../src/watch/auto-comments.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-auto-comments-'));
}

function makeQueue(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'watch'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'watch', 'queue.json'), JSON.stringify({
    date: '2026-11-12',
    updatedAt: new Date().toISOString(),
    items: [{
      id: '2026-11-12-BV1', date: '2026-11-12', bvid: 'BV1', mid: 1,
      title: '显卡怎么选', up: 'UP', status: 'accepted', points: [], url: 'https://www.bilibili.com/video/BV1',
    }],
  }), 'utf8');
}

function fakeFactory(sent) {
  let created = 0;
  return () => {
    created += 1;
    const isReplyClient = created > 1;
    return {
      client: {
        async call(name, args) {
          if (name === 'bili_comments') {
            return { bvid: args.bvid, comments: [{ rpid: 101, user: '问的人', content: '请问 5070 和 5080 怎么选？', like: 8, reply_count: 2 }] };
          }
          if (name === 'bili_reply') {
            sent.push(args);
            return { success: true, rpid: 999, root: args.rpid };
          }
          throw new Error(`unexpected tool ${name}`);
        },
        stop() {},
      },
    };
  };
}

test('AUTO-C-01 drafts, mentions the owner, and sends one approved comment', async () => {
  const dataDir = tempDir();
  makeQueue(dataDir);
  const sent = [];
  const result = await runAutoComments({
    ctx: {},
    dataDir,
    config: { ownerMention: 'kelunisi', mentionPerDay: 3 },
    route: { provider: 'p', model: 'm' },
    llm: { stream() {} },
    clientFactory: fakeFactory(sent),
    modelCaller: async () => '{"reply":"看预算和用途，5070 够用就选 5070。"}',
  });
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^@kelunisi /);
  assert.match(sent[0].text, /预算/);
  assert.ok(fs.existsSync(result.file));
});

test('AUTO-C-02 a privacy-hit draft is blocked and never sent', async () => {
  const dataDir = tempDir();
  makeQueue(dataDir);
  const sent = [];
  const result = await runAutoComments({
    ctx: {},
    dataDir,
    config: { ownerMention: 'kelunisi', mentionPerDay: 3 },
    route: { provider: 'p', model: 'm' },
    llm: { stream() {} },
    clientFactory: fakeFactory(sent),
    modelCaller: async () => '{"reply":"加我微信 13800138000 聊。"}',
  });
  assert.equal(result.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(result.blocked, 1);
});
