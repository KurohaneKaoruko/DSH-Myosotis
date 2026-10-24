/**
 * 路径解析：记忆文件落在哪里。
 *
 * 约定：
 * - 全局记忆跟 DSH 走：`<DSH_HOME>/memory/`（默认 `~/.dsh/memory/`）。
 * - 项目记忆跟仓库走：`<cwd>/.dsh/memory/`，可以直接提交进 git，团队共享。
 * - 会话记忆不污染仓库：`<DSH_HOME>/memory/sessions/<sessionId>.json`。
 * - 工作目录不可写时，项目记忆回退到 `<DSH_HOME>/memory/projects/<hash>.json`。
 *
 * @module dsh-myosotis/paths
 */

import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { hash32 } from './text.js';

/**
 * DSH 主目录。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() ? resolve(fromEnv) : join(homedir(), '.dsh');
}

/**
 * 全局记忆目录。
 * @param {string} [configured=''] 配置项；绝对路径直接使用，相对路径相对 DSH_HOME。
 * @returns {string} 绝对路径。
 */
export function globalDir(configured = '') {
  const value = String(configured ?? '').trim();
  if (!value) return join(dshHome(), 'memory');
  return isAbsolute(value) ? resolve(value) : join(dshHome(), value);
}

/**
 * 项目记忆目录。
 * @param {string} cwd 工作目录。
 * @param {string} [configured='.dsh/memory'] 配置项（相对 cwd）。
 * @returns {string} 绝对路径。
 */
export function projectDir(cwd, configured = '.dsh/memory') {
  const value = String(configured ?? '').trim() || '.dsh/memory';
  return isAbsolute(value) ? resolve(value) : join(cwd, value);
}

/**
 * 会话记忆文件。
 * @param {string} root 全局记忆目录。
 * @param {string} sessionId 会话 id。
 * @returns {string} 绝对路径。
 */
export function sessionFile(root, sessionId) {
  return join(root, 'sessions', `${safeName(sessionId)}.json`);
}

/**
 * 项目目录不可写时的回退文件。
 * @param {string} root 全局记忆目录。
 * @param {string} cwd 工作目录。
 * @returns {string} 绝对路径。
 */
export function projectFallbackFile(root, cwd) {
  return join(root, 'projects', `${hash32(normalizeCwd(cwd))}.json`);
}

/**
 * 项目展示名。
 * @param {string} cwd 工作目录。
 * @returns {string} 目录名。
 */
export function projectLabel(cwd) {
  if (!cwd) return '';
  const name = basename(cwd.replace(/[\\/]+$/, ''));
  return name || cwd;
}

/**
 * 规范化工作目录，用于比较与哈希：统一分隔符、Windows 下转小写。
 * @param {string} cwd 工作目录。
 * @returns {string} 规范化结果。
 */
export function normalizeCwd(cwd) {
  const value = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * 文件名安全化。
 * @param {string} value 原始 id。
 * @returns {string} 只含 `[A-Za-z0-9._-]` 的名字。
 */
export function safeName(value) {
  const name = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return name.slice(0, 96) || 'unnamed';
}
