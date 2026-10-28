/**
 * 知识库：SQLite 里的原文索引。
 *
 * 和记忆的区别不是「重要程度」，而是**形态**：
 * 记忆是结论（一句话，人/模型维护，每轮可能进上下文）；
 * 知识是原文（整篇文档，从磁盘来，只在被检索到时浮出来，且必须带出处）。
 *
 * 三张表：
 *   docs    一篇文档一行：路径、标题、mtime、大小、内容哈希、块数
 *   chunks  一块一行：正文、标题路径、原文行号范围、分词后的 token 串
 *   chunks_fts  FTS5 索引，建在 token 串上（中文必须自己分词，理由同 deep.js）
 *
 * 增量入库：先比 mtime + 大小，变了再比内容哈希，只有内容真的变了才重新切块。
 * 目录同步会把「已经不在磁盘上的文档」一起删掉——知识库要能跟着仓库走，
 * 而不是越攒越脏。
 *
 * @module dsh-myosotis/kb
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative as pathRelative, resolve } from 'node:path';

import { chunkText } from './chunk.js';
import { extractText } from './extract.js';
import { hash32, tokenize } from './text.js';

/** FTS 候选池上限：先粗排这么多，再用 JS 精排。 */
const CANDIDATES = 400;

/** 目录同步时最多返回几条失败原因（够定位问题就行）。 */
const MAX_ERRORS = 5;

/** 表结构与索引。幂等，每次打开都执行。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id         TEXT PRIMARY KEY,
  norm       TEXT NOT NULL,
  path       TEXT NOT NULL,
  rel        TEXT NOT NULL DEFAULT '',
  project    TEXT NOT NULL DEFAULT '',
  scope      TEXT NOT NULL DEFAULT 'project',
  title      TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT 'text',
  bytes      INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL DEFAULT 0,
  hash       TEXT NOT NULL DEFAULT '',
  chunks     INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_norm ON docs(norm);
CREATE INDEX IF NOT EXISTS idx_docs_project ON docs(project, updated_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  ord        INTEGER NOT NULL DEFAULT 0,
  heading    TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  tokens     TEXT NOT NULL DEFAULT '',
  start_line INTEGER NOT NULL DEFAULT 0,
  end_line   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, ord);
`;

/** FTS 表；建立失败时降级为 LIKE 查询。 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(tokens, id UNINDEXED, tokenize='unicode61');
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
 * 当前运行时是否支持 SQLite。
 * @returns {boolean} 是否可用。
 */
export function sqliteAvailable() {
  const module = sqliteModule();
  return typeof module?.DatabaseSync === 'function';
}

/**
 * 路径归一化：统一分隔符、绝对化，Windows 下转小写用于比较与去重。
 * @param {string} value 原始路径。
 * @returns {string} 归一化路径。
 */
