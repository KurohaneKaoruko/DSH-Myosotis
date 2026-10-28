/**
 * 学习闭环单测：反馈记账、打法浮现、复盘、整理。
 *
 * 这一层的特点是「大部分逻辑不写内容、只改权重和可见性」，
 * 所以断言集中在计数、排序位置、以及「什么不该发生」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../lib/config.js';
import { MemoryService } from '../lib/memory.js';

/**
 * 建一套临时环境。
 * @param {(env: { cwd: string, agent: any, service: MemoryService }) => any} run 测试体。
 * @param {Record<string, any>} [config] 配置覆盖。
 */
function withEnv(run, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'myosotis-learn-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh-home');
  const cwd = join(root, 'project');
  const agent = { id: 'session-learn', session: { header: { id: 'session-learn', cwd }, events: [] } };
  const service = new MemoryService({ config: { ...DEFAULTS, ...config }, logger: () => {} });
  try {
    return run({ cwd, agent, service });
  } finally {
    service.dispose();
    process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 注入一轮，让服务记住「这一轮给了模型什么」。
 * @param {MemoryService} service 服务。
 * @param {any} agent Agent。
 * @param {string} query 用户这句话。
 * @returns {string} 注入文本。
 */
function recall(service, agent, query) {
  service.noteQuery(agent.id, query);
  return service.renderFor(agent);
}

test('反馈：用户说「不对」时给上一轮注入的记忆记一次纠正', () => {
  withEnv(({ cwd, agent, service }) => {
    service.save({ text: '提交信息一律用英文', scope: 'project', kind: 'convention', importance: 4 }, agent);
    recall(service, agent, '提交信息怎么写');

    const result = service.observe('不对，提交信息要用中文', agent);
    assert.equal(result.type, 'correction');
    assert.equal(result.applied, 1);
    assert.equal(service.projectStore(cwd).list()[0].corrections, 1);
  });
});

test('反馈：只标记和纠正句相关的记忆，不牵连身份与关系', () => {
  withEnv(({ cwd, agent, service }) => {
    service.save({ text: '用户叫 Kaoruko，喜欢被直呼名字', scope: 'global', kind: 'profile', importance: 5 }, agent);
    service.save({ text: '提交信息一律用英文', scope: 'project', kind: 'convention', importance: 4 }, agent);
    recall(service, agent, '提交信息怎么写');

    const result = service.observe('不对，提交信息要用中文', agent);
    assert.equal(result.applied, 1, '只该标记提交信息那条');
    assert.equal(service.projectStore(cwd).list()[0].corrections, 1);
    assert.equal(Number(service.globalStore().list()[0].corrections ?? 0), 0, '身份不该被牵连');
  });
});

test('反馈：只说「不对」时只标上一轮最相关的一条', () => {
  withEnv(({ cwd, agent, service }) => {
    service.save({ text: '用户叫 Kaoruko，喜欢被直呼名字', scope: 'global', kind: 'profile', importance: 5 }, agent);
    service.save({ text: '提交信息一律用英文', scope: 'project', kind: 'convention', importance: 4 }, agent);
    recall(service, agent, '提交信息怎么写');

    const result = service.observe('不对', agent);
    assert.equal(result.applied, 1);
    assert.equal(service.projectStore(cwd).list()[0].corrections, 1);
    assert.equal(Number(service.globalStore().list()[0].corrections ?? 0), 0);
  });
});

test('反馈：一次注入只结算一次，重复说「不对」不会连乘', () => {
  withEnv(({ cwd, agent, service }) => {
    service.save({ text: '这个仓库用 pnpm', scope: 'project', kind: 'fact' }, agent);
    recall(service, agent, '这个仓库用什么包管理器');

    service.observe('不对', agent);
    const second = service.observe('不对', agent);
    assert.equal(second.applied, 0);
    assert.equal(service.projectStore(cwd).list()[0].corrections, 1);
  });
});

test('反馈：窗口外不结算', () => {
  withEnv(
    ({ cwd, agent, service }) => {
      service.save({ text: '这个仓库用 pnpm', scope: 'project', kind: 'fact' }, agent);
      recall(service, agent, '用什么包管理器');
      // 手动把注入时间往前拨，模拟隔了很久才回复。
      service.injected.get(agent.id).at = Date.now() - 3600 * 1000;
      const result = service.observe('不对', agent);
      assert.equal(result.applied, 0);
      assert.equal(Number(service.projectStore(cwd).list()[0].corrections ?? 0), 0);
    },
    { feedbackWindowSec: 600 },
  );
});

test('反馈：确认到门槛后自动升一级重要度', () => {
  withEnv(
    ({ cwd, agent, service }) => {
      service.save({ text: '提交信息一律用中文', scope: 'project', kind: 'convention', importance: 3 }, agent);
      for (let index = 0; index < 3; index += 1) {
        recall(service, agent, '提交信息怎么写');
        service.observe('对，就是这样', agent);
      }
      assert.equal(service.projectStore(cwd).list()[0].importance, 4);
    },
    { confirmAfter: 3 },
  );
});

test('反馈：learning=false 时完全不动', () => {
  withEnv(
    ({ agent, service }) => {
      service.save({ text: '这个仓库用 pnpm', scope: 'project' }, agent);
      recall(service, agent, '用什么包管理器');
      assert.equal(service.observe('不对', agent), null);
    },
    { learning: false },
  );
});

test('打法：playbook 单独成段，不占普通记忆的预算', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '改检索排序：先跑 tests/retrieval 看分数，再动权重，最后补一条用例', scope: 'project', kind: 'playbook', importance: 4 }, agent);
    service.save({ text: '提交信息一律用中文', scope: 'project', kind: 'convention', importance: 5 }, agent);

    const text = recall(service, agent, '检索排序怎么调');
    assert.match(text, /### 相关打法/);
    assert.match(text, /tests\/retrieval/);
    // 打法不该出现在普通分组里。
    const routineSection = text.slice(text.indexOf('### 相关打法'));
    assert.match(routineSection, /\[打法\]/);
    const beforeRoutine = text.slice(0, text.indexOf('### 相关打法'));
    assert.ok(!beforeRoutine.includes('tests/retrieval'));
  });
});

