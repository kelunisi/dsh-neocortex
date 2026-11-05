import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { brainState, initializeBrain, listTemplateFiles, planInitialization } from '../src/setup.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neocortex-release-'));
}

function makeTemplate(root) {
  const files = {
    'AGENTS.md': '# 智脑规则\n',
    '从这里开始.md': '# 从这里开始\n',
    '个人模型/_索引.md': '# 个人模型\n',
    '个人模型/近况/通用.md': '# 通用\n',
    '操作日志.md': '# 操作日志\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return files;
}

function hashTree(root) {
  const result = {};
  if (!fs.existsSync(root)) return result;
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else result[child] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, child))).digest('hex');
    }
  };
  walk('');
  return result;
}

test('REL-01 brainState detects missing, empty, initialized, unrecognized and not-directory', () => {
  const root = tempDir();
  const missing = path.join(root, 'nope');
  assert.equal(brainState(missing).status, 'missing');
  assert.equal(brainState('').status, 'missing');

  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  assert.equal(brainState(empty).status, 'empty');

  const dotOnly = path.join(root, 'dotonly');
  fs.mkdirSync(dotOnly);
  fs.mkdirSync(path.join(dotOnly, '.git'));
  assert.equal(brainState(dotOnly).status, 'empty');

  const initialized = path.join(root, 'init');
  fs.mkdirSync(path.join(initialized, '个人模型'), { recursive: true });
  fs.writeFileSync(path.join(initialized, '个人模型', '_索引.md'), '# x\n');
  assert.equal(brainState(initialized).status, 'initialized');

  const withAgents = path.join(root, 'agents');
  fs.mkdirSync(withAgents);
  fs.writeFileSync(path.join(withAgents, 'AGENTS.md'), '# x\n');
  assert.equal(brainState(withAgents).status, 'initialized');

  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'hello');
  assert.equal(brainState(foreign).status, 'unrecognized');

  const asFile = path.join(root, 'afile');
  fs.writeFileSync(asFile, 'not a dir');
  assert.equal(brainState(asFile).status, 'not-directory');
});

test('REL-02 planInitialization new reports what would be created', () => {
  const root = tempDir();
  const templateRoot = path.join(root, 'template');
  const files = makeTemplate(templateRoot);
  const target = path.join(root, 'brain');
  const plan = planInitialization({ mode: 'new', targetDir: target, templateRoot });
  assert.equal(plan.status, 'ok');
  assert.deepEqual(plan.wouldCreate.sort(), Object.keys(files).map((f) => f.split('/').join(path.sep)).sort());
});

test('REL-03 new creation copies every template file into a missing directory', () => {
  const root = tempDir();
  const templateRoot = path.join(root, 'template');
  makeTemplate(templateRoot);
  const target = path.join(root, 'brain');
  const result = initializeBrain({ mode: 'new', targetDir: target, templateRoot });
  assert.equal(result.status, 'initialized');
  assert.equal(result.created.length, 5);
  for (const relative of listTemplateFiles(templateRoot)) {
    assert.ok(fs.existsSync(path.join(target, relative)), `${relative} must exist`);
    assert.equal(
      fs.readFileSync(path.join(target, relative), 'utf8'),
      fs.readFileSync(path.join(templateRoot, relative), 'utf8'),
      `${relative} must match the template byte for byte`,
    );
  }
});

test('REL-04 any pre-existing file aborts new creation with zero writes', () => {
  const root = tempDir();
  const templateRoot = path.join(root, 'template');
  makeTemplate(templateRoot);
  const target = path.join(root, 'brain');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, '操作日志.md'), '用户自己的日志，不许动\n');
  const before = hashTree(target);
  const plan = planInitialization({ mode: 'new', targetDir: target, templateRoot });
  assert.equal(plan.status, 'conflict');
  assert.deepEqual(plan.conflicts, ['操作日志.md']);
  const result = initializeBrain({ mode: 'new', targetDir: target, templateRoot });
  assert.equal(result.status, 'conflict');
  assert.deepEqual(hashTree(target), before, 'no file may be created or modified after a conflict');
  assert.equal(fs.readdirSync(target).length, 1, 'the conflicting directory must contain only the pre-existing file');
});

