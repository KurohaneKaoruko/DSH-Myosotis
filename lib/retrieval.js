/**
 * 记忆检索：在「不调用模型」的前提下，把最该被想起来的那几条挑出来。
 *
 * 分数由六部分组成：
 *   lexical    词法相关性（IDF 加权，标签 > 标题 > 正文）
 *   importance 用户/模型标注的重要度
 *   recency    新近度（半衰期 45 天）
 *   usage      被想起过的次数（对数饱和）
 *   pinned     置顶加分（但不足以压过明确的词法命中）
 *   affect     情绪强度
 *
 * 这不是语义检索，是「够用的词法检索 + 人为权重」。
 * 好处是零依赖、毫秒级、完全可预测——记忆注入在每一轮对话的请求路径上，
 * 不能有网络调用，也不该有不确定性。
 *
 * IDF 必须在**整个候选池**上算，不能分作用域各算各的：
 * 否则只有一条记忆的项目库会把每个词都当成稀有词，分数和全局库不可比。
 *
 * @module dsh-myosotis/retrieval
 */

import { tokenize } from './text.js';

/** 命中标签的权重倍数。 */
const TAG_WEIGHT = 3;
/** 命中标题的权重倍数。 */
const TITLE_WEIGHT = 2;
/** 正文权重。 */
const BODY_WEIGHT = 1;
/** 新近度半衰期（天）。 */
const HALF_LIFE_DAYS = 45;

/**
 * 给一组带作用域的记忆打分。
 * @param {{ scope: string, item: Record<string, any> }[]} entries 候选记忆。
 * @param {string} query 当前用户输入。
 * @param {number} [now=Date.now()] 当前时间。
 * @returns {{ scope: string, item: Record<string, any>, score: number, lexical: number }[]} 按分数降序。
 */
export function rankScoped(entries, query, now = Date.now()) {
  const queryTokens = [...new Set(tokenize(query))];
  const docs = entries.map((entry) => {
    const body = new Set(tokenize(entry.item.text));
    const title = new Set(tokenize(entry.item.title ?? ''));
    const tags = new Set((entry.item.tags ?? []).flatMap((tag) => tokenize(String(tag))));
    return { scope: entry.scope, item: entry.item, body, title, tags };
  });

  // 文档频次：一个词在越多条记忆里出现，区分度越低。
  const df = new Map();
  for (const doc of docs) {
    const seen = new Set([...doc.body, ...doc.title, ...doc.tags]);
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, docs.length);
  const idf = (token) => Math.log(1 + (total - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));

  const scored = docs.map((doc) => {
    let lexical = 0;
    for (const token of queryTokens) {
      const weight = doc.tags.has(token) ? TAG_WEIGHT : doc.title.has(token) ? TITLE_WEIGHT : doc.body.has(token) ? BODY_WEIGHT : 0;
      if (weight > 0) lexical += idf(token) * weight;
    }
    // 按查询长度归一，避免长问题天然占优。
    if (queryTokens.length > 0) lexical /= Math.sqrt(queryTokens.length);

    const ageDays = Math.max(0, now - Number(doc.item.updatedAt ?? now)) / 86400000;
    const recency = Math.exp(-ageDays / HALF_LIFE_DAYS);
    const hits = Math.min(1, Math.log1p(Number(doc.item.hits ?? 0)) / Math.log(20));
    const affect = Number(doc.item.affect?.intensity ?? 0) / 5;

    const score =
      lexical * 2.4 +
      (Number(doc.item.importance ?? 3) / 5) * 0.7 +
      recency * 0.3 +
      hits * 0.2 +
      (doc.item.pinned ? 0.45 : 0) +
      affect * 0.15;

    return { scope: doc.scope, item: doc.item, score, lexical };
  });

  scored.sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));
  return scored;
}

/**
 * 给一组记忆打分（不带作用域）。
 * @param {Record<string, any>[]} items 候选记忆。
 * @param {string} query 当前用户输入。
 * @param {number} [now=Date.now()] 当前时间。
 * @returns {{ item: Record<string, any>, score: number, lexical: number }[]} 按分数降序。
 */
export function rank(items, query, now = Date.now()) {
  return rankScoped(
    items.map((item) => ({ scope: '', item })),
    query,
    now,
  ).map(({ item, score, lexical }) => ({ item, score, lexical }));
}

/**
 * 在字符预算内挑出要注入的记忆。
 *
 * 规则：
 * 1. 置顶 / 身份 / 关系类永远优先（它们回答的是「这个人是谁、我们是什么关系」）。
 * 2. 其余按分数排，直到预算用尽。
 * 3. 每个作用域至少保留一条（如果有），否则新项目第一次对话会什么都看不到。
 *
 * @param {{ scope: string, items: Record<string, any>[] }[]} groups 按作用域分组的候选。
 * @param {object} options 选项。
 * @param {string} [options.query=''] 当前用户输入。
 * @param {number} [options.budgetChars=2400] 总字符预算。
 * @param {number} [options.now] 当前时间。
 * @param {number} [options.alwaysCap=8] 置顶/身份类最多条数。
 * @returns {{ picked: { scope: string, item: Record<string, any> }[], dropped: number, used: number }} 结果。
 */
export function select(groups, { query = '', budgetChars = 2400, now = Date.now(), alwaysCap = 8 } = {}) {
  /** @type {{ scope: string, item: Record<string, any> }[]} */
  const entries = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.items)) continue;
    for (const item of group.items) entries.push({ scope: group.scope, item });
  }
  if (entries.length === 0) return { picked: [], dropped: 0, used: 0 };

  const ranked = rankScoped(entries, query, now);
  const alwaysList = ranked
    .filter((entry) => entry.item.pinned || entry.item.kind === 'profile' || entry.item.kind === 'bond')
    .sort((a, b) => b.score - a.score || Number(b.item.importance ?? 3) - Number(a.item.importance ?? 3))
    .slice(0, alwaysCap);
  const alwaysIds = new Set(alwaysList.map((entry) => `${entry.scope}:${entry.item.id}`));
  const rest = ranked.filter((entry) => !alwaysIds.has(`${entry.scope}:${entry.item.id}`));

  const ordered = [...alwaysList, ...rest];
  /** @type {{ scope: string, item: Record<string, any>, score: number }[]} */
  const selected = [];
  const usedByScope = new Map();
  let used = 0;

  // 先按「置顶/身份/关系优先」的顺序做预算分配，保证它们不被挤掉；
  // 展示顺序最后再按分数重排——保证的是入选，不是排在最前面。
  for (const entry of ordered) {
    const cost = String(entry.item.text ?? '').length + 8; // 8 ≈ 前缀标记与换行
    const scopeCount = usedByScope.get(entry.scope) ?? 0;
    // 预算用尽时，仍允许每个作用域补第一条，保证三层都有存在感。
    const allowance = scopeCount === 0 ? cost : 0;
    if (used + cost > budgetChars && !(scopeCount === 0 && used + allowance <= budgetChars + 200)) continue;
    selected.push({ scope: entry.scope, item: entry.item, score: entry.score });
    usedByScope.set(entry.scope, scopeCount + 1);
    used += cost;
  }

  selected.sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));
  return { picked: selected.map(({ scope, item }) => ({ scope, item })), dropped: entries.length - selected.length, used };
}