test('打法：话题不相关时不浮现', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '改检索排序：先跑 tests/retrieval 看分数，再动权重', scope: 'project', kind: 'playbook' }, agent);
    const text = recall(service, agent, '帮我写个 CSS 动画');
    assert.ok(!text.includes('相关打法'));
  });
});

test('复盘：被纠正过的记忆会出现在可疑清单里', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '提交信息一律用英文', scope: 'project', kind: 'convention' }, agent);
    recall(service, agent, '提交信息怎么写');
    service.observe('不对，要用中文', agent);

    const report = service.review(agent);
    assert.equal(report.suspect.length, 1);
    assert.equal(report.suspect[0].corrections, 1);
    assert.equal(report.growth.total, 1);
  });
});

test('复盘：跨作用域的近似记忆算重复', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '提交信息一律用中文，不要自动 push', scope: 'global', kind: 'convention' }, agent);
    service.save({ text: '提交信息一律用中文，不要自动 push，也不要 amend', scope: 'project', kind: 'convention' }, agent);

    const report = service.review(agent);
    assert.equal(report.duplicates.length, 1);
    assert.ok(report.duplicates[0].similarity >= 0.85);
  });
});

test('复盘：一个说要、一个说不要，算矛盾而不是重复', () => {
  withEnv(({ agent, service }) => {
    service.save({ text: '这个仓库用 pnpm 管理依赖', scope: 'project', kind: 'convention' }, agent);
    service.save({ text: '这个仓库不要用 pnpm 管理依赖', scope: 'project', kind: 'convention' }, agent);

    const report = service.review(agent);
    assert.equal(report.conflicts.length, 1);
    assert.equal(report.duplicates.length, 0, '同一对不该同时出现在两个清单里');
  });
});

