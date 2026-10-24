#!/usr/bin/env node
/**
 * tools/memory.mjs —— 不开 DSH 也能维护记忆。
 *
 *   node tools/memory.mjs stats
 *   node tools/memory.mjs list --scope project
 *   node tools/memory.mjs search 提交信息
 *   node tools/memory.mjs add "提交信息一律用中文" --scope project --kind convention --importance 5
 *   node tools/memory.mjs pin m_xxx
 *   node tools/memory.mjs rm m_xxx
 *   node tools/memory.mjs export --scope global
 *   node tools/memory.mjs path
 *
 * 和插件读写的是同一批文件，所以改完重启 DSH 就会生效（或者下一次组装提示词时生效）。
 * 环境变量 DSH_HOME 与插件一致，默认 `~/.dsh`。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULTS } from '../lib/config.js';
import { MemoryService } from '../lib/memory.js';
import { globalDir, projectDir, sessionFile } from '../lib/paths.js';
import { KIND_LABELS, KINDS } from '../lib/store.js';

/**
 * 解析 `--key value` / `--flag` 形式的参数。
 * @param {string[]} argv 原始参数。
 * @returns {{ _: string[], [key: string]: any }} 解析结果。
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

/**
 * 造一个假的 agent，让 MemoryService 能在 CLI 里复用。
 * @param {string} cwd 工作目录。
 * @param {string} sessionId 会话 id。
 * @returns {any} agent 形状。
 */
function fakeAgent(cwd, sessionId) {
  return { id: sessionId, session: { header: { id: sessionId, cwd }, events: [] } };
}

/**
 * 终端显示宽度：CJK 与全角字符占两列。
 * @param {string} text 文本。
 * @returns {number} 列数。
 */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
  }
  return width;
}

/**
 * 打印一张表（按显示宽度对齐，中文不会错位）。
 * @param {string[]} headers 表头。
 * @param {string[][]} rows 行。
 */
function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index]))));
  const line = (cells) => cells.map((cell, index) => String(cell ?? '') + ' '.repeat(Math.max(0, widths[index] - displayWidth(cell)))).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';
const cwd = resolve(typeof args.cwd === 'string' ? args.cwd : process.cwd());
const sessionId = typeof args.session === 'string' ? args.session : 'cli';
const agent = fakeAgent(cwd, sessionId);
const service = new MemoryService({ config: { ...DEFAULTS }, logger: (message) => console.error(message) });

/**
 * 把作用域过滤参数转成数组。
 * @returns {string[] | undefined} 作用域列表。
 */
function scopeFilter() {
  const scope = typeof args.scope === 'string' ? args.scope : undefined;
  if (!scope) return undefined;
  if (!['global', 'project', 'session'].includes(scope)) {
    console.error(`未知作用域：${scope}（可选 global / project / session）`);
    process.exit(1);
  }
  return [scope];
}

