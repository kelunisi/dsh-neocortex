import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.js';
import { MemoryWriter, isoWeek, sha256 } from '../src/writer.js';
import { LifecycleEngine } from '../src/lifecycle.js';
import { WeeklyReview, ReviewConflictError, isMondayAfterNine } from '../src/review.js';
import { PanelStateService } from '../src/panel-service.js';
import { executePanelTool } from '../src/panel-tool.js';
import { readAllMemoryEntries, readBrainSnapshot } from '../src/recall.js';
import { DEFAULT_CONFIG, resolveConfig } from '../src/defaults.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'fixtures', 'brain');
const config = resolveConfig();
const report = [];
const GENERAL = '个人模型/近况/通用.md';
const SLEEPING = '个人模型/近况/沉睡条目.md';

function setup(name, initial = '2026-11-09T02:00:00.000Z', brainOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `neocortex-p4-${name}-`));
  const brainRoot = brainOverride || path.join(dir, 'brain');
  if (!brainOverride) fs.cpSync(fixture, brainRoot, { recursive: true });
  const clock = { value: new Date(initial) };
  const now = () => clock.value;
  const ledger = new Ledger(path.join(dir, 'ledger.json'), { now });
  const writer = new MemoryWriter({ brainRoot, ledger, config, now });
  const lifecycle = new LifecycleEngine({ brainRoot, ledger, writer, config, now });
  const review = new WeeklyReview({ brainRoot, ledger, writer, lifecycle, config, now });
  const panel = new PanelStateService({ brainRoot, dataDir: dir, ledger, writer, lifecycle, review, config: { ...config } });
  return { dir, brainRoot, ledger, writer, lifecycle, review, panel, now, setNow: (value) => { clock.value = new Date(value); } };
}

function read(brainRoot, relative) {
  return fs.readFileSync(path.join(brainRoot, relative), 'utf8');
}

function prependGeneral(brainRoot, lines) {
  const file = path.join(brainRoot, GENERAL);
  const content = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, content.replace('## 条目\n\n', `## 条目\n\n${lines.join('\n')}\n`), 'utf8');
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function gitInit(cwd) {
  git(cwd, ['init']);
  git(cwd, ['config', 'user.name', 'Neocortex Test']);
  git(cwd, ['config', 'user.email', 'neocortex@example.test']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  git(cwd, ['config', 'core.quotepath', 'false']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'fixture baseline']);
}

async function record(id, arrange, action) {
  await test(id, async (t) => {
    t.diagnostic(`Arrange: ${arrange}`);
    const detail = await action(t);
    report.push({ id, arrange, assert: detail, status: 'passed' });
    t.diagnostic(`Assert: ${JSON.stringify(detail)}`);
  });
}

process.on('exit', () => {
  fs.writeFileSync(path.join(root, 'evidence', 'p4-unit-report.json'), JSON.stringify({
    phase: 'P4',
    date: '2026-11-05',
    status: report.length === 8 ? 'passed' : 'incomplete',
    summary: { passed: report.length, failed: 0 },
    results: report,
    liveWebReport: 'evidence/p4-live-web-report.json',
  }, null, 2) + '\n');
});

await record('P4-01', 'A Monday schedule trigger followed by manual review, with queue and L2 audit data.', () => {
  const env = setup('scheduled-manual');
  env.setNow('2026-11-09T00:59:00.000Z');
  assert.equal(isMondayAfterNine(env.now()), false);
  env.setNow('2026-11-09T01:00:00.000Z');
  assert.equal(isMondayAfterNine(env.now()), true);
  env.writer.remember({ layer: 'L2', text: '周报审计条目', targetPath: '知识库/审计.md', source: 'fixture://audit' });
  const week = isoWeek(env.now());
  env.ledger.state.pendingQueue.push(
    { id: 'old-queue', text: '最旧候选', layer: 'L3', scene: '队列', week, queuedAt: '2026-11-09T01:00:00.000Z', reason: 'daily-quota' },
    { id: 'new-queue', text: '较新候选', layer: 'L3', scene: '队列', week, queuedAt: '2026-11-09T01:30:00.000Z', reason: 'daily-quota' },
  );
  const scheduled = env.review.ensureWeekly({ sessionId: 'p4-scheduled' });
  const manual = env.review.manual({ sessionId: 'p4-manual' });
  assert.equal(scheduled.generated, true);
  assert.equal(manual.reused, true);
  assert.deepEqual(manual.candidateIds, scheduled.candidateIds);
  assert.deepEqual(manual.lifecycle, scheduled.lifecycle);
  assert.deepEqual(manual.l2Audit, scheduled.l2Audit);
  assert.equal(scheduled.l2Audit[0].path, '知识库/审计.md');
  assert.equal(scheduled.l2Audit[0].sha256, sha256(read(env.brainRoot, '知识库/审计.md')));
  const queueCandidates = scheduled.candidates.filter((candidate) => candidate.type === 'queue-item');
  assert.deepEqual(queueCandidates.map((candidate) => candidate.queueId), ['old-queue', 'new-queue']);
  assert.equal(env.review.list({ week })[0].queueId, 'old-queue');
  assert.equal(scheduled.reconciliation.memories > 0, true);
  return { sameLifecycle: true, sameCandidates: true, queueOldestFirst: true, l2ReadonlyAudit: true, reconciliation: true };
});

