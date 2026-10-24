/**
 * 三个模型侧工具：memory_save / memory_search / memory_forget。
 *
 * 这里直接写 JSON Schema，不经过 `defineTool`：
 * 工具注册表只要求 `parameters` 是合法 JSON Schema、`output.schema` 能通过校验，
 * 少一层包装就少一个运行时依赖，也让这个文件能在没有 DSH 的环境里被测试。
 *
 * @module dsh-myosotis/tools
 */

import { KINDS, KIND_LABELS } from './store.js';
import { truncate } from './text.js';

/** 作用域说明，三处复用。 */
const SCOPE_DOC = 'global = 跨项目的用户偏好/身份/关系；project = 当前仓库的技术栈、约定、决策、坑；session = 本次对话的临时线索（会过期）。';

/**
 * 取调用方 agent；工具必须挂在某个会话上才有意义。
 * @param {any} exec 工具执行上下文。
 * @returns {any} Agent 句柄。
 */
function requireAgent(exec) {
  if (!exec?.agent) throw new Error('memory 工具需要在一个 agent 会话里调用');
  return exec.agent;
}

/**
 * 构造全部工具定义。
 * @param {import('./memory.js').MemoryService} service 记忆服务。
 * @returns {any[]} 工具定义数组。
 */
export function createTools(service) {
  return [saveTool(service), searchTool(service), forgetTool(service)];
}

/**
 * memory_save。
 * @param {import('./memory.js').MemoryService} service 记忆服务。
 * @returns {any} 工具定义。
 */
