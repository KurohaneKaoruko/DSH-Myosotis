/**
 * 记忆服务：把四层存储、检索、注入、写入串起来。
 *
 * 这是宿主侧的「大脑」，不认识 HTTP、不认识 React，只依赖 node:fs。
 * 插件入口（index.js）负责把它挂到 DSH 的 systemPrompt / tools 上，
 * CLI（tools/memory.mjs）负责在没有 DSH 的时候操作同一批文件。
 *
 * @module dsh-myosotis/memory
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DeepStore, sqliteAvailable } from './deep.js';
import { detectFeedback, isSuspect } from './feedback.js';
import { renderMarkdown } from './markdown.js';
import { globalDir, deepFile, normalizeCwd, projectDir, projectFallbackFile, projectLabel, safeName, sessionFile } from './paths.js';
import { QueryTracker } from './queries.js';
import { renderRecall } from './render.js';
import { rankScoped, select } from './retrieval.js';
import { contextOf, projectKey } from './session.js';
import { MemoryStore } from './store.js';
import { bigramSet, hasNegation, hash32, lastUserText, similarityOf, truncate } from './text.js';

/** 会话存储缓存上限：同时开着的会话不会超过这个数。 */
const SESSION_CACHE = 32;

/** 深记忆自动浮现最多占多少字符预算。 */
const DEEP_BUDGET_RATIO = 0.3;

/** 复盘时同一类最多比较多少条（避免 O(n²) 失控）。 */
const REVIEW_GROUP_CAP = 60;

/** 判定「重复」的相似度门槛。 */
const DUPLICATE_THRESHOLD = 0.85;

/** 判定「互相矛盾」的相似度门槛：要足够像，才有资格谈矛盾。 */
const CONFLICT_THRESHOLD = 0.7;

/** 可能构成矛盾的类型：只有这几类「做 / 不做」是互斥的。 */
const CONFLICT_KINDS = new Set(['convention', 'gotcha', 'preference', 'habit']);

export { contextOf, projectKey };

/**
 * 记忆服务。
 */
export class MemoryService {
  /**
   * @param {object} options 选项。
   * @param {Record<string, any>} options.config 已解析的插件配置。
   * @param {(message: string) => void} [options.logger] 告警输出。
   * @param {QueryTracker} [options.queries] 与知识库共用的查询追踪器。
   */
  constructor({ config, logger, queries }) {
    this.config = config;
    this.log = logger ?? (() => {});
    this.root = globalDir(config.globalDir);
    /** @type {Map<string, MemoryStore>} */
    this.stores = new Map();
    /** 最近一次用户输入；与知识库共用，避免两套状态。 */
    this.queries = queries ?? new QueryTracker();
    /** @type {Map<string, { key: string, text: string }>} */
    this.cache = new Map();
    /** @type {Map<string, boolean>} */
    this.writable = new Map();
    this.mirrorTimer = null;
    this.mirrorDirty = false;
    /**
     * 上一轮注入了哪些记忆：agent → { ids: { scope, id }[], at }。
     * 用户下一轮说「不对」时，就靠它知道该给哪几条记账。
     * @type {Map<string, { ids: { scope: string, id: string }[], at: number }>}
     */
    this.injected = new Map();
    /** 写操作计数，用于按 `consolidateEvery` 触发自动整理。 */
    this.writeCount = 0;
    /** 整理重入保护。 */
    this.consolidating = false;
    /** 深记忆存储；运行时没有 node:sqlite 或配置关闭时为 null。 */
    this.deep = config.deep && sqliteAvailable() ? new DeepStore({ file: deepFile(this.root, config.deepPath), maxEntries: config.deepMax, logger: this.log }) : null;
    if (config.deep && !this.deep) this.log('[memory] 深记忆已禁用：当前运行时没有 node:sqlite');
    /** 深记忆写入计数，参与渲染缓存判定。 */
    this.deepVersion = 0;
  }

  // ── 存储 ────────────────────────────────────────────────────────────────

  /**
   * 取得（或创建）一个存储实例。
   * @param {string} key 缓存键。
   * @param {string} file 文件路径。
   * @param {'global'|'project'|'session'} scope 作用域。
   * @param {number} limit 条目上限。
   * @param {number} ttlDays 过期天数（0 = 不过期）。
   * @returns {MemoryStore} 存储。
   */
  store(key, file, scope, limit, ttlDays) {
    let store = this.stores.get(key);
    if (store) {
      // LRU：重新插入到末尾。
      this.stores.delete(key);
      this.stores.set(key, store);
      return store;
    }
    store = new MemoryStore({ file, scope, limit, ttlDays, logger: this.log });
    this.stores.set(key, store);
    this.trimCache();
    return store;
  }

  /** 全局存储。 */
  globalStore() {
    return this.store('global', join(this.root, 'global.json'), 'global', this.config.maxGlobal, 0);
  }

  /**
   * 项目存储；目录不可写时回退到全局目录下的哈希文件。
   * @param {string} cwd 工作目录。
   * @returns {MemoryStore} 存储。
   */
  projectStore(cwd) {
    const dir = projectDir(cwd, this.config.projectDir);
    let file = join(dir, 'project.json');
    if (!this.writableDir(dir)) {
      const fallback = projectFallbackFile(this.root, cwd);
      this.log(`[memory] 项目目录不可写，项目记忆回退到 ${fallback}`);
      file = fallback;
    }
    const store = this.store(`project:${normalizeCwd(file)}`, file, 'project', this.config.maxProject, 0);
    store.cwd = cwd;
    return store;
  }

