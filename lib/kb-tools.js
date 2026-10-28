/**
 * 三个知识库工具：kb_add / kb_search / kb_remove。
 *
 * 和记忆工具的分工写在描述里，因为模型是靠描述决定用哪个的：
 * 记忆存结论，知识库存原文；记忆每轮自动出现，知识库要主动查。
 *
 * @module dsh-myosotis/kb-tools
 */

import { truncate } from './text.js';

/** 单次返回的文档条数上限：目录很大时不要把工具输出撑爆。 */
const MAX_DOCS = 20;

/**
 * 取调用方 agent；工具必须挂在某个会话上才有意义。
 * @param {any} exec 工具执行上下文。
 * @returns {any} Agent 句柄。
 */
function requireAgent(exec) {
  if (!exec?.agent) throw new Error('知识库工具需要在一个 agent 会话里调用');
  return exec.agent;
}

/**
 * 构造全部知识库工具。
 * @param {import('./kb-service.js').KnowledgeService} service 知识库服务。
 * @returns {any[]} 工具定义数组。
 */
export function createKnowledgeTools(service) {
  return [addTool(service), searchTool(service), removeTool(service)];
}

/**
 * kb_add。
 * @param {import('./kb-service.js').KnowledgeService} service 知识库服务。
 * @returns {any} 工具定义。
 */
function addTool(service) {
  return {
    name: 'kb_add',
    description:
      '把磁盘上的文档加入知识库（SQLite 全文索引），供以后检索。path 可以是文件或目录；目录会做增量同步（新增、更新、删掉已经不存在的）。不传 path 时扫描项目下的默认知识目录（docs）。只收磁盘上的文档，不要用它存对话结论——那是 memory_save 的活。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件或目录路径，相对当前工作目录或绝对路径。留空 = 默认知识目录。' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'project = 只在这个项目里可见（默认）；global = 所有项目都能检索到。' },
        recursive: { type: 'boolean', description: '目录是否递归，默认 true。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          kind: { type: 'string' },
          added: { type: 'integer' },
          updated: { type: 'integer' },
          skipped: { type: 'integer' },
          failed: { type: 'integer' },
          removed: { type: 'integer' },
          chunks: { type: 'integer' },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                path: { type: 'string' },
                rel: { type: 'string' },
                title: { type: 'string' },
                chunks: { type: 'integer' },
              },
              required: ['id', 'path', 'rel', 'title', 'chunks'],
            },
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { path: { type: 'string' }, reason: { type: 'string' } },
              required: ['path', 'reason'],
            },
          },
        },
        required: ['ok', 'target', 'kind', 'added', 'updated', 'skipped', 'failed', 'removed', 'chunks', 'documents', 'errors'],
      },
      render: (_args, value) => {
        const parts = [`已入库：新增 ${value.added}，更新 ${value.updated}，未变 ${value.skipped}，删除 ${value.removed}，失败 ${value.failed}。`];
        parts.push(`共 ${value.documents.length} 篇文档、${value.chunks} 块（${value.target}）。`);
        if (value.errors.length > 0) {
          parts.push(`失败原因：\n${value.errors.map((item) => `- ${item.path}：${item.reason}`).join('\n')}`);
        }
        return [{ type: 'text', text: parts.join('\n') }];
      },
    },
    presentCall: (args) => ({ card: 'generic', title: '知识库入库', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const input = args && typeof args === 'object' ? args : {};
      const summary = service.add(input, agent);
      return {
        ok: true,
        target: summary.target,
        kind: summary.kind,
        added: summary.added,
        updated: summary.updated,
        skipped: summary.skipped,
        failed: summary.failed,
        removed: summary.removed,
        chunks: summary.chunks,
        documents: summary.documents.slice(0, MAX_DOCS).map((doc) => ({ id: doc.id, path: doc.path, rel: doc.rel, title: doc.title, chunks: doc.chunks })),
        errors: summary.errors.slice(0, 5),
      };
    },
  };
}

/**
 * kb_search。
 * @param {import('./kb-service.js').KnowledgeService} service 知识库服务。
 * @returns {any} 工具定义。
 */
