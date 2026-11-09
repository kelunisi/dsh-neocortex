/**
 * 极小的 MCP stdio 客户端。
 *
 * 协议只有三步：initialize → notifications/initialized → tools/call；
 * stdio 上一行一个 JSON-RPC。
 *
 * 改编自 dsh-bili-scroll（MIT, Copyright (c) 2026 c1overzz）的 lib/mcp.mjs，
 * 保留其"自己起 Python MCP、不依赖宿主 mcp-client"的做法；改动仅为通用化与注释。
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PKG = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')); } catch { return {}; }
})();

export class McpClient {
  constructor({ command, args = [], cwd, env, log = () => {} }) {
    this.cfg = { command, args, cwd, env, log };
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.starting = null;
  }

  get running() {
    return Boolean(this.proc);
  }

  async start() {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { command, args, cwd, env, log } = this.cfg;
      this.proc = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this.#onData(chunk));
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
      this.proc.on('error', (error) => log(`MCP 子进程启动失败：${error?.message ?? error}`));
      this.proc.on('exit', (code) => {
        log(`MCP 子进程退出（code=${code}）`);
        for (const [, pending] of this.pending) {
          pending.reject(new Error(`MCP 子进程退出（code=${code}）${this.stderr ? '：' + this.stderr.slice(-300) : ''}`));
        }
        this.pending.clear();
        this.proc = null;
      });
      await this.#request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: PKG.name || 'dsh-neocortex', version: PKG.version || '0.0.0' },
      });
      this.#notify('notifications/initialized', {});
      log('MCP 已就绪');
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  stop() {
    try { this.proc?.kill(); } catch { /* already gone */ }
    this.proc = null;
  }

  /** Call one MCP tool; JSON parse the text block when possible. */
  async call(name, args = {}, opts = {}) {
    return (await this.callRaw(name, args, opts)).json;
  }

  /** Same as call but keeps image blocks: { json, images: [{data, mimeType}] }. */
  async callRaw(name, args = {}, { timeoutMs = 180000, signal } = {}) {
    await this.start();
    const result = await this.#request('tools/call', { name, arguments: args }, timeoutMs, signal);
    const blocks = result?.content ?? [];
    const text = blocks.map((block) => block?.text ?? '').filter(Boolean).join('\n').trim();
    if (result?.isError) throw new Error(text || `MCP 工具 ${name} 报错`);
    const images = blocks
      .filter((block) => block?.type === 'image' && block?.data)
      .map((block) => ({ data: block.data, mimeType: block.mimeType || block.mime_type || 'image/jpeg' }));
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
    return { json, images };
  }

  #onData(chunk) {
    this.buf += chunk;
    let index;
    while ((index = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, index).trim();
      this.buf = this.buf.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; } // non-JSON log lines are ignored
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error?.message ? String(message.error.message) : JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
  }

  #send(object) {
    if (!this.proc?.stdin?.writable) throw new Error('MCP 子进程不在运行');
    this.proc.stdin.write(JSON.stringify(object) + '\n');
  }

  #notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #request(method, params, timeoutMs = 60000, signal) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`MCP ${method} 已取消`));
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`MCP ${method} 已取消`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）${this.stderr ? '：' + this.stderr.slice(-200) : ''}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try { this.#send({ jsonrpc: '2.0', id, method, params }); } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

export function modulePath() {
  return fileURLToPath(import.meta.url);
}
