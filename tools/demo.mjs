#!/usr/bin/env node
/**
 * tools/demo.mjs —— 不开 DSH，看注入块长什么样。
 *
 *   node tools/demo.mjs
 *   node tools/demo.mjs "帮我改一下提交信息"
 *
 * 会在系统临时目录里造一份假环境（全局 + 项目 + 会话各几条记忆），
 * 打印「模型实际会看到的记忆块」，跑完就删，不碰你真实的记忆文件。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../lib/config.js';
import { MemoryService } from '../lib/memory.js';

const query = process.argv.slice(2).join(' ') || '帮我把这个改动提交了';
const root = mkdtempSync(join(tmpdir(), 'myosotis-demo-'));
const previous = process.env.DSH_HOME;
process.env.DSH_HOME = join(root, 'dsh-home');
const cwd = join(root, 'DSH-Myosotis');

const agent = { id: 'demo-session', session: { header: { id: 'demo-session', cwd }, events: [] } };
const service = new MemoryService({ config: { ...DEFAULTS }, logger: () => {} });

try {
  service.save({ text: '用户叫 Kaoruko，喜欢被直呼名字，讨厌客套和总结陈词', scope: 'global', kind: 'profile', importance: 5 }, agent);
  service.save({ text: '偏好 TypeScript 严格模式，不接受为了省事加 any', scope: 'global', kind: 'preference', importance: 4, tags: ['typescript'] }, agent);
  service.save({ text: '深夜写代码时容易焦虑，先给结论再解释细节', scope: 'global', kind: 'bond', importance: 4, affect: { label: '在意', intensity: 4 } }, agent);
  service.save({ text: '提交信息一律用中文，不要自动 push', scope: 'project', kind: 'convention', importance: 5, tags: ['git'] }, agent);
  service.save({ text: '这个仓库用 pnpm，不要引入 npm 的 lock 文件', scope: 'project', kind: 'gotcha', importance: 4 }, agent);
  service.save({ text: '2026-10 一起把检索从分作用域 IDF 改成全局 IDF，他发现问题时很兴奋', scope: 'global', kind: 'episode', importance: 3, affect: { label: '兴奋', intensity: 3 }, date: '10-24' }, agent);
  service.save({ text: '这轮在调记忆注入的预算', scope: 'session', kind: 'fact', importance: 2 }, agent);

  service.noteQuery(agent.id, query);
  const block = service.renderFor(agent);

  console.log(`当前输入：${query}`);
  console.log(`工作目录：${cwd}`);
  console.log('─'.repeat(60));
  console.log(block || '（没有可注入的记忆）');
  console.log('─'.repeat(60));
  console.log(`字符数：${block.length} / 预算 ${DEFAULTS.budgetChars}`);
} finally {
  service.dispose();
  process.env.DSH_HOME = previous;
  rmSync(root, { recursive: true, force: true });
}