function searchTool(service) {
  return {
    name: 'kb_search',
    description:
      '在知识库里检索原文片段，返回文件路径、标题路径与行号。query 留空则列出已索引的文档。回答「文档里怎么写的」「这个项目的规范是什么」之前先查它，不要凭印象编；引用时用返回的 path / heading / startLine 做出处。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词或一句话；留空表示列出已索引的文档。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 6。' },
        path: { type: 'string', description: '只在这个文件或目录下找（相对工作目录或绝对路径）。' },
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
                docId: { type: 'string' },
                path: { type: 'string' },
                rel: { type: 'string' },
                title: { type: 'string' },
                heading: { type: 'string' },
                startLine: { type: 'integer' },
                endLine: { type: 'integer' },
                text: { type: 'string' },
                score: { type: 'number' },
              },
              required: ['docId', 'path', 'rel', 'title', 'heading', 'startLine', 'endLine', 'text', 'score'],
            },
          },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                path: { type: 'string' },
                rel: { type: 'string' },
                title: { type: 'string' },
                chunks: { type: 'integer' },
                bytes: { type: 'integer' },
                updatedAt: { type: 'integer' },
              },
              required: ['id', 'path', 'rel', 'title', 'chunks', 'bytes', 'updatedAt'],
            },
          },
        },
        required: ['count', 'results', 'documents'],
      },
      render: (args, value) => {
        if (value.documents.length > 0) {
          const lines = value.documents.map((doc, index) => `${index + 1}. ${doc.rel || doc.path}（${doc.chunks} 块，${doc.bytes} B）`);
          return [{ type: 'text', text: `知识库里有 ${value.documents.length} 篇文档：\n${lines.join('\n')}` }];
        }
        if (value.count === 0) {
          return [{ type: 'text', text: `知识库里没有找到与「${truncate(String(args?.query ?? ''), 60)}」相关的内容。` }];
        }
        const lines = value.results.map((hit, index) => {
          const where = [hit.rel || hit.path, hit.heading].filter(Boolean).join(' › ');
          const range = hit.startLine > 0 ? `L${hit.startLine}${hit.endLine > hit.startLine ? `-${hit.endLine}` : ''}` : '';
          return `${index + 1}. ${where}${range ? `（${range}）` : ''}\n   ${truncate(hit.text, 400)}`;
        });
        return [{ type: 'text', text: `找到 ${value.count} 段：\n${lines.join('\n')}` }];
      },
    },
    presentCall: (args) => ({ card: 'generic', title: '检索知识库', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const input = args && typeof args === 'object' ? args : {};
      const { hits, documents } = service.search(String(input.query ?? ''), { limit: input.limit ?? 6, path: input.path }, agent);
      return {
        count: hits.length,
        results: hits.map((hit) => ({
          docId: hit.docId,
          path: hit.path,
          rel: hit.rel,
          title: hit.title,
          heading: hit.heading,
          startLine: hit.startLine,
          endLine: hit.endLine,
          text: hit.text,
          score: hit.score,
        })),
        documents: documents.slice(0, MAX_DOCS).map((doc) => ({
          id: doc.id,
          path: doc.path,
          rel: doc.rel,
          title: doc.title,
          chunks: doc.chunks,
          bytes: doc.bytes,
          updatedAt: doc.updatedAt,
        })),
      };
    },
  };
}

/**
 * kb_remove。
 * @param {import('./kb-service.js').KnowledgeService} service 知识库服务。
 * @returns {any} 工具定义。
 */
function removeTool(service) {
  return {
    name: 'kb_remove',
    description: '从知识库移除文档（只删索引，不动磁盘上的文件）。id 精确删；给 path 删单篇；path 是目录时先返回候选，需要 confirm=true 才真删。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '文档 id（kb_search 返回的 docId）。' },
        path: { type: 'string', description: '文件或目录路径。' },
        confirm: { type: 'boolean', description: '按目录批量删除时必须为 true。' },
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
                path: { type: 'string' },
                chunks: { type: 'integer' },
              },
              required: ['id', 'path', 'chunks'],
            },
          },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                path: { type: 'string' },
                chunks: { type: 'integer' },
              },
              required: ['id', 'path', 'chunks'],
            },
          },
        },
        required: ['count', 'needConfirm', 'removed'],
      },
      render: (_args, value) => {
        if (value.needConfirm) {
          const list = (value.candidates ?? []).map((doc, index) => `${index + 1}. ${doc.path}（${doc.chunks} 块）`).join('\n');
          return [{ type: 'text', text: `匹配到 ${value.count} 篇文档，尚未删除。确认后带 confirm=true 再调用：\n${list}` }];
        }
        if (value.count === 0) return [{ type: 'text', text: '没有移除任何文档。' }];
        return [{ type: 'text', text: `已从知识库移除 ${value.count} 篇：\n${value.removed.map((doc) => `- ${doc.path}`).join('\n')}` }];
      },
    },
    presentCall: (args) => ({ card: 'generic', title: '移除知识库文档', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const input = args && typeof args === 'object' ? args : {};
      if (!input.id && !String(input.path ?? '').trim()) throw new Error('kb_remove 需要 id 或 path');
      const result = service.remove(input, agent);
      const removed = result.removed ?? [];
      const candidates = result.candidates ?? [];
      return {
        count: result.needConfirm ? candidates.length : removed.length,
        needConfirm: Boolean(result.needConfirm),
        removed: removed.map((doc) => ({ id: doc.id, path: doc.path, chunks: doc.chunks })),
        ...(result.needConfirm ? { candidates: candidates.map((doc) => ({ id: doc.id, path: doc.path, chunks: doc.chunks })) } : {}),
      };
    },
  };
}
