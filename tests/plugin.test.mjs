/**
 * 插件装载测试：用假 ctx 验证 apply 的挂载行为。
 *
 * 这里刻意不复用 DSH 的运行时：插件对外只依赖两个服务
 * （`systemPrompt.section` / `tools.register`）和两个事件，
 * 用假 ctx 就能把契约钉死，跑得也快。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS, validateConfig } from '../lib/config.js';
import { apply } from '../lib/index.js';

/**
 * 造一个最小可用的 Cordis 上下文。
 * @returns {any} 带观测面的假 ctx。
 */
function createCtx() {
  /** @type {any[]} */
  const sections = [];
  /** @type {any[]} */
  const tools = [];
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  /** @type {Function[]} */
  const cleanups = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return () => {};
    },
    effect(factory) {
      cleanups.push(factory());
    },
    get() {
      return undefined;
    },
  };
  return {
    ctx,
    sections,
    tools,
    cleanups,
    emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) handler(payload);
    },
  };
}

/**
 * 隔离 DSH_HOME 的测试环境。
 * @param {(env: any) => any} run 测试体。
 */
function withEnv(run) {
  const root = mkdtempSync(join(tmpdir(), 'myosotis-plugin-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh-home');
  const cwd = join(root, 'workspace');
  const agent = {
    id: 'session-1',
    session: { header: { id: 'session-1', cwd }, events: [] },
  };
  try {
    return run({ root, cwd, agent });
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('apply：注册两个提示词段落与三个工具', () => {
  withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    assert.deepEqual(
      harness.sections.map((section) => section.name),
      ['memory:policy', 'memory:recall'],
    );
    assert.deepEqual(harness.sections.map((section) => section.order), [30, 31]);
    assert.deepEqual(
      harness.tools.map((tool) => tool.name),
      ['memory_save', 'memory_search', 'memory_forget'],
    );
    for (const tool of harness.tools) {
      assert.equal(tool.parameters.type, 'object');
      assert.equal(typeof tool.output.render, 'function');
      assert.equal(typeof tool.execute, 'function');
    }
  });
});

test('apply：enabled=false 时什么都不注册', () => {
  withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS, enabled: false });
    assert.equal(harness.sections.length, 0);
    assert.equal(harness.tools.length, 0);
  });
});

test('apply：policy=false 时只注册注入段落', () => {
  withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS, policy: false });
    assert.deepEqual(
      harness.sections.map((section) => section.name),
      ['memory:recall'],
    );
  });
});

test('recall 段落：按当前 agent 渲染出已保存的记忆', () => {
  withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    return save
      .execute({ text: '提交信息一律用中文', scope: 'project', kind: 'convention' }, { agent })
      .then(() => {
        const recall = harness.sections.find((section) => section.name === 'memory:recall');
        const text = recall.text({ agent });
        assert.match(text, /提交信息/);
        // 无 agent 的组装（例如预览）必须安全降级。
        assert.equal(recall.text({}), '');
      });
  });
});

test('recall 段落：渲染异常时返回空串而不是抛出', () => {
  withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const recall = harness.sections.find((section) => section.name === 'memory:recall');
    const broken = { id: 'x', session: { header: null, get events() { throw new Error('boom'); } } };
    assert.equal(recall.text({ agent: broken }), '');
  });
});

test('自动捕获：用户说「以后都用 pnpm」时落一条会话记忆', () => {
  withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    harness.emit('agent/inbox/claimed', {
      agent,
      message: { content: [{ type: 'text', text: '以后都用 pnpm，不要用 npm。' }], source: { kind: 'user' } },
    });
    const search = harness.tools.find((tool) => tool.name === 'memory_search');
    return search.execute({ query: 'pnpm' }, { agent }).then((value) => {
      assert.equal(value.count, 1);
      assert.equal(value.results[0].scope, 'session');
      assert.match(value.results[0].text, /pnpm/);
    });
  });
});

test('自动捕获：只问「你记得吗」时不记录', () => {
  withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    harness.emit('agent/inbox/claimed', {
      agent,
      message: { content: [{ type: 'text', text: '你还记得上次那个构建脚本吗？' }], source: { kind: 'user' } },
    });
    const search = harness.tools.find((tool) => tool.name === 'memory_search');
    return search.execute({}, { agent }).then((value) => assert.equal(value.count, 0));
  });
});

test('工具：save → search → forget 全链路', () => {
  withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    const search = harness.tools.find((tool) => tool.name === 'memory_search');
    const forget = harness.tools.find((tool) => tool.name === 'memory_forget');

    return save
      .execute({ text: '用户叫 Kaoruko，喜欢被直呼名字', scope: 'global', kind: 'profile', importance: 5 }, { agent })
      .then((saved) => {
        assert.equal(saved.ok, true);
        assert.equal(saved.scope, 'global');
        return search.execute({ query: 'Kaoruko' }, { agent });
      })
      .then((found) => {
        assert.equal(found.count, 1);
        assert.equal(found.results[0].kind, 'profile');
        return forget.execute({ id: found.results[0].id }, { agent });
      })
      .then((removed) => {
        assert.equal(removed.count, 1);
        return search.execute({ query: 'Kaoruko' }, { agent });
      })
      .then((after) => assert.equal(after.count, 0));
  });
});

test('工具：memory_save 缺 text 时抛出可读错误', () => {
  withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    return assert.rejects(() => save.execute({}, { agent }), /text/);
  });
});

test('工具：没有 agent 时拒绝执行', () => {
  withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const search = harness.tools.find((tool) => tool.name === 'memory_search');
    return assert.rejects(() => search.execute({ query: 'x' }, {}), /agent/);
  });
});

test('工具：输出能被各自的 output.render 消费', () => {
  withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    return save.execute({ text: '这个仓库用 pnpm', scope: 'project' }, { agent }).then((value) => {
      const blocks = save.output.render({}, value);
      assert.equal(blocks[0].type, 'text');
      assert.match(blocks[0].text, /pnpm/);
    });
  });
});

test('配置：空配置补全为默认值', () => {
  const result = validateConfig(undefined);
  assert.ok('value' in result);
  assert.equal(result.value.budgetChars, DEFAULTS.budgetChars);
});

test('配置：类型错误会被拒绝', () => {
  const result = validateConfig({ budgetChars: '很多' });
  assert.ok('issues' in result);
  assert.match(result.issues[0].message, /budgetChars/);
});

test('配置：未知键被丢弃，数值被夹取', () => {
  const result = validateConfig({ nope: 1, budgetChars: 999999 });
  assert.ok('value' in result);
  assert.equal(result.value.nope, undefined);
  assert.equal(result.value.budgetChars, 20000);
});
