/**
 * 深记忆（SQLite）单测。
 *
 * 依赖 `node:sqlite`（Node 22.5+ 内置）。运行时没有这个模块时整组跳过——
 * 插件本身也是这么降级的，测试保持同样的口径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeepStore, sqliteAvailable } from '../lib/deep.js';

const skip = sqliteAvailable() ? false : '当前运行时没有 node:sqlite';

/**
 * 建一个临时库，跑完关闭并删除。
 * @param {object} options 选项。
 * @param {(store: DeepStore, dir: string) => any} run 测试体。
 */
function withDb(options, run) {
  const dir = mkdtempSync(join(tmpdir(), 'myosotis-deep-'));
  const store = new DeepStore({ file: join(dir, 'deep.db'), logger: () => {}, ...options });
  try {
    return run(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sqliteAvailable：Node 22.5+ 应返回 true', { skip }, () => {
  assert.equal(sqliteAvailable(), true);
});

test('open：建库、建 FTS 索引', { skip }, () => {
  withDb({}, (store, dir) => {
    assert.equal(store.open(), true);
    assert.equal(store.fts, true);
    assert.equal(store.ready, true);
    assert.ok(statSync(join(dir, 'deep.db')).size > 0);
  });
});

test('save / search：中文查询能命中', { skip }, () => {
  withDb({}, (store) => {
    store.save({ text: '2026-10 一起把检索从分作用域 IDF 改成全局 IDF', kind: 'episode', tags: ['检索'] }, { project: '/p/a' });
    store.save({ text: '提交信息一律用中文，不要自动 push', kind: 'convention', importance: 5 }, { project: '/p/a' });
    const hits = store.search('检索排序', { project: '/p/a' });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /IDF/);
  });
});

test('search：两字中文查询也能命中（二元组索引）', { skip }, () => {
  withDb({}, (store) => {
    store.save({ text: '提交信息一律用中文' }, { project: '/p/a' });
    const hits = store.search('提交', { project: '/p/a' });
    assert.equal(hits.length, 1);
  });
});

test('search：项目隔离，未绑定项目的条目对所有人可见', { skip }, () => {
  withDb({}, (store) => {
    store.save({ text: 'A 项目的私有决定' }, { project: '/p/a' });
    store.save({ text: 'B 项目的私有决定' }, { project: '/p/b' });
    store.save({ text: '跨项目通用的决定' }, { project: '' });
    const inA = store.search('决定', { project: '/p/a' }).map((row) => row.text);
    assert.ok(inA.includes('A 项目的私有决定'));
    assert.ok(inA.includes('跨项目通用的决定'));
    assert.ok(!inA.includes('B 项目的私有决定'));
  });
});

test('search：没有关键词时按重要度与新近度列出', { skip }, () => {
  withDb({}, (store) => {
    store.save({ text: '低重要度的一条记录', importance: 1 }, { project: '/p/a' });
    store.save({ text: '高重要度的一条记录', importance: 5 }, { project: '/p/a' });
    const hits = store.search('', { project: '/p/a' });
    assert.equal(hits[0].importance, 5);
  });
});

test('search：FTS 不可用时退回 LIKE 仍然能搜到', { skip }, () => {
  withDb({}, (store) => {
    store.save({ text: '提交信息一律用中文' }, { project: '/p/a' });
    store.fts = false;
    const hits = store.search('提交信息', { project: '/p/a' });
    assert.equal(hits.length, 1);
  });
});

test('save：同 id 更新保留创建时间与置顶状态', { skip }, () => {
  withDb({}, (store) => {
    const first = store.save({ text: '关于构建脚本的历史细节', pinned: true, importance: 2 }, { project: '/p/a' });
    const second = store.save({ id: first.item.id, text: '改过的文本', importance: 4 }, { project: '/p/a' });
    assert.equal(second.action, 'updated');
    assert.equal(second.item.text, '改过的文本');
    assert.equal(second.item.pinned, true);
    assert.equal(second.item.importance, 4);
    assert.equal(second.item.createdAt, first.item.createdAt);
    // 旧文本独有的词不应再命中，说明 FTS 行跟着换了。
    assert.equal(store.search('构建脚本', { project: '/p/a' }).length, 0);
    assert.equal(store.search('改过', { project: '/p/a' }).length, 1);
  });
});

test('remove：删除后检索不到，计数同步', { skip }, () => {
  withDb({}, (store) => {
    const saved = store.save({ text: '待删除的一条记录' }, { project: '/p/a' });
    assert.equal(store.stats().count, 1);
    assert.ok(store.remove(saved.item.id));
    assert.equal(store.stats().count, 0);
    assert.equal(store.search('待删除', { project: '/p/a' }).length, 0);
    assert.equal(store.remove('nope'), undefined);
  });
});

test('prune：超限时淘汰低分条目，置顶项保留', { skip }, () => {
  withDb({ maxEntries: 3 }, (store) => {
    const pinned = store.save({ text: '置顶的那条', pinned: true, importance: 1 }, { project: '/p/a' });
    for (let i = 0; i < 5; i += 1) store.save({ text: `普通记录第 ${i} 号`, importance: 1 }, { project: '/p/a' });
    assert.equal(store.stats().count, 3);
    assert.ok(store.get(pinned.item.id));
  });
});

test('touch：命中计数递增', { skip }, () => {
  withDb({}, (store) => {
    const saved = store.save({ text: '会被反复检索的一条' }, { project: '/p/a' });
    store.search('反复检索', { project: '/p/a' });
    store.search('反复检索', { project: '/p/a' });
    assert.equal(store.get(saved.item.id).hits, 2);
  });
});

test('archive：批量写入并跳过坏数据', { skip }, () => {
  withDb({}, (store) => {
    const count = store.archive([{ text: '第一条' }, { text: '' }, { text: '第三条' }], { project: '/p/a' });
    assert.equal(count, 2);
    assert.equal(store.stats().count, 2);
  });
});

test('exportAll：按创建时间导出', { skip }, (t) => {
  withDb({}, (store) => {
    store.save({ text: '第一条记录' }, { project: '/p/a' });
    store.save({ text: '第二条记录' }, { project: '/p/a' });
    const rows = store.exportAll('/p/a');
    assert.equal(rows.length, 2);
    assert.ok(rows[0].createdAt <= rows[1].createdAt);
  });
});

test('open：路径不可用时返回 false 而不是抛错', { skip }, () => {
  // 把一个普通文件当成目录用，mkdtemp 一定失败——模拟「目录不可写」。
  const dir = mkdtempSync(join(tmpdir(), 'myosotis-deep-bad-'));
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  const store = new DeepStore({ file: join(blocker, 'deep.db'), logger: () => {} });
  try {
    assert.equal(store.open(), false);
    assert.equal(store.search('任意', {}).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
