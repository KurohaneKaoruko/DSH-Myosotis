/**
 * 插件装载测试：用假 ctx 验证 apply 的挂载行为。
 *
 * 这里刻意不复用 DSH 的运行时：插件对外只依赖两个服务
 * （`systemPrompt.section` / `tools.register`）和两个事件，
 * 用假 ctx 就能把契约钉死，跑得也快。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS, validateConfig } from '../lib/config.js';
import { apply } from '../lib/index.js';

/** 本文件创建过的假 ctx；每个用例结束时统一卸载，确保 SQLite 句柄被释放。 */
const harnesses = [];

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
  const harness = {
    ctx,
    sections,
    tools,
    cleanups,
    emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) handler(payload);
    },
  };
  harnesses.push(harness);
  return harness;
}

/**
 * 隔离 DSH_HOME 的测试环境；结束时先卸载插件再删临时目录。
 * 用 async 是为了等测试体里的 Promise 跑完再清理——否则 SQLite 句柄会在断言前被关掉。
 * @param {(env: any) => any} run 测试体。
 */
async function withEnv(run) {
  const root = mkdtempSync(join(tmpdir(), 'myosotis-plugin-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh-home');
  const cwd = join(root, 'workspace');
  const agent = {
    id: 'session-1',
    session: { header: { id: 'session-1', cwd }, events: [] },
  };
  try {
    return await run({ root, cwd, agent });
  } finally {
    // 假 ctx 不会自己跑 effect 清理，这里手动卸载，否则 Windows 上 db 文件被占用。
    for (const harness of harnesses.splice(0)) {
      for (const cleanup of harness.cleanups) {
        try {
          cleanup?.();
        } catch {
          /* 清理失败不影响断言结果 */
        }
      }
    }
    process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('apply：注册三个提示词段落与六个工具', () => {
  return withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    assert.deepEqual(
      harness.sections.map((section) => section.name),
      ['memory:policy', 'memory:recall', 'knowledge:recall'],
    );
    assert.deepEqual(harness.sections.map((section) => section.order), [30, 31, 32]);
    assert.deepEqual(
      harness.tools.map((tool) => tool.name),
      ['memory_save', 'memory_search', 'memory_forget', 'memory_review', 'kb_add', 'kb_search', 'kb_remove'],
    );
    for (const tool of harness.tools) {
      assert.equal(tool.parameters.type, 'object');
      assert.equal(typeof tool.output.render, 'function');
      assert.equal(typeof tool.execute, 'function');
    }
  });
});

test('apply：knowledge=false 时不注册知识库段落与工具', () => {
  return withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS, knowledge: false });
    assert.deepEqual(
      harness.sections.map((section) => section.name),
      ['memory:policy', 'memory:recall'],
    );
    assert.deepEqual(
      harness.tools.map((tool) => tool.name),
      ['memory_save', 'memory_search', 'memory_forget', 'memory_review'],
    );
  });
});

test('apply：enabled=false 时什么都不注册', () => {
  return withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS, enabled: false });
    assert.equal(harness.sections.length, 0);
    assert.equal(harness.tools.length, 0);
  });
});

test('apply：policy=false 时只注册注入段落', () => {
  return withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS, policy: false });
    assert.deepEqual(
      harness.sections.map((section) => section.name),
      ['memory:recall', 'knowledge:recall'],
    );
  });
});

test('recall 段落：按当前 agent 渲染出已保存的记忆', () => {
  return withEnv(({ agent }) => {
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
  return withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const recall = harness.sections.find((section) => section.name === 'memory:recall');
    const broken = { id: 'x', session: { header: null, get events() { throw new Error('boom'); } } };
    assert.equal(recall.text({ agent: broken }), '');
  });
});

