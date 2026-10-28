/**
 * 文本工具：分词、归一化、去重相似度、消息取文。
 *
 * 记忆检索不需要真正的 NLP，但必须对中文友好：
 * 中文按「连续汉字串 → 二元组」切，英文按单词切并做极轻量的词尾归并。
 * 这样「不要用 CommonJS」和「CommonJS 别用」能落到同一批 token 上。
 *
 * @module dsh-myosotis/text
 */

/** 中日韩文字（含扩展 A、假名、谚文）连续串。 */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
/** 单个可检索片段：要么一段 CJK，要么一个拉丁/数字词。 */
const TOKEN_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9][a-z0-9_+#.\-]*/gu;

/**
 * 高频虚词二元组。它们几乎出现在每条记忆里，带不来区分度，
 * 留着只会把「什么」「可以」这类词顶到检索结果前面。
 */
const STOPWORDS = new Set([
  '这个', '那个', '这些', '那些', '什么', '怎么', '可以', '我们', '你们', '他们',
  '就是', '不是', '还是', '因为', '所以', '但是', '然后', '如果', '已经', '没有',
  '一个', '一下', '这样', '那样', '现在', '时候', '自己', '东西', '问题', '地方',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were',
  'are', 'you', 'your', 'not', 'but', 'all', 'can', 'will', 'would', 'should',
]);

/**
 * 单字虚词。中文单字成词时噪声极大（「的」几乎出现在每条记忆里），
 * 只保留可能是实词的单字。
 */
const SINGLE_STOPWORDS = new Set('的了是在和与就都也还把被给让对从到为以及或而但很太更最不没有我你他她它们个这那上下中里外大小多少好要会能可吗呢吧啊呀哦嗯啦么之其所以'.split(''));

/**
 * 极轻量词尾归并。只处理英文里最常见的复数/进行时，
 * 目的是让 remembers / remembered / remembering 落到同一个词根。
 * @param {string} word 小写单词。
 * @returns {string} 词根。
 */
function stem(word) {
  if (word.length <= 3) return word;
  // 技术词里以 s 结尾但不表复数的：js / css / os / analysis…一律不动。
  if (/(?:js|ss|us|is|os)$/u.test(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * 把一段文本切成检索 token。
 * @param {string} text 任意文本。
 * @returns {string[]} token 列表（保留重复，调用方需要频次）。
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lower = text.toLowerCase();
  const out = [];
  for (const match of lower.matchAll(TOKEN_RUN)) {
    const run = match[0];
    if (/^[a-z0-9]/.test(run)) {
      const word = stem(run);
      if (!STOPWORDS.has(word)) out.push(word);
      continue;
    }
    if (run.length === 1) {
      if (!SINGLE_STOPWORDS.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) out.push(gram);
    }
  }
  return out;
}

/**
 * 去重用的归一化：去掉空白与标点、转小写。
 * @param {string} text 原文。
 * @returns {string} 归一化结果。
 */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 字符二元组集合（用于近似重复判定）。
 * @param {string} text 原文。
 * @returns {Set<string>} 二元组集合。
 */
export function bigramSet(text) {
  const normalized = normalizeText(text);
  const set = new Set();
  if (normalized.length <= 2) {
    if (normalized.length > 0) set.add(normalized);
    return set;
  }
  for (let i = 0; i < normalized.length - 1; i += 1) set.add(normalized.slice(i, i + 2));
  return set;
}

/**
 * Jaccard 相似度，用来判断两条记忆是不是在说同一件事。
 * @param {string} a 文本 A。
 * @param {string} b 文本 B。
 * @returns {number} 0..1。
 */
export function jaccard(a, b) {
  const left = bigramSet(a);
  const right = bigramSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 近似重复判定用的相似度。
 *
 * 纯 Jaccard 对「插入一个词」过于敏感：两条几乎相同的记忆只差一个「一律」，
 * Jaccard 就掉到 0.75。所以长度接近时取 Jaccard 与包含度（交集 / 较短者）的较大值；
 * 长度差太多时退回 Jaccard，避免短句被长文「吞掉」。
 * @param {string} a 文本 A。
 * @param {string} b 文本 B。
 * @returns {number} 0..1。
 */
export function similarity(a, b) {
  return similarityOf(bigramSet(a), bigramSet(b));
}

/**
 * 直接比较两个已算好的二元组集合。
 * 复盘要两两比较几十条记忆，每次都重算集合太浪费，所以把这一步拆出来。
 * @param {Set<string>} left 集合 A。
 * @param {Set<string>} right 集合 B。
 * @returns {number} 0..1。
 */
export function similarityOf(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  const jaccardScore = shared / union;
  const ratio = Math.min(left.size, right.size) / Math.max(left.size, right.size);
  if (ratio < 0.6) return jaccardScore;
  return Math.max(jaccardScore, shared / Math.min(left.size, right.size));
}

/**
 * 否定词：用来区分「要做 X」和「不要做 X」。
 *
 * 合并近似记忆时必须先看这个——「这个仓库用 pnpm」和「这个仓库不要用 pnpm」
 * 字面很像，合并之后意思正好反过来。
 */
const NEGATIVE = /(?:^|[^不])不(?:要|用|能|该|许|准)|别|禁止|避免|禁用|never|don'?t|avoid/iu;

/**
 * 文本里是否带否定。
 * @param {string} text 原文。
 * @returns {boolean} 是否含否定。
 */
export function hasNegation(text) {
  return NEGATIVE.test(String(text ?? ''));
}

/**
 * 截断到指定长度，超长补省略号。
 * @param {string} text 原文。
 * @param {number} limit 最大字符数。
 * @returns {string} 截断结果。
 */
export function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)) + '…';
}

/**
 * 取一条模型消息里的可见文本。
 * @param {unknown} message 消息对象（`content` 为字符串或内容块数组）。
 * @returns {string} 文本；没有文本时为空串。
 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = /** @type {{ content?: unknown }} */ (message).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * 从会话日志里倒着找最后一条用户消息。
 * @param {unknown} session 会话对象（读 `events`）。
 * @param {number} [scan=200] 最多回看的事件数。
 * @returns {string} 文本；找不到时为空串。
 */
export function lastUserText(session, scan = 200) {
  const events = /** @type {{ events?: unknown[] }} */ (session)?.events;
  if (!Array.isArray(events)) return '';
  const start = Math.max(0, events.length - scan);
  for (let i = events.length - 1; i >= start; i -= 1) {
    const event = events[i];
    if (event && event.type === 'user/message') {
      const text = messageText(event.data);
      if (text) return text;
    }
  }
  return '';
}

/**
 * 把长文本按句子切开，用于从一段话里挑出「要记住」的那一句。
 * @param {string} text 原文。
 * @returns {string[]} 句子列表。
 */
export function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;\n])/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 稳定哈希（FNV-1a 32 位），用于缓存键与目录名。
 * @param {string} input 输入。
 * @returns {string} 8 位十六进制。
 */
export function hash32(input) {
  let hash = 0x811c9dc5;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export { CJK_RUN };