await record('P4-02', 'A review that fails after promotion, then resumes and is repeated.', () => {
  const env = setup('failure-recovery');
  prependGeneral(env.brainRoot, [
    '- [2026-11-09] 阅读一 {场景倾向:阅读}',
    '- [2026-11-09] 阅读二 {场景倾向:阅读}',
    '- [2026-11-09] 阅读三 {场景倾向:阅读}',
  ]);
  const original = env.lifecycle.runReview.bind(env.lifecycle);
  env.lifecycle.runReview = (options) => { original(options); throw new Error('fixture interruption after promotion'); };
  assert.throws(() => env.review.manual({ sessionId: 'p4-failure' }), /fixture interruption/);
  assert.equal(env.review.ledger.state.reviewRuns[isoWeek(env.now())].status, 'failed');
  assert.equal(readBrainSnapshot(env.brainRoot).scenes.find((scene) => scene.name === '阅读').status, 'active');
  env.lifecycle.runReview = original;
  const resumed = env.review.manual({ sessionId: 'p4-resume' });
  assert.equal(resumed.reused, false);
  const scenePage = '个人模型/近况/活跃/阅读.md';
  const entries = readBrainSnapshot(env.brainRoot).memories.filter((entry) => entry.scene === '阅读');
  assert.equal(entries.length, 3);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 3);
  const before = read(env.brainRoot, scenePage);
  const repeated = env.review.manual({ sessionId: 'p4-repeat' });
  assert.equal(repeated.reused, true);
  assert.equal(read(env.brainRoot, scenePage), before);
  return { failureRecorded: true, resumed: true, noHalfMoves: true, noDuplicateEntries: true, repeatReusesResult: true };
});

await record('P4-03', 'Real fixture memories, pending L1, quota, review and L2 state exposed to the panel model.', () => {
  const env = setup('panel-state');
  env.writer.remember({ layer: 'L1', text: '推断的待确认偏好', category: 'preference' });
  env.writer.remember({ layer: 'L2', text: '只读知识', targetPath: '知识库/只读.md', source: 'fixture://l2' });
  env.writer.remember({ layer: 'L3', text: '面板真实近况', scene: '标准化' });
  env.review.generate();
  env.ledger.state.l2Audit[isoWeek(env.now())] = env.review.auditL2();
  const state = env.panel.state();
  assert.equal(state.memories.some((item) => item.text.includes('面板真实近况') && item.explanation), true);
  assert.equal(state.l1Pending.every((item) => item.sourcePath.startsWith('个人模型/')), true);
  assert.equal(state.l1Pending.some((item) => item.text === '推断的待确认偏好'), true);
  assert.equal(state.l2Audit.some((item) => item.path === '知识库/只读.md' && !item.action), true);
  assert.equal(state.quota.total, 1);
  assert.equal(state.reviews.length > 0, true);
  assert.equal(state.settings.halfLifeDays, 30);
  assert.deepEqual(state.settingRanges.halfLifeDays, [15, 45]);
  assert.equal(Object.hasOwn(state, 'demoData'), false);
  return { realMemories: true, recallExplanations: true, l1PendingOnly: true, quotaAndReviews: true, realSettingsAndEmptyFlags: true };
});

