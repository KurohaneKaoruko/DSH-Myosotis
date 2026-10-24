/**
 * 文本层的单测：分词、相似度、消息取文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bigramSet, hash32, jaccard, lastUserText, messageText, normalizeText, sentences, similarity, tokenize, truncate } from '../lib/text.js';

test('tokenize：中文切二元组，英文做轻量词干', () => {
  const tokens = tokenize('用户偏好 ESM，不要 CommonJS');
  assert.ok(tokens.includes('用户'));
  assert.ok(tokens.includes('偏好'));
  assert.ok(tokens.includes('commonjs'), 'js 结尾的技术词不应被去掉 s');
  assert.ok(tokens.includes('esm'));
});

test('tokenize：英文复数归并到词根', () => {
  assert.ok(tokenize('remembering memories').includes('remember'));
});

test('tokenize：过滤高频虚词', () => {
  assert.ok(!tokenize('这个可以吗').includes('这个'));
});

test('normalizeText：去掉标点空白并转小写', () => {
  assert.equal(normalizeText('  Hello, World! 你好。 '), 'helloworld你好');
});

test('jaccard：近似句命中，无关句不命中', () => {
  assert.ok(jaccard('提交信息用中文，不要自动 push', '提交信息一律用中文，不要自动 push') > 0.7);
  assert.ok(jaccard('提交信息用中文', 'Python 的 GIL 限制并发') < 0.1);
});

test('similarity：插入一个词仍判为同一条', () => {
  assert.ok(similarity('提交信息用中文，不要自动 push', '提交信息一律用中文，不要自动 push') > 0.85);
  assert.ok(similarity('不要 push', '不要 push，也不要用 HTTPS 推送到 GitHub，一律走 SSH') < 0.85);
});

test('bigramSet：短文本也能产生集合', () => {
  assert.deepEqual([...bigramSet('ab')], ['ab']);
});

test('truncate：超长截断且保留省略号', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});

test('messageText：拼出内容块里的文本', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(messageText({ content: 'plain' }), 'plain');
  assert.equal(messageText(null), '');
});

test('lastUserText：倒着找到最后一条用户消息', () => {
  const session = {
    events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: '第一句' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '回答' }] } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '第二句' }] } },
    ],
  };
  assert.equal(lastUserText(session), '第二句');
  assert.equal(lastUserText({ events: [] }), '');
});

test('sentences：按中英文句读切句', () => {
  assert.deepEqual(sentences('第一句。第二句！第三句'), ['第一句。', '第二句！', '第三句']);
});

test('hash32：稳定且区分大小写', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
});
