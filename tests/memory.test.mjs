/**
 * 服务层单测：三层落盘、提升、检索、删除、注入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../lib/config.js';
import { MemoryService } from '../lib/memory.js';

/**
 * 建一套临时环境：DSH_HOME + 项目目录 + 假 agent。
 * @param {(env: { home: string, cwd: string, agent: any, service: MemoryService }) => any} run 测试体。
 */
function withEnv(run) {
  const root = mkdtempSync(join(tmpdir(), 'myosotis-svc-'));
  const home = join(root, 'dsh-home');
  const cwd = join(root, 'project');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const agent = {
    id: 'session-abc',
    session: {
      header: { id: 'session-abc', cwd },
      events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '这个项目的提交信息怎么写？' }] } }],
    },
  };
  const service = new MemoryService({ config: { ...DEFAULTS }, logger: () => {} });
  try {
    return run({ home, cwd, agent, service });
  } finally {
    service.dispose();
    process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('save：三个作用域各自落盘到正确位置', () => {
  withEnv(({ home, cwd, agent, service }) => {
    service.save({ text: '用户叫 Kaoruko', scope: 'global', kind: 'profile' }, agent);
    service.save({ text: '提交信息用中文', scope: 'project', kind: 'convention' }, agent);
    service.save({ text: '这次在改记忆插件', scope: 'session', kind: 'fact' }, agent);
    service.dispose();

    assert.ok(existsSync(join(home, 'memory', 'global.json')));
    assert.ok(existsSync(join(cwd, '.dsh', 'memory', 'project.json')));
    assert.ok(existsSync(join(home, 'memory', 'sessions', 'session-abc.json')));
  });
});

test('save：带 id 且换作用域时执行提升', () => {
  withEnv(({ agent, service }) => {
    const created = service.save({ text: '他喜欢被直呼名字', scope: 'session', kind: 'bond' }, agent);
    const promoted = service.save({ id: created.item.id, scope: 'global' }, agent);
    assert.equal(promoted.moved, true);
    assert.equal(promoted.scope, 'global');
    assert.equal(service.sessionStore('session-abc').list().length, 0);
    assert.equal(service.globalStore().list().length, 1);
  });
});

test('save：缺少 text 且无 id 时抛错', () => {
  withEnv(({ agent, service }) => {
    assert.throws(() => service.save({ scope: 'global' }, agent), /empty|text/);
  });
});

test('search：跨作用域按分数返回，带 id 与 scope', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '提交信息一律用中文，不要自动 push', scope: 'project', kind: 'convention' }, agent);
    service.save({ text: '这个仓库用 pnpm 管理依赖', scope: 'project', kind: 'fact' }, agent);
    service.save({ text: '用户喜欢简洁的回复', scope: 'global', kind: 'preference' }, agent);
    const results = service.search('提交信息', {}, agent);
    assert.ok(results.length >= 1);
    assert.match(results[0].text, /提交信息/);
    assert.ok(results[0].id.startsWith('m_'));
  });
});

test('forget：按 query 先给候选，confirm 后删除', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '提交信息一律用中文，不要自动 push', scope: 'project' }, agent);
    const preview = service.forget({ query: '提交信息' }, agent);
    assert.equal(preview.needConfirm, true);
    assert.equal(preview.removed.length, 0);
    assert.ok(preview.candidates.length >= 1);

    const done = service.forget({ query: '提交信息', confirm: true }, agent);
    assert.equal(done.removed.length, 1);
    assert.equal(service.projectStore(agent.session.header.cwd).list().length, 0);
  });
});

test('forget：按 id 精确删除', () => {
  withEnv(({ agent, service }) => {
    const { item } = service.save({ text: 'Python 的 GIL 限制并行', scope: 'global' }, agent);
    const result = service.forget({ id: item.id }, agent);
    assert.equal(result.removed.length, 1);
    assert.equal(service.globalStore().list().length, 0);
  });
});

test('renderFor：注入块包含相关记忆与项目名', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '提交信息一律用中文，不要自动 push', scope: 'project', kind: 'convention' }, agent);
    service.save({ text: '用户叫 Kaoruko，喜欢被直呼名字', scope: 'global', kind: 'profile' }, agent);
    service.noteQuery(agent.id, '提交信息要怎么写？');
    const text = service.renderFor(agent);
    assert.match(text, /长期记忆/);
    assert.match(text, /提交信息/);
    assert.match(text, /Kaoruko/);
    assert.match(text, /project/);
  });
});

test('renderFor：没有记忆时返回空串', () => {
  withEnv(({ agent, service }) => {
    assert.equal(service.renderFor(agent), '');
    assert.equal(service.renderFor(undefined), '');
  });
});

test('renderFor：同一轮内命中缓存，写入后失效', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '提交信息用中文', scope: 'project' }, agent);
    const first = service.renderFor(agent);
    const second = service.renderFor(agent);
    assert.equal(first, second);
    service.save({ text: '这个仓库用 pnpm 管理依赖', scope: 'project' }, agent);
    const third = service.renderFor(agent);
    assert.notEqual(third, first);
  });
});

test('renderFor：注入计次不改 version，否则缓存每步都会失效', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '提交信息用中文', scope: 'project' }, agent);
    const store = service.projectStore(agent.session.header.cwd);
    const before = store.version;
    service.renderFor(agent);
    assert.equal(store.version, before);
    assert.ok(store.list()[0].hits > 0, '命中计数仍应记录');
  });
});

test('forget：只按词法命中删，不会因为「重要度高」误删', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '用户叫 Kaoruko，喜欢被直呼名字', scope: 'global', kind: 'profile', importance: 5, pinned: true }, agent);
    service.save({ text: '提交信息一律用中文', scope: 'project' }, agent);
    const preview = service.forget({ query: '提交信息' }, agent);
    assert.equal(preview.candidates.length, 1);
    assert.match(preview.candidates[0].text, /提交信息/);
  });
});

test('markdown 镜像：写入后生成 MEMORY.md', () => {
  withEnv(({ home, agent, service }) => {
    service.save({ text: '用户叫 Kaoruko', scope: 'global', kind: 'profile', importance: 5 }, agent);
    service.dispose();
    const mirror = readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf8');
    assert.match(mirror, /全局记忆/);
    assert.match(mirror, /Kaoruko/);
    assert.match(mirror, /m_/);
  });
});

test('capture：自动捕获落到会话作用域并带过期时间', () => {
  withEnv(({ agent, service }) => {
    const result = service.capture('以后都用 pnpm，不要 npm', agent, { kind: 'convention', importance: 5 });
    assert.equal(result.scope, 'session');
    const item = service.sessionStore('session-abc').list()[0];
    assert.ok(item.expiresAt > Date.now());
    assert.equal(item.kind, 'convention');
    assert.equal(item.source.auto, true);
  });
});
