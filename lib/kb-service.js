/**
 * 知识库服务：把存储层挂到「会话 / 项目」上，并负责注入摘录。
 *
 * 三件事：
 * 1. **入库**：把相对路径解析成绝对路径，按项目作用域打标，目录走增量同步。
 * 2. **检索**：只在当前项目（+ 全局文档）里找，返回带出处的块。
 * 3. **注入**：当前输入和某几块强相关时，渲染一段「知识库摘录」进上下文。
 *
 * 注入用的是**独立段落、独立预算**，不和记忆抢：记忆是结论，短；
 * 摘录是原文，长。混在一个段落里，预算就没法分别调了。
 *
 * @module dsh-myosotis/kb-service
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { KnowledgeStore, normalizePath, sqliteAvailable } from './kb.js';
import { renderKnowledgeIndex } from './markdown.js';
import { globalDir, knowledgeDir, knowledgeFile, projectDir } from './paths.js';
import { QueryTracker } from './queries.js';
import { renderKnowledge } from './render.js';
import { contextOf, projectKey } from './session.js';
import { lastUserText } from './text.js';

/** 索引镜像的写盘防抖。 */
const INDEX_DELAY = 400;

/**
 * 把逗号分隔的配置项拆成数组。
 * @param {unknown} value 原始值。
 * @returns {string[]} 去空后的列表。
 */
export function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 知识库服务。
 */
export class KnowledgeService {
  /**
   * @param {object} options 选项。
   * @param {Record<string, any>} options.config 已解析的插件配置。
   * @param {(message: string) => void} [options.logger] 告警输出。
   * @param {QueryTracker} [options.queries] 与记忆层共用的查询追踪器。
   */
  constructor({ config, logger, queries }) {
    this.config = config;
    this.log = logger ?? (() => {});
    this.root = globalDir(config.globalDir);
    this.queries = queries ?? new QueryTracker();
    this.store =
      config.knowledge && sqliteAvailable()
        ? new KnowledgeStore({
            file: knowledgeFile(this.root, config.kbPath),
            maxChunks: config.kbMaxChunks,
            chunkChars: config.kbChunkChars,
            chunkOverlap: config.kbChunkOverlap,
            maxFileBytes: config.kbMaxFileBytes,
            ignore: parseList(config.kbIgnore),
            logger: this.log,
          })
        : null;
    if (config.knowledge && !this.store) this.log('[memory] 知识库已禁用：当前运行时没有 node:sqlite');
    /** @type {Map<string, string>} 待刷新的索引镜像：cwd → 项目键。 */
    this.pending = new Map();
    this.indexTimer = null;
  }

  /** @returns {boolean} 知识库是否可用。 */
  get ready() {
    return Boolean(this.store?.open());
  }

  /**
   * 把用户给的路径解析成绝对路径；空值退回默认知识目录。
   * @param {string} input 原始路径。
   * @param {string} cwd 工作目录。
   * @returns {string} 绝对路径。
   */
  target(input, cwd) {
    const value = String(input ?? '').trim();
    if (!value) return knowledgeDir(cwd, this.config.kbDir);
    return isAbsolute(value) ? resolve(value) : resolve(cwd || '.', value);
  }

  /**
   * 入库：文件或目录。
   * @param {Record<string, any>} input 参数。
   * @param {any} agent Agent 句柄。
   * @returns {Record<string, any>} 汇总。
   */
  add(input, agent) {
    if (!this.store) throw new Error('知识库不可用：当前运行时没有 node:sqlite，或配置里 knowledge 被关掉了');
    const { cwd } = contextOf(agent);
    const scope = input?.scope === 'global' ? 'global' : 'project';
    const project = scope === 'global' ? '' : projectKey(cwd);
    const target = this.target(input?.path, cwd);

    let stat;
    try {
      stat = statSync(target);
    } catch {
      throw new Error(`路径不存在：${target}`);
    }

    const recursive = input?.recursive !== false;
    if (stat.isDirectory()) {
      const summary = this.store.sync(target, { project, scope, root: cwd, recursive });
      this.afterChange(cwd, project);
      return { target, kind: 'directory', ...summary, documents: this.docsUnder(target, project), chunks: this.chunksUnder(target, project) };
    }

    const result = this.store.ingest(target, { project, scope, root: cwd });
    if (result.action === 'failed') throw new Error(`入库失败：${result.reason}`);
    this.afterChange(cwd, project);
    return {
      target,
      kind: 'file',
      added: result.action === 'added' ? 1 : 0,
      updated: result.action === 'updated' ? 1 : 0,
      skipped: result.action === 'skipped' ? 1 : 0,
      failed: 0,
      removed: 0,
      errors: [],
      documents: result.doc ? [result.doc] : [],
      chunks: result.chunks ?? 0,
    };
  }

  /**
   * 目标路径下的文档（文件本身也算）。
   * @param {string} target 绝对路径。
   * @param {string} project 项目键。
   * @returns {Record<string, any>[]} 文档列表。
   */
  docsUnder(target, project) {
    if (!this.store) return [];
    const norm = normalizePath(target);
    const prefix = `${norm.replace(/\/+$/u, '')}/`;
    return this.store
      .allDocs()
      .filter((doc) => doc.project === project && (doc.norm === norm || doc.norm.startsWith(prefix)))
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  }

  /**
   * 目标路径下的块总数。
   * @param {string} target 绝对路径。
   * @param {string} project 项目键。
   * @returns {number} 块数。
   */
  chunksUnder(target, project) {
    return this.docsUnder(target, project).reduce((sum, doc) => sum + Number(doc.chunks ?? 0), 0);
  }