  /**
   * 会话存储。
   * @param {string} sessionId 会话 id。
   * @param {string} [cwd] 工作目录（沉淀到深记忆时用来标记项目）。
   * @returns {MemoryStore} 存储。
   */
  sessionStore(sessionId, cwd = '') {
    const file = sessionFile(this.root, sessionId || 'anonymous');
    const store = this.store(`session:${safeName(sessionId || 'anonymous')}`, file, 'session', this.config.maxSession, this.config.sessionTtlDays);
    if (cwd) store.cwd = cwd;
    return store;
  }

  /**
   * 目录是否可写（尝试创建，结果按进程缓存）。
   * @param {string} dir 目录。
   * @returns {boolean} 是否可写。
   */
  writableDir(dir) {
    if (this.writable.has(dir)) return this.writable.get(dir);
    let ok = true;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      ok = false;
    }
    this.writable.set(dir, ok);
    return ok;
  }

  /** 控制存储缓存规模，超出的先落盘再丢弃。 */
  trimCache() {
    if (this.stores.size <= SESSION_CACHE + 8) return;
    for (const [key, store] of this.stores) {
      if (this.stores.size <= SESSION_CACHE + 8) break;
      if (store.scope !== 'session') continue;
      store.flushSync();
      this.stores.delete(key);
    }
  }

  // ── 上下文 ──────────────────────────────────────────────────────────────

  /**
   * 按作用域取存储，带上 agent 上下文。
   * @param {string} scope 作用域。
   * @param {any} agent Agent 句柄。
   * @returns {MemoryStore} 存储。
   */
  storeFor(scope, agent) {
    const { cwd, sessionId } = contextOf(agent);
    if (scope === 'global') return this.globalStore();
    if (scope === 'session') return this.sessionStore(sessionId, cwd);
    if (!cwd) {
      this.log('[memory] 当前会话没有工作目录，project 作用域回退到 global');
      return this.globalStore();
    }
    return this.projectStore(cwd);
  }

  /**
   * 三个作用域的存储列表（缺失的跳过）。
   * @param {any} agent Agent 句柄。
   * @returns {{ scope: string, store: MemoryStore }[]} 列表。
   */
  storesFor(agent) {
    const { cwd, sessionId } = contextOf(agent);
    const list = [{ scope: 'global', store: this.globalStore() }];
    if (cwd) list.push({ scope: 'project', store: this.projectStore(cwd) });
    if (sessionId) list.push({ scope: 'session', store: this.sessionStore(sessionId, cwd) });
    return list;
  }

  /**
   * 在精选层里按 id 找一条。
   * @param {string} id 记忆 id。
   * @param {any} agent Agent 句柄。
   * @returns {{ scope: string, store: MemoryStore, item: Record<string, any> } | undefined} 命中。
   */
  findCurated(id, agent) {
    for (const { scope, store } of this.storesFor(agent)) {
      const item = store.find(id);
      if (item) return { scope, store, item };
    }
    return undefined;
  }

  /**
   * 在所有层里按 id 找一条（精选三层 + 深记忆）。
   * @param {string} id 记忆 id。
   * @param {any} agent Agent 句柄。
   * @returns {{ scope: string, store?: MemoryStore, item: Record<string, any>, deep: boolean } | undefined} 命中。
   */
  findAcross(id, agent) {
    const curated = this.findCurated(id, agent);
    if (curated) return { ...curated, deep: false };
    const item = this.deep?.get(String(id));
    if (item) return { scope: 'deep', item, deep: true };
    return undefined;
  }

  /** @returns {boolean} 深记忆是否可用。 */
  get deepReady() {
    return Boolean(this.deep?.open());
  }

  // ── 写入 ────────────────────────────────────────────────────────────────

  /**
   * 保存一条记忆（新增 / 更新 / 跨层移动）。
   *
   * 作用域可以在四层之间移动：`global` / `project` / `session` 是精选层，
   * `deep` 是归档层。带 `id` 且换了 scope 就是移动——往 deep 是「沉底」，
   * 从 deep 回精选层是「提起」。
   * @param {Record<string, any>} input 字段。
   * @param {any} agent Agent 句柄。
   * @returns {{ action: string, item: Record<string, any>, scope: string, moved?: boolean }} 结果。
   */
  save(input, agent) {
    const { cwd, sessionId } = contextOf(agent);
    const wanted = normalizeScope(input?.scope);
    const defaults = { cwd, sessionId, now: Date.now() };
    const project = projectKey(cwd);

    // ── 目标是深记忆 ──────────────────────────────────────────────────────
    if (wanted === 'deep') {
      if (!this.deep) throw new Error('深记忆不可用：当前运行时没有 node:sqlite，或配置里 deep 被关掉了');
      const curated = input?.id ? this.findCurated(String(input.id), agent) : undefined;
      const payload = curated ? { ...curated.item, ...input, id: curated.item.id } : { ...input };
      delete payload.scope;
      delete payload.expiresAt;
      const result = this.deep.save(payload, { project, sessionId });
      if (curated) curated.store.remove(curated.item.id);
      this.afterDeepWrite();
      return { action: result.action, item: result.item, scope: 'deep', moved: Boolean(curated) };
    }

    // ── 从深记忆提回精选层 ────────────────────────────────────────────────
    if (input?.id) {
      const curated = this.findCurated(String(input.id), agent);
      if (!curated && this.deep) {
        const archived = this.deep.get(String(input.id));
        if (archived) {
          const target = this.storeFor(wanted ?? 'project', agent);
          const copy = { ...archived, ...input, id: archived.id };
          delete copy.scope;
          delete copy.deep;
          delete copy.project;
          delete copy.sessionId;
          delete copy.sourceJson;
          const expiresAt = target.scope === 'session' && this.config.sessionTtlDays > 0 ? Date.now() + this.config.sessionTtlDays * 86400000 : undefined;
          const result = target.add(copy, { ...defaults, scope: target.scope, expiresAt });
          this.deep.remove(archived.id);
          this.afterDeepWrite();
          return { action: result.action, item: result.item, scope: target.scope, moved: true };
        }
        throw new Error(`没有找到记忆 ${input.id}`);
      }
      if (!curated) throw new Error(`没有找到记忆 ${input.id}`);
      const targetScope = wanted && wanted !== curated.scope ? wanted : curated.scope;
      if (targetScope !== curated.scope) {
        const target = this.storeFor(targetScope, agent);
        const copy = { ...curated.item, ...input, id: curated.item.id };
        delete copy.scope;
        delete copy.expiresAt;
        const expiresAt = target.scope === 'session' && this.config.sessionTtlDays > 0 ? Date.now() + this.config.sessionTtlDays * 86400000 : undefined;
        const result = target.add(copy, { ...defaults, scope: target.scope, expiresAt });
        curated.store.remove(curated.item.id);
        this.afterWrite();
        return { action: result.action, item: result.item, scope: targetScope, moved: true };
      }
      const updated = curated.store.update(curated.item.id, input);
      if (!updated) throw new Error(`没有找到记忆 ${input.id}`);
      this.afterWrite();
      return { action: 'updated', item: updated, scope: curated.scope };
    }

    // ── 新建，落在精选层 ──────────────────────────────────────────────────
    const store = this.storeFor(wanted ?? 'session', agent);
    const expiresAt = store.scope === 'session' && this.config.sessionTtlDays > 0 ? Date.now() + this.config.sessionTtlDays * 86400000 : undefined;
    const result = store.add(input, { ...defaults, scope: store.scope, expiresAt });
    this.afterWrite();
    return { action: result.action, item: result.item, scope: store.scope };
  }

  /**
   * 直接归档到深记忆（不经精选层），供自动捕获与沉淀使用。
   * @param {Record<string, any>} input 字段。
   * @param {any} agent Agent 句柄。
   * @returns {{ action: string, item: Record<string, any> } | null} 结果；深记忆不可用时 null。
   */
  archive(input, agent) {
    if (!this.deep) return null;
    const { cwd, sessionId } = contextOf(agent);
    try {
      const result = this.deep.save(input, { project: projectKey(cwd), sessionId });
      this.afterDeepWrite();
      return result;
    } catch (error) {
      this.log(`[memory] 归档失败：${String(error)}`);
      return null;
    }
  }

  /**
   * 自动捕获：把用户话里明确要求记住的内容落到会话记忆。
   * @param {string} text 候选文本。
   * @param {any} agent Agent 句柄。
   * @param {{ kind?: string, importance?: number, tags?: string[] }} [meta] 推断出的元信息。
   * @returns {{ action: string, item: Record<string, any>, scope: string } | null} 结果。
   */
  capture(text, agent, meta = {}) {
    const body = truncate(text, 400);
    if (!body) return null;
    const { cwd, sessionId } = contextOf(agent);
    const store = this.sessionStore(sessionId, cwd);
    const expiresAt = this.config.sessionTtlDays > 0 ? Date.now() + this.config.sessionTtlDays * 86400000 : undefined;
    const result = store.add(
      {
        text: body,
        kind: meta.kind ?? 'fact',
        importance: meta.importance ?? 4,
        tags: meta.tags ?? [],
        source: { auto: true },
      },
      { cwd, sessionId, scope: 'session', expiresAt },
    );
    this.afterWrite();
    return { action: result.action, item: result.item, scope: 'session' };
  }

  /**
   * 从用户这一句话里读反馈，给上一轮注入的记忆记账。
   *
   * 这是「持续学习」的入口：用户说「不对」，那多半是上一轮的回答有问题，
   * 而回答是基于上一轮注入的记忆。于是给那些记忆 +1 correction，
   * 它们在排序里会轻微降权，也会出现在 `memory_review` 的可疑清单里，
   * 由模型决定是改写还是删掉——插件只负责记账，不改写内容。
   *
   * 只处理精选层：深记忆不进上下文，谈不上「这一轮说错了」。
   * @param {string} text 用户消息。
   * @param {any} agent Agent 句柄。
   * @returns {{ type: 'correction'|'confirmation', applied: number, promoted?: number } | null} 结果。
   */
  observe(text, agent) {
    if (!this.config.learning) return null;
    const feedback = detectFeedback(text);
    if (!feedback) return null;

    const { sessionId } = contextOf(agent);
    const key = String(agent?.id ?? sessionId);
    const last = this.injected.get(key);
    const windowMs = Number(this.config.feedbackWindowSec ?? 600) * 1000;
    if (!last || last.ids.length === 0 || Date.now() - last.at > windowMs) {
      return { type: feedback.type, applied: 0 };
    }

    /** @type {{ scope: string, item: Record<string, any>, lexical: number }[]} */
    const entries = [];
    for (const entry of last.ids) {
      const item = this.storeFor(entry.scope, agent).find(entry.id);
      if (item) entries.push({ scope: entry.scope, item, lexical: Number(entry.lexical ?? 0) });
    }
    // 一次注入只接受一次裁决：否则同一句「对」会在多轮里被重复计数。
    this.injected.delete(key);
    if (entries.length === 0) return { type: feedback.type, applied: 0 };

    // 关键的一步：只标记「和这句话有关」的那几条。
    // 一次注入通常有 5–10 条，用户说「不对」说的是其中一条；
    // 全标一遍会把用户身份、相处方式也一起拖下水。
    let targets;
    if (feedback.type === 'correction') {
      // 纠正句通常会把正确说法讲出来，和「错的那条」共享关键词。
      targets = rankScoped(entries, text)
        .filter((hit) => hit.lexical > 0)
        .slice(0, 3);
      // 只说「不对」两个字时没有关键词可用，退一步：认为上一轮最相关的那条错了。
      // 只取一条，是因为这时候没有别的信息可依据。
      if (targets.length === 0) {
        targets = [...entries].sort((a, b) => b.lexical - a.lexical).filter((entry) => entry.lexical > 0).slice(0, 1);
      }
    } else {
      // 确认句（「对，就是这样」）本身不含话题词，用上一轮注入时的相关度。
      targets = [...entries].sort((a, b) => b.lexical - a.lexical).filter((entry) => entry.lexical > 0).slice(0, 3);
    }
    if (targets.length === 0) return { type: feedback.type, applied: 0 };

    // 按作用域分组，一次调用处理一批。
    const byScope = new Map();
    for (const entry of targets) {
      if (!byScope.has(entry.scope)) byScope.set(entry.scope, []);
      byScope.get(entry.scope).push(entry.item.id);
    }

    let applied = 0;
    let promoted = 0;
    for (const [scope, ids] of byScope) {
      const store = this.storeFor(scope, agent);
      if (feedback.type === 'correction') applied += store.markCorrection(ids);
      else {
        const result = store.markConfirmation(ids, Number(this.config.confirmAfter ?? 3));
        applied += result.marked;
        promoted += result.promoted;
      }
    }
    if (applied > 0) this.afterWrite();
    return { type: feedback.type, applied, promoted };
  }

  /**
   * 记下某个 agent 最近一次用户输入，供检索使用。
   * @param {string} agentId Agent id。
   * @param {string} text 文本。
   */
  noteQuery(agentId, text) {
    this.queries.note(agentId, text);
  }

  /**
   * 某个 agent 最近一次的用户输入。
   * @param {string} agentId Agent id。
   * @returns {string} 文本；没有时为空串。
   */
  lastQuery(agentId) {
    return this.queries.last(agentId);
  }

  // ── 检索 ────────────────────────────────────────────────────────────────

  /**
   * 检索记忆（精选三层 + 深记忆）。
   * @param {string} query 查询词。
   * @param {object} [options] 选项。
   * @param {string[]} [options.scopes] 限定作用域，可含 `deep`。
   * @param {number} [options.limit=8] 返回条数。
   * @param {boolean} [options.touch=true] 是否计入使用频次。
   * @param {any} [agent] Agent 句柄。
   * @returns {{ id: string, scope: string, kind: string, text: string, importance: number, score: number }[]} 结果。
   */
  search(query, options = {}, agent) {
    const { scopes, limit = 8, touch = true } = options;
    const wanted = Array.isArray(scopes) && scopes.length > 0 ? new Set(scopes) : undefined;
    const max = Math.max(1, Math.min(50, limit));
    const { cwd } = contextOf(agent);

    /** @type {{ scope: string, item: Record<string, any> }[]} */
    const entries = [];
    for (const { scope, store } of this.storesFor(agent)) {
      if (wanted && !wanted.has(scope)) continue;
      for (const item of store.list()) entries.push({ scope, item });
    }
    const curatedHits = rankScoped(entries, query).map((hit) => ({
      id: hit.item.id,
      scope: hit.scope,
      kind: hit.item.kind,
      text: hit.item.text,
      importance: hit.item.importance,
      score: hit.score,
    }));

    if (touch) {
      const byStore = new Map();
      for (const hit of curatedHits.slice(0, max)) {
        if (!byStore.has(hit.scope)) byStore.set(hit.scope, []);
        byStore.get(hit.scope).push(hit.id);
      }
      for (const { scope, store } of this.storesFor(agent)) {
        const ids = byStore.get(scope);
        // 这里是「模型主动查了它」，记 used 而不是 hits——两者在打分里权重不同。
        if (ids && ids.length > 0) store.noteUsed(ids);
      }
    }

    // 深记忆：只有明确要（scopes 含 deep）或没限定作用域时才查。
    const wantDeep = Boolean(this.deep) && (!wanted || wanted.has('deep'));
    const deepHits =
      wantDeep && (entries.length > 0 || wanted?.has('deep') || String(query ?? '').trim())
        ? this.deep.search(String(query ?? ''), { limit: max, project: projectKey(cwd), touch }).map((row) => ({
            id: row.id,
            scope: 'deep',
            kind: row.kind,
            text: row.text,
            importance: row.importance,
            score: row.score,
          }))
        : [];

    const merged = [...curatedHits, ...deepHits].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return merged.slice(0, max).map((hit) => ({ ...hit, score: Math.round(hit.score * 1000) / 1000 }));
  }

  /**
   * 删除记忆。
   * @param {object} input 条件。
   * @param {string} [input.id] 精确 id。
   * @param {string} [input.query] 关键词批量删除。
   * @param {string} [input.scope] 限定作用域，可含 `deep`。
   * @param {boolean} [input.confirm=false] 批量删除必须确认。
   * @param {any} agent Agent 句柄。
   * @returns {{ removed: Record<string, any>[], candidates?: Record<string, any>[], needConfirm?: boolean }} 结果。
   */
  forget(input, agent) {
    if (input?.id) {
      const found = this.findAcross(String(input.id), agent);
      if (!found) return { removed: [] };
      if (found.deep) {
        this.deep.remove(found.item.id);
        this.afterDeepWrite();
      } else {
        found.store.remove(found.item.id);
        this.afterWrite();
      }
      return { removed: [{ id: found.item.id, scope: found.scope, text: found.item.text }] };
    }
    const query = String(input?.query ?? '').trim();
    if (!query) throw new Error('memory_forget 需要 id 或 query');
    const wanted = input?.scope ? new Set([String(input.scope)]) : undefined;

    /** @type {{ scope: string, item: Record<string, any> }[]} */
    const entries = [];
    for (const { scope, store } of this.storesFor(agent)) {
      if (wanted && !wanted.has(scope)) continue;
      for (const item of store.list()) entries.push({ scope, item });
    }
    // 只按词法命中删：只靠「重要度高」匹配上的条目，删掉是事故。
    const candidates = rankScoped(entries, query)
      .filter((entry) => entry.lexical > 0)
      .slice(0, 20)
      .map((entry) => ({ id: entry.item.id, scope: entry.scope, kind: entry.item.kind, text: entry.item.text, importance: entry.item.importance, score: Math.round(entry.score * 1000) / 1000 }));

    if (this.deep && (!wanted || wanted.has('deep'))) {
      const { cwd } = contextOf(agent);
      for (const row of this.deep.search(query, { limit: 20, project: projectKey(cwd), touch: false })) {
        candidates.push({ id: row.id, scope: 'deep', kind: row.kind, text: row.text, importance: row.importance, score: row.score });
      }
      candidates.sort((a, b) => b.score - a.score);
    }

    if (!input?.confirm) {
      return { removed: [], candidates, needConfirm: true };
    }
    const removed = [];
    for (const hit of candidates) {
      if (hit.scope === 'deep') {
        if (this.deep?.remove(hit.id)) removed.push({ id: hit.id, scope: 'deep', text: hit.text });
        continue;
      }
      const found = this.findCurated(hit.id, agent);
      if (!found) continue;
      found.store.remove(hit.id);
      removed.push({ id: hit.id, scope: hit.scope, text: hit.text });
    }
    if (removed.some((hit) => hit.scope === 'deep')) this.afterDeepWrite();
    this.afterWrite();
    return { removed };
  }

  // ── 学习 ────────────────────────────────────────────────────────────────

  /**
   * 自我复盘：把「该看但没人看」的记忆列出来。
   *
   * 只读。插件不替模型做判断——它只负责让问题**可见**：
   * 哪条被纠正过、哪条半年没人用、哪两条几乎重复、哪两条在说反话。
   * 改不改、删不删，由模型用 memory_save / memory_forget 决定。
   * @param {any} agent Agent 句柄。
   * @returns {Record<string, any>} 复盘结果。
   */
  review(agent) {
    const now = Date.now();
    /** @type {{ scope: string, item: Record<string, any> }[]} */
    const entries = [];
    for (const { scope, store } of this.storesFor(agent)) {
      for (const item of store.list()) entries.push({ scope, item });
    }

    const suspect = entries
      .filter((entry) => isSuspect(entry.item))
      .sort((a, b) => Number(b.item.corrections ?? 0) - Number(a.item.corrections ?? 0) || Number(b.item.updatedAt ?? 0) - Number(a.item.updatedAt ?? 0))
      .slice(0, 8)
      .map((entry) => ({
        id: entry.item.id,
        scope: entry.scope,
        kind: entry.item.kind,
        text: entry.item.text,
        corrections: Number(entry.item.corrections ?? 0),
        confirmed: Number(entry.item.confirmed ?? 0),
      }));

    const staleDays = Number(this.config.staleDays ?? 120);
    const stale = entries
      .filter((entry) => {
        if (entry.item.pinned) return false;
        if (Number(entry.item.importance ?? 3) > 3) return false;
        const last = Number(entry.item.lastUsedAt ?? entry.item.updatedAt ?? 0);
        return now - last > staleDays * 86400000;
      })
      .sort((a, b) => Number(a.item.lastUsedAt ?? a.item.updatedAt ?? 0) - Number(b.item.lastUsedAt ?? b.item.updatedAt ?? 0))
      .slice(0, 8)
      .map((entry) => ({
        id: entry.item.id,
        scope: entry.scope,
        kind: entry.item.kind,
        text: entry.item.text,
        days: Math.floor((now - Number(entry.item.lastUsedAt ?? entry.item.updatedAt ?? now)) / 86400000),
      }));

    const conflictPairs = findPairs(entries, CONFLICT_THRESHOLD, (left, right) => {
      if (!CONFLICT_KINDS.has(left.item.kind) || left.item.kind !== right.item.kind) return false;
      // 一条说「要这样」，另一条说「别这样」，才算矛盾。
      return hasNegation(left.item.text) !== hasNegation(right.item.text);
    });
    const conflictKeys = new Set(conflictPairs.map(pairKey));
    const conflicts = conflictPairs.map((pair) => ({
      a: { id: pair.left.item.id, scope: pair.left.scope, text: pair.left.item.text },
      b: { id: pair.right.item.id, scope: pair.right.scope, text: pair.right.item.text },
      similarity: round2(pair.similarity),
      kind: pair.left.item.kind,
    }));

    // 已经算作「矛盾」的那一对不再重复列进「重复」——两件事，看一个就够了。
    const duplicates = findPairs(entries, DUPLICATE_THRESHOLD, () => true, { groupBy: 'none' })
      .filter((pair) => !conflictKeys.has(pairKey(pair)))
      .map((pair) => ({
        a: { id: pair.left.item.id, scope: pair.left.scope, text: pair.left.item.text },
        b: { id: pair.right.item.id, scope: pair.right.scope, text: pair.right.item.text },
        similarity: round2(pair.similarity),
      }));

    const week = now - 7 * 86400000;
    const fresh = entries.filter((entry) => Number(entry.item.createdAt ?? 0) >= week);
    return {
      suspect,
      stale,
      duplicates: duplicates.slice(0, 6),
      conflicts: conflicts.slice(0, 6),
      growth: {
        total: entries.length,
        added7d: fresh.length,
        learned7d: fresh.filter((entry) => ['convention', 'gotcha', 'playbook', 'decision', 'preference'].includes(entry.item.kind)).length,
        playbooks: entries.filter((entry) => entry.item.kind === 'playbook').length,
        confirmed: entries.filter((entry) => Number(entry.item.confirmed ?? 0) > 0).length,
      },
    };
  }

  /**
   * 整理记忆：强化常用的、合并重复的、（可选）把过时的沉底。
   *
   * 自动跑时只做前两件——它们不会丢信息；「沉底」会改变可见性，
   * 必须显式 `aggressive: true` 才做（CLI `maintain --aggressive`）。
   * @param {any} [agent] Agent 句柄；不传则整理所有已加载的存储。
   * @param {object} [options] 选项。
   * @param {boolean} [options.aggressive=false] 是否沉底过时条目。
   * @param {boolean} [options.dryRun=false] 只统计不落盘。
   * @returns {{ promoted: number, merged: number, archived: number, removed: number }} 汇总。
   */
  consolidate(agent, { aggressive = false, dryRun = false } = {}) {
    const summary = { promoted: 0, merged: 0, archived: 0, removed: 0 };
    const stores = agent ? this.storesFor(agent) : [...this.stores.values()].map((store) => ({ scope: store.scope, store }));
    const promoteAfter = Number(this.config.promoteAfter ?? 5);

    for (const { store } of stores) {
      // 1) 强化：用得多的记忆，重要度往上走。这是唯一无损的自动改写。
      for (const item of store.list()) {
        const used = Number(item.used ?? 0);
        const importance = Number(item.importance ?? 3);
        if (importance >= 5 || used < promoteAfter * importance) continue;
        summary.promoted += 1;
        if (!dryRun) store.update(item.id, { importance: importance + 1 });
      }

      // 2) 合并：同一层里几乎一样的两条，留一条。
      const entries = store.list().map((item) => ({ scope: store.scope, item }));
      for (const pair of findPairs(entries, 0.92, () => true, { groupBy: 'none' })) {
        const left = pair.left.item;
        const right = pair.right.item;
        if (!store.find(left.id) || !store.find(right.id)) continue;
        const keeper = Number(left.importance ?? 3) >= Number(right.importance ?? 3) ? left : right;
        const loser = keeper === left ? right : left;
        summary.merged += 1;
        if (dryRun) continue;
        store.update(keeper.id, { importance: Math.max(Number(keeper.importance ?? 3), Number(loser.importance ?? 3)) });
        store.remove(loser.id);
      }

      // 3) 衰减：很久没用、又不重要的，沉进深记忆（或直接丢掉）。
      if (!aggressive) continue;
      const staleDays = Number(this.config.staleDays ?? 120);
      for (const item of store.staleCandidates({ days: staleDays, maxImportance: 2 })) {
        summary.archived += 1;
        if (dryRun) continue;
        if (this.deep) {
          this.deep.save({ ...item, source: { ...(item.source ?? {}), archivedFrom: store.scope } }, { project: projectKey(store.cwd ?? '') });
          summary.removed += 1;
          store.remove(item.id);
        } else {
          summary.removed += 1;
          store.remove(item.id);
        }
      }
    }

    if (!dryRun && (summary.promoted > 0 || summary.merged > 0 || summary.removed > 0)) {
      this.afterDeepWrite();
      // 这里不走 afterWrite：整理是被 afterWrite 触发的，再回去会递归。
      this.cache.clear();
      this.scheduleMirror();
    }
    return summary;
  }

  // ── 注入 ────────────────────────────────────────────────────────────────

  /**
   * 为一次提示词组装渲染记忆块。
   * @param {any} agent Agent 句柄。
   * @returns {string} 注入文本；无内容时为空串。
   */
  renderFor(agent) {
    if (!agent) return '';
    const { cwd, sessionId } = contextOf(agent);
    const key = `${agent.id ?? sessionId}`;
    const query = this.queries.last(key) || lastUserText(agent.session);

    const groups = [];
    const globalStore = this.globalStore();
    const projectStore = cwd ? this.projectStore(cwd) : undefined;
    const sessionStore = sessionId ? this.sessionStore(sessionId, cwd) : undefined;
    groups.push({ scope: 'global', items: globalStore.list() });
    if (projectStore) groups.push({ scope: 'project', items: projectStore.list() });
    if (sessionStore) groups.push({ scope: 'session', items: sessionStore.list() });

    // 过期的会话记忆不直接丢，沉到深记忆里——这是「短期记忆变长期」的通道。
    if (sessionStore) this.drainExpired(sessionStore);

    const versionKey = [
      globalStore.version,
      projectStore?.version ?? 0,
      sessionStore?.version ?? 0,
      this.deepVersion,
      hash32(query),
      this.config.budgetChars,
      this.config.deepRecall,
      this.config.playbookRecall,
    ].join(':');
    const cached = this.cache.get(key);
    if (cached && cached.key === versionKey) {
      // 命中缓存也要刷新时间戳：否则连着几步之后反馈窗口会误判成过期。
      const last = this.injected.get(key);
      if (last) last.at = Date.now();
      return cached.text;
    }

    // playbook 单独走一段：它是「怎么做」的流程，和「是什么」的记忆混在一起
    // 会互相挤占预算，也不方便渲染成有步骤感的样子。
    const curated = groups.map((group) => ({ scope: group.scope, items: group.items.filter((item) => item.kind !== 'playbook') }));
    const playbookEntries = groups.flatMap((group) => group.items.filter((item) => item.kind === 'playbook').map((item) => ({ scope: group.scope, item })));

    const { picked, dropped } = select(curated, {
      query,
      budgetChars: this.config.budgetChars,
      now: Date.now(),
    });
    const playbooks = this.selectPlaybooks(playbookEntries, query);

    // 深记忆只占预算的一小块：它是「提示存在这么一条」，不是正文。
    const deep = this.deepRecall(query, cwd, Math.round(this.config.budgetChars * DEEP_BUDGET_RATIO));
    const text = renderRecall({ picked, dropped, projectLabel: projectLabel(cwd), deep, playbooks });

    // 被注入即视为「被想起」，用于后续的新近/频次加权。
    const byScope = new Map();
    for (const entry of [...picked, ...playbooks]) {
      if (!byScope.has(entry.scope)) byScope.set(entry.scope, []);
      byScope.get(entry.scope).push(entry.item.id);
    }
    for (const group of groups) {
      const ids = byScope.get(group.scope);
      if (!ids || ids.length === 0) continue;
      const store = group.scope === 'global' ? globalStore : group.scope === 'project' ? projectStore : sessionStore;
      store?.touchHits(ids);
    }

    // 记下这一轮给了模型什么：下一轮用户说「不对」时要靠它定位。
    this.injected.set(key, {
      // lexical 一起存：下一轮如果用户只是「对」/「不对」，就靠它判断
      // 哪几条真的参与了这一轮的话题。
      ids: [...picked, ...playbooks].map((entry) => ({ scope: entry.scope, id: entry.item.id, lexical: Number(entry.lexical ?? 0) })),
      at: Date.now(),
    });
    if (this.injected.size > 64) this.injected.delete(this.injected.keys().next().value);

    this.cache.set(key, { key: versionKey, text });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return text;
  }

  /**
   * 挑几条与当前话题相关的「打法」。
   *
   * 只挑词法命中或置顶的：playbook 是流程，硬塞一段不相关的流程比不塞更糟。
   * @param {{ scope: string, item: Record<string, any> }[]} entries 全部 playbook。
   * @param {string} query 当前用户输入。
   * @returns {{ scope: string, item: Record<string, any> }[]} 选中的条目。
   */
  selectPlaybooks(entries, query) {
    const limit = Number(this.config.playbookRecall ?? 0);
    if (limit <= 0 || entries.length === 0) return [];
    return rankScoped(entries, query)
      .filter((entry) => entry.lexical > 0 || entry.item.pinned)
      .slice(0, limit)
      .map((entry) => ({ scope: entry.scope, item: entry.item, lexical: entry.lexical }));
  }

  /**
   * 从深记忆里捞几条与当前输入强相关的往事。
   * @param {string} query 当前用户输入。
   * @param {string} cwd 工作目录。
   * @param {number} budgetChars 可用字符预算。
   * @returns {Record<string, any>[]} 选中的深记忆。
   */
  deepRecall(query, cwd, budgetChars) {
    if (!this.deep || this.config.deepRecall <= 0) return [];
    const text = String(query ?? '').trim();
    if (text.length < 2) return [];
    let rows;
    try {
      rows = this.deep.search(text, { limit: this.config.deepRecall, project: projectKey(cwd), touch: true });
    } catch (error) {
      this.log(`[memory] 深记忆检索失败：${String(error)}`);
      return [];
    }
    const picked = [];
    let used = 0;
    for (const row of rows) {
      if (row.score < this.config.deepRecallMin) continue;
      const cost = Math.min(String(row.text ?? '').length, 120) + 24;
      if (used + cost > budgetChars) break;
      picked.push(row);
      used += cost;
    }
    return picked;
  }

  /**
   * 把会话存储里过期的条目沉淀到深记忆。
   * @param {MemoryStore} [sessionStore] 指定的会话存储；不传则处理全部。
   * @returns {number} 沉淀条数。
   */
  drainExpired(sessionStore) {
    if (!this.deep || !this.config.deepAutoArchive) return 0;
    const stores = sessionStore ? [sessionStore] : [...this.stores.values()].filter((store) => store.scope === 'session');
    let count = 0;
    for (const store of stores) {
      const expired = store.takeExpired();
      if (expired.length === 0) continue;
      count += this.deep.archive(
        expired.map((item) => ({ ...item, source: { ...(item.source ?? {}), archivedFrom: 'session' } })),
        { project: projectKey(store.cwd ?? '') },
      );
    }
    if (count > 0) this.afterDeepWrite();
    return count;
  }

  // ── 维护 ────────────────────────────────────────────────────────────────

  /**
   * 统计。
   * @param {any} [agent] Agent 句柄。
   * @returns {Record<string, any>} 统计信息。
   */
  stats(agent) {
    const out = { root: this.root, global: 0, project: 0, session: 0, deep: 0, pinned: 0, playbooks: 0, suspect: 0, confirmed: 0, deepEnabled: Boolean(this.deep) };
    for (const { scope, store } of this.storesFor(agent)) {
      const items = store.list();
      out[scope] = items.length;
      out.pinned += items.filter((item) => item.pinned).length;
      out.playbooks += items.filter((item) => item.kind === 'playbook').length;
      out.suspect += items.filter((item) => isSuspect(item)).length;
      out.confirmed += items.filter((item) => Number(item.confirmed ?? 0) > 0).length;
    }
    if (this.deep) {
      const deepStats = this.deep.stats();
      out.deep = deepStats.count;
      out.deepBytes = deepStats.bytes;
      out.deepFts = deepStats.fts;
      out.deepFile = this.deep.file;
    }
    return out;
  }

  /** 深记忆写入后的收尾：缓存失效、版本前进。 */
  afterDeepWrite() {
    this.deepVersion += 1;
    this.cache.clear();
  }

  /** 写操作后的收尾：刷新镜像、清空渲染缓存、按需触发整理。 */
  afterWrite() {
    this.cache.clear();
    this.writeCount += 1;
    this.scheduleMirror();
    this.maybeConsolidate();
  }

  /** 安排生成 Markdown 镜像（防抖）。 */
  scheduleMirror() {
    if (!this.config.markdownMirror) return;
    this.mirrorDirty = true;
    if (this.mirrorTimer) return;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      this.writeMirrors();
    }, 300);
    if (typeof this.mirrorTimer.unref === 'function') this.mirrorTimer.unref();
  }

  /**
   * 按 `consolidateEvery` 自动整理。
   *
   * 只做「强化 + 合并」：两者都不会丢信息。沉底过时条目会改变可见性，
   * 必须显式调用 `consolidate({ aggressive: true })`。
   */
  maybeConsolidate() {
    const every = Number(this.config.consolidateEvery ?? 0);
    if (every <= 0 || this.writeCount % every !== 0) return;
    // 整理本身会写回，必须挡住重入，否则会在这里无限递归。
    if (this.consolidating) return;
    this.consolidating = true;
    try {
      const summary = this.consolidate(undefined, { aggressive: false });
      if (summary.promoted > 0 || summary.merged > 0) {
        this.log(`[memory] 自动整理：升权 ${summary.promoted} 条，合并 ${summary.merged} 条`);
      }
    } catch (error) {
      this.log(`[memory] 自动整理失败：${String(error)}`);
    } finally {
      this.consolidating = false;
    }
  }

  /** 生成 Markdown 镜像（只覆盖 global 与 project）。 */
  writeMirrors() {
    if (!this.mirrorDirty) return;
    this.mirrorDirty = false;
    for (const store of this.stores.values()) {
      if (store.scope === 'session') continue;
      const items = store.list();
      if (items.length === 0 && !store.exists()) continue;
      const file = join(dirname(store.file), 'MEMORY.md');
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderMarkdown({ scope: store.scope, cwd: store.cwd ?? '', items }), 'utf8');
      } catch (error) {
        this.log(`[memory] 写入镜像 ${file} 失败：${String(error)}`);
      }
    }
  }

  /** 全量落盘（卸载 / 退出）。 */
  dispose() {
    if (this.mirrorTimer) {
      clearTimeout(this.mirrorTimer);
      this.mirrorTimer = null;
    }
    for (const store of this.stores.values()) store.flushSync();
    this.writeMirrors();
    this.drainExpired();
    this.deep?.close();
    this.cache.clear();
  }
}

