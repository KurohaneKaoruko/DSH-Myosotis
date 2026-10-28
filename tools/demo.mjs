#!/usr/bin/env node
/**
 * tools/demo.mjs —— 不开 DSH，看注入块长什么样。
 *
 *   node tools/demo.mjs
 *   node tools/demo.mjs "帮我改一下提交信息"
 *   node tools/demo.mjs "知识库的切块策略是什么"
 *
 * 会在系统临时目录里造一份假环境（全局 + 项目 + 会话记忆，外加一个已入库的文档），
 * 打印「模型实际会看到的记忆块与知识库摘录」，跑完就删，不碰你真实的记忆文件。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../lib/config.js';
import { KnowledgeService } from '../lib/kb-service.js';
import { MemoryService } from '../lib/memory.js';
import { QueryTracker } from '../lib/queries.js';

const query = process.argv.slice(2).join(' ') || '帮我把这个改动提交了';
const root = mkdtempSync(join(tmpdir(), 'myosotis-demo-'));
const previous = process.env.DSH_HOME;
process.env.DSH_HOME = join(root, 'dsh-home');
const cwd = join(root, 'DSH-Myosotis');

const agent = { id: 'demo-session', session: { header: { id: 'demo-session', cwd }, events: [] } };
const queries = new QueryTracker();
const service = new MemoryService({ config: { ...DEFAULTS }, logger: () => {}, queries });
const knowledge = new KnowledgeService({ config: { ...DEFAULTS }, logger: () => {}, queries });

try {
  service.save({ text: '用户叫 Kaoruko，喜欢被直呼名字，讨厌客套和总结陈词', scope: 'global', kind: 'profile', importance: 5 }, agent);
  service.save({ text: '偏好 TypeScript 严格模式，不接受为了省事加 any', scope: 'global', kind: 'preference', importance: 4, tags: ['typescript'] }, agent);
  service.save({ text: '深夜写代码时容易焦虑，先给结论再解释细节', scope: 'global', kind: 'bond', importance: 4, affect: { label: '在意', intensity: 4 } }, agent);
  service.save({ text: '提交信息一律用中文，不要自动 push', scope: 'project', kind: 'convention', importance: 5, tags: ['git'] }, agent);
  service.save({ text: '这个仓库用 pnpm，不要引入 npm 的 lock 文件', scope: 'project', kind: 'gotcha', importance: 4 }, agent);
  service.save({ text: '2026-10 一起把检索从分作用域 IDF 改成全局 IDF，他发现问题时很兴奋', scope: 'global', kind: 'episode', importance: 3, affect: { label: '兴奋', intensity: 3 }, date: '10-24' }, agent);
  service.save({ text: '这轮在调记忆注入的预算', scope: 'session', kind: 'fact', importance: 2 }, agent);
  service.save({ text: '2025-03 那次也卡在同样的检索排序上，最后是靠把 IDF 提到整池才算对', scope: 'deep', kind: 'episode', importance: 3 }, agent);

  const docs = join(cwd, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(
    join(docs, 'design.md'),
    [
      '# 设计取舍',
      '',
      '## 为什么不用向量检索',
      '',
      '注入发生在每一轮请求的组装路径上，要求同步、毫秒级、不发网络请求。',
      '向量检索需要 embedding 调用，这三条全破，所以用词法检索加 IDF 加权。',
      '',
      '## 切块策略',
      '',
      'Markdown 按标题切，代码按声明切，纯文本按段落切。每块保留原文行号，',
      '引用时能指回文件。',
      '',
    ].join('\n'),
    'utf8',
  );
  knowledge.add({ path: 'docs' }, agent);

  service.noteQuery(agent.id, query);
  const memoryBlock = service.renderFor(agent);
  const knowledgeBlock = knowledge.renderFor(agent);

  console.log(`当前输入：${query}`);
  console.log(`工作目录：${cwd}`);
  console.log('─'.repeat(60));
  console.log(memoryBlock || '（没有可注入的记忆）');
  console.log('─'.repeat(60));
  console.log(knowledgeBlock || '（这一轮没有相关知识库摘录）');
  console.log('─'.repeat(60));
  console.log(`字符数：记忆 ${memoryBlock.length} / ${DEFAULTS.budgetChars}，知识库 ${knowledgeBlock.length} / ${DEFAULTS.kbBudgetChars}`);

  // ── 学习闭环：纠正 → 复盘 ─────────────────────────────────────────────
  const wrong = service.save({ text: '提交信息一律用英文', scope: 'project', kind: 'convention', importance: 4 }, agent);
  service.noteQuery(agent.id, '提交信息怎么写');
  service.renderFor(agent);
  const observed = service.observe('不对，提交信息要用中文', agent);
  const report = service.review(agent);

  console.log('');
  console.log('─'.repeat(60));
  console.log(`用户接着说「不对，提交信息要用中文」→ 记了一次纠正（${observed?.applied ?? 0} 条受影响）`);
  console.log('下一轮 memory_review 会看到：');
  for (const item of report.suspect) {
    console.log(`  [${item.scope}·${item.kind}] ${item.text}（纠正 ${item.corrections} / 确认 ${item.confirmed}，id: ${item.id}）`);
  }
  console.log(`  成长：现有 ${report.growth.total} 条，7 天内新增 ${report.growth.added7d} 条，打法 ${report.growth.playbooks} 条`);
  void wrong;
} finally {
  knowledge.dispose();
  service.dispose();
  process.env.DSH_HOME = previous;
  rmSync(root, { recursive: true, force: true });
}
