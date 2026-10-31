/*
 * 地图库（主进程）。
 *
 * 建图结果保存成目录（而不是只能导出 ZIP），供定位算法直接加载：
 *   maps/<name>/map.pgm | map.yaml | map.png | trajectory.csv | session.json | meta.json
 *
 * 目录布局与日志同父目录（默认 %APPDATA%/usv-terminal/maps），
 * 不走程序目录：release 分支自动更新会覆盖程序目录，地图不能跟着被覆盖。
 *
 * 写入用「临时目录 + rename」：中途失败不会留下半个地图；同名时追加 -2/-3，
 * 绝不覆盖已有地图（地图是实验资产，删错无法重建）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { SlamRecorder } from '../algo/slamExport.js';
import { buildSlamFiles } from '../algo/slamExport.js';

export const MAP_FILES = [
  'map.png',
  'map.pgm',
  'map.yaml',
  'trajectory.csv',
  'session.json',
  'meta.json',
] as const;

/** 地图名只允许这些字符；其余替换成 - */
const NAME_BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const NAME_MAX = 48;

export interface MapMeta {
  version: 1;
  name: string;
  createdAt: string;
  app: { name: string; version: string };
  map: {
    size: number;
    resolution: number;
    origin: [number, number];
    observed: number;
    occupied: number;
    free: number;
    unknown: number;
  };
  ship: { host: string; port: number; firmware: string | null; caps: number };
  trajectory: { poses: number; dropped: number };
  files: string[];
  /** map.pgm + map.yaml 的 SHA-256，实验 summary 用它核对用的是哪张地图 */
  hash: string;
}

export interface MapEntry {
  name: string;
  dir: string;
  createdAt: number;
  size: number;
  resolution: number;
  origin: [number, number];
  observed: number;
  occupied: number | null;
  poses: number;
  hash: string | null;
  bytes: number;
  /** meta.json 损坏时为原因，列表仍可展示该目录 */
  warning: string | null;
}

export interface SaveMapInput {
  recorder: SlamRecorder;
  appVersion: string;
  ship: { host: string; port: number; firmware: string | null; caps: number };
  name?: string;
}

export interface SaveMapResult {
  ok: boolean;
  name?: string;
  dir?: string;
  files?: number;
  bytes?: number;
  message: string;
}

export interface LoadMapResult {
  ok: boolean;
  name?: string;
  /** map.yaml 绝对路径；侧车用它加载 */
  yamlPath?: string;
  meta?: MapMeta;
  message: string;
}

/** 地图名清洗：空值回退时间戳，限长，去路径分隔符 */
export function sanitizeMapName(raw: string | undefined, at = new Date()): string {
  const cleaned = (raw ?? '')
    .replace(NAME_BAD_CHARS, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, NAME_MAX);
  if (cleaned && cleaned !== '.' && cleaned !== '..') return cleaned;
  return `map-${stamp(at)}`;
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 校验 name 只指向 baseDir 的直接子目录，挡掉 ../ 与绝对路径 */
export function resolveMapDir(baseDir: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`非法地图名 ${JSON.stringify(name)}`);
  }
  const base = path.resolve(baseDir);
  const dir = path.resolve(base, name);
  if (path.dirname(dir) !== base) throw new Error(`地图路径越界: ${name}`);
  return dir;
}

function sha256(parts: Buffer[]): string {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return `sha256:${h.digest('hex')}`;
}

/** 解析 P5 PGM，统计三态格数；用于地图库列表与元信息 */
export function countPgmStates(pgm: Buffer): {
  width: number;
  height: number;
  occupied: number;
  free: number;
  unknown: number;
} {
  // 头：P5\n<w> <h>\n<max>\n，允许注释行
  let off = 0;
  const readToken = (): string => {
    while (off < pgm.length) {
      const c = pgm[off];
      if (c === 0x23) {
        while (off < pgm.length && pgm[off] !== 0x0a) off++;
      } else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
        off++;
      } else {
        break;
      }
    }
    const start = off;
    while (off < pgm.length && ![0x20, 0x0a, 0x0d, 0x09].includes(pgm[off]!)) off++;
    return pgm.toString('ascii', start, off);
  };

  const magic = readToken();
  if (magic !== 'P5') throw new Error(`不是 P5 PGM：${JSON.stringify(magic)}`);
  const width = Number(readToken());
  const height = Number(readToken());
  const maxval = Number(readToken());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PGM 尺寸无效');
  }
  if (maxval !== 255) throw new Error(`PGM maxval 必须是 255（实际 ${maxval}）`);
  // 头部之后紧跟一个空白，跳过它
  off++;
  const body = pgm.subarray(off, off + width * height);
  if (body.length < width * height) throw new Error('PGM 数据不完整');

  let occupied = 0;
  let free = 0;
  let unknown = 0;
  for (let i = 0; i < body.length; i++) {
    const v = body[i]!;
    if (v <= 1) occupied++;
    else if (v >= 250) free++;
    else unknown++;
  }
  return { width, height, occupied, free, unknown };
}

