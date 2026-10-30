/*
 * 会话日志导出：把日志目录流式写成一个 ZIP。
 *
 * 为什么不用 slamExport 的 makeZip：
 *   - 日志里主要是原始二进制帧，deflate 收益低，level 9 还会把主进程卡住；
 *   - 一次实验的日志可能上百 MB，整个读进内存不安全。
 * 所以这里只做 store（不压缩），边读边写，CRC 在流式读取时累加。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ZipExtraEntry {
  name: string;
  data: Buffer;
}

export interface ZipOutcome {
  bytes: number;
  files: string[];
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32Update(crc: number, buf: Buffer): number {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff]! ^ (c >>> 8)) | 0;
  return c;
}

function crc32(buf: Buffer): number {
  return (crc32Update(-1, buf) ^ -1) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

function localHeader(name: Buffer, time: number, date: number): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0x0800, 6); // 文件名 UTF-8
  h.writeUInt16LE(0, 8); // store
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(0, 14); // CRC，写完回填
  h.writeUInt32LE(0, 18); // 压缩后大小
  h.writeUInt32LE(0, 22); // 原始大小
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return h;
}

function centralHeader(
  name: Buffer,
  crc: number,
  size: number,
  offset: number,
  time: number,
  date: number,
): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10); // store
  h.writeUInt16LE(time, 12);
  h.writeUInt16LE(date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  h.writeUInt32LE(0, 38);
  h.writeUInt32LE(offset, 42);
  return h;
}

/**
 * 把 dir 下的普通文件（按名称排序）和 extra 虚拟文件写进 dest。
 * 不做压缩；调用方负责写到 .part 再改名。
 */
export function zipDirectoryToFile(
  dir: string,
  dest: string,
  extra: ZipExtraEntry[] = [],
  at = new Date(),
): ZipOutcome {
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const entryCount = names.length + extra.length;
  if (entryCount > 0xffff) throw new Error(`文件过多（${entryCount}），超出 ZIP 上限`);

  const { time, date } = dosDateTime(at);
  const out = fs.openSync(dest, 'w');
  const centrals: Buffer[] = [];
  const files: string[] = [];
  const chunk = Buffer.allocUnsafe(1 << 20);
  let offset = 0;

  try {
    const writeEntry = (name: string, size: number, payload: (emit: (b: Buffer) => void) => number) => {
      const nameBuf = Buffer.from(name, 'utf8');
      const header = localHeader(nameBuf, time, date);
      const headerOffset = offset;
      fs.writeSync(out, header);
      fs.writeSync(out, nameBuf);
      offset += header.length + nameBuf.length;

      let crc = -1;
      const written = payload((b) => {
        crc = crc32Update(crc, b);
        fs.writeSync(out, b);
        offset += b.length;
      });

      if (written !== size) throw new Error(`${name} 在导出过程中被修改（${size} → ${written} 字节）`);
      if (offset > 0xffffffff) throw new Error('日志总大小超过 4 GiB，暂不支持 ZIP64');

      header.writeUInt32LE((crc ^ -1) >>> 0, 14);
      header.writeUInt32LE(size, 18);
      header.writeUInt32LE(size, 22);
      fs.writeSync(out, header, 0, 30, headerOffset);

      centrals.push(
        centralHeader(nameBuf, (crc ^ -1) >>> 0, size, headerOffset, time, date),
        nameBuf,
      );
      files.push(name);
    };

    for (const name of names) {
      const file = path.join(dir, name);
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try {
        writeEntry(name, size, (emit) => {
          let total = 0;
          for (;;) {
            const n = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (n <= 0) break;
            emit(chunk.subarray(0, n));
            total += n;
          }
          return total;
        });
      } finally {
        fs.closeSync(fd);
      }
    }

    for (const e of extra) {
      writeEntry(e.name, e.data.length, (emit) => {
        emit(e.data);
        return e.data.length;
      });
    }

    const central = Buffer.concat(centrals);
    fs.writeSync(out, central);
    offset += central.length;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entryCount, 8);
    eocd.writeUInt16LE(entryCount, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(offset - central.length, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(out, eocd);
    offset += eocd.length;

    return { bytes: offset, files };
  } finally {
    fs.closeSync(out);
  }
}

/** 计算单块数据的 CRC32（测试与外部工具复用） */
export function crc32Of(buf: Buffer): number {
  return crc32(buf);
}
