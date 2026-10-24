/**
 * 自动捕获：不调用模型，靠确定性规则把「明确要求记住的话」捡出来。
 *
 * 这里刻意只做**高置信度**的捕获：
 * - 宁可漏，不可错。记错一条偏好，比少记十条更伤。
 * - 捕获落在 session 作用域（会过期），再由模型判断要不要提升到
 *   project / global——规则负责发现，判断留给模型。
 *
 * @module dsh-myosotis/capture
 */

import { sentences, truncate } from './text.js';

/**
 * 触发规则。顺序有意义：越靠前越具体。
 * @type {{ re: RegExp, kind: string, importance: number }[]}
 */
const RULES = [
  { re: /(以后都|以后别|以后不要|以后只用|从现在开始|from now on|going forward)/iu, kind: 'convention', importance: 5 },
  { re: /(不要再|别再|千万别|绝对不要|再也不要|never ever|don'?t ever|stop using)/iu, kind: 'gotcha', importance: 5 },
  { re: /(我们约定|说好了|约定好|we agreed|let'?s agree)/iu, kind: 'convention', importance: 4 },
  { re: /(我讨厌|我不喜欢|我受不了|i hate|i can'?t stand)/iu, kind: 'preference', importance: 4 },
  { re: /(我喜欢|我偏好|我更喜欢|我习惯|i prefer|i like|i usually)/iu, kind: 'preference', importance: 4 },
  { re: /(记住|记一下|记下|别忘了|请记得|remember (?:that|this)|keep in mind)/iu, kind: 'fact', importance: 4 },
];

/** 这些说法只是在问「你记得吗」，不是在要求记住。 */
const NOT_A_COMMAND = /(你(还)?记得|记得吗|还记得|do you remember|did you remember)/iu;

/** 明显是元讨论（在聊记忆机制本身），不捕获。 */
const META_TALK = /(记忆插件|memory plugin|记忆系统|memory system)/iu;

/**
 * 判断一句话是不是「要求记住」的指令。
 * @param {string} text 用户消息全文。
 * @returns {{ text: string, kind: string, importance: number } | null} 命中时返回要保存的句子。
 */
export function detectMemoryIntent(text) {
  const body = String(text ?? '').trim();
  if (body.length < 4 || body.length > 4000) return null;
  if (NOT_A_COMMAND.test(body)) return null;
  if (META_TALK.test(body) && body.length > 400) return null;

  for (const rule of RULES) {
    const match = rule.re.exec(body);
    if (!match) continue;
    const sentence = pickSentence(body, match.index);
    if (!sentence || sentence.length < 4) continue;
    return { text: truncate(sentence, 200), kind: rule.kind, importance: rule.importance };
  }
  return null;
}

/**
 * 取出命中位置所在的那一句；整段没有句读时退回整段（截断）。
 * @param {string} body 全文。
 * @param {number} index 命中位置。
 * @returns {string} 句子。
 */
function pickSentence(body, index) {
  let cursor = 0;
  for (const sentence of sentences(body)) {
    const start = body.indexOf(sentence, cursor);
    const end = start + sentence.length;
    if (index >= start && index < end) return sentence.replace(/^[-*\s]+/, '').trim();
    cursor = end;
  }
  return truncate(body, 160);
}

/**
 * 生成一条「这一轮做了什么」的流水记录（日记模式用）。
 * @param {object} input 输入。
 * @param {string} [input.query] 用户这一轮说的话。
 * @param {string[]} [input.tools] 调用过的工具名。
 * @param {string[]} [input.files] 碰过的文件。
 * @returns {string} 一句话。
 */
export function episodeText({ query = '', tools = [], files = [] }) {
  const parts = [];
  const said = truncate(query.replace(/\s+/g, ' '), 60);
  if (said) parts.push(`处理「${said}」`);
  const toolList = [...new Set(tools)].filter(Boolean).slice(0, 4);
  if (toolList.length > 0) parts.push(`用了 ${toolList.join('/')}`);
  const fileList = [...new Set(files)].filter(Boolean).slice(0, 3);
  if (fileList.length > 0) parts.push(`改了 ${fileList.join('、')}`);
  if (parts.length === 0) return '';
  return truncate(parts.join('，'), 200);
}
