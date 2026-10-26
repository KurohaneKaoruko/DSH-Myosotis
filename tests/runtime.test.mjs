/**
 * 真实运行时集成测试。
 *
 * 用本机 DSH 自带的 Cordis + systemPrompt + tools 装载插件，
 * 验证「配置校验、依赖注入、段落注册、工具 schema」这些只有真环境才暴露的问题
 * （比如 output.schema 不合法，注册时就会抛）。
 *
 * 找不到运行时（CI / 没装 DSH）时整组跳过，不影响其它测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 找一个能解析出 DSH 核心包的 node_modules 目录。
 * @returns {string | undefined} 目录路径。
 */
function findRuntime() {
  const candidates = [];
  if (process.env.DSH_RUNTIME) candidates.push(process.env.DSH_RUNTIME, join(process.env.DSH_RUNTIME, 'node_modules'));
  candidates.push(join(homedir(), '.dsh', 'local-plugins', 'node_modules'));
  candidates.push(join(homedir(), '.dsh', 'profiles', 'node_modules'));
  const extractRoot = join(tmpdir(), 'opencode', 'asarextract');
  if (existsSync(extractRoot)) {
    for (const name of readdirSync(extractRoot)) candidates.push(join(extractRoot, name, 'node_modules'));
  }
  for (const candidate of candidates) {
    try {
      const require = createRequire(join(candidate, 'probe.js'));
      require.resolve('@deepseek-ai/cordis');
      require.resolve('@deepseek-ai/dsh-tools');
      require.resolve('@deepseek-ai/dsh-system-prompt');
      return candidate;
    } catch {
      /* 换下一个候选 */
    }
  }
  return undefined;
}

const runtime = findRuntime();
const skip = runtime ? false : '本机没有可用的 DSH 运行时';

/**
 * 从运行时目录里 import 一个包。
 * @param {string} id 包名。
 * @returns {Promise<any>} 模块。
 */
async function load(id) {
  const require = createRequire(join(runtime, 'probe.js'));
  return import(pathToFileURL(require.resolve(id)).href);
}

test('真实运行时：插件能被 Cordis 装载并注册段落与工具', { skip }, async () => {
  const { Context } = await load('@deepseek-ai/cordis');
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools');
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const plugin = await import('../lib/index.js');

  const root = mkdtempSync(join(tmpdir(), 'myosotis-runtime-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const ctx = new Context();
  let fiber;
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    fiber = ctx.plugin(plugin, {});
    await fiber;
    assert.equal(fiber.error, undefined, `插件装载失败：${fiber.error?.message}`);

    const assembly = await ctx.systemPrompt.assemble({});
    const names = assembly.sections.map((section) => section.name);
    assert.ok(names.includes('memory:policy'));
    assert.ok(names.includes('memory:recall'));
    assert.deepEqual(
      assembly.tools.map((tool) => tool.name).sort(),
      ['memory_forget', 'memory_save', 'memory_search'],
    );

    // 真实注册表拿到的工具，能执行、能渲染。
    const save = ctx.tools.get('memory_save');
    assert.ok(save, 'tools.get 应能取到 memory_save');
    const agent = {
      id: 'session-runtime',
      session: { header: { id: 'session-runtime', cwd: join(root, 'workspace') }, events: [] },
    };
    const value = await save.execute({ text: '运行时测试写入的一条记忆', scope: 'project' }, { agent });
    assert.equal(value.ok, true);
    const blocks = save.output.render({}, value);
    assert.match(blocks[0].text, /运行时测试/);

    // 注入段落读得到刚写进去的东西。
    const withAgent = await ctx.systemPrompt.assemble({ agent, scope: agent });
    const recall = withAgent.sections.find((section) => section.name === 'memory:recall');
    assert.ok(recall, '有记忆时应出现 memory:recall 段落');
    assert.match(recall.text, /运行时测试/);

    // 深记忆：真运行时里 SQLite 应当可用（DSH 跑 Node 24），不可用则跳过这段。
    const search = ctx.tools.get('memory_search');
    if (ctx.tools.get('memory_save') && typeof process.getBuiltinModule === 'function' && process.getBuiltinModule('node:sqlite')) {
      const archived = await save.execute({ text: '真运行时里写进 SQLite 的一条归档', scope: 'deep', kind: 'episode' }, { agent });
      assert.equal(archived.scope, 'deep');
      const found = await search.execute({ query: 'SQLite 归档' }, { agent });
      assert.ok(found.results.some((hit) => hit.scope === 'deep'), '深记忆应能被检索到');
    }
  } finally {
    // 必须先卸载插件（effect 清理里会关掉 SQLite 句柄），否则 Windows 上删不掉临时目录。
    await fiber?.dispose?.();
    process.env.DSH_HOME = previous;
    await ctx.stop?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test('真实运行时：非法配置被 Cordis 拒绝', { skip }, async () => {
  const { Context } = await load('@deepseek-ai/cordis');
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools');
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const plugin = await import('../lib/index.js');

  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await assert.rejects(async () => {
    const fiber = ctx.plugin(plugin, { budgetChars: '不是数字' });
    await fiber;
  }, /invalid config|budgetChars/);
  await ctx.stop?.();
});
