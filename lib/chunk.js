/**
 * 文档切块：把一篇长文档切成「能独立被检索到、又能看懂」的小段。
 *
 * 切块质量直接决定检索质量，所以这里不做「按固定字数硬切」：
 * - **Markdown 按标题切**。一节一个块，块上带标题路径（`安装 › 配置`），
 *   检索到片段时模型立刻知道它在文档的哪一部分。
 * - **代码按声明切**。函数/类/类型的首行作为块标题，比「第 120 行」有用。
 * - **纯文本按空行 + 段落切**，不做语义猜测。
 *
 * 块内保留 `startLine` / `endLine`，引用时能指回原文行号。
 * 超过 `maxChars` 的节再按行打包，并保留 `overlap` 个字符的重叠——
 * 重叠是为了不让一句关键的话正好被切在两条块的分界线上。
 *
 * 不依赖任何外部包。
 *
 * @module dsh-myosotis/chunk
 */

/** Markdown ATX 标题。 */
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;

/** 代码围栏（``` 或 ~~~），围栏里的 `#` 不是标题。 */
const FENCE = /^\s*(?:```|~~~)/u;

/** 代码声明：函数 / 类 / 类型 / 模块。 */
const CODE_DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|def|fn|func|module|namespace)\s+([A-Za-z_$][\w$]*)/u;

/** 顶层变量声明：`const NAME =` 这类。 */
const CODE_ASSIGN = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u;

/**
 * 切成块。
 * @param {string} text 文档全文。
 * @param {object} [options] 选项。
 * @param {number} [options.maxChars=900] 单块字符上限。
 * @param {number} [options.overlap=120] 相邻块的重叠字符数。
 * @param {'markdown'|'code'|'text'} [options.format='text'] 文档形态。
 * @returns {{ text: string, heading: string, startLine: number, endLine: number }[]} 块列表。
 */
export function chunkText(text, { maxChars = 900, overlap = 120, format = 'text' } = {}) {
  const limit = Math.max(120, Math.round(maxChars));
  const shared = Math.max(0, Math.min(Math.round(overlap), Math.floor(limit / 2)));
  const lines = splitLines(text, limit);
  if (lines.length === 0) return [];

  if (format === 'markdown') {
    const out = [];
    for (const section of markdownSections(lines)) {
      for (const piece of packLines(section.lines, limit, shared)) {
        out.push({ ...piece, heading: section.heading });
      }
    }
    return out;
  }

  const pieces = packLines(lines, limit, shared);
  if (format !== 'code') return pieces.map((piece) => ({ ...piece, heading: '' }));

  // 代码：块标题取「块起点之前最近的一个声明」，没有就用空。
  const decls = codeDecls(lines);
  return pieces.map((piece) => ({ ...piece, heading: headingAt(decls, piece.startLine) }));
}

/**
 * 按行拆开，并把超长行硬切成多段（保持同一个行号）。
 * @param {string} text 原文。
 * @param {number} maxChars 单行上限。
 * @returns {{ text: string, no: number }[]} 行列表。
 */
function splitLines(text, maxChars) {
  const raw = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n');
  /** @type {{ text: string, no: number }[]} */
  const out = [];
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index].replace(/\s+$/u, '');
    if (line.length <= maxChars) {
      out.push({ text: line, no: index + 1 });
      continue;
    }
    // 压缩过的 JS、单行长段落：只能硬切，否则一块就爆掉整个预算。
    for (let start = 0; start < line.length; start += maxChars) {
      out.push({ text: line.slice(start, start + maxChars), no: index + 1 });
    }
  }
  return out;
}

/**
 * Markdown：按标题层级分组，每组带完整标题路径。
 * @param {{ text: string, no: number }[]} lines 行。
 * @returns {{ heading: string, lines: { text: string, no: number }[] }[]} 节列表。
 */
function markdownSections(lines) {
  /** @type {{ heading: string, lines: { text: string, no: number }[] }[]} */
  const sections = [];
  /** @type {{ level: number, text: string }[]} */
  const stack = [];
  let current = { heading: '', lines: [] };
  let fenced = false;

  const flush = () => {
    if (current.lines.some((line) => line.text.trim())) sections.push(current);
  };

  for (const line of lines) {
    if (FENCE.test(line.text)) fenced = !fenced;
    const match = fenced ? null : HEADING.exec(line.text);
    if (!match) {
      current.lines.push(line);
      continue;
    }
    flush();
    const level = match[1].length;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: cleanHeading(match[2]) });
    // 标题行进块：检索命中时能一眼看出这段属于哪一节。
    current = { heading: stack.map((item) => item.text).join(' › '), lines: [line] };
  }
  flush();
  return sections;
}

/**
 * 去掉标题里的行内标记，只留文字。
 * 提取层取文档标题时也用它，否则 `# **安装**` 这种标题会和标题路径对不上。
 * @param {string} text 标题原文。
 * @returns {string} 干净标题。
 */
export function cleanHeading(text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`~]/gu, '')
    .trim();
}

/**
 * 按行打包成块，超限时在行边界断开，并保留尾部重叠。
 * @param {{ text: string, no: number }[]} lines 行。
 * @param {number} maxChars 单块上限。
 * @param {number} overlap 重叠字符数。
 * @returns {{ text: string, startLine: number, endLine: number }[]} 块列表。
 */
function packLines(lines, maxChars, overlap) {
  /** @type {{ text: string, startLine: number, endLine: number }[]} */
  const chunks = [];
  /** @type {{ text: string, no: number }[]} */
  let buffer = [];
  let size = 0;

  const emit = () => {
    if (buffer.length === 0) return;
    const text = buffer
      .map((line) => line.text)
      .join('\n')
      .trim();
    if (text) chunks.push({ text, startLine: buffer[0].no, endLine: buffer[buffer.length - 1].no });
  };

  // 只从第二行开始保留重叠：整块复制一份会让检索结果出现重复条目。
  const tail = (limit) => {
    if (limit <= 0 || buffer.length <= 1) return [];
    /** @type {{ text: string, no: number }[]} */
    const kept = [];
    let used = 0;
    for (let index = buffer.length - 1; index >= 1; index -= 1) {
      const cost = buffer[index].text.length + 1;
      if (used + cost > limit) break;
      kept.unshift(buffer[index]);
      used += cost;
    }
    return kept;
  };

  for (const line of lines) {
    const cost = line.text.length + 1;
    if (buffer.length > 0 && size + cost > maxChars) {
      emit();
      buffer = tail(overlap);
      size = buffer.reduce((sum, item) => sum + item.text.length + 1, 0);
    }
    buffer.push(line);
    size += cost;
  }
  emit();
  return chunks;
}

/**
 * 收集代码里的声明位置。
 * @param {{ text: string, no: number }[]} lines 行。
 * @returns {{ no: number, name: string }[]} 声明列表（按行号升序）。
 */
function codeDecls(lines) {
  /** @type {{ no: number, name: string }[]} */
  const out = [];
  for (const line of lines) {
    const match = CODE_DECL.exec(line.text) ?? CODE_ASSIGN.exec(line.text);
    if (match) out.push({ no: line.no, name: match[1] });
  }
  return out;
}

/**
 * 找块起点所属的声明名。
 * @param {{ no: number, name: string }[]} decls 声明列表。
 * @param {number} lineNo 块起始行号。
 * @returns {string} 声明名；没有时为空串。
 */
function headingAt(decls, lineNo) {
  let name = '';
  for (const decl of decls) {
    if (decl.no > lineNo) break;
    name = decl.name;
  }
  return name;
}
