/**
 * 记忆服务：把三层存储、检索、注入、写入串起来。
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
import { renderMarkdown } from './markdown.js';
import { globalDir, deepFile, normalizeCwd, projectDir, projectFallbackFile, projectLabel, safeName, sessionFile } from './paths.js';
import { renderRecall } from './render.js';
import { rankScoped, select } from './retrieval.js';
import { MemoryStore } from './store.js';
import { hash32, lastUserText, truncate } from './text.js';

/** 会话存储缓存上限：同时开着的会话不会超过这个数。 */
const SESSION_CACHE = 32;

/** 深记忆自动浮现最多占多少字符预算。 */
const DEEP_BUDGET_RATIO = 0.3;

/**
 * 从 agent 上读出记忆需要的上下文。
 * @param {any} agent DSH 的 Agent 句柄。
 * @returns {{ cwd: string, sessionId: string }} 上下文。
 */
export function contextOf(agent) {
  const header = agent?.session?.header ?? {};
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';
  const sessionId = String(header.id ?? agent?.id ?? '');
  return { cwd, sessionId };
}

/**
 * 记忆服务。
 */
export class MemoryService {
  /**
   * @param {object} options 选项。
   * @param {Record<string, any>} options.config 已解析的插件配置。
   * @param {(message: string) => void} [options.logger] 告警输出。
   */
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger ?? (() => {});
    this.root = globalDir(config.globalDir);
    /** @type {Map<string, MemoryStore>} */
    this.stores = new Map();
    /** @type {Map<string, { text: string, at: number }>} */
    this.queries = new Map();
    /** @type {Map<string, { key: string, text: string }>} */
    this.cache = new Map();
    /** @type {Map<string, boolean>} */
    this.writable = new Map();
    this.mirrorTimer = null;
    this.mirrorDirty = false;
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
   * 记下某个 agent 最近一次用户输入，供检索使用。
   * @param {string} agentId Agent id。
   * @param {string} text 文本。
   */
  noteQuery(agentId, text) {
    if (!agentId) return;
    const value = truncate(text, 2000);
    if (!value) return;
    this.queries.set(agentId, { text: value, at: Date.now() });
    if (this.queries.size > 64) {
      const oldest = [...this.queries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.queries.delete(oldest[0]);
    }
  }

  /**
   * 某个 agent 最近一次的用户输入。
   * @param {string} agentId Agent id。
   * @returns {string} 文本；没有时为空串。
   */
  lastQuery(agentId) {
    return this.queries.get(String(agentId ?? ''))?.text ?? '';
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
        if (ids && ids.length > 0) store.touchHits(ids);
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
    const query = this.queries.get(key)?.text ?? lastUserText(agent.session);

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
    ].join(':');
    const cached = this.cache.get(key);
    if (cached && cached.key === versionKey) return cached.text;

    const { picked, dropped } = select(groups, {
      query,
      budgetChars: this.config.budgetChars,
      now: Date.now(),
    });

    // 深记忆只占预算的一小块：它是「提示存在这么一条」，不是正文。
    const deep = this.deepRecall(query, cwd, Math.round(this.config.budgetChars * DEEP_BUDGET_RATIO));
    const text = renderRecall({ picked, dropped, projectLabel: projectLabel(cwd), deep });

    // 被注入即视为「被想起」，用于后续的新近/频次加权。
    const byScope = new Map();
    for (const entry of picked) {
      if (!byScope.has(entry.scope)) byScope.set(entry.scope, []);
      byScope.get(entry.scope).push(entry.item.id);
    }
    for (const group of groups) {
      const ids = byScope.get(group.scope);
      if (!ids || ids.length === 0) continue;
      const store = group.scope === 'global' ? globalStore : group.scope === 'project' ? projectStore : sessionStore;
      store?.touchHits(ids);
    }

    this.cache.set(key, { key: versionKey, text });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return text;
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
    const out = { root: this.root, global: 0, project: 0, session: 0, deep: 0, pinned: 0, deepEnabled: Boolean(this.deep) };
    for (const { scope, store } of this.storesFor(agent)) {
      const items = store.list();
      out[scope] = items.length;
      out.pinned += items.filter((item) => item.pinned).length;
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

  /** 写操作后的收尾：刷新镜像、清空渲染缓存。 */
  afterWrite() {
    this.cache.clear();
    if (!this.config.markdownMirror) return;
    this.mirrorDirty = true;
    if (this.mirrorTimer) return;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      this.writeMirrors();
    }, 300);
    if (typeof this.mirrorTimer.unref === 'function') this.mirrorTimer.unref();
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
 * 项目键：规范化后的工作目录，空目录用空串（表示不绑定项目）。
 * @param {string} cwd 工作目录。
 * @returns {string} 项目键。
 */
export function projectKey(cwd) {
  return cwd ? normalizeCwd(cwd) : '';
}

