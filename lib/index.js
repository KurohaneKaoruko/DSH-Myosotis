/**
 * dsh-myosotis（Myosotis）—— DSH 的三层持久记忆插件。
 *
 * 挂载点只有两个，都是官方公开接口：
 *   `ctx.systemPrompt.section()` 把记忆注入系统提示词（每轮按当前输入重排）
 *   `ctx.tools.register()`       给模型三个维护工具
 *
 * 另外监听两个事件做确定性捕获：
 *   `agent/inbox/claimed` 用户消息入站 —— 记录本轮查询、识别「记住…」指令
 *   `session/event`       会话事件流 —— 日记模式（可选）
 *
 * 不依赖任何第三方包：配置校验自己实现 Standard Schema 协议，
 * 其余全部是 node: 内置模块。
 *
 * @module dsh-myosotis
 */

import { Config } from './config.js';
import { detectMemoryIntent, episodeText } from './capture.js';
import { MemoryService } from './memory.js';
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

  const service = new MemoryService({
    config,
    logger: (message) => {
      try {
        ctx.logger?.warn?.(message);
      } catch {
        /* 日志失败不影响主流程 */
      }
    },
  });

  ctx.effect(() => {
    return () => service.dispose();
  }, 'memory.dispose()');

  // ── 提示词段落 ──────────────────────────────────────────────────────────
  // order 30/31：紧跟 persona（0）之后、计划策略（500）之前。
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
          ctx.logger?.warn?.(`[memory] 注入失败：${String(error)}`);
          return '';
        }
      },
    });
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  for (const tool of createTools(service)) {
    try {
      ctx.tools.register(tool);
    } catch (error) {
      ctx.logger?.warn?.(`[memory] 注册工具 ${tool.name} 失败：${String(error)}`);
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
      const fromUser = !message.source || message.source.kind === 'user';
      if (!config.autoCapture || !fromUser) return;
      const intent = detectMemoryIntent(text);
      if (!intent) return;
      service.capture(intent.text, agent, intent);
    } catch (error) {
      ctx.logger?.warn?.(`[memory] 自动捕获失败：${String(error)}`);
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
        ctx.logger?.warn?.(`[memory] 日记写入失败：${String(error)}`);
      }
    });
  }
}
