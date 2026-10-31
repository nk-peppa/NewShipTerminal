"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MapLibrary = exports.MAP_FILES = void 0;
exports.sanitizeMapName = sanitizeMapName;
exports.resolveMapDir = resolveMapDir;
exports.countPgmStates = countPgmStates;
const node_crypto_1 = __importDefault(require("node:crypto"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const slamExport_js_1 = require("../algo/slamExport.js");
exports.MAP_FILES = [
    'map.png',
    'map.pgm',
    'map.yaml',
    'trajectory.csv',
    'session.json',
    'meta.json',
];
/** 地图名只允许这些字符；其余替换成 - */
const NAME_BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const NAME_MAX = 48;
/** 地图名清洗：空值回退时间戳，限长，去路径分隔符 */
function sanitizeMapName(raw, at = new Date()) {
    const cleaned = (raw ?? '')
        .replace(NAME_BAD_CHARS, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, NAME_MAX);
    if (cleaned && cleaned !== '.' && cleaned !== '..')
        return cleaned;
    return `map-${stamp(at)}`;
}
function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return (`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
}
/** 校验 name 只指向 baseDir 的直接子目录，挡掉 ../ 与绝对路径 */
function resolveMapDir(baseDir, name) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error(`非法地图名 ${JSON.stringify(name)}`);
    }
    const base = node_path_1.default.resolve(baseDir);
    const dir = node_path_1.default.resolve(base, name);
    if (node_path_1.default.dirname(dir) !== base)
        throw new Error(`地图路径越界: ${name}`);
    return dir;
}
function sha256(parts) {
    const h = node_crypto_1.default.createHash('sha256');
    for (const p of parts)
        h.update(p);
    return `sha256:${h.digest('hex')}`;
}
/** 解析 P5 PGM，统计三态格数；用于地图库列表与元信息 */
function countPgmStates(pgm) {
    // 头：P5\n<w> <h>\n<max>\n，允许注释行
    let off = 0;
    const readToken = () => {
        while (off < pgm.length) {
            const c = pgm[off];
            if (c === 0x23) {
                while (off < pgm.length && pgm[off] !== 0x0a)
                    off++;
            }
            else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
                off++;
            }
            else {
                break;
            }
        }
        const start = off;
        while (off < pgm.length && ![0x20, 0x0a, 0x0d, 0x09].includes(pgm[off]))
            off++;
        return pgm.toString('ascii', start, off);
    };
    const magic = readToken();
    if (magic !== 'P5')
        throw new Error(`不是 P5 PGM：${JSON.stringify(magic)}`);
    const width = Number(readToken());
    const height = Number(readToken());
    const maxval = Number(readToken());
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error('PGM 尺寸无效');
    }
    if (maxval !== 255)
        throw new Error(`PGM maxval 必须是 255（实际 ${maxval}）`);
    // 头部之后紧跟一个空白，跳过它
    off++;
    const body = pgm.subarray(off, off + width * height);
    if (body.length < width * height)
        throw new Error('PGM 数据不完整');
    let occupied = 0;
    let free = 0;
    let unknown = 0;
    for (let i = 0; i < body.length; i++) {
        const v = body[i];
        if (v <= 1)
            occupied++;
        else if (v >= 250)
            free++;
        else
            unknown++;
    }
    return { width, height, occupied, free, unknown };
}
function parseYaml(text) {
    let image = null;
    let resolution = null;
    let origin = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !line.includes(':'))
            continue;
        const i = line.indexOf(':');
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key === 'image')
            image = value;
        else if (key === 'resolution')
            resolution = Number(value);
        else if (key === 'origin') {
            const parts = value
                .replace(/[[\]]/g, '')
                .split(',')
                .map((s) => Number(s.trim()));
            if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
                origin = [parts[0], parts[1]];
            }
        }
    }
    return { image, resolution, origin };
}
/** 从已有的 map.png/map.pgm/map.yaml 反推元信息（老地图没有 meta.json 时） */
async function readFallback(dir) {
    const out = {};
    try {
        const yamlText = await promises_1.default.readFile(node_path_1.default.join(dir, 'map.yaml'), 'utf8');
        const y = parseYaml(yamlText);
        const pgm = await promises_1.default.readFile(node_path_1.default.join(dir, 'map.pgm'));
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
    }
    catch {
        /* 缺文件时保持空，让调用方给出 warning */
    }
    return out;
}
async function dirBytes(dir) {
    let total = 0;
    for (const entry of await promises_1.default.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile())
            continue;
        try {
            total += (await promises_1.default.stat(node_path_1.default.join(dir, entry.name))).size;
        }
        catch {
            /* 文件在被统计时被删掉：忽略 */
        }
    }
    return total;
}
class MapLibrary {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    /** 列出地图目录；meta.json 缺失或损坏时用 PGM/YAML 兜底，不让整表失败 */
    async list() {
        let entries;
        try {
            entries = await promises_1.default.readdir(this.baseDir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const out = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.tmp-'))
                continue;
            const dir = node_path_1.default.join(this.baseDir, entry.name);
            let meta = null;
            let warning = null;
            try {
                meta = JSON.parse(await promises_1.default.readFile(node_path_1.default.join(dir, 'meta.json'), 'utf8'));
            }
            catch (err) {
                warning = `meta.json 不可读：${err.message}`;
            }
            const fallback = meta ? {} : await readFallback(dir);
            const map = meta?.map ?? fallback.map;
            if (!map) {
                // 连地图文件都没有的目录不进列表（可能是用户手放的别的目录）
                continue;
            }
            const createdAt = meta?.createdAt ? Date.parse(meta.createdAt) : NaN;
            const stat = await promises_1.default.stat(dir).catch(() => null);
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
    async save(input, at = new Date()) {
        const { recorder, appVersion, ship } = input;
        if (!recorder.hasMap)
            return { ok: false, message: '还没有 SLAM 地图，先让船跑一圈' };
        const { entries, files } = (0, slamExport_js_1.buildSlamFiles)(recorder, {
            appVersion,
            exportedAt: at.getTime(),
            ship,
            recording: { since: recorder.stats().firstPoseAt },
        });
        const pgm = entries.find((e) => e.name === 'map.pgm');
        const yaml = entries.find((e) => e.name === 'map.yaml');
        if (!pgm || !yaml)
            return { ok: false, message: '地图文件生成失败（PGM 或 YAML 缺失）' };
        let states;
        try {
            states = countPgmStates(pgm.data);
        }
        catch (err) {
            return { ok: false, message: `地图文件无效：${err.message}` };
        }
        const stats = recorder.stats();
        const metaBase = {
            version: 1,
            createdAt: at.toISOString(),
            app: { name: 'USV Terminal', version: appVersion },
            map: {
                size: states.width,
                resolution: stats.resolution,
                origin: stats.origin ?? [-20, -20],
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
        await promises_1.default.mkdir(this.baseDir, { recursive: true });
        const base = sanitizeMapName(input.name, at);
        let name = base;
        let dir = resolveMapDir(this.baseDir, name);
        for (let i = 2;; i++) {
            try {
                await promises_1.default.access(dir);
                name = `${base}-${i}`;
                dir = resolveMapDir(this.baseDir, name);
            }
            catch {
                break;
            }
        }
        const tmp = node_path_1.default.join(this.baseDir, `.tmp-${name}-${process.pid}-${node_crypto_1.default.randomBytes(4).toString('hex')}`);
        try {
            await promises_1.default.mkdir(tmp, { recursive: false });
            for (const e of entries)
                await promises_1.default.writeFile(node_path_1.default.join(tmp, e.name), e.data);
            const meta = { ...metaBase, name };
            await promises_1.default.writeFile(node_path_1.default.join(tmp, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
            await promises_1.default.rename(tmp, dir);
        }
        catch (err) {
            await promises_1.default.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
            return { ok: false, message: `保存地图失败：${err.message}` };
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
    async load(name) {
        let dir;
        try {
            dir = resolveMapDir(this.baseDir, name);
        }
        catch (err) {
            return { ok: false, message: err.message };
        }
        const yamlPath = node_path_1.default.join(dir, 'map.yaml');
        try {
            await promises_1.default.access(yamlPath);
            await promises_1.default.access(node_path_1.default.join(dir, 'map.pgm'));
        }
        catch {
            return { ok: false, message: `地图 ${name} 缺少 map.yaml 或 map.pgm` };
        }
        let meta;
        try {
            meta = JSON.parse(await promises_1.default.readFile(node_path_1.default.join(dir, 'meta.json'), 'utf8'));
        }
        catch {
            meta = {
                version: 1,
                name,
                createdAt: (await promises_1.default.stat(dir)).mtime.toISOString(),
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
            };
        }
        return { ok: true, name, yamlPath, meta, message: name };
    }
    /** 删除地图；调用方负责确认与「定位中不许删」的门控 */
    async delete(name) {
        let dir;
        try {
            dir = resolveMapDir(this.baseDir, name);
        }
        catch (err) {
            return { ok: false, message: err.message };
        }
        try {
            await promises_1.default.access(dir);
        }
        catch {
            return { ok: false, message: `地图 ${name} 不存在` };
        }
        try {
            await promises_1.default.rm(dir, { recursive: true, force: true });
            return { ok: true, message: name };
        }
        catch (err) {
            return { ok: false, message: `删除失败：${err.message}` };
        }
    }
    async openDir() {
        await promises_1.default.mkdir(this.baseDir, { recursive: true });
        return this.baseDir;
    }
}
exports.MapLibrary = MapLibrary;
//# sourceMappingURL=mapLibrary.js.map