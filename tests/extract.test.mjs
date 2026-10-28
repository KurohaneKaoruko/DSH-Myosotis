/**
 * 文本提取单测。
 *
 * docx 用例在测试里现造一个 zip：不依赖任何真实 Word 文件，
 * 也就顺带把 zip 读取器（store / deflate 两条路径）一起验了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docxToText, extractText, htmlToText } from '../lib/extract.js';

/**
 * 造一个最小 zip。
 * @param {{ name: string, data: string, store?: boolean }[]} entries 成员。
 * @returns {Buffer} zip 内容。
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data, 'utf8');
    const method = entry.store ? 0 : 8;
    const data = entry.store ? raw : deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

/**
 * 在临时目录里跑测试体。
 * @param {(dir: string) => any} run 测试体。
 */
function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'myosotis-extract-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('markdown：识别格式并取第一个一级标题', () => {
  withDir((dir) => {
    const file = join(dir, 'guide.md');
    writeFileSync(file, '\uFEFF# 安装指南\r\n\r\n正文。\r\n', 'utf8');
    const result = extractText(file);
    assert.equal(result.ok, true);
    assert.equal(result.format, 'markdown');
    assert.equal(result.title, '安装指南');
    assert.ok(!result.text.includes('\r'), 'CRLF 应被归一化');
    assert.ok(!result.text.startsWith('\uFEFF'), 'BOM 应被去掉');
  });
});

test('代码：按代码格式返回，标题退回文件名', () => {
  withDir((dir) => {
    const file = join(dir, 'store.ts');
    writeFileSync(file, 'export const a = 1;\n', 'utf8');
    const result = extractText(file);
    assert.equal(result.ok, true);
    assert.equal(result.format, 'code');
    assert.equal(result.title, 'store');
  });
});

test('html：保留标题层级与列表，去掉脚本样式', () => {
  const text = htmlToText(
    '<html><head><style>p{color:red}</style><script>var a=1</script></head><body><h1>标题</h1><p>段落&amp;实体</p><ul><li>甲</li><li>乙</li></ul></body></html>',
  );
  assert.match(text, /^# 标题/mu);
  assert.match(text, /段落&实体/u);
  assert.match(text, /- 甲/u);
  assert.ok(!text.includes('var a=1'));
  assert.ok(!text.includes('color:red'));
});

test('html：实体与数字引用被解码', () => {
  assert.equal(htmlToText('<p>&lt;tag&gt; &#65; &#x42;</p>'), '<tag> A B');
});

test('docx：从 zip 里取出正文（deflate 与 store 两种方式）', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>';
  for (const store of [false, true]) {
    const buffer = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: xml, store },
    ]);
    assert.equal(docxToText(buffer), '第一段\n第二段', `store=${store}`);
  }
});

test('docx：缺 document.xml 时返回空串而不是抛错', () => {
  const buffer = buildZip([{ name: 'word/styles.xml', data: '<x/>' }]);
  assert.equal(docxToText(buffer), '');
  assert.equal(docxToText(Buffer.from('not a zip')), '');
});

test('docx：文件级提取走同一路径', () => {
  withDir((dir) => {
    const file = join(dir, 'note.docx');
    writeFileSync(file, buildZip([{ name: 'word/document.xml', data: '<w:p><w:r><w:t>会议纪要</w:t></w:r></w:p>' }]));
    const result = extractText(file);
    assert.equal(result.ok, true);
    assert.equal(result.text, '会议纪要');
    assert.equal(result.title, 'note');
  });
});

test('二进制文件被拒绝', () => {
  withDir((dir) => {
    const file = join(dir, 'blob.dat');
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    const result = extractText(file);
    assert.equal(result.ok, false);
    assert.match(result.reason, /二进制/);
  });
});

test('pdf 给出明确提示，而不是塞乱码', () => {
  withDir((dir) => {
    const file = join(dir, 'manual.pdf');
    writeFileSync(file, '%PDF-1.7\n', 'utf8');
    const result = extractText(file);
    assert.equal(result.ok, false);
    assert.match(result.reason, /PDF/);
  });
});

test('超过大小上限被拒绝', () => {
  withDir((dir) => {
    const file = join(dir, 'big.md');
    writeFileSync(file, '# 大文件\n' + 'x'.repeat(2000), 'utf8');
    const result = extractText(file, { maxBytes: 100 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /超过上限/);
  });
});

test('不存在的文件返回失败而不是抛错', () => {
  const result = extractText(join(tmpdir(), 'myosotis-not-exist-文件.md'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /不存在/);
});

test('空文件返回失败', () => {
  withDir((dir) => {
    const file = join(dir, 'empty.md');
    writeFileSync(file, '   \n\n', 'utf8');
    const result = extractText(file);
    assert.equal(result.ok, false);
    assert.match(result.reason, /没有可索引/);
  });
});
