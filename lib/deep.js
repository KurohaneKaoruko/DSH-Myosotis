/**
 * 深记忆：SQLite 归档层。
 *
 * 前三层（global / project / session）是「每轮都可能被注入」的精选记忆，
 * 条目少、必须能在提示词里读完。这一层相反：**量可以很大，默认不进上下文，
 * 只在被检索时浮出来**。
 *
 * 用 `node:sqlite`（Node 22.5+ 内置，DSH 运行时是 Node 24），所以仍然是零依赖：
 * 不需要 better-sqlite3，不需要编译，不需要额外二进制。
 *
 * 检索用 FTS5 建在**自己分词后的 token 串**上，而不是原文：
 * FTS5 默认的 unicode61 分词器会把一整句中文当成一个词，中文根本搜不出来；
 * 把 `提交信息` 拆成 `提交 交信 信息` 再建索引，中英文才能走同一套查询。
 *
 * 拿不到 `node:sqlite`（老运行时、被裁剪的构建）时整层静默禁用，
 * 前三层照常工作——深记忆是增益，不是前置条件。
 *
 * @module dsh-myosotis/deep
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { createId, KINDS } from './store.js';
import { tokenize, truncate } from './text.js';

/** 深记忆单条文本上限。比精选层宽松，容得下整段复盘。 */
const MAX_TEXT = 8000;

/** FTS 候选池上限：先粗排这么多个，再用 JS 精排。 */
const CANDIDATES = 200;

/** 表结构与索引。幂等，每次打开都执行。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL DEFAULT 'deep',
  project          TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL DEFAULT 'fact',
  text             TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '',
  tokens           TEXT NOT NULL DEFAULT '',
  importance       INTEGER NOT NULL DEFAULT 3,
  pinned           INTEGER NOT NULL DEFAULT 0,
  affect_label     TEXT,
  affect_intensity INTEGER,
  date             TEXT,
  session_id       TEXT,
  source           TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 0,
  last_used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deep_project ON memories(project, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_deep_created ON memories(created_at DESC);
`;

/** FTS 表；建立失败时降级为 LIKE 查询。 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(tokens, id UNINDEXED, tokenize='unicode61');
`;

/**
 * 取内置 sqlite 模块。
 * @returns {any | undefined} 模块；运行时不支持时 undefined。
 */
function sqliteModule() {
  try {
    return process.getBuiltinModule?.('node:sqlite');
  } catch {
    return undefined;
  }
}

/**
 * 当前运行时是否支持 SQLite 深记忆。
 * @returns {boolean} 是否可用。
 */
export function sqliteAvailable() {
  const module = sqliteModule();
  return typeof module?.DatabaseSync === 'function';
}

/**
 * 深记忆存储。
 */
