/**
 * B 站 MCP 的只读客户端工厂。
 *
 * 工具白名单在 **MCP 进程侧**用 BILI_MCP_TOOLS 强制（server 不认识的名字直接拒绝），
 * 不是靠提示词；写工具（bili_reply / bili_send_message）不在默认名单里。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp.js';
import { credentialFile, ensureServerScript, resolvePython, serverDir, venvPython } from './python.js';

export const READ_ONLY_TOOLS = Object.freeze([
  'bili_check_credential',
  'bili_search',
  'bili_comments',
  'bili_subtitle',
  'bili_danmaku',
  'bili_video_info',
  'bili_crawl',
  'bili_video_zones',
  'bili_hot_videos',
  'bili_hot_buzzwords',
  'bili_weekly_hot',
  'bili_rank',
  'bili_user_info',
  'bili_user_videos',
  'bili_followings',
  'bili_favorite_lists',
  'bili_favorite_content',
  'bili_unread_messages',
  'bili_received_replies',
  'bili_received_at_and_likes',
  'bili_cover',
  'bili_frames',
  'bili_recommend',
  'bili_transcribe',
  'bili_transcribe_start',
  'bili_transcribe_result',
]);

/** 写操作单独开一组：只有用户明确批准关注时才把 bili_follow 放进白名单。 */
export const FOLLOW_TOOLS = Object.freeze([...READ_ONLY_TOOLS, 'bili_follow']);

export function defaultVendorDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'bilibili-mcp');
}

export function resolveBiliRuntime({ dataDir, config = {}, vendorDir = defaultVendorDir() }) {
  const python = resolvePython({ configPath: config.pythonPath });
  if (!python.ok) {
    return { ok: false, reason: 'python-missing', python, vendorDir };
  }
  const script = ensureServerScript({ vendorDir, dataDir });
  if (!script.ok) {
    return { ok: false, reason: 'server-missing', python, vendorDir, script };
  }
  const venv = venvPython(dataDir);
  const command = fs.existsSync(venv) ? venv : python.command;
  return {
    ok: true,
    python,
    script: script.script,
    command,
    dir: serverDir(dataDir),
    credential: credentialFile(dataDir),
  };
}

export function createBiliClient({ dataDir, config = {}, vendorDir, tools = READ_ONLY_TOOLS, log }) {
  const runtime = resolveBiliRuntime({ dataDir, config, vendorDir });
  if (!runtime.ok) {
    throw new Error(runtime.reason === 'python-missing'
      ? `找不到可用的 Python：${runtime.python?.detail || '未安装'}`
      : `vendor 里的 mcp_server.py 缺失：${runtime.script?.reason || vendorDir}`);
  }
  const client = new McpClient({
    command: runtime.command,
    args: [runtime.script],
    cwd: runtime.dir,
    env: {
      BILI_MCP_TOOLS: tools.join(','),
      BILI_STYLE_OFF: '1',
      // Windows 上 Python 默认按 GBK 编解码；中文/emoji 进管道会乱码甚至卡死。
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
    log,
  });
  return { client, runtime };
}
