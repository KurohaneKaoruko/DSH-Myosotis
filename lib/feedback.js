/**
 * 反馈信号：从用户的一句话里判断「上一轮回答被纠正了」还是「被确认了」。
 *
 * 这是整套「持续学习」的输入。没有它，记忆只会越攒越多、永远正确；
 * 有了它，一条记错的偏好会被标出来，模型下次看到就有机会改。
 *
 * 刻意做得**很保守**：
 * - 只认短消息（≤ 200 字）。长消息多半是在讨论问题，里面的「不对」不一定指向上一轮。
 * - 问句一律不认。「不是这样吗？」是在问，不是在纠正。
 * - 只认句首或明确的第二人称说法（「你说错了」）。「这个方案不对」不认——
 *   它说的是方案，不是你说的那句话。
 *
 * 宁可漏：少标一条，代价是那条记忆没被提醒；
 * 错标一条，代价是模型去改一条本来正确的记忆。
 *
 * @module dsh-myosotis/feedback
 */

/** 句首纠正。`对` 要排除「对于 / 对比 / 对应」这类介词开头。 */
const CORRECTION_HEAD = /^(?:不对|不是这样|不是吧|错了|错啦|搞错|记错|我说过|我说的是|应该是|改成|别用|不要用|你搞错)/u;

/** 句中纠正：必须明确指向「你」，否则可能只是在评价方案。 */
const CORRECTION_INLINE = /(?:你(?:说|记|写|搞)错|你记错|记错了|你搞错了)/u;

/** 句首确认。`对` 后面不能跟介词或「比 / 应 / 象」。 */
const CONFIRMATION_HEAD = /^(?:对(?!于|比|应|象|照)|是的|没错|就是这样|正是|很好|完美|可以继续|就这样)/u;

/** 句中确认。 */
const CONFIRMATION_INLINE = /(?:就是这样|正是如此|完全正确|说得对)/u;

/** 问句：以问号结尾，或句中出现「吗 / 呢 / ？」。 */
const QUESTION = /[?？]\s*$/u;

/** 太长的消息不当成单纯反馈。 */
const MAX_LENGTH = 200;

/**
 * 判断一条用户消息是纠正、确认，还是都不是。
 * @param {string} text 用户消息全文。
 * @returns {{ type: 'correction'|'confirmation' } | null} 结果；不是反馈时 null。
 */
export function detectFeedback(text) {
  const body = String(text ?? '').trim();
  if (!body || body.length > MAX_LENGTH) return null;
  if (QUESTION.test(body)) return null;

  if (CORRECTION_HEAD.test(body) || CORRECTION_INLINE.test(body)) return { type: 'correction' };
  if (CONFIRMATION_HEAD.test(body) || CONFIRMATION_INLINE.test(body)) return { type: 'confirmation' };
  return null;
}

/**
 * 判断一条记忆是否「被纠正得比被确认多」——复盘时优先列出来。
 * @param {Record<string, any>} item 记忆。
 * @returns {boolean} 是否可疑。
 */
export function isSuspect(item) {
  const corrections = Number(item?.corrections ?? 0);
  const confirmed = Number(item?.confirmed ?? 0);
  return corrections > 0 && corrections >= confirmed;
}
