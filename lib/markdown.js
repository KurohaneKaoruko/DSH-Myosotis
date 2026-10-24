/**
 * 人类可读镜像。
 *
 * JSON 是唯一真相，Markdown 只是给人看（以及给 git 看 diff）的投影。
 * 每次写入后重新生成，所以手改会在下一次写入时被覆盖——这一点写在文件头里。
 *
 * @module dsh-myosotis/markdown
 */

import { KIND_LABELS } from './store.js';

/**
 * 格式化时间。
 * @param {number} timestamp 毫秒时间戳。
 * @returns {string} `YYYY-MM-DD HH:mm`。
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 渲染一个作用域的 Markdown 镜像。
 * @param {object} options 选项。
 * @param {'global'|'project'|'session'} options.scope 作用域。
 * @param {string} [options.cwd=''] 项目目录（project 作用域使用）。
 * @param {Record<string, any>[]} options.items 记忆条目。
 * @param {number} [options.now=Date.now()] 生成时间。
 * @returns {string} Markdown 文本。
 */
export function renderMarkdown({ scope, cwd = '', items, now = Date.now() }) {
  const title = scope === 'global' ? '全局记忆' : scope === 'project' ? `项目记忆${cwd ? ` · ${cwd}` : ''}` : '会话记忆';
  const lines = [
    `# ${title}`,
    '',
    '> 由 dsh-myosotis 自动生成，是 JSON 的只读投影；手改会在下一次写入时被覆盖。',
    '> 要增删改，请让 Agent 用 `memory_save` / `memory_forget`，或运行 `node tools/memory.mjs`。',
    '',
    `最后更新：${formatTime(now)} · 共 ${items.length} 条`,
    '',
  ];

  const groups = new Map();
  for (const item of items) {
    const kind = KIND_LABELS[item.kind] ? item.kind : 'fact';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(item);
  }

  const order = ['profile', 'bond', 'preference', 'habit', 'convention', 'decision', 'gotcha', 'fact', 'episode'];
  for (const kind of order) {
    const group = groups.get(kind);
    if (!group || group.length === 0) continue;
    group.sort((a, b) => Number(b.importance ?? 3) - Number(a.importance ?? 3) || Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    lines.push(`## ${KIND_LABELS[kind]}`, '');
    for (const item of group) {
      const star = item.pinned ? ' ★' : '';
      const mood = item.affect?.label ? ` ♥${item.affect.label}${item.affect.intensity ?? ''}` : '';
      const date = item.date ? `（每年 ${item.date}）` : '';
      lines.push(`- ${item.text}${date}${star}${mood} <!-- ${item.id} -->`);
    }
    lines.push('');
  }

  if (items.length === 0) lines.push('（还没有记忆）', '');
  return lines.join('\n');
}
