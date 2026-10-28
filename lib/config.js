/**
 * 配置声明。
 *
 * 这里没有用 schemastery，而是直接实现 Standard Schema 接口
 * （`{"~standard": { validate }}`）——Cordis 只认这个协议。
 * 好处是这个插件**零运行时依赖**：不需要解析 `@deepseek-ai/schemastery`，
 * 也就能在没有 DSH 的环境里被单测直接 import。
 *
 * 铁律：每个字段都必须有默认值。profile 里那行 `- id: memory / name: dsh-myosotis`
 * 不带 config，校验器必须能把它补全成一份完整配置，否则整棵插件树启动失败。
 *
 * @module dsh-myosotis/config
 */

/**
 * @typedef {object} Field
 * @property {'boolean'|'string'|'number'} type 类型。
 * @property {any} default 默认值。
 * @property {number} [min] 数值下界。
 * @property {number} [max] 数值上界。
 * @property {string} description 说明（给人看）。
 */

/** @type {Record<string, Field>} */
export const FIELDS = {
  enabled: { type: 'boolean', default: true, description: '总开关；关掉后不注册任何段落与工具' },
  globalDir: { type: 'string', default: '', description: '全局记忆目录；空 = <DSH_HOME>/memory' },
  projectDir: { type: 'string', default: '.dsh/memory', description: '项目记忆目录（相对工作目录）' },
  inject: { type: 'boolean', default: true, description: '是否把记忆注入系统提示词' },
  policy: { type: 'boolean', default: true, description: '是否注入记忆使用规则段落' },
  budgetChars: { type: 'number', default: 2400, min: 200, max: 20000, description: '每轮注入的字符预算' },
  maxGlobal: { type: 'number', default: 400, min: 20, max: 5000, description: '全局记忆条数上限' },
  maxProject: { type: 'number', default: 300, min: 20, max: 5000, description: '项目记忆条数上限' },
  maxSession: { type: 'number', default: 120, min: 10, max: 2000, description: '会话记忆条数上限' },
  sessionTtlDays: { type: 'number', default: 30, min: 0, max: 3650, description: '会话记忆过期天数；0 = 不过期' },
  autoCapture: { type: 'boolean', default: true, description: '自动捕获「记住 / 以后都 / 不要再」这类明确指令' },
  autoEpisode: { type: 'boolean', default: false, description: '日记模式：每轮结束自动往深记忆记一条流水' },
  episodeMinTools: { type: 'number', default: 2, min: 1, max: 50, description: '日记模式的工具调用门槛' },
  markdownMirror: { type: 'boolean', default: true, description: '同步生成人类可读的 MEMORY.md 镜像' },
  deep: { type: 'boolean', default: true, description: '启用 SQLite 深记忆（需要运行时支持 node:sqlite）' },
  deepPath: { type: 'string', default: '', description: '深记忆数据库路径；空 = <DSH_HOME>/memory/deep.db' },
  deepMax: { type: 'number', default: 20000, min: 100, max: 2000000, description: '深记忆条数上限，超出按保留分数淘汰' },
  deepRecall: { type: 'number', default: 2, min: 0, max: 8, description: '每轮自动浮现几条相关往事；0 = 不浮现' },
  deepRecallMin: { type: 'number', default: 1.6, min: 0, max: 10, description: '浮现的分数门槛，越高越保守' },
  deepAutoArchive: { type: 'boolean', default: true, description: '会话记忆过期后沉淀进深记忆，而不是直接丢弃' },

  // ── 学习（自我进化） ──────────────────────────────────────────────────
  learning: { type: 'boolean', default: true, description: '启用反馈闭环：从「不对 / 就是这样」里修正记忆权重' },
  feedbackWindowSec: { type: 'number', default: 600, min: 30, max: 86400, description: '反馈只关联这个时间窗内注入过的记忆' },
  confirmAfter: { type: 'number', default: 3, min: 1, max: 20, description: '被确认几次后自动升一级重要度' },
  promoteAfter: { type: 'number', default: 5, min: 1, max: 50, description: '被主动检索多少次后，整理时升一级重要度（按 used ≥ 门槛 × 重要度 判定）' },
  staleDays: { type: 'number', default: 120, min: 7, max: 3650, description: '多少天没被用过算过时' },
  consolidateEvery: { type: 'number', default: 0, min: 0, max: 1000, description: '每多少次写入自动整理一次；0 = 只在 CLI / 工具里跑' },
  playbookRecall: { type: 'number', default: 2, min: 0, max: 6, description: '每轮最多浮现几条相关打法；0 = 不浮现' },

  // ── 知识库 ────────────────────────────────────────────────────────────
  knowledge: { type: 'boolean', default: true, description: '启用 SQLite 知识库（需要运行时支持 node:sqlite）' },
  kbPath: { type: 'string', default: '', description: '知识库数据库路径；空 = <DSH_HOME>/memory/knowledge.db' },
  kbDir: { type: 'string', default: 'docs', description: '默认知识目录（相对工作目录）；kb_add 不带路径时扫这里' },
  kbInject: { type: 'boolean', default: true, description: '每轮把检索到的文档摘录注入上下文' },
  kbRecall: { type: 'number', default: 2, min: 0, max: 8, description: '每轮注入几段摘录；0 = 不注入' },
  kbRecallMin: { type: 'number', default: 1.8, min: 0, max: 10, description: '摘录的分数门槛，越高越保守' },
  kbBudgetChars: { type: 'number', default: 700, min: 100, max: 4000, description: '知识库摘录的字符预算' },
  kbChunkChars: { type: 'number', default: 900, min: 200, max: 4000, description: '单块字符上限' },
  kbChunkOverlap: { type: 'number', default: 120, min: 0, max: 1000, description: '相邻块的重叠字符数' },
  kbMaxChunks: { type: 'number', default: 60000, min: 100, max: 5000000, description: '块数上限，超出时整篇淘汰最久未更新的文档' },
  kbMaxFileBytes: { type: 'number', default: 2000000, min: 1000, max: 50000000, description: '单个文件的大小上限' },
  kbIgnore: {
    type: 'string',
    default: 'node_modules,.git,dist,build,out,.next,.nuxt,.cache,coverage,target,vendor,__pycache__,.venv',
    description: '目录同步时忽略的目录名，逗号分隔',
  },
};

