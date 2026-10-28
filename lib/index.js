/**
 * dsh-myosotis（Myosotis）—— DSH 的持久记忆 + 知识库插件。
 *
 * 挂载点只有两个，都是官方公开接口：
 *   `ctx.systemPrompt.section()` 把记忆 / 知识库摘录注入系统提示词（每轮按当前输入重排）
 *   `ctx.tools.register()`       给模型六个维护工具
 *
 * 另外监听两个事件做确定性捕获：
 *   `agent/inbox/claimed` 用户消息入站 —— 记录本轮查询、识别「记住…」指令、读取反馈信号
 *   `session/event`       会话事件流 —— 日记模式（可选）
 *
 * 记忆与知识库是两条并行的轴：
 *   记忆 = 结论（短、四层、可能每轮进上下文）
 *   知识库 = 原文（长、SQLite 全文索引、只在被检索到时浮出来）
 *
 * 记忆这一轴还会**学**：用户说「不对」时给上一轮注入的记忆记账，
 * 被确认多次的自动升权，`memory_review` 把过时 / 重复 / 矛盾的条目摆出来让模型裁决。
 *
 * 不依赖任何第三方包：配置校验自己实现 Standard Schema 协议，
 * 其余全部是 node: 内置模块。
 *
 * @module dsh-myosotis
 */

import { Config } from './config.js';
import { detectMemoryIntent, episodeText } from './capture.js';
import { KnowledgeService } from './kb-service.js';
import { createKnowledgeTools } from './kb-tools.js';
import { MemoryService } from './memory.js';
import { QueryTracker } from './queries.js';
import { policyText } from './render.js';
import { messageText } from './text.js';
import { createTools } from './tools.js';

/** Cordis 插件名。 */
export const name = 'memory';

/** 依赖的服务：工具注册表与系统提示词注册表，DSH 任何组合里都有。 */
export const inject = ['tools', 'systemPrompt'];

export { Config };

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文。
 * @param {any} config 已校验的配置。
 */
export function apply(ctx, config) {
  if (!config?.enabled) return;

  const logger = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  // 记忆与知识库共用一份「最近一次用户输入」，避免两套状态漂移。
  const queries = new QueryTracker();
  const service = new MemoryService({ config, logger, queries });
  const knowledge = new KnowledgeService({ config, logger, queries });

  ctx.effect(() => {
    return () => {
      service.dispose();
      knowledge.dispose();
    };
  }, 'memory.dispose()');

  // ── 提示词段落 ──────────────────────────────────────────────────────────
  // order 30/31/32：紧跟 persona（0）之后、计划策略（500）之前。
  // 记忆是「这个人是谁、我们做过什么」，应当早于任何任务性指令出现。
  if (config.policy) {
    ctx.systemPrompt.section({
      name: 'memory:policy',
      order: 30,
      interpolate: false,
      text: policyText(),
    });
  }

  if (config.inject) {
    ctx.systemPrompt.section({
      name: 'memory:recall',
      order: 31,
      interpolate: false,
      text: (assembly) => {
        try {
          return service.renderFor(assembly?.agent);
        } catch (error) {
          // 注入失败绝不能让整次请求挂掉：记忆是增益，不是前置条件。
          logger(`[memory] 注入失败：${String(error)}`);
          return '';
        }
      },
    });
  }

  // 知识库独立成段：它的预算、开关、失败域都该和记忆分开。
  if (config.knowledge && config.kbInject && config.kbRecall > 0) {
    ctx.systemPrompt.section({
      name: 'knowledge:recall',
      order: 32,
      interpolate: false,
      text: (assembly) => {
        try {
          return knowledge.renderFor(assembly?.agent);
        } catch (error) {
          logger(`[memory] 知识库注入失败：${String(error)}`);
          return '';
        }
      },
    });
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  const tools = [...createTools(service)];
  if (config.knowledge) tools.push(...createKnowledgeTools(knowledge));
  for (const tool of tools) {
    try {
      ctx.tools.register(tool);
    } catch (error) {
      logger(`[memory] 注册工具 ${tool.name} 失败：${String(error)}`);
    }
  }

  // ── 入站消息：记录查询 + 自动捕获 ───────────────────────────────────────
  ctx.on('agent/inbox/claimed', (payload) => {
    try {
      const agent = payload?.agent;
      const message = payload?.message;
      if (!agent || !message) return;
      const text = messageText(message);
      if (!text) return;
      service.noteQuery(String(agent.id ?? ''), text);
      // 先读反馈：用户这句「不对」说的是上一轮的回答，也就是上一轮注入的记忆。
      service.observe(text, agent);
      const fromUser = !message.source || message.source.kind === 'user';
      if (!config.autoCapture || !fromUser) return;
      const intent = detectMemoryIntent(text);
      if (!intent) return;
      service.capture(intent.text, agent, intent);
    } catch (error) {
      logger(`[memory] 自动捕获失败：${String(error)}`);
    }
  });

  // ── 日记模式（可选） ────────────────────────────────────────────────────
  if (config.autoEpisode) {
    /** @type {Map<string, { tools: string[], files: string[], query: string }>} */
    const turns = new Map();
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = String(session?.id ?? session?.header?.id ?? '');
        if (!sessionId || !event) return;
        if (event.type === 'tool/call') {
          const state = turns.get(sessionId) ?? { tools: [], files: [], query: '' };
          const toolName = String(event.data?.name ?? event.data?.tool ?? '');
          if (toolName) state.tools.push(toolName);
          const args = event.data?.arguments ?? event.data?.args;
          const path = args && typeof args === 'object' ? args.path ?? args.file_path : undefined;
          if (typeof path === 'string') state.files.push(path.split(/[\\/]/).pop() ?? path);
          turns.set(sessionId, state);
          return;
        }
        if (event.type !== 'turn/end') return;
        const state = turns.get(sessionId);
        turns.delete(sessionId);
        if (!state || state.tools.length < config.episodeMinTools) return;
        const agents = ctx.get?.('agents');
        const agent = agents?.get?.(sessionId);
        if (!agent) return;
        const text = episodeText({ query: service.lastQuery(String(agent.id)), tools: state.tools, files: state.files });
        // 日记走深记忆：量大、默认不进上下文，需要时再检索。
        if (text) service.archive({ text, kind: 'episode', importance: 2, tags: ['diary'], source: { auto: true, diary: true } }, agent);
      } catch (error) {
        logger(`[memory] 日记写入失败：${String(error)}`);
      }
    });
  }
}
