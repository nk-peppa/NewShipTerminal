/*
 * 会话日志导出：把日志目录流式写成一个 ZIP。
 *
 * 为什么不用 slamExport 的 makeZip：
 *   - 日志里主要是原始二进制帧，deflate 收益低，level 9 还会把主进程卡住；
 *   - 一次实验的日志可能上百 MB，整个读进内存不安全。
 * 所以这里只做 store（不压缩），边读边写，CRC 在流式读取时累加。
 *
 * 为什么是 async：
 *   log:save 跑在 Electron 主进程上，和 50Hz CMD 调度器同一个线程。同步读整包
 *   会把控制环卡住，日志大了甚至可能让船端 300ms 看门狗触发失联保护。这里按
 *   1 MiB 分块用异步 IO，块之间把事件循环让出去，控制环照常跑。
 *
 * 每个文件在导出开始时取一次 size，只读这么多字节：边录边导时文件还在增长，
 * 按 size 截断保证导出的是「发起导出那一刻的前缀」。同步写的行是一次一条，
 * 所以这个边界一定落在行尾，不会切出半行。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface ZipExtraEntry {
  name: string;
  data: Buffer;
}

export interface ZipOutcome {
  bytes: number;
  files: string[];
}

/** 单次读写的分块大小 */
const CHUNK_BYTES = 1 << 20;

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

/** 全量写出（FileHandle.write 允许部分写，这里循环补齐） */
async function writeAll(handle: fs.FileHandle, buf: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < buf.length) {
    const { bytesWritten } = await handle.write(buf, done, buf.length - done, position + done);
    if (bytesWritten <= 0) throw new Error('ZIP 写入中断');
    done += bytesWritten;
  }
}

/**
 * 把 dir 下的普通文件（按名称排序）和 extra 虚拟文件写进 dest。
 * 不做压缩；调用方负责写到 .part 再改名。
 */
export async function zipDirectoryToFile(
  dir: string,
  dest: string,
  extra: ZipExtraEntry[] = [],
  at = new Date(),
): Promise<ZipOutcome> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const entryCount = names.length + extra.length;
  if (entryCount > 0xffff) throw new Error(`文件过多（${entryCount}），超出 ZIP 上限`);

  const { time, date } = dosDateTime(at);
  const out = await fs.open(dest, 'w');
  const centrals: Buffer[] = [];
  const files: string[] = [];
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let offset = 0;

  const addEntry = async (
    name: string,
    size: number,
    fill: (emit: (b: Buffer) => Promise<void>) => Promise<void>,
  ): Promise<void> => {
    const nameBuf = Buffer.from(name, 'utf8');
    const header = localHeader(nameBuf, time, date);
    const headerOffset = offset;
    await writeAll(out, header, offset);
    await writeAll(out, nameBuf, offset + header.length);
    offset += header.length + nameBuf.length;

    let crc = -1;
    let written = 0;
    await fill(async (b) => {
      crc = crc32Update(crc, b);
      await writeAll(out, b, offset);
      offset += b.length;
      written += b.length;
    });
    if (written !== size) throw new Error(`${name} 长度不一致（预期 ${size}，实写 ${written} 字节）`);
    if (offset > 0xffffffff) throw new Error('日志总大小超过 4 GiB，暂不支持 ZIP64');

    const crcValue = (crc ^ -1) >>> 0;
    header.writeUInt32LE(crcValue, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    await writeAll(out, header, headerOffset);

    centrals.push(centralHeader(nameBuf, crcValue, size, headerOffset, time, date), nameBuf);
    files.push(name);
  };

  try {
    for (const name of names) {
      const file = path.join(dir, name);
      // 先定住长度：导出期间日志还在追加，只读这么多就是一致的前缀
      const size = (await fs.stat(file)).size;
      const fd = await fs.open(file, 'r');
      try {
        await addEntry(name, size, async (emit) => {
          let read = 0;
          while (read < size) {
            const want = Math.min(CHUNK_BYTES, size - read);
            const { bytesRead } = await fd.read(chunk, 0, want, read);
            if (bytesRead <= 0) throw new Error(`${name} 在读过程中被截断`);
            await emit(chunk.subarray(0, bytesRead));
            read += bytesRead;
          }
        });
      } finally {
        await fd.close();
      }
    }

    for (const e of extra) {
      await addEntry(e.name, e.data.length, async (emit) => {
        for (let pos = 0; pos < e.data.length; pos += CHUNK_BYTES) {
          await emit(e.data.subarray(pos, pos + CHUNK_BYTES));
        }
      });
    }

    const central = Buffer.concat(centrals);
    const centralOffset = offset;
    await writeAll(out, central, offset);
    offset += central.length;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entryCount, 8);
    eocd.writeUInt16LE(entryCount, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await writeAll(out, eocd, offset);
    offset += eocd.length;

    return { bytes: offset, files };
  } finally {
    await out.close();
  }
}

/** 计算单块数据的 CRC32（测试与外部工具复用） */
export function crc32Of(buf: Buffer): number {
  return crc32(buf);
}
