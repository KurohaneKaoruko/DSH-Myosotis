#!/usr/bin/env node
/**
 * tools/kb.mjs —— 不开 DSH 也能维护知识库。
 *
 *   node tools/kb.mjs add docs            # 目录增量同步
 *   node tools/kb.mjs add README.md       # 单篇
 *   node tools/kb.mjs search 提交信息      # 检索（带出处）
 *   node tools/kb.mjs list                # 列出已索引文档
 *   node tools/kb.mjs rm d_xxx            # 按 id 删
 *   node tools/kb.mjs rm docs --yes       # 按目录删
 *   node tools/kb.mjs stats
 *   node tools/kb.mjs export backup.json
 *   node tools/kb.mjs vacuum
 *   node tools/kb.mjs path
 *
 * 和插件读写同一个 `knowledge.db`，所以入库后下一轮对话就能检索到。
 * 环境变量 DSH_HOME 与插件一致，默认 `~/.dsh`。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULTS } from '../lib/config.js';
import { KnowledgeService } from '../lib/kb-service.js';
import { knowledgeDir, knowledgeFile } from '../lib/paths.js';
import { formatBytes, formatDay, parseArgs, table } from './format.mjs';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';
const cwd = resolve(typeof args.cwd === 'string' ? args.cwd : process.cwd());
const sessionId = typeof args.session === 'string' ? args.session : 'cli';

/** 造一个假 agent，让服务层能在 CLI 里复用。 */
const agent = { id: sessionId, session: { header: { id: sessionId, cwd }, events: [] } };

const config = { ...DEFAULTS };
const service = new KnowledgeService({ config, logger: (message) => console.error(message) });

/**
 * 确认服务可用，否则直接退出。
 * @returns {any} 存储实例。
 */
function store() {
  if (!service.store || !service.store.open()) {
    console.error('知识库不可用：当前 Node 没有 node:sqlite，或配置里 knowledge 被关掉了。');
    process.exit(1);
  }
  return service.store;
}

/**
 * 打印一篇文档的一行。
 * @param {Record<string, any>} doc 文档。
 * @returns {string[]} 行。
 */
function docRow(doc) {
  return [doc.id, doc.rel || doc.path, doc.title, String(doc.chunks), formatBytes(doc.bytes), formatDay(doc.updatedAt)];
}

try {
  switch (command) {
    case 'add':
    case 'sync': {
      const path = args._.slice(1).join(' ');
      const summary = service.add({ path, scope: args.global ? 'global' : 'project', recursive: !args['no-recursive'] }, agent);
      console.log(`目标：${summary.target}（${summary.kind === 'directory' ? '目录' : '文件'}）`);
      console.log(`新增 ${summary.added}，更新 ${summary.updated}，未变 ${summary.skipped}，删除 ${summary.removed}，失败 ${summary.failed}`);
      console.log(`共 ${summary.documents.length} 篇、${summary.chunks} 块。`);
      if (summary.errors.length > 0) {
        console.log('\n失败：');
        for (const item of summary.errors) console.log(`  ${item.path}：${item.reason}`);
      }
      break;
    }

    case 'search': {
      const query = args._.slice(1).join(' ');
      if (!query) {
        console.error('用法：node tools/kb.mjs search <关键词> [--limit N] [--path P]');
        process.exit(1);
      }
      const { hits } = service.search(query, { limit: Number(args.limit ?? 8), path: typeof args.path === 'string' ? args.path : '' }, agent);
      if (hits.length === 0) {
        console.log('没有匹配的片段。');
        break;
      }
      for (const [index, hit] of hits.entries()) {
        const where = [hit.rel || hit.path, hit.heading].filter(Boolean).join(' › ');
        const range = hit.startLine > 0 ? `L${hit.startLine}${hit.endLine > hit.startLine ? `-${hit.endLine}` : ''}` : '';
        console.log(`\n${index + 1}. ${where}${range ? `（${range}）` : ''}  [${hit.score.toFixed(2)}]`);
        console.log(`   ${hit.text.replace(/\n/gu, '\n   ')}`);
      }
      break;
    }

    case 'list': {
      const docs = service.list(agent, Number(args.limit ?? 200));
      if (docs.length === 0) {
        console.log('知识库还是空的。先跑 `node tools/kb.mjs add docs`。');
        break;
      }
      table(['id', '路径', '标题', '块数', '大小', '更新'], docs.map(docRow));
      break;
    }

    case 'rm': {
      const target = args._[1];
      if (!target) {
        console.error('用法：node tools/kb.mjs rm <id|path> [--yes]');
        process.exit(1);
      }
      const result = service.remove({ id: target.startsWith('d_') ? target : undefined, path: target.startsWith('d_') ? undefined : target, confirm: Boolean(args.yes) }, agent);
      if (result.needConfirm) {
        console.log(`匹配到 ${result.candidates.length} 篇，尚未删除。确认后加 --yes：`);
        table(['id', '路径', '标题', '块数', '大小', '更新'], result.candidates.map(docRow));
        break;
      }
      if (result.removed.length === 0) {
        console.log('没有找到对应的文档。');
        break;
      }
      console.log(`已移除 ${result.removed.length} 篇：`);
      for (const doc of result.removed) console.log(`  ${doc.rel || doc.path}`);
      break;
    }

    case 'stats': {
      const stats = service.stats(agent);
      if (!stats.enabled) {
        console.error('知识库不可用：当前 Node 没有 node:sqlite，或配置里 knowledge 被关掉了。');
        process.exit(1);
      }
      table(
        ['项', '值'],
        [
          ['文档', String(stats.docs)],
          ['块', String(stats.chunks)],
          ['本项文档', String(stats.documents)],
          ['库大小', formatBytes(stats.bytes)],
          ['检索方式', stats.fts ? 'FTS5' : 'LIKE（FTS 不可用）'],
          ['最早', formatDay(stats.oldest)],
          ['最近', formatDay(stats.newest)],
          ['文件', stats.file],
        ],
      );
      break;
    }

    case 'export': {
      const file = args._[1];
      const payload = JSON.stringify({ exportedAt: Date.now(), ...store().exportAll() }, null, 2);
      if (file) {
        writeFileSync(file, payload, 'utf8');
        console.log(`已导出到 ${file}`);
      } else {
        console.log(payload);
      }
      break;
    }

    case 'vacuum': {
      const before = store().stats().bytes;
      store().vacuum();
      const after = store().stats().bytes;
      console.log(`已压缩：${formatBytes(before)} → ${formatBytes(after)}`);
      break;
    }

    case 'path': {
      console.log(`DSH_HOME   ${process.env.DSH_HOME || '~/.dsh'}`);
      console.log(`knowledge  ${knowledgeFile(service.root, DEFAULTS.kbPath)}`);
      console.log(`默认目录   ${knowledgeDir(cwd, DEFAULTS.kbDir)}`);
      console.log(`工作目录   ${cwd}`);
      break;
    }

    default: {
      console.log(`dsh-myosotis 知识库 CLI

  add [path] [--global] [--no-recursive]   入库（目录会增量同步；默认扫 ${DEFAULTS.kbDir}/）
  sync [path]                              同 add
  search <关键词> [--limit N] [--path P]   检索，带文件 / 标题 / 行号
  list [--limit N]                         列出已索引文档
  rm <id|path> [--yes]                     移除（只删索引，不动文件）
  stats                                    统计
  export [file.json]                       导出 JSON
  vacuum                                   压缩数据库
  path                                     显示文件位置

当前工作目录：${cwd}
`);
    }
  }
} finally {
  service.dispose();
}
