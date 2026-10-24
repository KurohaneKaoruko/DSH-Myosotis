/**
 * 检索层单测：相关性、置顶、预算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rank, select } from '../lib/retrieval.js';

/**
 * 造一条记忆。
 * @param {string} text 文本。
 * @param {Record<string, any>} [extra] 额外字段。
 * @returns {Record<string, any>} 记录。
 */
function memory(text, extra = {}) {
  const now = Date.now();
  return { id: text.slice(0, 8), scope: 'project', kind: 'fact', text, tags: [], importance: 3, pinned: false, hits: 0, createdAt: now, updatedAt: now, ...extra };
}

test('rank：相关记忆排在无关记忆前面', () => {
  const items = [
    memory('提交信息一律用中文，不要自动 push'),
    memory('Python 的 GIL 限制多线程并行'),
    memory('这个仓库用 pnpm 管理依赖'),
  ];
  const ranked = rank(items, '提交信息要怎么写？');
  assert.match(ranked[0].item.text, /提交信息/);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('rank：标签命中权重高于正文命中', () => {
  const tagged = memory('一条不太相关的话', { tags: ['git'] });
  const body = memory('git 相关但标签为空的一条话');
  const ranked = rank([body, tagged], 'git');
  assert.equal(ranked[0].item.tags[0], 'git');
});

test('rank：空查询时按重要度与新近度排序', () => {
  const items = [memory('低重要度的一条', { importance: 1 }), memory('高重要度的一条', { importance: 5 })];
  const ranked = rank(items, '');
  assert.equal(ranked[0].item.importance, 5);
});

test('select：置顶与关系类永远入选', () => {
  const items = [
    memory('用户叫 Kaoruko', { kind: 'profile', importance: 3 }),
    memory('他讨厌客套话', { kind: 'bond', importance: 2 }),
    ...Array.from({ length: 20 }, (_, i) => memory(`普通记忆 ${i} 号内容`, { importance: 1 })),
  ];
  const { picked } = select([{ scope: 'global', items }], { query: '完全无关的查询', budgetChars: 200 });
  const kinds = picked.map((entry) => entry.item.kind);
  assert.ok(kinds.includes('profile'));
  assert.ok(kinds.includes('bond'));
});

test('select：预算生效，且每个作用域至少留一条', () => {
  const global = [memory('全局记忆一条比较长的话'.repeat(3), { kind: 'preference', importance: 5 })];
  const project = [memory('项目记忆一条同样很长的话'.repeat(3), { kind: 'convention', importance: 5 })];
  const session = [memory('会话记忆也不短'.repeat(3), { kind: 'fact', importance: 5 })];
  const { picked } = select(
    [
      { scope: 'global', items: global },
      { scope: 'project', items: project },
      { scope: 'session', items: session },
    ],
    { query: '', budgetChars: 120 },
  );
  const scopes = new Set(picked.map((entry) => entry.scope));
  assert.ok(scopes.has('global') && scopes.has('project') && scopes.has('session'));
  assert.ok(picked.length <= 3);
});

test('select：空集合返回空结果', () => {
  assert.deepEqual(select([], { query: 'x' }).picked, []);
});
