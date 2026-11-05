import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A directory is treated as a Zhinao brain when at least one marker exists.
const BRAIN_MARKERS = ['AGENTS.md', '从这里开始.md', path.join('个人模型', '_索引.md')];

export function brainState(brainRoot) {
  if (!brainRoot || typeof brainRoot !== 'string') return { status: 'missing', brainRoot: brainRoot || '' };
  let stat;
  try { stat = fs.statSync(brainRoot); } catch { return { status: 'missing', brainRoot }; }
  if (!stat.isDirectory()) return { status: 'not-directory', brainRoot };
  const entries = fs.readdirSync(brainRoot);
  if (BRAIN_MARKERS.some((marker) => entries.includes(marker) || fs.existsSync(path.join(brainRoot, marker)))) {
    return { status: 'initialized', brainRoot };
  }
  const visible = entries.filter((name) => !name.startsWith('.'));
  if (visible.length === 0) return { status: 'empty', brainRoot };
  return { status: 'unrecognized', brainRoot, entries: visible.slice(0, 20) };
}

export function listTemplateFiles(templateRoot, relative = '') {
  const absolute = path.join(templateRoot, relative);
  const result = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...listTemplateFiles(templateRoot, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

function isSubPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Plan first, write nothing. Any conflict aborts the whole new-brain creation.
export function planInitialization({ mode, targetDir, templateRoot }) {
  if (!targetDir || typeof targetDir !== 'string' || !targetDir.trim()) {
    return { status: 'invalid', reason: 'empty-target' };
  }
  const resolved = path.resolve(targetDir.trim());
  if (path.parse(resolved).root === resolved) {
    return { status: 'invalid', reason: 'filesystem-root' };
  }
  if (mode === 'new') {
    let files;
    try { files = listTemplateFiles(templateRoot); }
    catch (error) { return { status: 'invalid', reason: `template-missing:${error.message}` }; }
    if (files.length === 0) return { status: 'invalid', reason: 'template-empty' };
    const conflicts = [];
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) return { status: 'invalid', reason: 'target-is-file' };
      for (const relative of files) {
        if (fs.existsSync(path.join(resolved, relative))) conflicts.push(relative);
      }
    }
    if (conflicts.length > 0) return { status: 'conflict', conflicts };
    return { status: 'ok', wouldCreate: files, targetDir: resolved };
  }
  if (mode === 'takeover') {
    const state = brainState(resolved);
    if (state.status !== 'initialized') return { status: 'invalid', reason: `not-a-brain:${state.status}`, targetDir: resolved };
    if (templateRoot && isSubPath(resolved, templateRoot)) return { status: 'invalid', reason: 'target-inside-template' };
    return { status: 'ok', targetDir: resolved };
  }
  if (mode === 'upgrade') {
    const state = brainState(resolved);
    if (state.status !== 'initialized') return { status: 'invalid', reason: `not-a-brain:${state.status}`, targetDir: resolved };
    let files;
    try { files = listTemplateFiles(templateRoot); }
    catch (error) { return { status: 'invalid', reason: `template-missing:${error.message}` }; }
    if (files.length === 0) return { status: 'invalid', reason: 'template-empty' };
    const missing = [];
    const skipped = [];
    for (const relative of files) {
      (fs.existsSync(path.join(resolved, relative)) ? skipped : missing).push(relative);
    }
    return { status: 'ok', targetDir: resolved, wouldCreate: missing, skipped };
  }
  return { status: 'invalid', reason: 'unknown-mode' };
}

export function initializeBrain({ mode, targetDir, templateRoot }) {
  const plan = planInitialization({ mode, targetDir, templateRoot });
  if (plan.status !== 'ok') return plan;
  if (mode === 'new') {
    const created = [];
    for (const relative of plan.wouldCreate) {
      const destination = path.join(plan.targetDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(templateRoot, relative), destination);
      created.push(relative);
    }
    return { status: 'initialized', mode, targetDir: plan.targetDir, created };
  }
  if (mode === 'upgrade') {
    const created = [];
    for (const relative of plan.wouldCreate) {
      const destination = path.join(plan.targetDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(templateRoot, relative), destination);
      created.push(relative);
    }
    return {
      status: created.length > 0 ? 'upgraded' : 'nothing-to-do',
      mode,
      targetDir: plan.targetDir,
      created,
      skipped: plan.skipped,
    };
  }
  // takeover: verify only, never modify existing files
  return { status: 'takeover-ready', mode, targetDir: plan.targetDir, created: [] };
}

export function defaultBrainDir() {
  return path.join(os.homedir(), '智脑');
}