await record('P4-04', 'L1 confirmation, fact undo, manual review and an attempted action on L2.', () => {
  const env = setup('panel-actions');
  env.writer.remember({ layer: 'L1', text: '待用户确认的偏好', category: 'preference' });
  const pending = env.panel.listL1Pending().find((item) => item.text === '待用户确认的偏好');
  const confirmed = env.panel.confirmL1({ id: pending.id, expectedHash: pending.sha256 }, 'p4-panel');
  assert.equal(confirmed.status, 'confirmed');
  const page = read(env.brainRoot, '个人模型/协作偏好.md');
  assert.match(page, /## 用户明示记录[\s\S]*待用户确认的偏好/);
  assert.doesNotMatch(page.slice(page.indexOf('## 待确认调整'), page.indexOf('## 用户明示记录')), /待用户确认的偏好/);
  assert.match(read(env.brainRoot, '个人模型/_索引.md'), /待用户确认的偏好/);
  assert.equal(env.panel.confirmL1({ id: pending.id }, 'p4-panel').status, 'not-found');
  env.writer.remember({ layer: 'L3', text: '旧事实', factKey: '面板.事实' });
  const replaced = env.writer.remember({ layer: 'L3', text: '新事实', factKey: '面板.事实' });
  const toolState = executePanelTool(env.panel, { action: 'state' }, 'p4-tool');
  assert.equal(toolState.memories.some((item) => item.text.includes('新事实')), true);
  assert.equal(executePanelTool(env.panel, { action: 'undo', id: replaced.tombstoneId }, 'p4-tool').status, 'undone');
  assert.equal(env.panel.undo({ id: replaced.tombstoneId }, 'p4-panel').status, 'already-undone');
  const candidates = env.review.generate();
  assert.equal(candidates.length > 0, true);
  assert.deepEqual(
    executePanelTool(env.panel, { action: 'preview_review', id: candidates[0].id }, 'p4-tool'),
    env.review.preview(candidates[0].id),
  );
  const manual = executePanelTool(env.panel, { action: 'manual_review' }, 'p4-tool');
  assert.equal(manual.reused, false);
  assert.equal(env.panel.manualReview({}, 'p4-panel').reused, true);
  assert.equal(executePanelTool(env.panel, { action: 'retry_review' }, 'p4-tool').reused, true);
  const toolSettings = executePanelTool(env.panel, { action: 'update_settings', settings: { halfLifeDays: 31 } }, 'p4-tool');
  const uiSettings = env.panel.updateSettings({ halfLifeDays: 31 });
  assert.deepEqual(toolSettings.settings, uiSettings.settings);
  assert.equal(toolSettings.historyUnchanged, true);
  assert.equal(env.panel.confirmL1({ id: '知识库/只读.md' }, 'p4-panel').status, 'not-found');
  for (const action of ['confirm_l1', 'accept_review', 'reject_review']) {
    assert.equal(executePanelTool(env.panel, { action, id: 'user-only' }, 'p4-tool').reason, 'unknown-or-user-only-action');
  }
  return { onlyL1Confirmable: true, l2Readonly: true, undoResult: true, manualReviewResult: true, staleConfirmationRejected: true, agentToolParity: true, userOnlyApprovals: true };
});

await record('P4-05', 'Default settings, invalid values, a valid update and historical usage counters.', () => {
  const env = setup('settings');
  assert.equal(DEFAULT_CONFIG.halfLifeDays, 30);
  assert.equal(DEFAULT_CONFIG.firstInjectionMaxItems, 10);
  assert.equal(DEFAULT_CONFIG.firstInjectionMaxChars, 800);
  assert.equal(DEFAULT_CONFIG.generalSleepDays, 15);
  assert.equal(DEFAULT_CONFIG.revivalWindowDays, 3);
  assert.equal(DEFAULT_CONFIG.revivalThreshold, 3);
  assert.throws(() => resolveConfig({ halfLifeDays: 14 }), /15\.\.45/);
  assert.throws(() => resolveConfig({ generalSleepDays: 31 }), /10\.\.30/);
  assert.throws(() => env.panel.updateSettings({ dailyWriteQuota: 16 }), /Unknown or frozen/);
  const memoryId = readBrainSnapshot(env.brainRoot).memories[0].id;
  env.ledger.state.memories[memoryId].useCount = 7;
  const updated = env.panel.updateSettings({ halfLifeDays: 45, generalSleepDays: 10 });
  assert.equal(updated.settings.halfLifeDays, 45);
  assert.equal(updated.settings.generalSleepDays, 10);
  assert.equal(updated.historyUnchanged, true);
  assert.equal(env.ledger.state.memories[memoryId].useCount, 7);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.dir, 'settings.json'), 'utf8')).halfLifeDays, 45);
  return { defaultsMatch: true, invalidRejected: true, validPersisted: true, usageHistoryUnchanged: true };
});