test('REL-05 unsafe targets are rejected before any write', () => {
  const root = tempDir();
  const templateRoot = path.join(root, 'template');
  makeTemplate(templateRoot);
  assert.equal(planInitialization({ mode: 'new', targetDir: path.parse(root).root, templateRoot }).status, 'invalid');
  assert.equal(planInitialization({ mode: 'new', targetDir: '  ', templateRoot }).status, 'invalid');
  assert.equal(planInitialization({ mode: 'new', targetDir: null, templateRoot }).status, 'invalid');
  const asFile = path.join(root, 'afile');
  fs.writeFileSync(asFile, 'x');
  const result = initializeBrain({ mode: 'new', targetDir: asFile, templateRoot });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'target-is-file');
});

test('REL-06 takeover verifies markers and never modifies existing files', () => {
  const root = tempDir();
  const templateRoot = path.join(root, 'template');
  makeTemplate(templateRoot);
  const brain = path.join(root, 'existing');
  fs.mkdirSync(path.join(brain, '个人模型'), { recursive: true });
  fs.writeFileSync(path.join(brain, '个人模型', '_索引.md'), '# 用户自己的内容\n');
  const before = hashTree(brain);
  const result = initializeBrain({ mode: 'takeover', targetDir: brain, templateRoot });
  assert.equal(result.status, 'takeover-ready');
  assert.deepEqual(hashTree(brain), before, 'takeover must be read-only');
});

test('REL-07 takeover refuses non-brain directories', () => {
  const root = tempDir();
  const templateRoot = path.join(root, 'template');
  makeTemplate(templateRoot);
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'x');
  const result = initializeBrain({ mode: 'takeover', targetDir: foreign, templateRoot });
  assert.equal(result.status, 'invalid');
  assert.match(result.reason, /^not-a-brain:/);
});

test('REL-08 upgrade fills missing skeleton files and never touches existing ones', () => {
  const root = tempDir();
  const templateRoot = path.join(root, 'template');
  makeTemplate(templateRoot);
  const brain = path.join(root, 'legacy');
  fs.mkdirSync(path.join(brain, '个人模型'), { recursive: true });
  fs.writeFileSync(path.join(brain, '个人模型', '_索引.md'), '# 用户自己的索引，不许动\n');
  const before = hashTree(brain);

  const plan = planInitialization({ mode: 'upgrade', targetDir: brain, templateRoot });
  assert.equal(plan.status, 'ok');
  assert.deepEqual(plan.skipped, [path.join('个人模型', '_索引.md')]);
  assert.equal(plan.wouldCreate.length, 4);

  const result = initializeBrain({ mode: 'upgrade', targetDir: brain, templateRoot });
  assert.equal(result.status, 'upgraded');
  assert.equal(result.created.length, 4);
  assert.deepEqual(hashTree(brain)['个人模型/_索引.md'.split('/').join(path.sep)], before['个人模型/_索引.md'.split('/').join(path.sep)], 'existing file content must be untouched');
  assert.equal(fs.readdirSync(path.join(brain, '个人模型')).length, 2, '_索引.md plus the new 近况 directory');
  assert.ok(fs.existsSync(path.join(brain, '从这里开始.md')));

  const again = initializeBrain({ mode: 'upgrade', targetDir: brain, templateRoot });
  assert.equal(again.status, 'nothing-to-do');
  assert.equal(again.created.length, 0);

  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'x');
  const rejected = initializeBrain({ mode: 'upgrade', targetDir: foreign, templateRoot });
  assert.equal(rejected.status, 'invalid');
  assert.match(rejected.reason, /^not-a-brain:/);
});
