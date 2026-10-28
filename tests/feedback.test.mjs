/**
 * 反馈信号单测。
 *
 * 这一层是「持续学习」的输入端，误判的代价比漏判大：
 * 错标一条，模型会去改一条本来正确的记忆。所以用例里一半是「不该触发」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectFeedback, isSuspect } from '../lib/feedback.js';

test('纠正：句首「不对 / 错了 / 记错了」', () => {
  for (const text of ['不对，提交信息要用英文', '错了，这个仓库用的是 pnpm', '记错了，我不叫这个名字', '不是这样，应该先跑测试']) {
    assert.deepEqual(detectFeedback(text), { type: 'correction' }, text);
  }
});

test('纠正：句中出现「你说错 / 记错了」也算', () => {
  assert.equal(detectFeedback('你记错了，我用的是 pnpm')?.type, 'correction');
  assert.equal(detectFeedback('这里你搞错了')?.type, 'correction');
});

test('确认：「对 / 就是这样 / 没错」', () => {
  for (const text of ['对', '对，就这样', '是的，就是这个意思', '没错', '就是这样', '完美，继续']) {
    assert.deepEqual(detectFeedback(text), { type: 'confirmation' }, text);
  }
});

test('确认：句中的「就是这样 / 说得对」', () => {
  assert.equal(detectFeedback('嗯，就是这样')?.type, 'confirmation');
  assert.equal(detectFeedback('这次说得对')?.type, 'confirmation');
});

test('不误判：以「对于 / 对比 / 对应」开头的不是确认', () => {
  assert.equal(detectFeedback('对于这个问题，我倾向于先做检索'), null);
  assert.equal(detectFeedback('对比一下两个方案的代价'), null);
  assert.equal(detectFeedback('对应到代码里是哪一段'), null);
});

test('不误判：问句不触发', () => {
  assert.equal(detectFeedback('不是这样吗？'), null);
  assert.equal(detectFeedback('这样对不对？'), null);
  assert.equal(detectFeedback('你说的对吗?'), null);
});

test('不误判：长消息不当成单纯反馈', () => {
  const long = `不对，但我想说的其实是另一个问题：${'这段设计我看了半天还是觉得有问题。'.repeat(12)}`;
  assert.ok(long.length > 200);
  assert.equal(detectFeedback(long), null);
});

test('不误判：评价方案而不是评价我说的话', () => {
  assert.equal(detectFeedback('这个方案不对'), null);
  assert.equal(detectFeedback('这个设计有问题'), null);
});

test('空输入与非字符串返回 null', () => {
  assert.equal(detectFeedback(''), null);
  assert.equal(detectFeedback('   '), null);
  assert.equal(detectFeedback(undefined), null);
  assert.equal(detectFeedback(null), null);
});

test('isSuspect：纠正多于确认才算可疑', () => {
  assert.equal(isSuspect({ corrections: 1, confirmed: 0 }), true);
  assert.equal(isSuspect({ corrections: 2, confirmed: 2 }), true);
  assert.equal(isSuspect({ corrections: 1, confirmed: 3 }), false);
  assert.equal(isSuspect({ corrections: 0, confirmed: 0 }), false);
  assert.equal(isSuspect({}), false);
});
