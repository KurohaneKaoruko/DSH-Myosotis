/**
 * 命令行共用的小工具：参数解析与对齐输出。
 *
 * 单独抽出来是因为两个 CLI（memory / kb）都要用；中文在终端里占两列，
 * 不对齐的话表格会歪得没法看。
 *
 * @module dsh-myosotis/tools/format
 */

/**
 * 解析 `--key value` / `--flag` 形式的参数。
 * @param {string[]} argv 原始参数。
 * @returns {{ _: string[], [key: string]: any }} 解析结果。
 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

/**
 * 终端显示宽度：CJK 与全角字符占两列。
 * @param {string} text 文本。
 * @returns {number} 列数。
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
  }
  return width;
}

/**
 * 打印一张表（按显示宽度对齐，中文不会错位）。
 * @param {string[]} headers 表头。
 * @param {string[][]} rows 行。
 */
export function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index]))));
  const line = (cells) => cells.map((cell, index) => String(cell ?? '') + ' '.repeat(Math.max(0, widths[index] - displayWidth(cell)))).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

/**
 * 人类可读的字节数。
 * @param {number} bytes 字节。
 * @returns {string} 形如 `1.2 MB`。
 */
export function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 时间戳 → `YYYY-MM-DD`。
 * @param {number} timestamp 毫秒时间戳。
 * @returns {string} 日期；非法值返回 `—`。
 */
export function formatDay(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return new Date(value).toISOString().slice(0, 10);
}
