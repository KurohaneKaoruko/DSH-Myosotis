/**
 * 会话上下文：从 agent 句柄里读「这是哪个项目、哪个会话」。
 *
 * 单独一个模块是为了让记忆层与知识库层都能用，而不互相 import。
 *
 * @module dsh-myosotis/session
 */

import { normalizeCwd } from './paths.js';

/**
 * 从 agent 上读出记忆需要的上下文。
 * @param {any} agent DSH 的 Agent 句柄。
 * @returns {{ cwd: string, sessionId: string }} 上下文。
 */
export function contextOf(agent) {
  const header = agent?.session?.header ?? {};
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';
  const sessionId = String(header.id ?? agent?.id ?? '');
  return { cwd, sessionId };
}

/**
 * 项目键：规范化后的工作目录，空目录用空串（表示不绑定项目）。
 * @param {string} cwd 工作目录。
 * @returns {string} 项目键。
 */
export function projectKey(cwd) {
  return cwd ? normalizeCwd(cwd) : '';
}