/** 默认配置。 */
export const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, field.default]));

/**
 * 校验并补全配置。
 * @param {unknown} value 原始配置（可能来自 YAML、可能为空）。
 * @returns {{ value: Record<string, any> } | { issues: { message: string, path?: string[] }[] }} 结果。
 */
export function validateConfig(value) {
  if (value === undefined || value === null) return { value: { ...DEFAULTS } };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ message: 'config must be an object' }] };
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {{ message: string, path?: string[] }[]} */
  const issues = [];
  /** @type {Record<string, any>} */
  const out = {};

  for (const [key, field] of Object.entries(FIELDS)) {
    const raw = source[key];
    if (raw === undefined) {
      out[key] = field.default;
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        issues.push({ message: `${key} 必须是布尔值`, path: [key] });
        continue;
      }
      out[key] = raw;
      continue;
    }
    if (field.type === 'number') {
      const number = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(number)) {
        issues.push({ message: `${key} 必须是数字`, path: [key] });
        continue;
      }
      const min = field.min ?? Number.NEGATIVE_INFINITY;
      const max = field.max ?? Number.POSITIVE_INFINITY;
      out[key] = Math.min(max, Math.max(min, Math.round(number)));
      continue;
    }
    if (typeof raw !== 'string') {
      issues.push({ message: `${key} 必须是字符串`, path: [key] });
      continue;
    }
    out[key] = raw;
  }

  if (issues.length > 0) return { issues };
  return { value: out };
}

/**
 * Standard Schema 形态的 Config，供 Cordis 在加载时校验。
 * 未声明的键会被丢弃（而不是报错），这样升级/降级时多出来的字段不会拖垮启动。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-myosotis',
    validate: validateConfig,
  },
};
