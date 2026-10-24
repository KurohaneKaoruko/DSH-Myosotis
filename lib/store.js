/**
 * 一层记忆的持久化容器：一个 JSON 文件 = 一个作用域。
 *
 * 设计取舍：
 * - **同步读、异步写**。读发生在提示词组装路径上（必须同步拿到字符串），
 *   文件很小（几百条），一次 readFileSync 可以接受；写走防抖 + 原子替换，
 *   不阻塞对话。
 * - **一个进程内只有一个实例**，按绝对路径去重。多开窗口时是「最后写入者胜」，
 *   原子替换保证任何时刻文件都是完整 JSON，不会读到半个对象。
 * - 淘汰与去重放在这里，而不是上层：任何写入口（工具、自动捕获、CLI）
 *   都自动享受同样的卫生规则。
 *
 * @module dsh-myosotis/store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { similarity, normalizeText, truncate } from './text.js';

/** 文件格式版本。字段不兼容时靠它做迁移。 */
export const FORMAT_VERSION = 1;

/** 记忆种类。顺序即 UI/渲染里的展示优先级。 */
export const KINDS = [
  'profile',
  'preference',
  'habit',
  'convention',
  'decision',
  'fact',
  'gotcha',
  'episode',
  'bond',
];

/** 种类 → 中文标签。 */
export const KIND_LABELS = {
  profile: '身份',
  preference: '偏好',
  habit: '习惯',
  convention: '约定',
  decision: '决策',
  fact: '事实',
  gotcha: '坑',
  episode: '经历',
  bond: '关系',
};

/** 作用域。 */
export const SCOPES = ['global', 'project', 'session'];

let counter = 0;

/**
 * 生成记忆 id。带时间前缀，方便人眼看顺序；随机尾缀避免同毫秒碰撞。
 * @param {number} now 毫秒时间戳。
 * @returns {string} 形如 `m_lq3f9a_7c1`。
 */
export function createId(now = Date.now()) {
  counter = (counter + 1) % 1296;
  return `m_${now.toString(36)}_${counter.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 36).toString(36)}`;
}

/**
 * 把任意输入收敛成一条合法记忆。
 * @param {Record<string, unknown>} input 原始字段。
 * @param {object} defaults 作用域、来源等默认值。
 * @returns {Record<string, unknown>} 规范化后的记录。
 */
export function normalizeRecord(input, defaults = {}) {
  const text = truncate(String(input.text ?? ''), 2000);
  if (!text) throw new Error('memory text must not be empty');
  const kind = KINDS.includes(String(input.kind)) ? String(input.kind) : 'fact';
  const importance = clampInt(input.importance, 1, 5, 3);
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  const now = Number(defaults.now ?? Date.now());
  const affect = normalizeAffect(input.affect);
  return {
    id: typeof input.id === 'string' && input.id ? input.id : createId(now),
    scope: SCOPES.includes(String(defaults.scope)) ? String(defaults.scope) : 'project',
    kind,
    text,
    tags,
    importance,
    pinned: input.pinned === true,
    ...(affect ? { affect } : {}),
    ...(typeof input.date === 'string' && /^\d{2}-\d{2}$/.test(input.date) ? { date: input.date } : {}),
    source: {
      ...(defaults.sessionId ? { sessionId: defaults.sessionId } : {}),
      ...(defaults.cwd ? { cwd: defaults.cwd } : {}),
      ...(input.source && typeof input.source === 'object' ? input.source : {}),
      at: now,
    },
    hits: Number.isFinite(Number(input.hits)) ? Number(input.hits) : 0,
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now,
    updatedAt: now,
    ...(typeof defaults.expiresAt === 'number' ? { expiresAt: defaults.expiresAt } : {}),
  };
}

/**
 * 夹取整数。
 * @param {unknown} value 输入。
 * @param {number} min 下界。
 * @param {number} max 上界。
 * @param {number} fallback 非法时的回退值。
 * @returns {number} 结果。
 */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * 规范化情绪标注。
 * @param {unknown} value `{ label, intensity }`。
 * @returns {{ label: string, intensity: number } | null} 合法值或 null。
 */
function normalizeAffect(value) {
  if (value === null || typeof value !== 'object') return null;
  const label = typeof value.label === 'string' ? truncate(value.label, 24) : '';
  const intensity = clampInt(value.intensity, 1, 5, 0);
  if (!label && intensity === 0) return null;
  return { label: label || '情绪', intensity: intensity || 3 };
}

/**
 * 保留分数：条目超限时按它从低到高淘汰。置顶项永不淘汰。
 * @param {Record<string, any>} item 记录。
 * @param {number} now 当前时间。
 * @returns {number} 分数。
 */
