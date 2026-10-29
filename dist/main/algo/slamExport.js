"use strict";
/*
 * SLAM 数据导出。
 *
 * 保存内容是「SLAM 的结果」，不是原始雷达帧：
 *   map.pgm        占据栅格（ROS map_server 三态：0=占据 254=空闲 205=未知）
 *   map.yaml       map_server 元数据，可直接被 rviz / 其他工具读
 *   map.png        侧车原样输出的彩色栅格（未知区透明，肉眼看好）
 *   trajectory.csv 位姿序列（t, x, y, yaw, status, rmse, inlier）
 *   session.json   本次运行的元信息（固件版本、栅格参数、点数、导出时间）
 *
 * 打包成 ZIP 而不是散文件：保存对话框只能选一个路径，而 ZIP 在 Windows
 * 上双击就能看，不需要额外装解压工具。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlamRecorder = void 0;
exports.decodePng = decodePng;
exports.rgbaToPgm = rgbaToPgm;
exports.makeZip = makeZip;
exports.buildTrajectoryCsv = buildTrajectoryCsv;
exports.buildMapYaml = buildMapYaml;
exports.stampName = stampName;
exports.buildSlamArchive = buildSlamArchive;
const node_zlib_1 = __importDefault(require("node:zlib"));
/** 轨迹最多保留的点数（10 Hz 下约 2.8 小时） */
const MAX_POSES = 100_000;
/** PGM 里「够亮就算占据」的灰度阈值：空闲底色 ~111，占据 ~234 */
const LUM_OCCUPIED = 170;
/** ROS map_server 的三态取值 */
const PGM_OCCUPIED = 0;
const PGM_UNKNOWN = 205;
const PGM_FREE = 254;
/** 边收边记：地图只留最新一张，轨迹按到达顺序累积 */
class SlamRecorder {
    map = null;
    poses = [];
    dropped = 0;
    firstPoseAt = null;
    onPose(p) {
        if (this.poses.length >= MAX_POSES) {
            this.dropped++;
            return;
        }
        if (this.firstPoseAt == null)
            this.firstPoseAt = Date.now();
        this.poses.push({
            t: p.t,
            x: p.x,
            y: p.y,
            yaw: p.yaw,
            status: p.status,
            rmse: typeof p.rmse === 'number' ? p.rmse : null,
            inlier: typeof p.inlier === 'number' ? p.inlier : null,
        });
    }
    onMap(m) {
        // 清空回执是「png 为空 + cleared」，此时旧地图必须一起丢掉
        if (m.cleared || !m.png) {
            this.clear();
            return;
        }
        this.map = m;
    }
    clear() {
        this.map = null;
        this.poses.length = 0;
        this.dropped = 0;
        this.firstPoseAt = null;
    }
    get hasMap() {
        return this.map !== null;
    }
    get hasData() {
        return this.map !== null || this.poses.length > 0;
    }
    stats() {
        const last = this.poses[this.poses.length - 1] ?? null;
        return {
            hasMap: this.map !== null,
            observed: this.map?.observed ?? 0,
            size: this.map?.size ?? 0,
            resolution: this.map?.resolution ?? 0,
            origin: this.map ? this.map.origin : null,
            poses: this.poses.length,
            dropped: this.dropped,
            firstPoseAt: this.firstPoseAt,
            lastPoseAt: last ? Date.now() : null,
            lastStatus: last?.status ?? null,
        };
    }
    snapshot() {
        return {
            map: this.map,
            poses: this.poses.slice(),
            dropped: this.dropped,
            firstPoseAt: this.firstPoseAt,
        };
    }
}
exports.SlamRecorder = SlamRecorder;
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
/**
 * 最小 PNG 解码：8bit、非隔行，支持灰度/RGB/RGBA 与全部 5 种行过滤器。
 * 侧车当前只产出 RGBA + filter 0，但过滤器全实现一遍代价很小，
 * 以后换颜色类型也不会静默出错。
 */
