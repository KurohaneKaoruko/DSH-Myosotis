/**
 * 文本提取：把磁盘上的文件变成可以切块的纯文本。
 *
 * 不装依赖，所以能读什么完全由「能不能自己解析」决定：
 * - **纯文本 / 代码**：直接读，BOM、CRLF 归一化；用「前 8KB 有没有 NUL」判断二进制。
 * - **HTML**：去脚本、去样式、保留标题层级与列表，转成近似 Markdown 的纯文本。
 * - **docx**：它是个 zip，取出 `word/document.xml` 再把段落还原成行。
 * - **PDF 不做**：可靠的 PDF 文本抽取需要字体编码与 xref 解析，自己做只会得到乱码。
 *   遇到 PDF 返回一句明确的「请先转成文本」，而不是塞一堆垃圾进索引。
 *
 * @module dsh-myosotis/extract
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { cleanHeading } from './chunk.js';
import { readZipEntry } from './zip.js';

/** Markdown 系扩展名。 */
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx', '.mdown', '.mkd']);

/** HTML 系扩展名。`.vue` / `.svelte` 归到代码，它们的模板语法不是标准 HTML。 */
const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);

/** 明确按代码处理的扩展名（决定块标题取函数名还是标题）。 */
const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.lua', '.sh', '.bash', '.zsh',
  '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.astro',
]);

/** 明确不支持、也不用尝试的扩展名（免得把二进制读成乱码再切块）。 */
const BLOCKED_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.xz', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.wasm', '.o', '.a',
  '.db', '.sqlite', '.sqlite3', '.woff', '.woff2', '.ttf', '.otf',
]);

/**
 * 提取文本。
 * @param {string} file 绝对路径。
 * @param {object} [options] 选项。
 * @param {number} [options.maxBytes=2000000] 文件大小上限。
 * @returns {{ ok: true, text: string, format: 'markdown'|'code'|'text', title: string, bytes: number }
 *   | { ok: false, reason: string, bytes?: number }} 结果。
 */
export function extractText(file, { maxBytes = 2_000_000 } = {}) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { ok: false, reason: '文件不存在或无法访问' };
  }
  if (!stat.isFile()) return { ok: false, reason: '不是普通文件' };
  if (stat.size > maxBytes) return { ok: false, reason: `文件 ${formatSize(stat.size)} 超过上限 ${formatSize(maxBytes)}`, bytes: stat.size };

  const ext = extname(file).toLowerCase();
  if (BLOCKED_EXT.has(ext)) {
    const hint = ext === '.pdf' ? 'PDF 需要先转成文本（例如 pdftotext），再做索引' : '这个格式不支持直接索引';
    return { ok: false, reason: hint, bytes: stat.size };
  }

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    return { ok: false, reason: `读取失败：${String(error)}`, bytes: stat.size };
  }

  if (ext === '.docx') {
    const text = docxToText(buffer);
    if (!text) return { ok: false, reason: 'docx 解析失败（可能不是标准 Word 文档）', bytes: stat.size };
    return { ok: true, text, format: 'text', title: basename(file, ext), bytes: stat.size };
  }

  if (looksBinary(buffer)) return { ok: false, reason: '看起来是二进制文件', bytes: stat.size };

  let text = buffer.toString('utf8').replace(/^\uFEFF/u, '');
  let format = 'text';
  if (MARKDOWN_EXT.has(ext)) format = 'markdown';
  else if (CODE_EXT.has(ext)) format = 'code';
  else if (HTML_EXT.has(ext)) {
    text = htmlToText(text);
    format = 'markdown'; // 标题已经转成 `#`，按 Markdown 切块更准
  }

  text = text.replace(/\r\n?/gu, '\n').replace(/\u0000/gu, '').trimEnd();
  if (!text.trim()) return { ok: false, reason: '文件没有可索引的文本', bytes: stat.size };

  return { ok: true, text, format, title: titleOf(text, file, format), bytes: stat.size };
}

/**
 * 文档标题：Markdown 取第一个一级标题，否则用文件名。
 * @param {string} text 正文。
 * @param {string} file 路径。
 * @param {string} format 形态。
 * @returns {string} 标题。
 */
export function titleOf(text, file, format = 'text') {
  if (format === 'markdown') {
    for (const line of String(text).split('\n', 40)) {
      const match = /^#\s+(.+?)\s*#*\s*$/u.exec(line);
      if (match) return cleanHeading(match[1]);
    }
  }
  return basename(file, extname(file));
}

/**
 * 前 8KB 里有 NUL 就认为是二进制。
 * @param {Buffer} buffer 文件内容。
 * @returns {boolean} 是否二进制。
 */
function looksBinary(buffer) {
  const end = Math.min(buffer.length, 8192);
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * HTML → 近似 Markdown 的纯文本。
 * @param {string} html 原文。
 * @returns {string} 文本。
 */
export function htmlToText(html) {
  const body = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/giu, '');

  const withStructure = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_all, level, inner) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`)
    .replace(/<li\b[^>]*>/giu, '\n- ')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre|figure)>/giu, '\n\n')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(td|th)>/giu, ' | ');

  const text = decodeEntities(stripTags(withStructure))
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return text;
}

/**
 * 去掉所有标签。
 * @param {string} html 片段。
 * @returns {string} 文本。
 */
function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*>/gu, '');
}

/**
 * docx → 纯文本（段落一行，制表符保留）。
 * @param {Buffer} buffer 文件内容。
 * @returns {string} 文本；解析失败时为空串。
 */
export function docxToText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) return '';
  const raw = xml.toString('utf8');
  const text = raw
    .replace(/<w:tab\b[^>]*\/>/gu, '\t')
    .replace(/<w:br\b[^>]*\/>/gu, '\n')
    .replace(/<\/w:p>/gu, '\n')
    .replace(/<[^>]*>/gu, '');
  return decodeEntities(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * 解 HTML/XML 实体。
 * @param {string} text 原文。
 * @returns {string} 解码结果。
 */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/giu, (_all, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_all, dec) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&amp;/giu, '&');
}

/**
 * 码点 → 字符；非法码点退回空串。
 * @param {number} code 码点。
 * @returns {string} 字符。
 */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * 人类可读的字节数。
 * @param {number} bytes 字节。
 * @returns {string} 形如 `1.2 MB`。
 */
export function formatSize(bytes) {
  const value = Number(bytes ?? 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