test('写入：极性相反的两条不会被合并掉', () => {
  withEnv(({ cwd, agent, service }) => {
    service.save({ text: '这个仓库用 pnpm 管理依赖', scope: 'project', kind: 'convention' }, agent);
    const second = service.save({ text: '这个仓库不要用 pnpm 管理依赖', scope: 'project', kind: 'convention' }, agent);
    assert.equal(second.action, 'created');
    assert.equal(service.projectStore(cwd).list().length, 2);
  });
});

test('整理：被反复检索的记忆会升权', () => {
  withEnv(
    ({ cwd, agent, service }) => {
      const saved = service.save({ text: '提交信息一律用中文', scope: 'project', kind: 'convention', importance: 3 }, agent);
      const store = service.projectStore(cwd);
      for (let index = 0; index < 6; index += 1) store.noteUsed([saved.item.id]);

      const summary = service.consolidate(agent);
      assert.equal(summary.promoted, 1);
      assert.equal(store.list()[0].importance, 4);
    },
    { promoteAfter: 2 },
  );
});

test('整理：dryRun 不落盘', () => {
  withEnv(
    ({ cwd, agent, service }) => {
      const saved = service.save({ text: '提交信息一律用中文', scope: 'project', importance: 3 }, agent);
      const store = service.projectStore(cwd);
      for (let index = 0; index < 6; index += 1) store.noteUsed([saved.item.id]);

      const summary = service.consolidate(agent, { dryRun: true });
      assert.equal(summary.promoted, 1);
      assert.equal(store.list()[0].importance, 3);
    },
    { promoteAfter: 2 },
  );
});

test('整理：aggressive 时把过时的低重要度记忆沉进深记忆', () => {
  withEnv(
    ({ cwd, agent, service }) => {
      service.save({ text: '这个项目曾经用 webpack 打包', scope: 'project', kind: 'fact', importance: 1 }, agent);
      const store = service.projectStore(cwd);
      // 直接改时间戳，模拟「很久没被用过」。
      store.list()[0].updatedAt = Date.now() - 30 * 86400000;

      const summary = service.consolidate(agent, { aggressive: true });
      assert.equal(summary.archived, 1);
      assert.equal(store.list().length, 0);
      assert.equal(service.deep?.stats().count, 1);
    },
    { staleDays: 7 },
  );
});

test('整理：不 aggressive 时不沉底', () => {
  withEnv(
    ({ cwd, agent, service }) => {
      service.save({ text: '这个项目曾经用 webpack 打包', scope: 'project', kind: 'fact', importance: 1 }, agent);
      const store = service.projectStore(cwd);
      store.list()[0].updatedAt = Date.now() - 30 * 86400000;

      const summary = service.consolidate(agent);
      assert.equal(summary.archived, 0);
      assert.equal(store.list().length, 1);
    },
    { staleDays: 7 },
  );
});

test('镜像：MEMORY.md 里有「最近学到的」与「待复核」', () => {
  withEnv(({ cwd, agent, service }) => {
    service.save({ text: '提交信息一律用英文', scope: 'project', kind: 'convention' }, agent);
    recall(service, agent, '提交信息怎么写');
    service.observe('不对，要用中文', agent);
    service.dispose();

    const file = join(cwd, '.dsh', 'memory', 'MEMORY.md');
    assert.ok(existsSync(file));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /## 最近学到的/);
    assert.match(text, /## 待复核/);
    assert.match(text, /纠正 1/);
  });
});

test('检索：被主动检索会记 used，注入只记 hits', () => {
  withEnv(({ cwd, agent, service }) => {
    const saved = service.save({ text: '提交信息一律用中文', scope: 'project', kind: 'convention' }, agent);
    recall(service, agent, '提交信息怎么写');
    const store = service.projectStore(cwd);
    const afterRecall = store.find(saved.item.id);
    assert.equal(Number(afterRecall.used ?? 0), 0);
    assert.equal(Number(afterRecall.hits ?? 0), 1);

    service.search('提交信息', {}, agent);
    assert.equal(Number(store.find(saved.item.id).used ?? 0), 1);
  });
});