export function retentionScore(item, now = Date.now()) {
  const ageDays = Math.max(0, now - Number(item.updatedAt ?? now)) / 86400000;
  const recency = Math.exp(-ageDays / 60);
  return Number(item.importance ?? 3) * 2 + Math.min(Number(item.hits ?? 0), 10) * 0.3 + recency * 2 + (item.pinned ? 1000 : 0);
}

/**
 * 一个作用域的记忆集合。
 */
export class MemoryStore {
  /**
   * @param {object} options 配置。
   * @param {string} options.file JSON 文件绝对路径。
   * @param {'global'|'project'|'session'} options.scope 作用域。
   * @param {number} [options.limit=400] 条目上限，超出按保留分数淘汰。
   * @param {number} [options.ttlDays=0] 过期天数；0 表示永不过期。
   * @param {(message: string) => void} [options.logger] 告警输出。
   */
  constructor({ file, scope, limit = 400, ttlDays = 0, logger }) {
    this.file = file;
    this.scope = scope;
    this.limit = limit;
    this.ttlDays = ttlDays;
    this.log = logger ?? (() => {});
    /** @type {Record<string, any>[]} */
    this.items = [];
    /** 每次内存变更自增，供渲染缓存判定失效。 */
    this.version = 0;
    this.loaded = false;
    this.dirty = false;
    this.timer = null;
    this.meta = {};
  }