function saveTool(service) {
  return {
    name: 'memory_save',
    description:
      '保存一条长期记忆。用户说「记住 / 以后都 / 不要再 / 我习惯」时必须调用；发现值得跨会话保留的偏好、约定、决策、坑时主动调用。给 id 是更新；给 id 且 scope 不同是提升到该作用域。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '记忆本身：一句陈述句，20–80 字，带上适用条件或理由。不要写「用户说……」这种转述外壳。' },
        scope: { type: 'string', enum: ['session', 'project', 'global'], description: SCOPE_DOC },
        kind: {
          type: 'string',
          enum: KINDS,
          description: 'profile=身份信息；preference=偏好；habit=习惯；convention=约定/规范；decision=技术决策；fact=事实；gotcha=踩过的坑；episode=共同经历；bond=关系与相处方式。',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '检索用标签，1–4 个，小写。' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '5 = 违反会出事或核心偏好；3 = 有用；1 = 闲聊。默认 3。' },
        pinned: { type: 'boolean', description: '置顶：每轮都会出现在上下文里。只给真正每轮都该记住的少数几条用。' },
        affect: {
          type: 'object',
          additionalProperties: false,
          description: '情绪重量。用于 episode / bond：这件事当时是什么感觉。',
          properties: {
            label: { type: 'string', description: '情绪标签，如「兴奋」「挫败」「在意」。' },
            intensity: { type: 'integer', minimum: 1, maximum: 5, description: '强度 1–5。' },
          },
          required: ['label'],
        },
        date: { type: 'string', description: '每年重复的重要日期，格式 MM-DD（生日、纪念日）。' },
        id: { type: 'string', description: '已有记忆的 id：给出时执行更新或跨作用域提升。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          id: { type: 'string' },
          scope: { type: 'string' },
          kind: { type: 'string' },
          text: { type: 'string' },
          total: { type: 'integer' },
        },
        required: ['ok', 'action', 'id', 'scope', 'kind', 'text', 'total'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已${value.action === 'created' ? '记住' : value.action === 'merged' ? '合并进已有记忆' : '更新'}（${value.scope}·${KIND_LABELS[value.kind] ?? value.kind}）：${truncate(value.text, 160)}${value.total > 0 ? `\n该作用域现有 ${value.total} 条。` : ''}`,
        },
      ],
    },
    presentCall: (args) => ({ card: 'generic', title: '保存记忆', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const input = args && typeof args === 'object' ? args : {};
      if (!input.id && !String(input.text ?? '').trim()) {
        throw new Error('memory_save 需要 text（新记忆）或 id（更新已有记忆）');
      }
      const result = service.save(input, agent);
      return {
        ok: true,
        action: result.action,
        id: result.item.id,
        scope: result.scope,
        kind: result.item.kind,
        text: result.item.text,
        total: service.storeFor(result.scope, agent).list().length,
      };
    },
  };
}

/**
 * memory_search。
 * @param {import('./memory.js').MemoryService} service 记忆服务。
 * @returns {any} 工具定义。
 */
function searchTool(service) {
  return {
    name: 'memory_search',
    description:
      '检索长期记忆。不确定用户偏好、以前做过什么、某个约定是什么时先查，不要猜。query 留空则按重要度与新近度列出。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词或一句话；留空表示按重要度列出。' },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: ['global', 'project', 'session'] },
          description: '限定作用域；不填则三层都查。',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 8。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                scope: { type: 'string' },
                kind: { type: 'string' },
                text: { type: 'string' },
                importance: { type: 'integer' },
                score: { type: 'number' },
              },
              required: ['id', 'scope', 'kind', 'text', 'importance', 'score'],
            },
          },
        },
        required: ['count', 'results'],
      },
      render: (args, value) => {
        if (value.count === 0) return [{ type: 'text', text: `没有找到与「${truncate(String(args?.query ?? ''), 60)}」相关的记忆。` }];
        const lines = value.results.map(
          (hit, index) => `${index + 1}. [${hit.scope}·${KIND_LABELS[hit.kind] ?? hit.kind}] ${hit.text}（id: ${hit.id}）`,
        );
        return [{ type: 'text', text: `找到 ${value.count} 条：\n${lines.join('\n')}` }];
      },
    },
    presentCall: (args) => ({ card: 'generic', title: '检索记忆', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const input = args && typeof args === 'object' ? args : {};
      const results = service.search(String(input.query ?? ''), { scopes: input.scopes, limit: input.limit ?? 8 }, agent);
      return { count: results.length, results };
    },
  };
}

/**
 * memory_forget。
 * @param {import('./memory').MemoryService} service 记忆服务。
 * @returns {any} 工具定义。
 */
function forgetTool(service) {
  return {
    name: 'memory_forget',
    description: '删除记忆。id 精确删除；只给 query 时先返回候选，需要 confirm=true 才真正删除。用户说「忘掉这个」时使用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '精确删除的记忆 id。' },
        query: { type: 'string', description: '按关键词匹配候选（与 scope 一起用）。' },
        scope: { type: 'string', enum: ['global', 'project', 'session'], description: '限定作用域。' },
        confirm: { type: 'boolean', description: '按 query 批量删除时必须为 true。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          needConfirm: { type: 'boolean' },
          removed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                scope: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['id', 'scope', 'text'],
            },
          },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                scope: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
              },
              required: ['id', 'scope', 'text', 'score'],
            },
          },
        },
        required: ['count', 'needConfirm', 'removed'],
      },
      render: (_args, value) => {
        if (value.needConfirm) {
          const list = (value.candidates ?? []).map((hit, index) => `${index + 1}. [${hit.scope}] ${hit.text}（id: ${hit.id}）`).join('\n');
          return [
            {
              type: 'text',
              text: value.count === 0 ? '没有匹配到可删除的记忆。' : `匹配到 ${value.count} 条，尚未删除。确认后带 confirm=true 再调用：\n${list}`,
            },
          ];
        }
        if (value.count === 0) return [{ type: 'text', text: '没有删除任何记忆。' }];
        return [{ type: 'text', text: `已删除 ${value.count} 条记忆：\n${value.removed.map((hit) => `- [${hit.scope}] ${truncate(hit.text, 80)}`).join('\n')}` }];
      },
    },
    presentCall: (args) => ({ card: 'generic', title: '删除记忆', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const input = args && typeof args === 'object' ? args : {};
      if (!input.id && !String(input.query ?? '').trim()) throw new Error('memory_forget 需要 id 或 query');
      const result = service.forget(input, agent);
      const removed = result.removed ?? [];
      const count = result.needConfirm ? (result.candidates?.length ?? 0) : removed.length;
      return {
        count,
        needConfirm: Boolean(result.needConfirm),
        removed: removed.map((hit) => ({ id: hit.id, scope: hit.scope, text: hit.text })),
        ...(result.candidates ? { candidates: result.candidates.map((hit) => ({ id: hit.id, scope: hit.scope, text: hit.text, score: hit.score })) } : {}),
      };
    },
  };
}