export class DeepStore {
  /**
   * @param {object} options 选项。
   * @param {string} options.file 数据库文件路径。
   * @param {number} [options.maxEntries=20000] 条目上限，超出按保留分数淘汰。
   * @param {(message: string) => void} [options.logger] 告警输出。
   */
  constructor({ file, maxEntries = 20000, logger }) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.log = logger ?? (() => {});
    /** @type {any} */
    this.db = null;
    /** FTS5 是否可用（不可用时退回 LIKE 扫描）。 */
    this.fts = false;
    this.closed = false;
  }

  /**
   * 打开数据库并建表。失败时保持关闭状态，调用方据此降级。
   * @returns {boolean} 是否可用。
   */
  open() {
    if (this.db) return true;
    const module = sqliteModule();
    if (typeof module?.DatabaseSync !== 'function') {
      this.log('[memory] 当前运行时不支持 node:sqlite，深记忆已禁用');
      return false;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.db = new module.DatabaseSync(this.file);
      // WAL 让「边写边读」不互相阻塞；桌面端单进程也无害。
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(SCHEMA);
      try {
        this.db.exec(FTS_SCHEMA);
        this.fts = true;
      } catch (error) {
        this.fts = false;
        this.log(`[memory] FTS5 不可用，深记忆退回 LIKE 检索：${String(error)}`);
      }
      return true;
    } catch (error) {
      this.log(`[memory] 打开深记忆失败（${this.file}）：${String(error)}`);
      this.db = null;
      return false;
    }
  }

  /** @returns {boolean} 是否已就绪。 */
  get ready() {
    return this.db !== null && !this.closed;
  }

  /**
   * 写入一条深记忆。同 id 覆盖。
   * @param {Record<string, any>} input 字段。
   * @param {object} [defaults] 默认值（项目、会话）。
   * @returns {{ action: 'created'|'updated', item: Record<string, any> }} 结果。
   */
  save(input, defaults = {}) {
    if (!this.open()) throw new Error('深记忆不可用（运行时缺少 node:sqlite）');
    const now = Number(defaults.now ?? Date.now());
    const text = truncate(String(input.text ?? ''), MAX_TEXT);
    if (!text) throw new Error('memory text must not be empty');
    const id = typeof input.id === 'string' && input.id ? input.id : createId(now);
    const existing = this.get(id);
    const existingTags = Array.isArray(existing?.tags) ? existing.tags.join(' ') : '';
    const record = {
      id,
      scope: typeof input.scope === 'string' ? input.scope : 'deep',
      project: String(defaults.project ?? input.project ?? ''),
      kind: KINDS.includes(String(input.kind)) ? String(input.kind) : existing?.kind ?? 'fact',
      text,
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).join(' ') : existingTags,
      tokens: tokensOf(text, input.tags, input.kind),
      importance: clampInt(input.importance, 1, 5, existing?.importance ?? 3),
      pinned: input.pinned === true || existing?.pinned === true ? 1 : 0,
      affect_label: input.affect?.label ?? existing?.affect?.label ?? null,
      affect_intensity: clampInt(input.affect?.intensity, 1, 5, existing?.affect?.intensity ?? 0) || null,
      date: typeof input.date === 'string' && /^\d{2}-\d{2}$/.test(input.date) ? input.date : existing?.date ?? null,
      session_id: defaults.sessionId ?? existing?.sessionId ?? null,
      source: input.source ? JSON.stringify(input.source) : existing?.sourceJson ?? null,
      created_at: existing?.createdAt ?? now,
      updated_at: now,
      hits: existing?.hits ?? 0,
      last_used_at: existing?.lastUsedAt ?? null,
    };

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, scope, project, kind, text, tags, tokens, importance, pinned, affect_label, affect_intensity, date, session_id, source, created_at, updated_at, hits, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             scope=excluded.scope, project=excluded.project, kind=excluded.kind, text=excluded.text,
             tags=excluded.tags, tokens=excluded.tokens, importance=excluded.importance, pinned=excluded.pinned,
             affect_label=excluded.affect_label, affect_intensity=excluded.affect_intensity, date=excluded.date,
             session_id=excluded.session_id, source=excluded.source, updated_at=excluded.updated_at`,
        )
        .run(
          record.id,
          record.scope,
          record.project,
          record.kind,
          record.text,
          record.tags,
          record.tokens,
          record.importance,
          record.pinned,
          record.affect_label,
          record.affect_intensity,
          record.date,
          record.session_id,
          record.source,
          record.created_at,
          record.updated_at,
          record.hits,
          record.last_used_at,
        );
      if (this.fts) {
        this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(record.id);
        this.db.prepare('INSERT INTO memories_fts (tokens, id) VALUES (?, ?)').run(record.tokens, record.id);
      }
    });

    this.prune();
    return { action: existing ? 'updated' : 'created', item: this.get(id) };
  }

  /**
   * 批量归档（会话过期、导入历史用）。
   * @param {Record<string, any>[]} items 记录。
   * @param {object} [defaults] 默认值。
   * @returns {number} 写入条数。
   */
  archive(items, defaults = {}) {
    let count = 0;
    for (const item of items) {
      try {
        this.save(item, defaults);
        count += 1;
      } catch (error) {
        this.log(`[memory] 归档失败：${String(error)}`);
      }
    }
    return count;
  }

  /**
   * 按 id 取一条。
   * @param {string} id 记忆 id。
   * @returns {Record<string, any> | undefined} 记录。
   */
  get(id) {
    if (!this.open()) return undefined;
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id));
    return row ? toRecord(row) : undefined;
  }

  /**
   * 检索。先走 FTS 取候选，再用与精选层相同的打分函数精排。
   * @param {string} query 查询词。
   * @param {object} [options] 选项。
   * @param {number} [options.limit=8] 返回条数。
   * @param {string} [options.project] 当前项目（同时包含不绑定项目的条目）。
   * @param {boolean} [options.touch=true] 是否计入命中。
   * @returns {Record<string, any>[]} 记录，按分数降序。
   */
  search(query, { limit = 8, project, touch = true } = {}) {
    if (!this.open()) return [];
    const tokens = [...new Set(tokenize(query))].slice(0, 24);
    const rows = tokens.length > 0 ? this.candidates(tokens, project) : this.recent(project, limit);
    if (rows.length === 0) return [];

    const ranked = rankRows(rows, query).slice(0, Math.max(1, Math.min(50, limit)));
    if (touch && ranked.length > 0) this.touch(ranked.map((row) => row.id));
    return ranked;
  }

  /**
   * 取候选行：FTS 命中或 LIKE 兜底。
   * @param {string[]} tokens 查询 token。
   * @param {string} [project] 项目过滤。
   * @returns {Record<string, any>[]} 行。
   */
  candidates(tokens, project) {
    const ids = new Set();
    if (this.fts) {
      // 每个 token 用引号包成短语，避免 - / * 之类被当成 FTS 语法。
      const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
      try {
        const hits = this.db.prepare('SELECT id FROM memories_fts WHERE tokens MATCH ? LIMIT ?').all(match, CANDIDATES);
        for (const hit of hits) ids.add(String(hit.id));
      } catch (error) {
        this.log(`[memory] FTS 查询失败，退回 LIKE：${String(error)}`);
      }
    }
    if (ids.size === 0) {
      const clause = tokens.map(() => 'tokens LIKE ?').join(' OR ');
      const params = tokens.map((token) => `% ${token} %`);
      const sql = `SELECT id FROM memories WHERE (${clause}) ORDER BY updated_at DESC LIMIT ${CANDIDATES}`;
      for (const hit of this.db.prepare(sql).all(...params)) ids.add(String(hit.id));
    }
    if (ids.size === 0) return [];

    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    const where = project ? `AND (project = ? OR project = '')` : '';
    const params = project ? [...list, project] : list;
    return this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) ${where}`).all(...params).map(toRecord);
  }

  /**
   * 没有关键词时按新近度列出。
   * @param {string} [project] 项目过滤。
   * @param {number} [limit=8] 条数。
   * @returns {Record<string, any>[]} 行。
   */
  recent(project, limit = 8) {
    const where = project ? `WHERE project = ? OR project = ''` : '';
    const params = project ? [project] : [];
    return this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`)
      .all(...params, limit)
      .map(toRecord);
  }

  /**
   * 记一次命中。
   * @param {string[]} ids 记忆 id。
   */
  touch(ids) {
    if (!this.open() || ids.length === 0) return;
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`UPDATE memories SET hits = hits + 1, last_used_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
  }

  /**
   * 删除。
   * @param {string} id 记忆 id。
   * @returns {Record<string, any> | undefined} 被删除的记录。
   */
  remove(id) {
    if (!this.open()) return undefined;
    const record = this.get(id);
    if (!record) return undefined;
    this.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(String(id));
      if (this.fts) this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(String(id));
    });
    return record;
  }

  /**
   * 超出上限时按保留分数淘汰。
   * @returns {number} 淘汰条数。
   */
  prune() {
    if (!this.open()) return 0;
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM memories').get();
    const excess = Number(count) - this.maxEntries;
    if (excess <= 0) return 0;
    const victims = this.db
      .prepare(
        `SELECT id FROM memories WHERE pinned = 0
         ORDER BY (importance * 100 + MIN(hits, 20) * 5 + (updated_at / 86400000)) ASC
         LIMIT ?`,
      )
      .all(excess);
    for (const victim of victims) this.remove(String(victim.id));
    return victims.length;
  }

  /**
   * 统计。
   * @returns {{ count: number, bytes: number, fts: boolean, oldest: number|null, newest: number|null }} 统计。
   */
  stats() {
    if (!this.open()) return { count: 0, bytes: 0, fts: false, oldest: null, newest: null };
    const row = this.db.prepare('SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(updated_at) AS newest FROM memories').get();
    let bytes = 0;
    try {
      bytes = statSync(this.file).size;
    } catch {
      bytes = 0;
    }
    return { count: Number(row.count ?? 0), bytes, fts: this.fts, oldest: row.oldest ?? null, newest: row.newest ?? null };
  }

  /**
   * 全量导出（CLI / 备份用）。
   * @param {string} [project] 项目过滤。
   * @returns {Record<string, any>[]} 记录。
   */
  exportAll(project) {
    if (!this.open()) return [];
    const where = project ? `WHERE project = ? OR project = ''` : '';
    const params = project ? [project] : [];
    return this.db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at ASC`).all(...params).map(toRecord);
  }

  /**
   * 压缩数据库（删除后回收空间）。
   * @returns {boolean} 是否执行。
   */
  vacuum() {
    if (!this.open()) return false;
    try {
      this.db.exec('VACUUM');
      return true;
    } catch (error) {
      this.log(`[memory] VACUUM 失败：${String(error)}`);
      return false;
    }
  }

  /** 关闭数据库。 */
  close() {    if (!this.db || this.closed) return;
    try {
      this.db.close();
    } catch {
      /* 关闭失败无补救，忽略 */
    }
    this.closed = true;
    this.db = null;
  }

  /**
   * 包一层事务。
   * @param {() => void} body 事务体。
   */
  transaction(body) {
    this.db.exec('BEGIN');
    try {
      body();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw error;
    }
  }

  /**
   * 数据库文件是否存在。
   * @returns {boolean} 是否存在。
   */
  exists() {
    return existsSync(this.file);
  }
}

/**
 * 拼出索引用的 token 串：正文 + 标签 + 类型。
 * @param {string} text 正文。
 * @param {unknown} tags 标签。
 * @param {unknown} kind 类型。
 * @returns {string} 空格分隔的 token。
 */
function tokensOf(text, tags, kind) {
  const parts = [text];
  if (Array.isArray(tags)) parts.push(tags.join(' '));
  if (typeof kind === 'string') parts.push(kind);
  return [...new Set(tokenize(parts.join(' ')))].join(' ');
}

/**
 * 夹取整数。
 * @param {unknown} value 输入。
 * @param {number} min 下界。
 * @param {number} max 上界。
 * @param {number} fallback 回退值。
 * @returns {number} 结果。
 */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * SQLite 行 → 普通对象（字段名转驼峰，布尔转回来）。
 * @param {Record<string, any>} row 行。
 * @returns {Record<string, any>} 记录。
 */
function toRecord(row) {
  return {
    id: String(row.id),
    scope: String(row.scope ?? 'deep'),
    project: String(row.project ?? ''),
    kind: String(row.kind ?? 'fact'),
    text: String(row.text ?? ''),
    tags: String(row.tags ?? '') ? String(row.tags).split(' ').filter(Boolean) : [],
    importance: Number(row.importance ?? 3),
    pinned: Number(row.pinned ?? 0) === 1,
    ...(row.affect_label ? { affect: { label: String(row.affect_label), intensity: Number(row.affect_intensity ?? 3) } } : {}),
    ...(row.date ? { date: String(row.date) } : {}),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    ...(row.source ? { sourceJson: String(row.source) } : {}),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    hits: Number(row.hits ?? 0),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    deep: true,
  };
}

/**
 * 在候选集里用与精选层一致的权重排序。
 * 深记忆量大，词法相关性权重更高、新近度衰减更快。
 * @param {Record<string, any>[]} rows 候选。
 * @param {string} query 查询。
 * @returns {Record<string, any>[]} 排序后的记录（附带 score）。
 */
function rankRows(rows, query) {
  const queryTokens = [...new Set(tokenize(query))];
  const df = new Map();
  for (const row of rows) {
    const seen = new Set(tokenize(row.text));
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, rows.length);
  const now = Date.now();
  const idfOf = (token) => {
    const dfValue = df.get(token) ?? 0;
    return Math.log(1 + (total - dfValue + 0.5) / (dfValue + 0.5));
  };
  // 只把「语料里出现过」的查询词计入分母：库里根本没有的词不该稀释命中。
  const ceiling = queryTokens.reduce((sum, token) => sum + ((df.get(token) ?? 0) > 0 ? idfOf(token) : 0), 0);

  return rows
    .map((row) => {
      const body = new Set(tokenize(row.text));
      const tags = new Set(row.tags);
      let lexical = 0;
      for (const token of queryTokens) {
        const weight = tags.has(token) ? 3 : body.has(token) ? 1 : 0;
        if (weight === 0) continue;
        lexical += idfOf(token) * weight;
      }
      // 归一化：1.0 = 每个查询词都在正文里，标签命中会超过 1（同精选层口径）。
      lexical = ceiling > 0 ? lexical / ceiling : 0;
      const ageDays = Math.max(0, now - Number(row.updatedAt ?? now)) / 86400000;
      const score =
        lexical * 2.6 +
        (Number(row.importance ?? 3) / 5) * 0.6 +
        Math.exp(-ageDays / 120) * 0.25 +
        (row.pinned ? 0.4 : 0) +
        Number(row.affect?.intensity ?? 0) * 0.12;
      return { ...row, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
}