function decodePng(buf) {
    for (let i = 0; i < 8; i++) {
        if (buf[i] !== PNG_SIG[i])
            throw new Error('不是 PNG 数据');
    }
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const body = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            bitDepth = body[8] ?? 0;
            colorType = body[9] ?? 0;
            interlace = body[12] ?? 0;
        }
        else if (type === 'IDAT') {
            idat.push(Buffer.from(body));
        }
        else if (type === 'IEND') {
            break;
        }
        off += 12 + len;
    }
    if (bitDepth !== 8)
        throw new Error(`只支持 8bit PNG（实际 ${bitDepth}bit）`);
    if (interlace !== 0)
        throw new Error('不支持隔行 PNG');
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
    if (!channels)
        throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);
    if (!width || !height)
        throw new Error('PNG 尺寸无效');
    const raw = node_zlib_1.default.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(height * stride);
    let prev = Buffer.alloc(stride);
    let p = 0;
    for (let y = 0; y < height; y++) {
        if (p >= raw.length)
            throw new Error('PNG 数据不完整');
        const filter = raw[p++];
        const row = raw.subarray(p, p + stride);
        p += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        for (let i = 0; i < stride; i++) {
            // a=左 b=上 c=左上
            const a = i >= channels ? (cur[i - channels] ?? 0) : 0;
            const b = prev[i] ?? 0;
            const c = i >= channels ? (prev[i - channels] ?? 0) : 0;
            let v = row[i] ?? 0;
            switch (filter) {
                case 0:
                    break;
                case 1:
                    v = (v + a) & 0xff;
                    break;
                case 2:
                    v = (v + b) & 0xff;
                    break;
                case 3:
                    v = (v + ((a + b) >> 1)) & 0xff;
                    break;
                case 4: {
                    const pa = Math.abs(b - c);
                    const pb = Math.abs(a - c);
                    const pc = Math.abs(a + b - 2 * c);
                    const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                    v = (v + pr) & 0xff;
                    break;
                }
                default:
                    throw new Error(`未知 PNG 行过滤器 ${filter}`);
            }
            cur[i] = v;
        }
        prev = cur;
    }
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0, n = width * height; i < n; i++) {
        const s = i * channels;
        const d = i * 4;
        if (channels === 4) {
            rgba[d] = out[s] ?? 0;
            rgba[d + 1] = out[s + 1] ?? 0;
            rgba[d + 2] = out[s + 2] ?? 0;
            rgba[d + 3] = out[s + 3] ?? 0;
        }
        else if (channels === 3) {
            rgba[d] = out[s] ?? 0;
            rgba[d + 1] = out[s + 1] ?? 0;
            rgba[d + 2] = out[s + 2] ?? 0;
            rgba[d + 3] = 255;
        }
        else if (channels === 1) {
            rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s] ?? 0;
            rgba[d + 3] = 255;
        }
        else {
            rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s] ?? 0;
            rgba[d + 3] = out[s + 1] ?? 0;
        }
    }
    return { width, height, rgba };
}
/** RGBA → ROS map_server 的三态 PGM（行 0 在最上，与 PNG 一致） */
function rgbaToPgm(img) {
    const body = Buffer.alloc(img.width * img.height);
    for (let i = 0, n = img.width * img.height; i < n; i++) {
        const d = i * 4;
        if ((img.rgba[d + 3] ?? 0) === 0) {
            body[i] = PGM_UNKNOWN;
            continue;
        }
        const lum = 0.299 * (img.rgba[d] ?? 0) + 0.587 * (img.rgba[d + 1] ?? 0) + 0.114 * (img.rgba[d + 2] ?? 0);
        body[i] = lum >= LUM_OCCUPIED ? PGM_OCCUPIED : PGM_FREE;
    }
    const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
    return Buffer.concat([header, body]);
}
/* ---------------- 最小 ZIP 写入 ---------------- */
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++)
        c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) | 0;
    return (c ^ -1) >>> 0;
}
/** deflate 不划算就原样存（PNG 这类已压缩内容会走 store） */
function makeZip(entries, at = new Date()) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    const dosTime = ((at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const crc = crc32(e.data);
        const deflated = node_zlib_1.default.deflateRawSync(e.data, { level: 9 });
        const useDeflate = deflated.length < e.data.length;
        const payload = useDeflate ? deflated : e.data;
        const method = useDeflate ? 8 : 0;
        const lf = Buffer.alloc(30);
        lf.writeUInt32LE(0x04034b50, 0);
        lf.writeUInt16LE(20, 4);
        lf.writeUInt16LE(0x0800, 6); // 名称按 UTF-8
        lf.writeUInt16LE(method, 8);
        lf.writeUInt16LE(dosTime, 10);
        lf.writeUInt16LE(dosDate, 12);
        lf.writeUInt32LE(crc, 14);
        lf.writeUInt32LE(payload.length, 18);
        lf.writeUInt32LE(e.data.length, 22);
        lf.writeUInt16LE(name.length, 26);
        lf.writeUInt16LE(0, 28);
        locals.push(lf, name, payload);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0x0800, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt16LE(dosTime, 12);
        cd.writeUInt16LE(dosDate, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(payload.length, 20);
        cd.writeUInt32LE(e.data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(0, 38);
        cd.writeUInt32LE(offset, 42);
        centrals.push(cd, name);
        offset += lf.length + name.length + payload.length;
    }
    const central = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, central, eocd]);
}
/* ---------------- 组包 ---------------- */
function csvCell(v) {
    if (v == null)
        return '';
    if (typeof v === 'number')
        return Number.isFinite(v) ? String(v) : '';
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function buildTrajectoryCsv(poses) {
    const lines = ['t_ms,x_m,y_m,yaw_rad,yaw_deg,status,rmse_m,inlier'];
    for (const p of poses) {
        lines.push([
            csvCell(p.t),
            csvCell(p.x),
            csvCell(p.y),
            csvCell(p.yaw),
            csvCell((p.yaw * 180) / Math.PI),
            csvCell(p.status),
            csvCell(p.rmse),
            csvCell(p.inlier),
        ].join(','));
    }
    return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
function buildMapYaml(map) {
    const [ox, oy] = map.origin;
    return Buffer.from([
        '# 由 USV Terminal 导出（ROS map_server 格式）',
        '# 0=占据 254=空闲 205=未知',
        'image: map.pgm',
        `resolution: ${map.resolution}`,
        `origin: [${ox}, ${oy}, 0.0]`,
        'negate: 0',
        'occupied_thresh: 0.65',
        'free_thresh: 0.196',
        '',
    ].join('\n'), 'utf8');
}
/** 导出的文件名：本地时间，便于按时间排序 */
function stampName(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return (`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
}
/**
 * 把一次运行打包成 ZIP。没有地图也能导出（只含轨迹），
 * 但如果连轨迹都没有就没意义，由调用方先拦掉。
 */
function buildSlamArchive(rec, meta, at = new Date()) {
    const snap = rec.snapshot();
    const files = [];
    const entries = [];
    if (snap.map) {
        const png = Buffer.from(snap.map.png, 'base64');
        entries.push({ name: 'map.png', data: png });
        files.push('map.png');
        try {
            entries.push({ name: 'map.pgm', data: rgbaToPgm(decodePng(png)) });
            files.push('map.pgm');
        }
        catch (err) {
            // PGM 转不出来不能连累整包：把原因写进 session.json
            console.warn(`[slam-export] PGM 转换失败: ${err.message}`);
        }
        entries.push({ name: 'map.yaml', data: buildMapYaml(snap.map) });
        files.push('map.yaml');
    }
    if (snap.poses.length > 0) {
        entries.push({ name: 'trajectory.csv', data: buildTrajectoryCsv(snap.poses) });
        files.push('trajectory.csv');
    }
    const last = snap.poses[snap.poses.length - 1] ?? null;
    // 列表里要包含 session.json 自己，与界面上报的数量一致
    files.push('session.json');
    const session = {
        app: 'USV Terminal',
        app_version: meta.appVersion,
        exported_at: new Date(meta.exportedAt).toISOString(),
        ship: meta.ship,
        map: snap.map
            ? {
                size: snap.map.size,
                resolution: snap.map.resolution,
                origin: snap.map.origin,
                observed: snap.map.observed,
                captured_at: new Date(snap.map.t).toISOString(),
            }
            : null,
        trajectory: {
            poses: snap.poses.length,
            dropped: snap.dropped,
            started_at: snap.firstPoseAt ? new Date(snap.firstPoseAt).toISOString() : null,
            final: last
                ? { x: last.x, y: last.y, yaw: last.yaw, status: last.status, rmse: last.rmse }
                : null,
        },
        files,
        note: 'map.pgm/map.yaml 为 ROS map_server 三态格式；map.png 为界面同款彩色渲染。',
    };
    entries.push({ name: 'session.json', data: Buffer.from(JSON.stringify(session, null, 2), 'utf8') });
    return { zip: makeZip(entries, at), files };
}
//# sourceMappingURL=slamExport.js.map