export function normalizePath(value) {
  const resolved = resolve(String(value ?? '')).replace(/\\/gu, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 相对项目根的路径（用于展示与引用）；不在项目内时返回空串。
 * @param {string} root 项目根。
 * @param {string} file 文件路径。
 * @returns {string} 形如 `docs/guide.md`。
 */
export function relativePath(root, file) {
  if (!root) return '';
  const rel = pathRelative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return '';
  return rel.replace(/\\/gu, '/');
}

/**
 * 知识库存储。
 */
export class KnowledgeStore {
  /**
   * @param {object} options 选项。
   * @param {string} options.file 数据库文件路径。
   * @param {number} [options.maxChunks=60000] 块数上限，超出时整篇淘汰最久未更新的文档。
   * @param {number} [options.chunkChars=900] 单块字符上限。
   * @param {number} [options.chunkOverlap=120] 相邻块重叠字符数。
   * @param {number} [options.maxFileBytes=2000000] 单文件大小上限。
   * @param {string[]} [options.ignore=[]] 目录同步时额外忽略的目录名。
   * @param {(message: string) => void} [options.logger] 告警输出。
   */
  constructor({ file, maxChunks = 60000, chunkChars = 900, chunkOverlap = 120, maxFileBytes = 2_000_000, ignore = [], logger }) {
    this.file = file;
    this.maxChunks = maxChunks;
    this.chunkChars = chunkChars;
    this.chunkOverlap = chunkOverlap;
    this.maxFileBytes = maxFileBytes;
    this.ignore = new Set(ignore.map((name) => String(name).toLowerCase()));
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
      this.log('[memory] 当前运行时不支持 node:sqlite，知识库已禁用');
      return false;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.db = new module.DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(SCHEMA);
      try {
        this.db.exec(FTS_SCHEMA);
        this.fts = true;
      } catch (error) {
        this.fts = false;
        this.log(`[memory] FTS5 不可用，知识库退回 LIKE 检索：${String(error)}`);
      }
      return true;
    } catch (error) {
      this.log(`[memory] 打开知识库失败（${this.file}）：${String(error)}`);
      this.db = null;
      return false;
    }
  }

  /** @returns {boolean} 是否已就绪。 */
  get ready() {
    return this.db !== null && !this.closed;
  }

  // ── 入库 ────────────────────────────────────────────────────────────────

  /**
   * 入库一个文件（新增或重建）。
   *
   * 三级短路：mtime + 大小没变 → 跳过；变了但内容哈希没变 → 只更新时间戳；
   * 内容真变了才重新提取、切块、重建索引。
   * @param {string} file 文件绝对路径。
   * @param {object} [options] 选项。
   * @param {string} [options.project] 所属项目键（空 = 全局可见）。
   * @param {'project'|'global'} [options.scope='project'] 作用域。
   * @param {string} [options.root=''] 项目根，用来算相对路径。
   * @param {boolean} [options.prune=true] 是否在写完后检查块数上限（批量同步时关掉，最后统一做）。
   * @returns {{ action: 'added'|'updated'|'skipped'|'failed', doc?: Record<string, any>, chunks?: number, reason?: string }} 结果。
   */
  ingest(file, { project = '', scope = 'project', root = '', prune = true } = {}) {
    if (!this.open()) return { action: 'failed', reason: '知识库不可用（运行时缺少 node:sqlite）' };

    let stat;
    try {
      stat = statSync(file);
    } catch {
      return { action: 'failed', reason: '文件不存在或无法访问' };
    }
    if (!stat.isFile()) return { action: 'failed', reason: '不是普通文件' };

    const norm = normalizePath(file);
    const existing = this.docByNorm(norm);
    const mtime = Math.round(stat.mtimeMs);
    if (existing && Number(existing.mtime) === mtime && Number(existing.bytes) === stat.size) {
      return { action: 'skipped', doc: existing, chunks: existing.chunks };
    }

    const extracted = extractText(file, { maxBytes: this.maxFileBytes });
    if (!extracted.ok) return { action: 'failed', reason: extracted.reason, doc: existing };

    const hash = hash32(extracted.text);
    if (existing && existing.hash === hash) {
      this.db.prepare('UPDATE docs SET mtime = ?, bytes = ?, updated_at = ? WHERE id = ?').run(mtime, stat.size, Date.now(), existing.id);
      return { action: 'skipped', doc: this.getDoc(existing.id), chunks: existing.chunks };
    }

    const chunks = chunkText(extracted.text, { maxChars: this.chunkChars, overlap: this.chunkOverlap, format: extracted.format });
    if (chunks.length === 0) return { action: 'failed', reason: '没有可索引的文本', doc: existing };
    // 文档的一级标题已经在 title 里了，标题路径里再去掉它，引用才不会出现
    // 「README.md › 项目名 › 安装 › 配置」这种半截重复。
    const titlePrefix = extracted.title ? `${extracted.title} › ` : '';
    const trimmed = titlePrefix
      ? chunks.map((chunk) => (chunk.heading.startsWith(titlePrefix) ? { ...chunk, heading: chunk.heading.slice(titlePrefix.length) } : chunk))
      : chunks;

    const now = Date.now();
    const id = existing?.id ?? `d_${hash32(norm)}`;
    const record = {
      id,
      norm,
      path: resolve(file),
      rel: relativePath(root, file),
      project,
      scope: scope === 'global' ? 'global' : 'project',
      title: extracted.title || basename(file),
      format: extracted.format,
      bytes: stat.size,
      mtime,
      hash,
      chunks: trimmed.length,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
    };

    this.transaction(() => {
      this.dropChunks(id);
      const insertChunk = this.db.prepare('INSERT INTO chunks (id, doc_id, ord, heading, text, tokens, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const insertFts = this.fts ? this.db.prepare('INSERT INTO chunks_fts (tokens, id) VALUES (?, ?)') : null;
      trimmed.forEach((chunk, index) => {
        const chunkId = `${id}_${index}`;
        // 文档标题也进 token 串：不然「找那个 deploy 文档」这种按文件名搜的场景搜不到。
        const tokens = tokensOf(`${record.title} ${chunk.heading}`, chunk.text);
        insertChunk.run(chunkId, id, index, chunk.heading, chunk.text, tokens, chunk.startLine, chunk.endLine);
        insertFts?.run(tokens, chunkId);
      });
      this.db
        .prepare(
          `INSERT INTO docs (id, norm, path, rel, project, scope, title, format, bytes, mtime, hash, chunks, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             norm=excluded.norm, path=excluded.path, rel=excluded.rel, project=excluded.project,
             scope=excluded.scope, title=excluded.title, format=excluded.format, bytes=excluded.bytes,
             mtime=excluded.mtime, hash=excluded.hash, chunks=excluded.chunks, updated_at=excluded.updated_at`,
        )
        .run(record.id, record.norm, record.path, record.rel, record.project, record.scope, record.title, record.format, record.bytes, record.mtime, record.hash, record.chunks, record.addedAt, record.updatedAt);
    });

    if (prune) this.prune();
    return { action: existing ? 'updated' : 'added', doc: this.getDoc(id), chunks: trimmed.length };
  }

  /**
   * 同步一个目录：新增、更新、删除磁盘上已经没有的文档。
   * @param {string} target 目录绝对路径。
   * @param {object} [options] 选项。
   * @param {string} [options.project] 项目键。
   * @param {'project'|'global'} [options.scope='project'] 作用域。
   * @param {string} [options.root=''] 项目根。
   * @param {boolean} [options.recursive=true] 是否递归。
   * @returns {{ added: number, updated: number, skipped: number, failed: number, removed: number, errors: { path: string, reason: string }[] }} 汇总。
   */
  sync(target, { project = '', scope = 'project', root = '', recursive = true } = {}) {
    const summary = { added: 0, updated: 0, skipped: 0, failed: 0, removed: 0, errors: [] };
    if (!this.open()) {
      summary.failed = 1;
      summary.errors.push({ path: target, reason: '知识库不可用（运行时缺少 node:sqlite）' });
      return summary;
    }

    const seen = new Set();
    for (const file of walkFiles(target, { ignore: this.ignore, recursive })) {
      seen.add(normalizePath(file));
      // 批量同步时逐篇 prune 是白花 O(n) 的 COUNT：等全部写完再统一检查一次。
      const result = this.ingest(file, { project, scope, root, prune: false });
      if (result.action === 'added') summary.added += 1;
      else if (result.action === 'updated') summary.updated += 1;
      else if (result.action === 'skipped') summary.skipped += 1;
      else {
        summary.failed += 1;
        if (summary.errors.length < MAX_ERRORS) summary.errors.push({ path: result.doc?.path ?? file, reason: result.reason ?? '未知原因' });
      }
    }
    summary.removed = this.removeMissingUnder(target, seen);
    this.prune();
    return summary;
  }

  /**
   * 删除某个目录下「本次同步没见到」的文档。
   * @param {string} base 目录。
   * @param {Set<string>} seen 本次见到的归一化路径。
   * @returns {number} 删除条数。
   */
  removeMissingUnder(base, seen) {
    const prefix = `${normalizePath(base).replace(/\/+$/u, '')}/`;
    let removed = 0;
    for (const doc of this.allDocs()) {
      if (!doc.norm.startsWith(prefix)) continue;
      if (seen.has(doc.norm)) continue;
      this.removeDoc(doc.id);
      removed += 1;
    }
    return removed;
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  /**
   * 按 id 取文档。
   * @param {string} id 文档 id。
   * @returns {Record<string, any> | undefined} 文档。
   */
  getDoc(id) {
    if (!this.open()) return undefined;
    const row = this.db.prepare('SELECT * FROM docs WHERE id = ?').get(String(id));
    return row ? toDoc(row) : undefined;
  }

  /**
   * 按归一化路径取文档。
   * @param {string} norm 归一化路径。
   * @returns {Record<string, any> | undefined} 文档。
   */
  docByNorm(norm) {
    if (!this.open()) return undefined;
    const row = this.db.prepare('SELECT * FROM docs WHERE norm = ?').get(String(norm));
    return row ? toDoc(row) : undefined;
  }

  /**
   * 列出文档。
   * @param {object} [options] 选项。
   * @param {string} [options.project=''] 项目键（同时包含全局文档）。
   * @param {number} [options.limit=200] 条数。
   * @returns {Record<string, any>[]} 文档列表。
   */
  list({ project = '', limit = 200 } = {}) {
    if (!this.open()) return [];
    const sql = project
      ? 'SELECT * FROM docs WHERE project = ? OR project = \'\' ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM docs ORDER BY updated_at DESC LIMIT ?';
    const params = project ? [project, Math.max(1, limit)] : [Math.max(1, limit)];
    return this.db.prepare(sql).all(...params).map(toDoc);
  }

  /**
   * 全部文档（内部维护用，不分页）。
   * @returns {Record<string, any>[]} 文档列表。
   */
  allDocs() {
    if (!this.open()) return [];
    return this.db.prepare('SELECT * FROM docs').all().map(toDoc);
  }

  /**
   * 一篇文档的全部块。
   * @param {string} docId 文档 id。
   * @returns {Record<string, any>[]} 块列表。
   */
  chunksOf(docId) {
    if (!this.open()) return [];
    return this.db.prepare('SELECT * FROM chunks WHERE doc_id = ? ORDER BY ord ASC').all(String(docId)).map(toChunk);
  }

  /**
   * 检索。
   * @param {string} query 查询词。
   * @param {object} [options] 选项。
   * @param {number} [options.limit=6] 返回条数。
   * @param {string} [options.project=''] 项目键（同时包含全局文档）。
   * @param {number} [options.perDoc=2] 同一篇文档最多出几条，避免一篇文档刷屏。
   * @returns {Record<string, any>[]} 命中块，按分数降序。
   */
  search(query, { limit = 6, project = '', perDoc = 2 } = {}) {
    if (!this.open()) return [];
    const tokens = [...new Set(tokenize(query))].slice(0, 24);
    if (tokens.length === 0) return [];

    const rows = this.candidates(tokens, project);
    if (rows.length === 0) return [];

    const ranked = rankChunks(rows, query);
    const used = new Map();
    const out = [];
    for (const hit of ranked) {
      const count = used.get(hit.docId) ?? 0;
      if (count >= perDoc) continue;
      used.set(hit.docId, count + 1);
      out.push(hit);
      if (out.length >= Math.max(1, Math.min(50, limit))) break;
    }
    return out;
  }

  /**
   * 取候选块：FTS 命中或 LIKE 兜底，再按项目过滤。
   * @param {string[]} tokens 查询 token。
   * @param {string} [project] 项目键。
   * @returns {Record<string, any>[]} 块 + 文档信息。
   */
  candidates(tokens, project) {
    const ids = new Set();
    if (this.fts) {
      // 每个 token 用引号包成短语，避免 - / * 之类被当成 FTS 语法。
      const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
      try {
        const hits = this.db.prepare('SELECT id FROM chunks_fts WHERE tokens MATCH ? LIMIT ?').all(match, CANDIDATES);
        for (const hit of hits) ids.add(String(hit.id));
      } catch (error) {
        this.log(`[memory] 知识库 FTS 查询失败，退回 LIKE：${String(error)}`);
      }
    }
    if (ids.size === 0) {
      const clause = tokens.map(() => 'tokens LIKE ?').join(' OR ');
      const params = tokens.map((token) => `% ${token} %`);
      const sql = `SELECT id FROM chunks WHERE (${clause}) ORDER BY rowid DESC LIMIT ${CANDIDATES}`;
      for (const hit of this.db.prepare(sql).all(...params)) ids.add(String(hit.id));
    }
    if (ids.size === 0) return [];

    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    const sql = `SELECT c.*, d.path AS doc_path, d.rel AS doc_rel, d.title AS doc_title, d.format AS doc_format, d.project AS doc_project
                 FROM chunks c JOIN docs d ON d.id = c.doc_id
                 WHERE c.id IN (${placeholders})${project ? " AND (d.project = ? OR d.project = '')" : ''}`;
    const params = project ? [...list, project] : list;
    return this.db.prepare(sql).all(...params).map(toCandidate);
  }

  // ── 删除与维护 ──────────────────────────────────────────────────────────

  /**
   * 删除一篇文档及其全部块。
   * @param {string} id 文档 id。
   * @returns {Record<string, any> | undefined} 被删除的文档。
   */
  removeDoc(id) {
    if (!this.open()) return undefined;
    const doc = this.getDoc(id);
    if (!doc) return undefined;
    this.transaction(() => {
      this.dropChunks(doc.id);
      this.db.prepare('DELETE FROM docs WHERE id = ?').run(doc.id);
    });
    return doc;
  }

  /**
   * 删除一篇文档的块（正文行与 FTS 行一起删）。
   * @param {string} docId 文档 id。
   */
  dropChunks(docId) {
    const rows = this.db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(String(docId));
    for (const row of rows) {
      const id = String(row.id);
      this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
      if (this.fts) this.db.prepare('DELETE FROM chunks_fts WHERE id = ?').run(id);
    }
  }

  /**
   * 超出块数上限时，按「最久未更新」整篇淘汰。
   * @returns {number} 淘汰的文档数。
   */
  prune() {
    if (!this.open()) return 0;
    let total = this.chunkCount();
    if (total <= this.maxChunks) return 0;
    let removed = 0;
    for (const doc of this.db.prepare('SELECT id, chunks FROM docs ORDER BY updated_at ASC').all()) {
      if (total <= this.maxChunks) break;
      this.removeDoc(String(doc.id));
      total -= Number(doc.chunks ?? 0);
      removed += 1;
    }
    return removed;
  }

  /**
   * 块总数。
   * @returns {number} 数量。
   */
  chunkCount() {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM chunks').get();
    return Number(row?.count ?? 0);
  }

  /**
   * 统计。
   * @returns {{ docs: number, chunks: number, bytes: number, fts: boolean, file: string, oldest: number|null, newest: number|null }} 统计。
   */
  stats() {
    if (!this.open()) return { docs: 0, chunks: 0, bytes: 0, fts: false, file: this.file, oldest: null, newest: null };
    const row = this.db.prepare('SELECT COUNT(*) AS docs, MIN(added_at) AS oldest, MAX(updated_at) AS newest FROM docs').get();
    let bytes = 0;
    try {
      bytes = statSync(this.file).size;
    } catch {
      bytes = 0;
    }
    return {
      docs: Number(row?.docs ?? 0),
      chunks: this.chunkCount(),
      bytes,
      fts: this.fts,
      file: this.file,
      oldest: row?.oldest ?? null,
      newest: row?.newest ?? null,
    };
  }

  /**
   * 全量导出（备份用）。
   * @returns {{ docs: Record<string, any>[], chunks: Record<string, any>[] }} 内容。
   */
  exportAll() {
    if (!this.open()) return { docs: [], chunks: [] };
    const docs = this.allDocs();
    const chunks = this.db.prepare('SELECT * FROM chunks ORDER BY doc_id, ord').all().map(toChunk);
    return { docs, chunks };
  }

  /**
   * 压缩数据库。
   * @returns {boolean} 是否执行。
   */
  vacuum() {
    if (!this.open()) return false;
    try {
      this.db.exec('VACUUM');
      return true;
    } catch (error) {
      this.log(`[memory] 知识库 VACUUM 失败：${String(error)}`);
      return false;
    }
  }

  /** 关闭数据库。 */
  close() {
    if (!this.db || this.closed) return;
    try {
      this.db.close();
    } catch {
      /* 关闭失败无补救，忽略 */
    }
    this.closed = true;
    this.db = null;
  }

  /**
   * 数据库文件是否存在。
   * @returns {boolean} 是否存在。
   */
  exists() {
    return existsSync(this.file);
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
}

/**
 * 递归收集目录下的文件。跳过隐藏项（`.` 开头）与忽略目录，不跟随符号链接。
 * @param {string} target 目录。
 * @param {object} options 选项。
 * @param {Set<string>} options.ignore 忽略的目录名（小写）。
 * @param {boolean} options.recursive 是否递归。
 * @returns {Generator<string>} 文件绝对路径。
 */
function* walkFiles(target, { ignore, recursive }) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    // 隐藏文件一律跳过：`.env`、`.git` 这类东西进知识库是事故，不是功能。
    if (name.startsWith('.')) continue;
    const full = resolve(target, name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (ignore.has(name.toLowerCase())) continue;
      yield* walkFiles(full, { ignore, recursive });
      continue;
    }
    if (entry.isFile()) yield full;
  }
}

/**
 * 拼出索引用的 token 串：文档标题 + 标题路径 + 正文。
 * @param {string} heading 标题路径（可带文档标题）。
 * @param {string} text 正文。
 * @returns {string} 空格分隔的 token。
 */
function tokensOf(heading, text) {
  return [...new Set(tokenize(`${heading} ${text}`))].join(' ');
}

/**
 * 在候选集里打分。
 *
 * 与记忆层同一套口径：IDF 在候选池上算，命中比例归一化，
 * 所以「1.0 = 查询词全在正文里」在不同规模的库上含义一致，阈值才不会漂。
 * 知识库额外加两项：整句命中（短语）与标题命中——原文检索里这两个信号很强。
 * @param {Record<string, any>[]} rows 候选块。
 * @param {string} query 查询。
 * @returns {Record<string, any>[]} 命中（含 score），按分数降序。
 */
function rankChunks(rows, query) {
  const queryTokens = [...new Set(tokenize(query))];
  const needle = normalizeForPhrase(query);
  const docs = rows.map((row) => {
    const body = new Set(tokenize(row.text));
    const heading = new Set(tokenize(row.heading));
    const title = new Set(tokenize(row.title));
    return { row, body, heading, title, flat: normalizeForPhrase(row.text) };
  });

  const df = new Map();
  for (const doc of docs) {
    for (const token of new Set([...doc.body, ...doc.heading, ...doc.title])) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, docs.length);
  const idf = (token) => Math.log(1 + (total - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
  const ceiling = queryTokens.reduce((sum, token) => sum + ((df.get(token) ?? 0) > 0 ? idf(token) : 0), 0);

  return docs
    .map((doc) => {
      let lexical = 0;
      for (const token of queryTokens) {
        const weight = doc.heading.has(token) ? 2.4 : doc.body.has(token) ? 1 : doc.title.has(token) ? 1.6 : 0;
        if (weight > 0) lexical += idf(token) * weight;
      }
      lexical = ceiling > 0 ? lexical / ceiling : 0;
      const phrase = needle.length >= 4 && doc.flat.includes(needle) ? 0.6 : 0;
      const titleHit = needle.length >= 2 && normalizeForPhrase(`${doc.row.title} ${doc.row.heading}`).includes(needle) ? 0.3 : 0;
      const score = lexical * 3 + phrase + titleHit;
      return { ...toHit(doc.row), score: Math.round(score * 1000) / 1000 };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/**
 * 短语匹配用的归一化：只留文字与数字。
 * @param {string} text 原文。
 * @returns {string} 归一化结果。
 */
function normalizeForPhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * SQLite 行 → 文档对象。
 * @param {Record<string, any>} row 行。
 * @returns {Record<string, any>} 文档。
 */
function toDoc(row) {
  return {
    id: String(row.id),
    norm: String(row.norm ?? ''),
    path: String(row.path ?? ''),
    rel: String(row.rel ?? ''),
    project: String(row.project ?? ''),
    scope: String(row.scope ?? 'project'),
    title: String(row.title ?? ''),
    format: String(row.format ?? 'text'),
    bytes: Number(row.bytes ?? 0),
    mtime: Number(row.mtime ?? 0),
    hash: String(row.hash ?? ''),
    chunks: Number(row.chunks ?? 0),
    addedAt: Number(row.added_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * SQLite 行 → 块对象。
 * @param {Record<string, any>} row 行。
 * @returns {Record<string, any>} 块。
 */
function toChunk(row) {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    ord: Number(row.ord ?? 0),
    heading: String(row.heading ?? ''),
    text: String(row.text ?? ''),
    startLine: Number(row.start_line ?? 0),
    endLine: Number(row.end_line ?? 0),
  };
}

/**
 * 候选行（块 + 文档字段）→ 内部结构。
 * @param {Record<string, any>} row 行。
 * @returns {Record<string, any>} 候选。
 */
function toCandidate(row) {
  return {
    ...toChunk(row),
    path: String(row.doc_path ?? ''),
    rel: String(row.doc_rel ?? ''),
    title: String(row.doc_title ?? ''),
    format: String(row.doc_format ?? 'text'),
    project: String(row.doc_project ?? ''),
  };
}

/**
 * 候选 → 对外的命中结果。
 * @param {Record<string, any>} row 候选。
 * @returns {Record<string, any>} 命中。
 */
function toHit(row) {
  return {
    id: row.id,
    docId: row.docId,
    path: row.path,
    rel: row.rel,
    title: row.title,
    heading: row.heading,
    format: row.format,
    startLine: row.startLine,
    endLine: row.endLine,
    text: row.text,
  };
}