  /** 从磁盘同步载入（只做一次）。 */
  load() {
    if (this.loaded) return this;
    this.loaded = true;
    let raw;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return this;
    }
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      this.items = items.filter((item) => item && typeof item.text === 'string' && item.text.trim().length > 0);
      this.meta = parsed && typeof parsed === 'object' ? { updatedAt: parsed.updatedAt } : {};
      this.version += 1;
    } catch (error) {
      this.log(`[memory] 无法解析 ${this.file}，已按空集合处理：${String(error)}`);
      this.items = [];
    }
    this.prune();
    return this;
  }

  /**
   * 丢弃过期条目。
   * @param {number} [now=Date.now()] 当前时间。
   * @returns {number} 被丢弃的条数。
   */
  prune(now = Date.now()) {
    const before = this.items.length;
    this.items = this.items.filter((item) => {
      const expiresAt = Number(item.expiresAt ?? 0);
      return !(expiresAt > 0 && expiresAt <= now);
    });
    const removed = before - this.items.length;
    if (removed > 0) this.touch();
    return removed;
  }

  /**
   * 按 id 查一条。
   * @param {string} id 记忆 id。
   * @returns {Record<string, any> | undefined} 记录。
   */
  find(id) {
    this.load();
    return this.items.find((item) => item.id === id);
  }

  /** @returns {Record<string, any>[]} 当前全部条目（只读视图）。 */
  list() {
    this.load();
    return this.items;
  }

  /**
   * 写入一条记忆：命中近似重复则合并，命中完全重复则更新，否则新增。
   * @param {Record<string, unknown>} input 记录字段。
   * @param {object} [defaults] 默认作用域与来源。
   * @returns {{ action: 'created'|'updated'|'merged', item: Record<string, any> }} 结果。
   */
  add(input, defaults = {}) {
    this.load();
    const now = Number(defaults.now ?? Date.now());
    const record = normalizeRecord({ ...input }, { scope: this.scope, now, ...defaults });

    const duplicate = this.items.find((item) => normalizeText(item.text) === normalizeText(record.text));
    if (duplicate) {
      this.mergeInto(duplicate, record, now);
      return { action: 'updated', item: duplicate };
    }
    const similar = this.items.find((item) => similarity(item.text, record.text) >= 0.85);
    if (similar) {
      this.mergeInto(similar, record, now);
      return { action: 'merged', item: similar };
    }

    this.items.push(record);
    this.evict(now);
    this.touch();
    return { action: 'created', item: record };
  }

  /**
   * 把新记录合并进旧记录：保留更长的文本，重要度取高，标签并集。
   * @param {Record<string, any>} target 旧记录。
   * @param {Record<string, any>} incoming 新记录。
   * @param {number} now 当前时间。
   */
  mergeInto(target, incoming, now) {
    if (incoming.text.length > target.text.length) target.text = incoming.text;
    target.importance = Math.max(Number(target.importance ?? 3), Number(incoming.importance ?? 3));
    target.pinned = Boolean(target.pinned || incoming.pinned);
    target.tags = [...new Set([...(target.tags ?? []), ...(incoming.tags ?? [])])].slice(0, 12);
    if (incoming.affect) target.affect = incoming.affect;
    if (incoming.date) target.date = incoming.date;
    target.updatedAt = now;
    this.touch();
  }

  /**
   * 更新一条记忆的字段。
   * @param {string} id 记忆 id。
   * @param {Record<string, unknown>} patch 字段补丁。
   * @returns {Record<string, any> | undefined} 更新后的记录；不存在时 undefined。
   */
  update(id, patch) {
    this.load();
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    if (typeof patch.text === 'string' && patch.text.trim()) item.text = truncate(patch.text.trim(), 2000);
    if (KINDS.includes(String(patch.kind))) item.kind = String(patch.kind);
    if (typeof patch.importance !== 'undefined') item.importance = clampInt(patch.importance, 1, 5, item.importance);
    if (typeof patch.pinned === 'boolean') item.pinned = patch.pinned;
    if (Array.isArray(patch.tags)) {
      item.tags = [...new Set(patch.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
    }
    if (patch.affect !== undefined) {
      const affect = normalizeAffect(patch.affect);
      if (affect) item.affect = affect;
      else delete item.affect;
    }
    if (typeof patch.date === 'string' && /^\d{2}-\d{2}$/.test(patch.date)) item.date = patch.date;
    item.updatedAt = Date.now();
    this.touch();
    return item;
  }

  /**
   * 删除一条。
   * @param {string} id 记忆 id。
   * @returns {Record<string, any> | undefined} 被删除的记录。
   */
  remove(id) {
    this.load();
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [removed] = this.items.splice(index, 1);
    this.touch();
    return removed;
  }

  /**
   * 记一次命中，用于使用频次加权。
   *
   * 注意：**不递增 version**。命中会让分数轻微变化，但注入块在同一轮里必须稳定
   * （否则每步都重算、缓存前缀被打碎）；而 version 一变，渲染缓存立刻失效，
   * 下次渲染又命中一次 → 每步都在重算。所以命中只安排落盘，不参与缓存判定。
   * @param {string[]} ids 被注入/检索到的 id。
   */
  touchHits(ids) {
    if (ids.length === 0) return;
    const now = Date.now();
    const wanted = new Set(ids);
    let changed = false;
    for (const item of this.items) {
      if (!wanted.has(item.id)) continue;
      item.hits = Number(item.hits ?? 0) + 1;
      item.lastUsedAt = now;
      changed = true;
    }
    if (changed) this.schedule();
  }

  /**
   * 超出上限时按保留分数淘汰。
   * @param {number} now 当前时间。
   */
  evict(now = Date.now()) {
    if (this.items.length <= this.limit) return;
    const ranked = [...this.items].sort((a, b) => retentionScore(a, now) - retentionScore(b, now));
    const drop = new Set();
    let excess = this.items.length - this.limit;
    for (const item of ranked) {
      if (excess <= 0) break;
      if (item.pinned) continue;
      drop.add(item.id);
      excess -= 1;
    }
    if (drop.size > 0) this.items = this.items.filter((item) => !drop.has(item.id));
  }

  /** 标记有未落盘变更并安排防抖写入。 */
  touch() {
    this.version += 1;
    this.schedule();
  }

  /** 只安排防抖落盘，不动 version（命中计数这类「不值得打断缓存」的变更用）。 */
  schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 120);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * 序列化当前内容。
   * @returns {string} JSON 文本。
   */
  serialize() {
    return (
      JSON.stringify(
        {
          version: FORMAT_VERSION,
          scope: this.scope,
          updatedAt: Date.now(),
          items: this.items,
        },
        null,
        2,
      ) + '\n'
    );
  }

  /**
   * 异步落盘（防抖回调）。
   * @returns {void}
   */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeJsonAtomic(this.file, this.serialize());
    } catch (error) {
      this.dirty = true;
      this.log(`[memory] 写入 ${this.file} 失败：${String(error)}`);
    }
  }

  /**
   * 同步落盘，用于卸载/进程退出。
   * @returns {void}
   */
  flushSync() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeJsonAtomic(this.file, this.serialize());
    } catch (error) {
      this.dirty = true;
      this.log(`[memory] 写入 ${this.file} 失败：${String(error)}`);
    }
  }

  /**
   * 文件是否已存在（CLI 判断用）。
   * @returns {boolean} 是否存在。
   */
  exists() {
    try {
      return statSync(this.file).isFile();
    } catch {
      return false;
    }
  }
}

/**
 * 原子写 JSON：先写同目录临时文件，再 rename 覆盖。
 * Windows 上杀毒/索引器偶尔会占用目标文件，所以对 EPERM/EACCES/EBUSY 做短暂重试。
 * @param {string} file 目标路径。
 * @param {string} content 完整内容。
 * @returns {void}
 */
export function writeJsonAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
      const until = Date.now() + 15 * (attempt + 1);
      while (Date.now() < until) {
        /* 短暂自旋等待占用释放：这里在写路径上，不值得引入异步。 */
      }
    }
  }
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* 临时文件清理失败不影响主流程 */
  }
  throw lastError;
}
