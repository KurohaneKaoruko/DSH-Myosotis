/**
 * 最小 ZIP 读取器：只为从 `.docx` / `.epub` 这类「其实是 zip 的文档」里取一个成员。
 *
 * 只做两件事：读中央目录、解一个成员。支持 store（不压缩）与 deflate 两种方式，
 * 遇到 zip64、加密、分卷这些情况一律返回 undefined——知识库宁可跳过一篇文档，
 * 也不能因为一个畸形压缩包把整次入库搞崩。
 *
 * 用 `node:zlib` 的 `inflateRawSync`，不引入任何第三方包。
 *
 * @module dsh-myosotis/zip
 */

import { inflateRawSync } from 'node:zlib';

/** 中央目录条目签名。 */
const CENTRAL = 0x02014b50;
/** 本地文件头签名。 */
const LOCAL = 0x04034b50;
/** 目录结束标记签名。 */
const EOCD = 0x06054b50;

/**
 * 从 ZIP 里读一个成员。
 * @param {Buffer} buffer 整个 zip 文件内容。
 * @param {string} wanted 成员路径（大小写不敏感，如 `word/document.xml`）。
 * @returns {Buffer | undefined} 成员内容；读不到时 undefined。
 */
export function readZipEntry(buffer, wanted) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return undefined;
  const eocd = findEocd(buffer);
  if (eocd < 0) return undefined;

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const target = String(wanted ?? '').toLowerCase();
  if (!target || count === 0 || offset <= 0 || offset >= buffer.length) return undefined;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) return undefined;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length) return undefined;
    const name = buffer.toString('utf8', offset + 46, nameEnd).toLowerCase();
    offset = nameEnd + extraLength + commentLength;

    if (name !== target) continue;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) return undefined; // zip64，不支持
    return readLocal(buffer, localOffset, compressedSize, method);
  }
  return undefined;
}

/**
 * 读本地文件头并取出数据。
 * @param {Buffer} buffer 文件内容。
 * @param {number} localOffset 本地头偏移。
 * @param {number} compressedSize 压缩后长度（来自中央目录）。
 * @param {number} method 压缩方式。
 * @returns {Buffer | undefined} 数据；不支持时 undefined。
 */
function readLocal(buffer, localOffset, compressedSize, method) {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) return undefined;
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (start < 0 || end > buffer.length) return undefined;
  const data = buffer.subarray(start, end);
  try {
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 从尾部向前找目录结束标记。
 * @param {Buffer} buffer 文件内容。
 * @returns {number} 偏移；找不到时 -1。
 */
function findEocd(buffer) {
  // 注释最长 65535 字节，加上标记本身 22 字节。
  const floor = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  return -1;
}
