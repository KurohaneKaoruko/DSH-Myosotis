/**
 * 人类可读镜像。
 *
 * JSON 是唯一真相，Markdown 只是给人看（以及给 git 看 diff）的投影。
 * 每次写入后重新生成，所以手改会在下一次写入时被覆盖——这一点写在文件头里。
 *
 * @module dsh-myosotis/markdown
 */

import { isSuspect } from './feedback.js';
import { KIND_LABELS } from './store.js';

/** 「最近学到的」看多少天。 */
const RECENT_DAYS = 7;

/** 哪些类型算「经验」——它们才是学到的，不是顺手记的事实。 */
const LEARNED_KINDS = new Set(['convention', 'gotcha', 'playbook', 'decision', 'preference']);

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

  // 先说「最近学到了什么」和「哪些该复核」：这两节是长出来的，
  // 下面的分类列表是存量。看文件的人通常关心前者。
  const fresh = items
    .filter((item) => Number(item.createdAt ?? 0) >= now - RECENT_DAYS * 86400000 && LEARNED_KINDS.has(item.kind))
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
    .slice(0, 8);
  if (fresh.length > 0) {
    lines.push(`## 最近学到的（${RECENT_DAYS} 天）`, '');
    for (const item of fresh) lines.push(`- [${KIND_LABELS[item.kind]}] ${item.text} <!-- ${item.id} -->`);
    lines.push('');
  }

  const suspect = items.filter((item) => isSuspect(item));
  if (suspect.length > 0) {
    lines.push('## 待复核', '', '> 这些被用户纠正过。让 Agent 跑一次 `memory_review`，或直接改写。', '');
    for (const item of suspect) {
      lines.push(`- [${KIND_LABELS[item.kind] ?? item.kind}] ${item.text}（纠正 ${item.corrections} / 确认 ${item.confirmed ?? 0}） <!-- ${item.id} -->`);
    }
    lines.push('');
  }

  const order = ['profile', 'bond', 'preference', 'habit', 'convention', 'decision', 'gotcha', 'playbook', 'fact', 'episode'];
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

/**
 * 渲染知识库索引。
 *
 * 知识库的正文在 SQLite 里，不适合做镜像；但「这个项目索引了哪些文档」
 * 值得让人一眼看到——它就是一张目录，不复制原文。
 * @param {object} options 选项。
 * @param {string} [options.cwd=''] 项目目录。
 * @param {Record<string, any>[]} [options.docs=[]] 文档列表。
 * @param {number} [options.now=Date.now()] 生成时间。
 * @returns {string} Markdown 文本。
 */
export function renderKnowledgeIndex({ cwd = '', docs = [], now = Date.now() }) {
  const list = Array.isArray(docs) ? [...docs] : [];
  list.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  const lines = [
    `# 知识库索引${cwd ? ` · ${cwd}` : ''}`,
    '',
    '> 由 dsh-myosotis 自动生成，是 `knowledge.db` 的只读投影；手改会在下一次入库时被覆盖。',
    '> 要增删，请让 Agent 用 `kb_add` / `kb_remove`，或运行 `node tools/kb.mjs`。',
    '',
    `最后更新：${formatTime(now)} · 共 ${list.length} 篇`,
    '',
  ];

  if (list.length === 0) {
    lines.push('（还没有索引任何文档）', '');
    return lines.join('\n');
  }

  lines.push('| 文档 | 标题 | 块数 | 大小 | 更新 |', '| --- | --- | ---: | ---: | --- |');
  for (const doc of list) {
    const name = String(doc.rel || doc.path || '').replace(/\|/gu, '\\|');
    const title = String(doc.title ?? '').replace(/\|/gu, '\\|');
    const size = Number(doc.bytes ?? 0) < 1024 ? `${doc.bytes ?? 0} B` : `${(Number(doc.bytes ?? 0) / 1024).toFixed(1)} KB`;
    lines.push(`| \`${name}\` | ${title} | ${doc.chunks ?? 0} | ${size} | ${formatTime(Number(doc.updatedAt ?? now)).slice(0, 10)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
