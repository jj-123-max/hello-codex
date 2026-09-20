// deploy/lib/zip.js — 零依赖 ZIP 打包/解包（只用 Node 内置 zlib）
//
// 为什么自己写：
//   1) 更新器运行在用户机器上，不能假设装了 7-Zip / WinRAR；
//   2) Windows 10 的 tar.exe 虽能解 zip，但版本差异大、报错信息不可控；
//   3) 引入 archiver / adm-zip 会往发布链路里塞第三方依赖，升级器本身要越薄越好。
//
// 能力边界（够用即可，刻意不做 ZIP64）：
//   - 打包：deflate(method 8) + 目录递归，文件名统一走 UTF-8（flag 0x0800）
//   - 解包：支持 method 0(store) / method 8(deflate)，逐条校验 CRC32
//   - 安全：拒绝绝对路径、`..` 穿越、符号链接项（防 zip-slip）
//   - 单包体积上限 4GB（超过直接报错，内容包实际只有 1~2MB）
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------------ CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// -------------------------------------------------------------- 时间戳转换
function toDosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

// ------------------------------------------------------------------ 打包
function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      walk(abs, rel, out);
    } else if (ent.isFile()) {
      out.push({ rel, abs });
    }
    // 符号链接一律跳过：dsh 的 node_modules 里有 junction，打进 zip 只会变成垃圾
  }
  return out;
}

/**
 * 把目录打包成 zip
 * @param {string} srcDir   源目录
 * @param {string} outFile  输出 zip 路径
 * @param {object} [opts]   { filter(relPath)->boolean, level=9, onFile(rel) }
 * @returns {{files:number, bytes:number, sha256:string}}
 */
function zipDir(srcDir, outFile, opts = {}) {
  const crypto = require('crypto');
  const level = opts.level == null ? 9 : opts.level;
  const filter = opts.filter || (() => true);

  const entries = walk(srcDir, '', []).filter((e) => filter(e.rel));
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, 'w');
  const central = [];
  let offset = 0;
  const hash = crypto.createHash('sha256');
  const chunkSize = 8 * 1024 * 1024;
  let buf = Buffer.allocUnsafe(chunkSize);
  let bufLen = 0;

  const push = (b) => {
    if (bufLen + b.length > buf.length) {
      if (bufLen > 0) { fs.writeSync(fd, buf, 0, bufLen); hash.update(buf.subarray(0, bufLen)); }
      bufLen = 0;
    }
    if (b.length >= buf.length) { fs.writeSync(fd, b); hash.update(b); return; }
    b.copy(buf, bufLen); bufLen += b.length;
  };

  try {
    for (const e of entries) {
      const raw = fs.readFileSync(e.abs);
      const deflated = zlib.deflateRawSync(raw, { level });
      const useDeflate = deflated.length < raw.length;
      const body = useDeflate ? deflated : raw;
      const method = useDeflate ? 8 : 0;
      const nameBuf = Buffer.from(e.rel, 'utf8');
      const { time, date } = toDosTime(fs.statSync(e.abs).mtime);
      const crc = crc32(raw);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      push(local); push(nameBuf); push(body);

      central.push({ nameBuf, method, time, date, crc, csize: body.length, usize: raw.length, offset });
      offset += 30 + nameBuf.length + body.length;
      if (opts.onFile) opts.onFile(e.rel);
    }

    // 中央目录
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);        // version made by
      h.writeUInt16LE(20, 6);        // version needed
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20);
      h.writeUInt32LE(c.usize, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attr
      h.writeUInt32LE(0, 38); // external attr
      h.writeUInt32LE(c.offset, 42);
      push(h); push(c.nameBuf);
      offset += 46 + c.nameBuf.length;
    }
    const cdSize = offset - cdStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    push(eocd);

    if (bufLen > 0) { fs.writeSync(fd, buf, 0, bufLen); hash.update(buf.subarray(0, bufLen)); }
  } finally {
    fs.closeSync(fd);
  }

  return { files: entries.length, bytes: fs.statSync(outFile).size, sha256: hash.digest('hex') };
}

// ------------------------------------------------------------------ 解包
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function safeJoin(destDir, name) {
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw new Error('非法绝对路径: ' + name);
  const out = path.resolve(destDir, norm);
  const root = path.resolve(destDir);
  if (out !== root && !out.startsWith(root + path.sep)) throw new Error('检测到路径穿越(zip-slip): ' + name);
  return out;
}

/**
 * 解包 zip 到目录
 * @param {string} zipFile
 * @param {string} destDir
 * @param {object} [opts] { onFile(rel, i, total), overwrite=true }
 * @returns {{files:number, bytes:number}}
 */
function unzipTo(zipFile, destDir, opts = {}) {
  const overwrite = opts.overwrite !== false;
  const buf = fs.readFileSync(zipFile);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）: ' + zipFile);

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的压缩包');

  fs.mkdirSync(destDir, { recursive: true });
  let p = cdOffset, count = 0, bytes = 0;

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + cmtLen;

    if (name.endsWith('/')) { fs.mkdirSync(safeJoin(destDir, name), { recursive: true }); continue; }

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地头损坏: ' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + csize);

    let raw;
    if (method === 0) raw = Buffer.from(comp);
    else if (method === 8) raw = zlib.inflateRawSync(comp);
    else throw new Error('不支持的压缩方式 ' + method + '（' + name + '）');

    if (raw.length !== usize) throw new Error('解压长度不符: ' + name);
    if (crc32(raw) !== crc) throw new Error('CRC 校验失败（文件损坏）: ' + name);

    const out = safeJoin(destDir, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!overwrite && fs.existsSync(out)) continue;
    fs.writeFileSync(out, raw);
    count++; bytes += raw.length;
    if (opts.onFile) opts.onFile(name, i + 1, total);
  }

  return { files: count, bytes };
}

/** 列出 zip 内条目（不打散到磁盘，用于发布前自检） */
function listZip(zipFile) {
  const buf = fs.readFileSync(zipFile);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件: ' + zipFile);
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < total; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    out.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      size: buf.readUInt32LE(p + 24),
      method: buf.readUInt16LE(p + 10)
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

module.exports = { zipDir, unzipTo, listZip, crc32 };