test('自动捕获：用户说「以后都用 pnpm」时落一条会话记忆', () => {
  return withEnv(({ agent }) => {
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
  return withEnv(({ agent }) => {
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
  return withEnv(({ agent }) => {
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

test('工具：memory_save 支持 scope=deep，检索能捞回来', () => {
  return withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    const search = harness.tools.find((tool) => tool.name === 'memory_search');
    return save
      .execute({ text: '2026-10 那次重构把状态机拆成了三个 reducer', scope: 'deep', kind: 'episode' }, { agent })
      .then((saved) => {
        assert.equal(saved.scope, 'deep');
        assert.equal(saved.total, 1);
        return search.execute({ query: '状态机' }, { agent });
      })
      .then((found) => {
        assert.equal(found.count, 1);
        assert.equal(found.results[0].scope, 'deep');
      });
  });
});

test('工具：memory_save 缺 text 时抛出可读错误', () => {
  return withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    return assert.rejects(() => save.execute({}, { agent }), /text/);
  });
});

test('工具：没有 agent 时拒绝执行', () => {
  return withEnv(() => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const search = harness.tools.find((tool) => tool.name === 'memory_search');
    return assert.rejects(() => search.execute({ query: 'x' }, {}), /agent/);
  });
});

test('工具：输出能被各自的 output.render 消费', () => {
  return withEnv(({ agent }) => {
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

test('工具：kb_add → kb_search 全链路，结果带文件与行号', () => {
  return withEnv(({ cwd, agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const docs = join(cwd, 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'design.md'), '# 设计\n\n## 切块\n\nMarkdown 按标题切块，代码按声明切块。\n', 'utf8');

    const add = harness.tools.find((tool) => tool.name === 'kb_add');
    const search = harness.tools.find((tool) => tool.name === 'kb_search');
    return add
      .execute({ path: 'docs' }, { agent })
      .then((summary) => {
        assert.equal(summary.ok, true);
        assert.equal(summary.added, 1);
        assert.equal(summary.chunks, 2);
        assert.equal(summary.documents[0].rel, 'docs/design.md');
        return search.execute({ query: '按标题切块' }, { agent });
      })
      .then((found) => {
        assert.equal(found.count, 1);
        assert.equal(found.results[0].heading, '切块');
        assert.equal(found.results[0].rel, 'docs/design.md');
        assert.ok(found.results[0].startLine >= 3);
        assert.match(found.results[0].text, /按标题切块/);
      });
  });
});

test('工具：kb_search 空查询时列出已索引文档', () => {
  return withEnv(({ cwd, agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'a.md'), '# 甲\n\n正文。\n', 'utf8');

    const add = harness.tools.find((tool) => tool.name === 'kb_add');
    const search = harness.tools.find((tool) => tool.name === 'kb_search');
    return add
      .execute({ path: 'docs' }, { agent })
      .then(() => search.execute({}, { agent }))
      .then((listed) => {
        assert.equal(listed.count, 0);
        assert.equal(listed.documents.length, 1);
        assert.equal(listed.documents[0].title, '甲');
      });
  });
});

test('工具：kb_add 路径不存在时抛出可读错误', () => {
  return withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const add = harness.tools.find((tool) => tool.name === 'kb_add');
    return assert.rejects(() => add.execute({ path: 'not-there' }, { agent }), /路径不存在/);
  });
});

test('工具：kb_remove 按 id 删除，检索不到', () => {
  return withEnv(({ cwd, agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'a.md'), '# 甲\n\n要删掉的部署说明。\n', 'utf8');

    const add = harness.tools.find((tool) => tool.name === 'kb_add');
    const search = harness.tools.find((tool) => tool.name === 'kb_search');
    const remove = harness.tools.find((tool) => tool.name === 'kb_remove');
    return add
      .execute({ path: 'docs' }, { agent })
      .then((summary) => remove.execute({ id: summary.documents[0].id }, { agent }))
      .then((removed) => {
        assert.equal(removed.count, 1);
        assert.equal(removed.needConfirm, false);
        return search.execute({ query: '部署' }, { agent });
      })
      .then((after) => assert.equal(after.count, 0));
  });
});

test('工具：memory_review 返回复盘结构，render 能消费', () => {
  return withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    const review = harness.tools.find((tool) => tool.name === 'memory_review');
    return save
      .execute({ text: '提交信息一律用中文', scope: 'project', kind: 'convention' }, { agent })
      .then(() => review.execute({}, { agent }))
      .then((value) => {
        assert.equal(value.growth.total, 1);
        assert.deepEqual(value.suspect, []);
        assert.deepEqual(value.duplicates, []);
        const blocks = review.output.render({}, value);
        assert.equal(blocks[0].type, 'text');
        assert.match(blocks[0].text, /记忆复盘/);
      });
  });
});

test('学习：用户说「不对」后，复盘里出现可疑条目', () => {
  return withEnv(({ agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    const save = harness.tools.find((tool) => tool.name === 'memory_save');
    const review = harness.tools.find((tool) => tool.name === 'memory_review');
    const recall = harness.sections.find((section) => section.name === 'memory:recall');

    return save
      .execute({ text: '提交信息一律用英文', scope: 'project', kind: 'convention', importance: 4 }, { agent })
      .then(() => {
        // 先渲染一次注入，服务才知道「这一轮给了模型什么」。
        recall.text({ agent });
        harness.emit('agent/inbox/claimed', {
          agent,
          message: { content: [{ type: 'text', text: '不对，提交信息要用中文' }], source: { kind: 'user' } },
        });
        return review.execute({}, { agent });
      })
      .then((value) => {
        assert.equal(value.suspect.length, 1);
        assert.equal(value.suspect[0].corrections, 1);
        const blocks = review.output.render({}, value);
        assert.match(blocks[0].text, /被纠正过/);
      });
  });
});

test('知识库段落：按当前输入注入摘录，带出处', () => {
  return withEnv(({ cwd, agent }) => {
    const harness = createCtx();
    apply(harness.ctx, { ...DEFAULTS });
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'faq.md'), '# 常见问题\n\n## 为什么不用向量检索\n\n注入在请求组装路径上，不能发网络请求。\n', 'utf8');

    const add = harness.tools.find((tool) => tool.name === 'kb_add');
    return add
      .execute({ path: 'docs' }, { agent })
      .then(() => {
        harness.emit('agent/inbox/claimed', {
          agent,
          message: { content: [{ type: 'text', text: '为什么不用向量检索？' }], source: { kind: 'user' } },
        });
        const recall = harness.sections.find((section) => section.name === 'knowledge:recall');
        const text = recall.text({ agent });
        assert.match(text, /知识库摘录/);
        assert.match(text, /docs\/faq\.md/);
        assert.match(text, /为什么不用向量检索/);
        // 没有 agent 的组装必须安全降级。
        assert.equal(recall.text({}), '');
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
