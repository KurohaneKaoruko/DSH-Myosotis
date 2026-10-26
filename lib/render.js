/**
 * 把选中的记忆渲染成注入用的文本块。
 *
 * 三条硬规则：
 * 1. **短**。这段文本每轮都要进上下文，长度直接等于成本。
 * 2. **像常识，不像报告**。用陈述句，不写「用户说」「根据记忆」。
 * 3. **可忽略**。它必须在模型眼里是「背景资料」而不是「新指令」，
 *    所以标题里明确写着这是自动注入的长期记忆。
 *
 * @module dsh-myosotis/render
 */

import { KIND_LABELS } from './store.js';
import { truncate } from './text.js';

/** 各作用域的标题。 */
const SCOPE_TITLES = {
  global: '关于用户',
  project: '本项目',
  session: '本次会话',
};

/**
 * 渲染单条记忆。
 * @param {Record<string, any>} item 记忆。
 * @returns {string} 形如 `- [偏好] 用户偏好 ESM。★`。
 */
export function renderItem(item) {
  const label = KIND_LABELS[item.kind] ?? item.kind ?? '事实';
  const mood = item.affect?.label ? `·${item.affect.label}` : '';
  const star = item.pinned ? '★' : '';
  const date = item.date ? `（每年 ${item.date}）` : '';
  const text = truncate(item.text, 240);
  return `- [${label}${mood}] ${text}${date}${star}`;
}

/**
 * 渲染完整的注入块。
 * @param {object} options 选项。
 * @param {{ scope: string, item: Record<string, any> }[]} options.picked 选中的记忆。
 * @param {number} [options.dropped=0] 因预算未展开的条数。
 * @param {string} [options.projectLabel=''] 项目显示名（通常是目录名）。
 * @param {Record<string, any>[]} [options.deep=[]] 从深记忆里捞出来的相关往事。
 * @returns {string} 注入文本；没有内容时为空串。
 */
export function renderRecall({ picked, dropped = 0, projectLabel = '', deep = [] }) {
  const curated = Array.isArray(picked) ? picked : [];
  const memories = Array.isArray(deep) ? deep : [];
  if (curated.length === 0 && memories.length === 0) return '';

  const groups = new Map();
  for (const entry of curated) {
    if (!groups.has(entry.scope)) groups.set(entry.scope, []);
    groups.get(entry.scope).push(entry.item);
  }

  const lines = ['## 长期记忆', '以下是自动注入的既有记忆，作为背景使用；不要向用户复述它们的存在。'];
  for (const scope of ['global', 'project', 'session']) {
    const items = groups.get(scope);
    if (!items || items.length === 0) continue;
    const title = scope === 'project' && projectLabel ? `本项目 · ${projectLabel}` : SCOPE_TITLES[scope];
    lines.push('', `### ${title}`);
    for (const item of items) lines.push(renderItem(item));
  }
  if (memories.length > 0) {
    lines.push('', '### 相关往事');
    for (const item of memories) lines.push(renderDeepItem(item));
  }
  if (dropped > 0) {
    lines.push('', `（另有 ${dropped} 条未展开；需要时用 memory_search 检索。）`);
  }
  return lines.join('\n');
}

/**
 * 渲染一条深记忆。比精选层更短：它只是「提示存在这么一条」，
 * 细节由模型按需 memory_search 取。
 * @param {Record<string, any>} item 记忆。
 * @returns {string} 形如 `- 2026-10-24 · [经历] 一起改检索…`。
 */
export function renderDeepItem(item) {
  const label = KIND_LABELS[item.kind] ?? item.kind ?? '事实';
  const date = formatDay(item.updatedAt ?? item.createdAt);
  return `- ${date} · [${label}] ${truncate(item.text, 120)}`;
}

/**
 * 时间戳 → `YYYY-MM-DD`。
 * @param {number} timestamp 毫秒时间戳。
 * @returns {string} 日期；非法值返回空串。
 */
function formatDay(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 记忆系统的行为准则：告诉模型什么时候写、怎么写、怎么用。
 * 这段是静态文本，只在插件启用时注册一次。
 * @returns {string} 提示词段落。
 */
export function policyText() {
  return [
    '## 记忆（Myosotis）',
    '你有四层持久记忆，用工具维护：',
    '- **global**：跨项目的用户偏好、习惯、身份、你们之间的共同经历与关系。',
    '- **project**：当前工作目录的技术栈、约定、决策、坑；跟着仓库走。',
    '- **session**：本次对话的临时线索，会过期。',
    '- **deep**：SQLite 归档层。不占每轮上下文，只能靠 memory_search 捞——整段复盘、历史细节、长记录放这里。',
    '',
    '**什么时候写**',
    '- 用户说「记住 / 以后都 / 不要再 / 我习惯 / 我们约定」时，立刻调用 memory_save，不要只在回复里答应。',
    '- 发现一条不写下来下次还会踩的坑、一个非显然的决策、一条用户没说出口但反复体现的偏好时，主动写。',
    '- 一个阶段性任务收尾、或与用户有一次值得留存的交流后，写一条 kind=episode（做了什么、结果、他的反应）；有情绪重量时带 affect。',
    '- 不写：能从代码或文档直接读到的事实、一次性的临时状态、对话原文的复述。',
    '',
    '**怎么写**',
    '- 一条一个事实，20–80 字，陈述句，不要「用户说」这种转述外壳。',
    '- 带上适用条件或理由：为什么重要、在什么情况下成立。',
    '- importance：5 = 违反会出事或核心偏好；3 = 有用；1 = 闲聊。',
    '',
    '**怎么用**',
    '记忆会自动出现在上下文里。直接把记得的事当常识用，不要说「根据我的记忆」；不确定时先 memory_search，不要猜。查过去做过什么、当时怎么决定的，先搜 deep。',
  ].join('\n');
}
