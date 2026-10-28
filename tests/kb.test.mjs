/**
 * 知识库（SQLite）单测。
 *
 * 依赖 `node:sqlite`（Node 22.5+ 内置）。运行时没有这个模块时整组跳过——
 * 插件本身也是这么降级的，测试保持同样的口径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeStore, normalizePath, relativePath, sqliteAvailable } from '../lib/kb.js';

const skip = sqliteAvailable() ? false : '当前运行时没有 node:sqlite';

/**
 * 建一个临时库，跑完关闭并删除。
 * 用 async 是为了等测试体跑完再清理——否则 SQLite 句柄会在断言前被关掉。
 * @param {object} options 选项。
 * @param {(store: KnowledgeStore, dir: string) => any} run 测试体。
 */
async function withDb(options, run) {
  const dir = mkdtempSync(join(tmpdir(), 'myosotis-kb-'));
  const store = new KnowledgeStore({ file: join(dir, 'knowledge.db'), logger: () => {}, ...options });
  try {
    return await run(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 写一个文件。
 * @param {string} dir 目录。
 * @param {string} name 文件名。
 * @param {string} content 内容。
 * @returns {string} 绝对路径。
 */
function writeDoc(dir, name, content) {
  const file = join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * 等待若干毫秒，让 updated_at 能拉开差距。
 * @param {number} ms 毫秒。
 * @returns {Promise<void>} 完成。
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('open：建库、建 FTS 索引', { skip }, () =>
  withDb({}, (store) => {
    assert.equal(store.open(), true);
    assert.equal(store.fts, true);
    assert.equal(store.ready, true);
    assert.equal(store.stats().docs, 0);
  }));

test('ingest / search：中文能命中，并带标题路径与行号', { skip }, () =>
  withDb({}, (store, dir) => {
    const file = writeDoc(dir, 'guide.md', '# 安装\n\n把目录复制到 local-plugins。\n\n## 配置\n\nbudgetChars 控制每轮注入的字符预算。\n');
    const result = store.ingest(file, { project: '/p/a', root: dir });
    assert.equal(result.action, 'added');
    assert.equal(result.doc.rel, 'guide.md');
    assert.equal(result.doc.title, '安装');

    const hits = store.search('配置预算', { project: '/p/a' });
    assert.equal(hits.length, 1);
    // 一级标题已经作为文档标题单独存了，标题路径里不再重复它。
    assert.equal(hits[0].heading, '配置');
    assert.equal(hits[0].startLine, 5);
    assert.equal(hits[0].endLine, 7);
    assert.match(hits[0].text, /budgetChars/);
  }));

test('ingest：没有一级标题时标题路径保持原样', { skip }, () =>
  withDb({}, (store, dir) => {
    const file = writeDoc(dir, 'note.md', '## 甲\n\n第一段。\n\n### 乙\n\n第二段。\n');
    store.ingest(file, { project: '/p/a' });
    assert.equal(store.list({ project: '/p/a' })[0].title, 'note');
    const hits = store.search('第二段', { project: '/p/a' });
    assert.equal(hits[0].heading, '甲 › 乙');
  }));

test('ingest：文件没变时跳过，不重建索引', { skip }, () =>
  withDb({}, (store, dir) => {
    const file = writeDoc(dir, 'a.md', '# 标题\n\n内容。\n');
    assert.equal(store.ingest(file, { project: '/p/a' }).action, 'added');
    assert.equal(store.ingest(file, { project: '/p/a' }).action, 'skipped');
  }));

test('ingest：mtime 变了但内容没变，仍然跳过（哈希兜底）', { skip }, () =>
  withDb({}, (store, dir) => {
    const file = writeDoc(dir, 'a.md', '# 标题\n\n内容。\n');
    store.ingest(file, { project: '/p/a' });
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    assert.equal(store.ingest(file, { project: '/p/a' }).action, 'skipped');
  }));

test('ingest：内容变了就重建，旧词搜不到', { skip }, () =>
  withDb({}, (store, dir) => {
    const file = writeDoc(dir, 'a.md', '# 标题\n\n旧内容讲的是状态机。\n');
    store.ingest(file, { project: '/p/a' });
    assert.equal(store.search('状态机', { project: '/p/a' }).length, 1);

    writeDoc(dir, 'a.md', '# 标题\n\n新内容讲的是检索排序，字数也不一样。\n');
    assert.equal(store.ingest(file, { project: '/p/a' }).action, 'updated');
    assert.equal(store.search('状态机', { project: '/p/a' }).length, 0);
    assert.equal(store.search('检索排序', { project: '/p/a' }).length, 1);
    assert.equal(store.stats().docs, 1, '不该留下孤儿文档行');
  }));

test('sync：新增、跳过、删除磁盘上已消失的文档', { skip }, () =>
  withDb({}, (store, dir) => {
    const docs = join(dir, 'docs');
    mkdirSync(docs, { recursive: true });
    writeDoc(docs, 'a.md', '# 甲\n\n第一篇。\n');
    writeDoc(docs, 'b.md', '# 乙\n\n第二篇。\n');

    const first = store.sync(docs, { project: '/p/a', root: dir });
    assert.deepEqual([first.added, first.updated, first.skipped, first.removed], [2, 0, 0, 0]);

    const second = store.sync(docs, { project: '/p/a', root: dir });
    assert.deepEqual([second.added, second.updated, second.skipped, second.removed], [0, 0, 2, 0]);

    rmSync(join(docs, 'b.md'));
    const third = store.sync(docs, { project: '/p/a', root: dir });
    assert.deepEqual([third.added, third.updated, third.skipped, third.removed], [0, 0, 1, 1]);
    assert.equal(store.stats().docs, 1);
  }));

test('sync：忽略 node_modules 与隐藏文件', { skip }, () =>
  withDb({ ignore: ['node_modules'] }, (store, dir) => {
    const docs = join(dir, 'docs');
    mkdirSync(join(docs, 'node_modules'), { recursive: true });
    mkdirSync(join(docs, '.hidden'), { recursive: true });
    writeDoc(docs, 'keep.md', '# 保留\n\n正文。\n');
    writeDoc(join(docs, 'node_modules'), 'skip.md', '# 依赖\n\n不该进来。\n');
    writeDoc(join(docs, '.hidden'), 'skip.md', '# 隐藏\n\n不该进来。\n');
    writeDoc(docs, '.env', 'SECRET=1\n');

    const summary = store.sync(docs, { project: '/p/a', root: dir });
    assert.equal(summary.added, 1);
    assert.equal(store.stats().docs, 1);
    assert.equal(store.list({ project: '/p/a' })[0].rel, 'docs/keep.md');
  }));

test('search：项目隔离，全局文档对所有人可见', { skip }, () =>
  withDb({}, (store, dir) => {
    store.ingest(writeDoc(dir, 'a.md', '# 甲\n\nA 项目的部署流程。\n'), { project: '/p/a' });
    store.ingest(writeDoc(dir, 'b.md', '# 乙\n\nB 项目的部署流程。\n'), { project: '/p/b' });
    store.ingest(writeDoc(dir, 'c.md', '# 丙\n\n通用的部署流程。\n'), { project: '' });

    const inA = store.search('部署流程', { project: '/p/a' }).map((hit) => hit.title);
    assert.ok(inA.includes('甲'));
    assert.ok(inA.includes('丙'));
    assert.ok(!inA.includes('乙'));
  }));

test('search：同一篇文档默认最多出两块', { skip }, () =>
  withDb({}, (store, dir) => {
    const body = ['# 部署', '部署流程分三步。', '## 部署细节', '部署前先备份。', '## 部署回滚', '部署失败要回滚。'].join('\n');
    store.ingest(writeDoc(dir, 'deploy.md', body), { project: '/p/a' });
    assert.equal(store.search('部署', { project: '/p/a', perDoc: 2, limit: 10 }).length, 2);
    assert.equal(store.search('部署', { project: '/p/a', perDoc: 1, limit: 10 }).length, 1);
  }));

test('search：FTS 不可用时退回 LIKE 仍然能搜到', { skip }, () =>
  withDb({}, (store, dir) => {
    store.ingest(writeDoc(dir, 'a.md', '# 标题\n\n提交信息一律用中文。\n'), { project: '/p/a' });
    store.fts = false;
    assert.equal(store.search('提交信息', { project: '/p/a' }).length, 1);
  }));

test('search：查询为空时不返回片段', { skip }, () =>
  withDb({}, (store, dir) => {
    store.ingest(writeDoc(dir, 'a.md', '# 标题\n\n内容。\n'), { project: '/p/a' });
    assert.deepEqual(store.search('', { project: '/p/a' }), []);
  }));

test('prune：超过块数上限时整篇淘汰最久未更新的文档', { skip }, () =>
  withDb({ maxChunks: 4 }, async (store, dir) => {
    store.ingest(writeDoc(dir, 'a.md', '# 甲\n\n一句话。\n'), { project: '/p/a' });
    await delay(8);
    store.ingest(writeDoc(dir, 'b.md', '# 乙\n\n第一段。\n\n# 乙二\n\n第二段。\n\n# 乙三\n\n第三段。\n'), { project: '/p/a' });
    await delay(8);
    store.ingest(writeDoc(dir, 'c.md', '# 丙\n\n最新的一篇。\n\n# 丙二\n\n第二段。\n'), { project: '/p/a' });

    const docs = store.list({ project: '/p/a' });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].title, '丙');
  }));

test('removeDoc：删除文档与它的块', { skip }, () =>
  withDb({}, (store, dir) => {
    const result = store.ingest(writeDoc(dir, 'a.md', '# 标题\n\n要删的内容。\n'), { project: '/p/a' });
    assert.ok(store.removeDoc(result.doc.id));
    assert.equal(store.stats().docs, 0);
    assert.equal(store.chunkCount(), 0);
    assert.equal(store.search('要删', { project: '/p/a' }).length, 0);
    assert.equal(store.removeDoc('d_nope'), undefined);
  }));

test('list：按更新时间倒序，可按项目过滤', { skip }, () =>
  withDb({}, async (store, dir) => {
    store.ingest(writeDoc(dir, 'old.md', '# 旧\n\n旧的一篇。\n'), { project: '/p/a' });
    await delay(8);
    store.ingest(writeDoc(dir, 'new.md', '# 新\n\n新的一篇。\n'), { project: '/p/a' });
    store.ingest(writeDoc(dir, 'other.md', '# 别\n\n别的项目。\n'), { project: '/p/b' });

    const docs = store.list({ project: '/p/a' });
    assert.equal(docs.length, 2);
    assert.equal(docs[0].title, '新');
    assert.equal(store.list({ project: '/p/a', limit: 1 }).length, 1);
  }));

test('ingest：二进制与超大文件被拒绝，不落库', { skip }, () =>
  withDb({ maxFileBytes: 200 }, (store, dir) => {
    const binary = join(dir, 'blob.dat');
    writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02]));
    assert.equal(store.ingest(binary, { project: '/p/a' }).action, 'failed');

    const big = writeDoc(dir, 'big.md', '# 大\n\n' + 'x'.repeat(500));
    const result = store.ingest(big, { project: '/p/a' });
    assert.equal(result.action, 'failed');
    assert.match(result.reason, /上限/);
    assert.equal(store.stats().docs, 0);
  }));

test('stats / exportAll：计数与导出对得上', { skip }, () =>
  withDb({}, (store, dir) => {
    store.ingest(writeDoc(dir, 'a.md', '# 甲\n\n正文。\n'), { project: '/p/a' });
    const stats = store.stats();
    assert.equal(stats.docs, 1);
    assert.equal(stats.chunks, 1);
    assert.equal(stats.fts, true);
    assert.ok(stats.bytes > 0);

    const exported = store.exportAll();
    assert.equal(exported.docs.length, 1);
    assert.equal(exported.chunks.length, 1);
    assert.equal(exported.chunks[0].docId, exported.docs[0].id);
  }));

test('normalizePath / relativePath：跨平台路径比较', () => {
  const base = process.platform === 'win32' ? 'c:/work/proj' : '/work/proj';
  assert.equal(normalizePath(base), base);
  assert.equal(relativePath('/work/proj', '/work/proj/docs/a.md'), 'docs/a.md');
  assert.equal(relativePath('/work/proj', '/other/a.md'), '');
  assert.equal(relativePath('', '/work/proj/a.md'), '');
});
