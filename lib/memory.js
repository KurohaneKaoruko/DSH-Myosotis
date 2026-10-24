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
import { renderMarkdown } from './markdown.js';
import { globalDir, normalizeCwd, projectDir, projectFallbackFile, projectLabel, safeName, sessionFile } from './paths.js';
import { renderRecall } from './render.js';
import { rankScoped, select } from './retrieval.js';
import { MemoryStore } from './store.js';
import { hash32, lastUserText, truncate } from './text.js';

/** 会话存储缓存上限：同时开着的会话不会超过这个数。 */
const SESSION_CACHE = 32;

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
   * @returns {MemoryStore} 存储。
   */
  sessionStore(sessionId) {
    const file = sessionFile(this.root, sessionId || 'anonymous');
    return this.store(`session:${safeName(sessionId || 'anonymous')}`, file, 'session', this.config.maxSession, this.config.sessionTtlDays);
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
    if (scope === 'session') return this.sessionStore(sessionId);
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
    if (sessionId) list.push({ scope: 'session', store: this.sessionStore(sessionId) });
    return list;
  }

  /**
   * 在所有作用域里按 id 找一条。
   * @param {string} id 记忆 id。
   * @param {any} agent Agent 句柄。
   * @returns {{ scope: string, store: MemoryStore, item: Record<string, any> } | undefined} 命中。
   */
  findAcross(id, agent) {
    for (const { scope, store } of this.storesFor(agent)) {
      const item = store.find(id);
      if (item) return { scope, store, item };
    }
    return undefined;
  }

  // ── 写入 ────────────────────────────────────────────────────────────────

  /**
   * 保存一条记忆（新增 / 更新 / 跨作用域移动）。
   * @param {Record<string, any>} input 字段。
   * @param {any} agent Agent 句柄。
   * @returns {{ action: string, item: Record<string, any>, scope: string, moved?: boolean }} 结果。
   */
  save(input, agent) {
    const { cwd, sessionId } = contextOf(agent);
    const wantedScope = ['global', 'project', 'session'].includes(input?.scope) ? input.scope : 'session';
    const defaults = { cwd, sessionId, now: Date.now() };

    if (input?.id) {
      const found = this.findAcross(String(input.id), agent);
      if (!found) throw new Error(`没有找到记忆 ${input.id}`);
      const targetScope = input.scope && input.scope !== found.scope ? input.scope : found.scope;
      if (targetScope !== found.scope) {
        const target = this.storeFor(targetScope, agent);
        const copy = { ...found.item, ...input, id: found.item.id };
        delete copy.scope;
        delete copy.expiresAt;
        const expiresAt = target.scope === 'session' && this.config.sessionTtlDays > 0 ? Date.now() + this.config.sessionTtlDays * 86400000 : undefined;
        const result = target.add(copy, { ...defaults, scope: target.scope, expiresAt });
        found.store.remove(found.item.id);
        this.afterWrite();
        return { action: result.action, item: result.item, scope: targetScope, moved: true };
      }
      const updated = found.store.update(found.item.id, input);
      if (!updated) throw new Error(`没有找到记忆 ${input.id}`);
      this.afterWrite();
      return { action: 'updated', item: updated, scope: found.scope };
    }

    const store = this.storeFor(wantedScope, agent);
    const expiresAt = store.scope === 'session' && this.config.sessionTtlDays > 0 ? Date.now() + this.config.sessionTtlDays * 86400000 : undefined;
    const result = store.add(input, { ...defaults, scope: store.scope, expiresAt });
    this.afterWrite();
    return { action: result.action, item: result.item, scope: store.scope };
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
    const store = this.sessionStore(sessionId);
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
   * 检索记忆。
   * @param {string} query 查询词。
   * @param {object} [options] 选项。
   * @param {string[]} [options.scopes] 限定作用域。
   * @param {number} [options.limit=8] 返回条数。
   * @param {boolean} [options.touch=true] 是否计入使用频次。
   * @param {any} [agent] Agent 句柄。
   * @returns {{ id: string, scope: string, kind: string, text: string, importance: number, score: number }[]} 结果。
   */
  search(query, options = {}, agent) {
    const { scopes, limit = 8, touch = true } = options;
    const wanted = Array.isArray(scopes) && scopes.length > 0 ? new Set(scopes) : undefined;
    /** @type {{ scope: string, item: Record<string, any> }[]} */
    const entries = [];
    for (const { scope, store } of this.storesFor(agent)) {
      if (wanted && !wanted.has(scope)) continue;
      for (const item of store.list()) entries.push({ scope, item });
    }
    const top = rankScoped(entries, query).slice(0, Math.max(1, Math.min(50, limit)));

    if (touch) {
      const byStore = new Map();
      for (const hit of top) {
        if (!byStore.has(hit.scope)) byStore.set(hit.scope, []);
        byStore.get(hit.scope).push(hit.item.id);
      }
      for (const { scope, store } of this.storesFor(agent)) {
        const ids = byStore.get(scope);
        if (ids && ids.length > 0) store.touchHits(ids);
      }
    }

    return top.map((hit) => ({
      id: hit.item.id,
      scope: hit.scope,
      kind: hit.item.kind,
      text: hit.item.text,
      importance: hit.item.importance,
      score: Math.round(hit.score * 1000) / 1000,
    }));
  }

  /**
   * 删除记忆。
   * @param {object} input 条件。
   * @param {string} [input.id] 精确 id。
   * @param {string} [input.query] 关键词批量删除。
   * @param {string} [input.scope] 限定作用域。
   * @param {boolean} [input.confirm=false] 批量删除必须确认。
   * @param {any} agent Agent 句柄。
   * @returns {{ removed: Record<string, any>[], candidates?: Record<string, any>[], needConfirm?: boolean }} 结果。
   */
  forget(input, agent) {
    if (input?.id) {
      const found = this.findAcross(String(input.id), agent);
      if (!found) return { removed: [] };
      found.store.remove(found.item.id);
      this.afterWrite();
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
    if (!input?.confirm) {
      return { removed: [], candidates, needConfirm: true };
    }
    const removed = [];
    for (const hit of candidates) {
      const found = this.findAcross(hit.id, agent);
      if (!found) continue;
      found.store.remove(hit.id);
      removed.push({ id: hit.id, scope: hit.scope, text: hit.text });
    }
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
    const sessionStore = sessionId ? this.sessionStore(sessionId) : undefined;
    groups.push({ scope: 'global', items: globalStore.list() });
    if (projectStore) groups.push({ scope: 'project', items: projectStore.list() });
    if (sessionStore) groups.push({ scope: 'session', items: sessionStore.list() });

    const versionKey = `${globalStore.version}:${projectStore?.version ?? 0}:${sessionStore?.version ?? 0}:${hash32(query)}:${this.config.budgetChars}`;
    const cached = this.cache.get(key);
    if (cached && cached.key === versionKey) return cached.text;

    const { picked, dropped } = select(groups, {
      query,
      budgetChars: this.config.budgetChars,
      now: Date.now(),
    });

    const text = renderRecall({ picked, dropped, projectLabel: projectLabel(cwd) });

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

  // ── 维护 ────────────────────────────────────────────────────────────────

  /**
   * 统计。
   * @param {any} [agent] Agent 句柄。
   * @returns {Record<string, any>} 统计信息。
   */
  stats(agent) {
    const out = { root: this.root, global: 0, project: 0, session: 0, pinned: 0 };
    for (const { scope, store } of this.storesFor(agent)) {
      const items = store.list();
      out[scope] = items.length;
      out.pinned += items.filter((item) => item.pinned).length;
    }
    return out;
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
    this.cache.clear();
  }
}

