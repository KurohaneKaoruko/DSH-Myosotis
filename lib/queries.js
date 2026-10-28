/**
 * 最近一次用户输入的追踪。
 *
 * 注入是「按当前这轮的话题重排」，所以要能在渲染时拿到用户刚说的话。
 * 会话事件里也能倒查（`lastUserText`），但那是兜底：入站事件更及时、更准。
 *
 * 记忆与知识库共用同一份追踪，避免两套状态漂移。
 *
 * @module dsh-myosotis/queries
 */

import { truncate } from './text.js';

/**
 * 查询追踪器。
 */
export class QueryTracker {
  /**
   * @param {number} [limit=64] 最多同时跟踪多少个 agent。
   */
  constructor(limit = 64) {
    this.limit = limit;
    /** @type {Map<string, { text: string, at: number }>} */
    this.map = new Map();
  }

  /**
   * 记下某个 agent 最近一次用户输入。
   * @param {string} agentId Agent id。
   * @param {string} text 文本。
   */
  note(agentId, text) {
    const key = String(agentId ?? '');
    if (!key) return;
    const value = truncate(text, 2000);
    if (!value) return;
    this.map.set(key, { text: value, at: Date.now() });
    if (this.map.size <= this.limit) return;
    // 超出上限时丢掉最久没更新的一条。
    let oldestKey = '';
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidate, entry] of this.map) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = candidate;
      }
    }
    if (oldestKey) this.map.delete(oldestKey);
  }

  /**
   * 某个 agent 最近一次的用户输入。
   * @param {string} agentId Agent id。
   * @returns {string} 文本；没有时为空串。
   */
  last(agentId) {
    return this.map.get(String(agentId ?? ''))?.text ?? '';
  }
}