  /**
   * 检索。query 为空时列出文档。
   * @param {string} query 查询词。
   * @param {object} [options] 选项。
   * @param {number} [options.limit=6] 条数。
   * @param {string} [options.path=''] 限定路径前缀。
   * @param {any} [agent] Agent 句柄。
   * @returns {{ hits: Record<string, any>[], documents: Record<string, any>[] }} 结果。
   */
  search(query, { limit = 6, path = '' } = {}, agent) {
    if (!this.store) return { hits: [], documents: [] };
    const { cwd } = contextOf(agent);
    const project = projectKey(cwd);
    const text = String(query ?? '').trim();
    const max = Math.max(1, Math.min(50, Number(limit) || 6));
    if (!text) return { hits: [], documents: this.list(agent, max) };

    let hits = this.store.search(text, { limit: max, project, perDoc: 2 });
    const prefix = String(path ?? '').trim();
    if (prefix) {
      const base = normalizePath(this.target(prefix, cwd));
      hits = hits.filter((hit) => {
        const norm = normalizePath(hit.path);
        return norm === base || norm.startsWith(`${base}/`);
      });
    }
    return { hits, documents: [] };
  }

  /**
   * 列出当前项目的文档。
   * @param {any} agent Agent 句柄。
   * @param {number} [limit=100] 条数。
   * @returns {Record<string, any>[]} 文档列表。
   */
  list(agent, limit = 100) {
    if (!this.store) return [];
    const { cwd } = contextOf(agent);
    return this.store.list({ project: projectKey(cwd), limit });
  }

  /**
   * 删除：按 id 精确删；按 path 删文件或目录（目录需要 confirm）。
   * @param {Record<string, any>} input 参数。
   * @param {any} agent Agent 句柄。
   * @returns {{ removed: Record<string, any>[], candidates?: Record<string, any>[], needConfirm?: boolean }} 结果。
   */
  remove(input, agent) {
    if (!this.store) throw new Error('知识库不可用：当前运行时没有 node:sqlite，或配置里 knowledge 被关掉了');
    const { cwd } = contextOf(agent);

    if (input?.id) {
      const doc = this.store.removeDoc(String(input.id));
      this.afterChange(cwd, projectKey(cwd));
      return { removed: doc ? [doc] : [] };
    }

    const path = String(input?.path ?? '').trim();
    if (!path) throw new Error('kb_remove 需要 id 或 path');
    const target = this.target(path, cwd);
    const norm = normalizePath(target);
    const docs = this.store.allDocs();
    const exact = docs.find((doc) => doc.norm === norm);
    if (exact) {
      this.store.removeDoc(exact.id);
      this.afterChange(cwd, projectKey(cwd));
      return { removed: [exact] };
    }

    const prefix = `${norm.replace(/\/+$/u, '')}/`;
    const under = docs.filter((doc) => doc.norm.startsWith(prefix));
    if (under.length === 0) return { removed: [] };
    if (!input?.confirm) return { removed: [], candidates: under, needConfirm: true };
    for (const doc of under) this.store.removeDoc(doc.id);
    this.afterChange(cwd, projectKey(cwd));
    return { removed: under };
  }

  /**
   * 为一次提示词组装渲染知识库摘录。
   * @param {any} agent Agent 句柄。
   * @returns {string} 注入文本；没有内容时为空串。
   */
  renderFor(agent) {
    if (!this.store || !this.config.kbInject || this.config.kbRecall <= 0) return '';
    if (!agent) return '';
    const { cwd, sessionId } = contextOf(agent);
    const query = this.queries.last(agent?.id ?? sessionId) || lastUserText(agent?.session);
    if (!query || query.trim().length < 2) return '';

    let hits;
    try {
      hits = this.store
        .search(query, { limit: this.config.kbRecall, project: projectKey(cwd), perDoc: 1 })
        .filter((hit) => hit.score >= this.config.kbRecallMin);
    } catch (error) {
      this.log(`[memory] 知识库检索失败：${String(error)}`);
      return '';
    }
    if (hits.length === 0) return '';
    return renderKnowledge(hits, { budgetChars: this.config.kbBudgetChars });
  }

  /**
   * 统计。
   * @param {any} [agent] Agent 句柄。
   * @returns {Record<string, any>} 统计信息。
   */
  stats(agent) {
    if (!this.store) return { enabled: false };
    const base = this.store.stats();
    return { enabled: true, ...base, documents: this.list(agent, 1000).length };
  }

  /**
   * 写操作后的收尾：安排刷新索引镜像。
   * @param {string} cwd 工作目录。
   * @param {string} project 项目键。
   */
  afterChange(cwd, project) {
    if (!cwd) return;
    this.pending.set(cwd, project);
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.flushIndex();
    }, INDEX_DELAY);
    if (typeof this.indexTimer.unref === 'function') this.indexTimer.unref();
  }

  /** 生成 `KNOWLEDGE.md`（只列目录，不复制正文）。 */
  flushIndex() {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [cwd, project] of entries) {
      const dir = projectDir(cwd, this.config.projectDir);
      const file = join(dir, 'KNOWLEDGE.md');
      try {
        const docs = this.store ? this.store.allDocs().filter((doc) => doc.project === project) : [];
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderKnowledgeIndex({ cwd, docs }), 'utf8');
      } catch (error) {
        this.log(`[memory] 写入知识库索引 ${file} 失败：${String(error)}`);
      }
    }
  }

  /** 关闭：刷新索引、关库。 */
  dispose() {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    this.flushIndex();
    this.store?.close();
  }
}