try {
  switch (command) {
    case 'stats': {
      const stats = service.stats(agent);
      table(
        ['作用域', '条数'],
        [
          ['global', String(stats.global)],
          ['project', String(stats.project)],
          ['session', String(stats.session)],
          ['置顶', String(stats.pinned)],
        ],
      );
      console.log('');
      console.log(`记忆根目录：${stats.root}`);
      break;
    }

    case 'list': {
      const scopes = scopeFilter() ?? ['global', 'project', 'session'];
      let total = 0;
      for (const scope of scopes) {
        const store = service.storeFor(scope, agent);
        const items = [...store.list()].sort((a, b) => Number(b.importance) - Number(a.importance) || Number(b.updatedAt) - Number(a.updatedAt));
        console.log(`\n## ${scope}（${items.length} 条）${store.file}`);
        if (items.length === 0) continue;
        total += items.length;
        table(
          ['id', '类型', '重要度', '置顶', '内容'],
          items.map((item) => [item.id, KIND_LABELS[item.kind] ?? item.kind, String(item.importance), item.pinned ? '★' : '', item.text]),
        );
      }
      if (total === 0) console.log('\n（还没有记忆）');
      break;
    }

    case 'search': {
      const query = args._.slice(1).join(' ');
      if (!query) {
        console.error('用法：node tools/memory.mjs search <关键词>');
        process.exit(1);
      }
      const results = service.search(query, { scopes: scopeFilter(), limit: Number(args.limit ?? 10) }, agent);
      if (results.length === 0) {
        console.log('没有匹配的记忆。');
        break;
      }
      table(
        ['id', '作用域', '类型', '分数', '内容'],
        results.map((hit) => [hit.id, hit.scope, KIND_LABELS[hit.kind] ?? hit.kind, hit.score.toFixed(2), hit.text]),
      );
      break;
    }

    case 'add': {
      const text = args._.slice(1).join(' ');
      if (!text) {
        console.error('用法：node tools/memory.mjs add "要记住的内容" [--scope global|project|session]');
        process.exit(1);
      }
      const kind = typeof args.kind === 'string' ? args.kind : 'fact';
      if (!KINDS.includes(kind)) {
        console.error(`未知类型：${kind}（可选 ${KINDS.join(' / ')}）`);
        process.exit(1);
      }
      const result = service.save(
        {
          text,
          scope: typeof args.scope === 'string' ? args.scope : 'project',
          kind,
          importance: Number(args.importance ?? 3),
          pinned: Boolean(args.pin),
          tags: typeof args.tags === 'string' ? args.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
        },
        agent,
      );
      console.log(`${result.action === 'created' ? '已记住' : '已更新'} ${result.item.id}（${result.scope}·${KIND_LABELS[result.item.kind]}）`);
      break;
    }

    case 'rm': {
      const id = args._[1];
      if (!id) {
        console.error('用法：node tools/memory.mjs rm <id>');
        process.exit(1);
      }
      const result = service.forget({ id }, agent);
      console.log(result.removed.length > 0 ? `已删除 ${id}` : `没有找到 ${id}`);
      break;
    }

    case 'pin': {
      const id = args._[1];
      if (!id) {
        console.error('用法：node tools/memory.mjs pin <id> [--off]');
        process.exit(1);
      }
      const found = service.findAcross(id, agent);
      if (!found) {
        console.error(`没有找到 ${id}`);
        process.exit(1);
      }
      found.store.update(id, { pinned: !args.off });
      console.log(`${args.off ? '已取消置顶' : '已置顶'} ${id}`);
      break;
    }

    case 'export': {
      const scope = typeof args.scope === 'string' ? args.scope : 'global';
      const store = service.storeFor(scope, agent);
      console.log(JSON.stringify({ scope, file: store.file, items: store.list() }, null, 2));
      break;
    }

    case 'path': {
      console.log(`DSH_HOME   ${process.env.DSH_HOME || '~/.dsh'}`);
      console.log(`global     ${globalDir(DEFAULTS.globalDir)}`);
      console.log(`project    ${projectDir(cwd, DEFAULTS.projectDir)}`);
      console.log(`session    ${sessionFile(globalDir(DEFAULTS.globalDir), sessionId)}`);
      break;
    }

    case 'import': {
      const file = args._[1];
      if (!file) {
        console.error('用法：node tools/memory.mjs import <file.json> [--scope global|project|session]');
        process.exit(1);
      }
      const payload = JSON.parse(readFileSync(file, 'utf8'));
      const items = Array.isArray(payload) ? payload : payload.items;
      if (!Array.isArray(items)) {
        console.error('文件里没有 items 数组');
        process.exit(1);
      }
      let added = 0;
      for (const item of items) {
        service.save({ ...item, scope: typeof args.scope === 'string' ? args.scope : item.scope ?? 'project' }, agent);
        added += 1;
      }
      console.log(`导入 ${added} 条。`);
      break;
    }

    default: {
      console.log(`dsh-myosotis CLI

  stats                              统计
  list [--scope S]                   列出
  search <关键词> [--limit N]        检索
  add "<内容>" [--scope S] [--kind K] [--importance 1-5] [--tags a,b] [--pin]
  rm <id>                            删除
  pin <id> [--off]                   置顶 / 取消
  export [--scope S]                 导出 JSON
  import <file.json> [--scope S]     导入 JSON
  path                               显示文件位置

作用域：global / project / session（默认 project；search/list 默认全部）
当前工作目录：${cwd}
`);
    }
  }
} finally {
  service.dispose();
}
