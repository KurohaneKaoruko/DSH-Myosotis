/**
 * 切块单测：标题路径、行号、重叠、超长行。
 *
 * 切块是检索质量的地基，这些用例钉的是「块里到底有什么」，
 * 不是「切出来几块」——数量会随参数变，结构不该变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkText } from '../lib/chunk.js';

/** 一段带三级标题的 Markdown。 */
const GUIDE = [
  '# 安装', // 1
  '', // 2
  '把目录复制到 local-plugins，然后重启 DSH。', // 3
  '', // 4
  '## 配置', // 5
  '', // 6
  'budgetChars 控制每轮注入的字符预算。', // 7
  '', // 8
  '### 细节', // 9
  '', // 10
  '- 默认 2400', // 11
  '- 上限 20000', // 12
].join('\n');

test('markdown：按标题切，带完整标题路径与行号', () => {
  const chunks = chunkText(GUIDE, { maxChars: 900, format: 'markdown' });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].heading, '安装');
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 4);
  assert.equal(chunks[1].heading, '安装 › 配置');
  assert.equal(chunks[1].startLine, 5);
  assert.equal(chunks[2].heading, '安装 › 配置 › 细节');
  assert.match(chunks[2].text, /默认 2400/);
});

test('markdown：第一个标题之前的内容单独成块，标题为空', () => {
  const chunks = chunkText('前言，还没进正题。\n\n# 正文\n\n内容。', { format: 'markdown' });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, '');
  assert.match(chunks[0].text, /前言/);
  assert.equal(chunks[1].heading, '正文');
});

test('markdown：围栏里的 # 不算标题', () => {
  const text = ['# 用法', '', '```bash', '# 这是注释，不是标题', 'echo hi', '```', '', '结束。'].join('\n');
  const chunks = chunkText(text, { format: 'markdown' });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, '用法');
  assert.match(chunks[0].text, /这是注释/);
});

test('markdown：同级标题会出栈，不会串成「安装 › 测试」', () => {
  const text = ['# 安装', '甲', '# 测试', '乙'].join('\n');
  const chunks = chunkText(text, { format: 'markdown' });
  assert.deepEqual(
    chunks.map((chunk) => chunk.heading),
    ['安装', '测试'],
  );
});

test('markdown：超长的一节按行切开，并保留重叠', () => {
  const lines = ['# 长节'];
  for (let index = 1; index <= 24; index += 1) lines.push(`第 ${index} 行的正文，长度足够触发一次切块。`);
  const chunks = chunkText(lines.join('\n'), { maxChars: 200, overlap: 60, format: 'markdown' });
  assert.ok(chunks.length > 1, '应当切成多块');
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 200, `块超长：${chunk.text.length}`);
    assert.equal(chunk.heading, '长节');
  }
  // 相邻块要有重叠：后一块的第一行应当出现在前一块里。
  const firstLine = chunks[1].text.split('\n')[0];
  assert.match(chunks[0].text, new RegExp(firstLine.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('code：块标题取块起点之前最近的声明', () => {
  const text = [
    'import x from "y";',
    '',
    'export function alpha() {',
    ...Array.from({ length: 10 }, (_unused, index) => `  const v${index} = ${index};`),
    '}',
    '',
    'class Beta {',
    ...Array.from({ length: 10 }, (_unused, index) => `  m${index}() { return ${index}; }`),
    '}',
  ].join('\n');
  const chunks = chunkText(text, { maxChars: 200, overlap: 0, format: 'code' });
  assert.ok(chunks.length > 1, '应当切成多块');
  assert.equal(chunks[0].heading, '', '第一个声明之前没有标题');
  const headings = chunks.map((chunk) => chunk.heading).filter(Boolean);
  assert.ok(headings.includes('alpha'), `实际标题：${chunks.map((chunk) => chunk.heading).join(',')}`);
});

test('text：纯文本按行打包，不产生空白块', () => {
  const text = ['第一段。', '', '第二段。', '', '', '第三段。'].join('\n');
  const chunks = chunkText(text, { format: 'text' });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /第三段/);
  assert.ok(!chunks.some((chunk) => chunk.text.trim().length === 0));
});

test('超长单行被硬切，单块不会超过上限', () => {
  const long = 'a'.repeat(1000);
  const chunks = chunkText(long, { maxChars: 200, overlap: 0, format: 'text' });
  assert.ok(chunks.length >= 5);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 200);
});

test('空文本与纯空白返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('maxChars 有下界：过小的值被抬到 120，避免切出碎片', () => {
  const chunks = chunkText('甲'.repeat(200), { maxChars: 10, overlap: 0, format: 'text' });
  assert.equal(chunks.length, 2);
});