function parseYaml(text: string): {
  image: string | null;
  resolution: number | null;
  origin: [number, number] | null;
} {
  let image: string | null = null;
  let resolution: number | null = null;
  let origin: [number, number] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes(':')) continue;
    const i = line.indexOf(':');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key === 'image') image = value;
    else if (key === 'resolution') resolution = Number(value);
    else if (key === 'origin') {
      const parts = value
        .replace(/[[\]]/g, '')
        .split(',')
        .map((s) => Number(s.trim()));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        origin = [parts[0]!, parts[1]!];
      }
    }
  }
  return { image, resolution, origin };
}

/** 从已有的 map.png/map.pgm/map.yaml 反推元信息（老地图没有 meta.json 时） */
async function readFallback(dir: string): Promise<Partial<MapMeta>> {
  const out: Partial<MapMeta> = {};
  try {
    const yamlText = await fs.readFile(path.join(dir, 'map.yaml'), 'utf8');
    const y = parseYaml(yamlText);
    const pgm = await fs.readFile(path.join(dir, 'map.pgm'));
    const states = countPgmStates(pgm);
    out.map = {
      size: states.width,
      resolution: y.resolution ?? 0,
      origin: y.origin ?? [0, 0],
      observed: states.occupied + states.free,
      occupied: states.occupied,
      free: states.free,
      unknown: states.unknown,
    };
    out.hash = sha256([pgm, Buffer.from(yamlText, 'utf8')]);
  } catch {
    /* 缺文件时保持空，让调用方给出 warning */
  }
  return out;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      total += (await fs.stat(path.join(dir, entry.name))).size;
    } catch {
      /* 文件在被统计时被删掉：忽略 */
    }
  }
  return total;
}

export class MapLibrary {
  constructor(readonly baseDir: string) {}