/**
 * 把作用域输入收敛成四层之一。
 * @param {unknown} value 原始值。
 * @returns {'global'|'project'|'session'|'deep'|undefined} 作用域；非法时 undefined。
 */
export function normalizeScope(value) {
  return ['global', 'project', 'session', 'deep'].includes(String(value)) ? /** @type {any} */ (String(value)) : undefined;
}

/**
 * 找出两两相似度超过门槛的条目对。
 *
 * 分组的目的是把 O(n²) 压下来：同一类（或同一条目集合）内部才两两比，
 * 每组最多 `cap` 条，超出时优先保留最近的——复盘关心的是「现在还在用的东西」。
 * @param {{ scope: string, item: Record<string, any> }[]} entries 候选。
 * @param {number} threshold 相似度门槛。
 * @param {(left: any, right: any) => boolean} accept 额外过滤条件。
 * @param {object} [options] 选项。
 * @param {'kind'|'none'} [options.groupBy='kind'] 分组方式。
 * @param {number} [options.cap] 每组上限。
 * @returns {{ left: any, right: any, similarity: number }[]} 按相似度降序的条目对。
 */
function findPairs(entries, threshold, accept, { groupBy = 'kind', cap = REVIEW_GROUP_CAP } = {}) {
  const sorted = [...entries].sort((a, b) => Number(b.item.updatedAt ?? 0) - Number(a.item.updatedAt ?? 0));
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const entry of sorted) {
    const key = groupBy === 'none' ? '' : String(entry.item.kind ?? 'fact');
    if (!groups.has(key)) groups.set(key, []);
    const list = groups.get(key);
    if (list.length >= cap) continue;
    list.push(entry);
  }

  const pairs = [];
  for (const list of groups.values()) {
    const sets = list.map((entry) => bigramSet(entry.item.text));
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        if (!accept(list[left], list[right])) continue;
        const score = similarityOf(sets[left], sets[right]);
        if (score < threshold) continue;
        pairs.push({ left: list[left], right: list[right], similarity: score });
      }
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity);
  return pairs;
}

/**
 * 保留两位小数。
 * @param {number} value 数值。
 * @returns {number} 结果。
 */
function round2(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/**
 * 一对记忆的稳定键：同一对无论左右顺序都得到同一个键。
 * @param {{ left: any, right: any }} pair 条目对。
 * @returns {string} 键。
 */
function pairKey(pair) {
  return [pair.left.item.id, pair.right.item.id].sort().join('|');
}

