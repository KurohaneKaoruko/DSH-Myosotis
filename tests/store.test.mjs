/**
 * 存储层单测：去重、合并、淘汰、过期、落盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, createId, normalizeRecord, retentionScore } from '../lib/store.js';

/**
 * 建一个临时目录，测试结束自动清理。
 * @param {(dir: string) => void} run 测试体。
 */
function withTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'myosotis-store-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('add：新建、落盘、重新载入', () => {
  withTemp((dir) => {
    const file = join(dir, 'project.json');
    const store = new MemoryStore({ file, scope: 'project' });
    const result = store.add({ text: '提交信息用中文', kind: 'convention', importance: 4, tags: ['Git'] });
    assert.equal(result.action, 'created');
    assert.equal(result.item.tags[0], 'git');
    store.flushSync();

    const reloaded = new MemoryStore({ file, scope: 'project' });
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0].text, '提交信息用中文');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
  });
});

test('add：完全重复时更新而不是新增', () => {
  withTemp((dir) => {
    const store = new MemoryStore({ file: join(dir, 'p.json'), scope: 'project' });
    const first = store.add({ text: '不要自动 push', importance: 3 });
    const second = store.add({ text: '不要自动 push。', importance: 5 });
    assert.equal(second.action, 'updated');
    assert.equal(store.list().length, 1);
    assert.equal(second.item.id, first.item.id);
    assert.equal(second.item.importance, 5);
  });
});

test('add：近似重复合并，保留更长的文本', () => {
  withTemp((dir) => {
    const store = new MemoryStore({ file: join(dir, 'p.json'), scope: 'project' });
    store.add({ text: '提交信息用中文，不要自动 push' });
    const merged = store.add({ text: '提交信息一律用中文，不要自动 push', tags: ['git'] });
    assert.equal(merged.action, 'merged');
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].text, '提交信息一律用中文，不要自动 push');
    assert.deepEqual(store.list()[0].tags, ['git']);
  });
});

test('update / remove：按 id 生效', () => {
  withTemp((dir) => {
    const store = new MemoryStore({ file: join(dir, 'p.json'), scope: 'project' });
    const { item } = store.add({ text: '偏好 ESM' });
    store.update(item.id, { text: '偏好 ESM，不要 CommonJS', pinned: true, importance: 5 });
    assert.equal(store.find(item.id).pinned, true);
    assert.equal(store.find(item.id).text, '偏好 ESM，不要 CommonJS');
    store.remove(item.id);
    assert.equal(store.list().length, 0);
    assert.equal(store.remove('nope'), undefined);
  });
});

test('evict：超限时淘汰低分条目，置顶项保留', () => {
  withTemp((dir) => {
    const store = new MemoryStore({ file: join(dir, 'p.json'), scope: 'project', limit: 3 });
    const pinned = store.add({ text: '置顶的那条', pinned: true, importance: 1 }).item;
    for (let i = 0; i < 6; i += 1) store.add({ text: `普通条目第 ${i} 号内容`, importance: 1 });
    assert.equal(store.list().length, 3);
    assert.ok(store.find(pinned.id), '置顶项不应被淘汰');
  });
});

test('prune：丢弃过期条目', () => {
  withTemp((dir) => {
    const store = new MemoryStore({ file: join(dir, 's.json'), scope: 'session' });
    store.add({ text: '这条明天就该消失' }, { expiresAt: Date.now() - 1000 });
    store.add({ text: 'Python 的 GIL 限制多线程并行' }, { expiresAt: Date.now() + 60000 });
    store.prune();
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].text, 'Python 的 GIL 限制多线程并行');
  });
});

test('retentionScore：置顶远高于普通条目', () => {
  const now = Date.now();
  const normal = { importance: 5, hits: 10, updatedAt: now };
  const pinned = { importance: 1, hits: 0, updatedAt: now, pinned: true };
  assert.ok(retentionScore(pinned, now) > retentionScore(normal, now));
});

test('normalizeRecord：非法字段被收敛', () => {
  const record = normalizeRecord({ text: 'x', kind: 'nonsense', importance: 99, tags: ['A', 'a', ''] }, { scope: 'global' });
  assert.equal(record.kind, 'fact');
  assert.equal(record.importance, 5);
  assert.deepEqual(record.tags, ['a']);
  assert.throws(() => normalizeRecord({ text: '   ' }), /empty/);
});

test('createId：不重复', () => {
  const ids = new Set(Array.from({ length: 200 }, () => createId(1700000000000)));
  assert.equal(ids.size, 200);
});