  /** 列出地图目录；meta.json 缺失或损坏时用 PGM/YAML 兜底，不让整表失败 */
  async list(): Promise<MapEntry[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: MapEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
      const dir = path.join(this.baseDir, entry.name);
      let meta: MapMeta | null = null;
      let warning: string | null = null;
      try {
        meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as MapMeta;
      } catch (err) {
        warning = `meta.json 不可读：${(err as Error).message}`;
      }
      const fallback = meta ? {} : await readFallback(dir);
      const map = meta?.map ?? fallback.map;
      if (!map) {
        // 连地图文件都没有的目录不进列表（可能是用户手放的别的目录）
        continue;
      }
      const createdAt = meta?.createdAt ? Date.parse(meta.createdAt) : NaN;
      const stat = await fs.stat(dir).catch(() => null);
      out.push({
        name: meta?.name ?? entry.name,
        dir,
        createdAt: Number.isFinite(createdAt) ? createdAt : (stat?.mtimeMs ?? 0),
        size: map.size,
        resolution: map.resolution,
        origin: map.origin,
        observed: map.observed,
        occupied: map.occupied ?? null,
        poses: meta?.trajectory?.poses ?? 0,
        hash: meta?.hash ?? fallback.hash ?? null,
        bytes: await dirBytes(dir),
        warning,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
    return out;
  }

  /**
   * 保存当前录制的地图。必须已有地图；轨迹可有可无。
   * 先写 maps/.tmp-<name>-<pid>-<rand>/，全部写完再 rename，避免半成品。
   */
  async save(input: SaveMapInput, at = new Date()): Promise<SaveMapResult> {
    const { recorder, appVersion, ship } = input;
    if (!recorder.hasMap) return { ok: false, message: '还没有 SLAM 地图，先让船跑一圈' };

    const { entries, files } = buildSlamFiles(recorder, {
      appVersion,
      exportedAt: at.getTime(),
      ship,
      recording: { since: recorder.stats().firstPoseAt },
    });
    const pgm = entries.find((e) => e.name === 'map.pgm');
    const yaml = entries.find((e) => e.name === 'map.yaml');
    if (!pgm || !yaml) return { ok: false, message: '地图文件生成失败（PGM 或 YAML 缺失）' };

    let states: ReturnType<typeof countPgmStates>;
    try {
      states = countPgmStates(pgm.data);
    } catch (err) {
      return { ok: false, message: `地图文件无效：${(err as Error).message}` };
    }
    const stats = recorder.stats();
    const metaBase = {
      version: 1 as const,
      createdAt: at.toISOString(),
      app: { name: 'USV Terminal', version: appVersion },
      map: {
        size: states.width,
        resolution: stats.resolution,
        origin: stats.origin ?? ([-20, -20] as [number, number]),
        observed: states.occupied + states.free,
        occupied: states.occupied,
        free: states.free,
        unknown: states.unknown,
      },
      ship,
      trajectory: { poses: stats.poses, dropped: stats.dropped },
      files: [...files, 'meta.json'],
      hash: sha256([pgm.data, yaml.data]),
    };

    await fs.mkdir(this.baseDir, { recursive: true });
    const base = sanitizeMapName(input.name, at);
    let name = base;
    let dir = resolveMapDir(this.baseDir, name);
    for (let i = 2; ; i++) {
      try {
        await fs.access(dir);
        name = `${base}-${i}`;
        dir = resolveMapDir(this.baseDir, name);
      } catch {
        break;
      }
    }

    const tmp = path.join(
      this.baseDir,
      `.tmp-${name}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    );
    try {
      await fs.mkdir(tmp, { recursive: false });
      for (const e of entries) await fs.writeFile(path.join(tmp, e.name), e.data);
      const meta: MapMeta = { ...metaBase, name };
      await fs.writeFile(path.join(tmp, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, dir);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, message: `保存地图失败：${(err as Error).message}` };
    }

    return {
      ok: true,
      name,
      dir,
      files: metaBase.files.length,
      bytes: await dirBytes(dir),
      message: name,
    };
  }

  /** 读取地图元信息并返回 map.yaml 绝对路径（侧车加载用） */
  async load(name: string): Promise<LoadMapResult> {
    let dir: string;
    try {
      dir = resolveMapDir(this.baseDir, name);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const yamlPath = path.join(dir, 'map.yaml');
    try {
      await fs.access(yamlPath);
      await fs.access(path.join(dir, 'map.pgm'));
    } catch {
      return { ok: false, message: `地图 ${name} 缺少 map.yaml 或 map.pgm` };
    }
    let meta: MapMeta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as MapMeta;
    } catch {
      meta = {
        version: 1,
        name,
        createdAt: (await fs.stat(dir)).mtime.toISOString(),
        app: { name: 'USV Terminal', version: 'unknown' },
        map: {
          size: 0,
          resolution: 0,
          origin: [0, 0],
          observed: 0,
          occupied: 0,
          free: 0,
          unknown: 0,
        },
        ship: { host: '', port: 0, firmware: null, caps: 0 },
        trajectory: { poses: 0, dropped: 0 },
        files: [],
        hash: '',
        ...(await readFallback(dir)),
      } as MapMeta;
    }
    return { ok: true, name, yamlPath, meta, message: name };
  }

  /** 删除地图；调用方负责确认与「定位中不许删」的门控 */
  async delete(name: string): Promise<{ ok: boolean; message: string }> {
    let dir: string;
    try {
      dir = resolveMapDir(this.baseDir, name);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    try {
      await fs.access(dir);
    } catch {
      return { ok: false, message: `地图 ${name} 不存在` };
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return { ok: true, message: name };
    } catch (err) {
      return { ok: false, message: `删除失败：${(err as Error).message}` };
    }
  }

  async openDir(): Promise<string> {
    await fs.mkdir(this.baseDir, { recursive: true });
    return this.baseDir;
  }
}