await record('P4-06', 'A local-only Git repository around a real plugin Markdown change.', () => {
  const env = setup('git-local');
  gitInit(env.brainRoot);
  env.writer.remember({ layer: 'L3', text: '本地审查条目', scene: '标准化' }, { sessionId: 'p4-git' });
  const diff = git(env.brainRoot, ['diff', '--', '个人模型/近况/活跃/标准化.md', '操作日志.md']);
  assert.match(diff, /本地审查条目/);
  assert.match(read(env.brainRoot, '操作日志.md'), /p4-git/);
  assert.match(git(env.brainRoot, ['status', '--short']), /操作日志\.md/);
  git(env.brainRoot, ['add', '.']);
  git(env.brainRoot, ['commit', '-m', 'review neocortex change']);
  assert.equal(git(env.brainRoot, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(git(env.brainRoot, ['remote', '-v']), '');
  return { reviewableDiff: true, localCommit: true, noRemoteAndNoPush: true };
});

await record('P4-07', 'A generated review candidate, an external iCloud-style edit, conflict detection and Git recovery.', () => {
  const env = setup('conflict');
  gitInit(env.brainRoot);
  const candidate = env.review.generate().find((item) => item.type === 'sleeping-item');
  const file = path.join(env.brainRoot, SLEEPING);
  const external = read(env.brainRoot, SLEEPING) + '- [2026-11-09] iCloud 外部新增\n';
  fs.writeFileSync(file, external, 'utf8');
  assert.throws(() => env.review.accept(candidate.id, { sessionId: 'p4-conflict' }), ReviewConflictError);
  assert.equal(read(env.brainRoot, SLEEPING), external);
  assert.equal(env.ledger.state.reviews[candidate.id].status, 'pending');
  const diff = git(env.brainRoot, ['diff', '--', SLEEPING]);
  assert.match(diff, /iCloud 外部新增/);
  git(env.brainRoot, ['checkout', '--', SLEEPING]);
  const accepted = env.review.accept(candidate.id, { sessionId: 'p4-conflict-recovered' });
  assert.equal(accepted.status, 'accepted');
  return { staleWriteStopped: true, externalChangePreservedUntilReview: true, gitLocatedAndRestored: true, retryAfterRecovery: true };
});

await record('P4-08', 'Two independent Harness ledgers sharing Markdown, plus an external Obsidian-style edit.', () => {
  const first = setup('cross-a');
  const second = setup('cross-b', '2026-11-09T03:00:00.000Z', first.brainRoot);
  const beforeInternal = fs.existsSync(path.join(first.brainRoot, '.obsidian'));
  first.writer.remember({ layer: 'L3', text: '跨 Harness 写入', scene: '跨端' }, { sessionId: 'harness-a' });
  assert.equal(readBrainSnapshot(second.brainRoot).memories.some((entry) => entry.text.includes('跨 Harness 写入')), true);
  const generalFile = path.join(first.brainRoot, GENERAL);
  fs.appendFileSync(generalFile, '- [2026-11-09] Obsidian 外部编辑 {场景倾向:编辑}\n', 'utf8');
  const reconciled = second.lifecycle.reconcile();
  const external = readAllMemoryEntries(second.brainRoot).find((entry) => entry.text.includes('Obsidian 外部编辑'));
  assert.equal(Boolean(second.ledger.state.memories[external.id]), true);
  assert.equal(reconciled.memories > 0, true);
  assert.match(read(first.brainRoot, '操作日志.md'), /DSH \+ dsh-neocortex/);
  assert.match(read(first.brainRoot, '操作日志.md'), /harness-a/);
  assert.equal(fs.existsSync(path.join(first.brainRoot, '.obsidian')), beforeInternal);
  assert.equal(fs.existsSync(path.join(first.brainRoot, '.smart-env')), false);
  return { markdownVisibleAcrossHarness: true, externalEditReconciled: true, protocolLogPresent: true, internalStateUntouched: true };
});
