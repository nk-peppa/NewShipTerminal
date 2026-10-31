"use strict";
/*
 * 定位实验记录器（主进程）。
 *
 * 定位一开始就在 experiments/<YYYYMMDD-HHmmss>/ 下边跑边落盘，不用等退出：
 *
 *   meta.json          本次实验元信息（开始 recording，结束时 done/failed）
 *   config.json        定位器参数（LocalizerConfig 全量）
 *   localization.csv   每个定位位姿 + 指标（~10Hz）
 *   scans.jsonl        原始扫描（Scan v1，可直接被 algo/run_slam.py 回放）
 *   events.jsonl       地图加载、全局搜索结果、手动位姿、状态切换、算法重启
 *   map.png/pgm/yaml   本次使用的先验地图副本
 *   summary.json       结束时的统计（进程被杀时可能缺失）
 *   README.txt         坐标约定与回放命令
 *
 * 写入用「每文件一条 promise 链 + fs.promises.appendFile」：异步、顺序确定，
 * 不会像同步写那样卡住 50Hz 控制环；排队超过上限就丢扫描并计数（scans_dropped），
 * 绝不反压控制链路。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExperimentRecorder = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const POSE_HEADER = 'recv_ms,boat_t_ms,x_m,y_m,yaw_rad,yaw_deg,status,pose_valid,rmse_m,inlier,' +
    'confidence,matched_points,dt_ms';
/** 未落盘字节上限：超过就丢扫描，绝不反压控制环 */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;
function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return (`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
}
function csvNumber(v, digits = 6) {
    if (v == null || !Number.isFinite(v))
        return '';
    return String(Number(v.toFixed(digits)));
}
function wrap(a) {
    return (a + Math.PI) % (2 * Math.PI) - Math.PI;
}
async function createDir(baseDir, at) {
    await promises_1.default.mkdir(baseDir, { recursive: true });
    const base = stamp(at);
    for (let i = 0; i < 200; i++) {
        const name = i === 0 ? base : `${base}-${i}`;
        const dir = node_path_1.default.join(baseDir, name);
        try {
            await promises_1.default.mkdir(dir);
            return { dir, name };
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
        }
    }
    throw new Error(`无法创建实验目录: ${baseDir}`);
}
class ExperimentRecorder {
    opts;
    posePath = '';
    scanPath = '';
    eventPath = '';
    queues = {
        pose: Promise.resolve(),
        scan: Promise.resolve(),
        event: Promise.resolve(),
    };
    queuedBytes = 0;
    writtenBytes = 0;
    counters = {
        frames: 0,
        tracking: 0,
        lost: 0,
        ambiguous: 0,
        searching: 0,
        scans: 0,
        scansDropped: 0,
        rmseSum: 0,
        rmseCount: 0,
        inlierSum: 0,
        confidenceSum: 0,
        dtSum: 0,
    };
    startedAt = Date.now();
    lastScanTs = 0;
    finalized = false;
    error = null;
    dir = '';
    name = '';
    lastPose = null;
    globalSearches = 0;
    constructor(opts) {
        this.opts = opts;
    }
    static async create(opts, at = new Date()) {
        const recorder = new ExperimentRecorder(opts);
        const { dir, name } = await createDir(opts.baseDir, at);
        recorder.dir = dir;
        recorder.name = name;
        recorder.startedAt = at.getTime();
        recorder.posePath = node_path_1.default.join(dir, 'localization.csv');
        recorder.scanPath = node_path_1.default.join(dir, 'scans.jsonl');
        recorder.eventPath = node_path_1.default.join(dir, 'events.jsonl');
        const meta = {
            version: 1,
            state: 'recording',
            name,
            startedAt: new Date(recorder.startedAt).toISOString(),
            app: { name: 'USV Terminal', version: opts.appVersion },
            ship: opts.ship,
            map: opts.map,
            sessionLogDir: opts.sessionLogDir ?? null,
            files: [
                'meta.json',
                'config.json',
                'localization.csv',
                'scans.jsonl',
                'events.jsonl',
                'map.png',
                'map.pgm',
                'map.yaml',
                'summary.json',
                'README.txt',
            ],
        };
        await Promise.all([
            promises_1.default.writeFile(recorder.posePath, `${POSE_HEADER}\n`, 'utf8'),
            promises_1.default.writeFile(recorder.scanPath, '', 'utf8'),
            promises_1.default.writeFile(recorder.eventPath, '', 'utf8'),
            promises_1.default.writeFile(node_path_1.default.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8'),
            promises_1.default.writeFile(node_path_1.default.join(dir, 'config.json'), `${JSON.stringify({ version: 1, localizer: opts.config }, null, 2)}\n`, 'utf8'),
            promises_1.default.writeFile(node_path_1.default.join(dir, 'README.txt'), recorder.readme(), 'utf8'),
        ]);
        // 地图副本：实验目录必须能独立解释结果，不能依赖地图库还在原处
        for (const file of ['map.png', 'map.pgm', 'map.yaml']) {
            const src = node_path_1.default.join(opts.map.dir, file);
            try {
                await promises_1.default.copyFile(src, node_path_1.default.join(dir, file));
            }
            catch (err) {
                if (file !== 'map.png') {
                    recorder.error = `复制 ${file} 失败：${err.message}`;
                }
            }
        }
        recorder.event('experiment-start', { map: opts.map.name });
        return recorder;
    }
    get directory() {
        return this.dir;
    }
    get active() {
        return !this.finalized;
    }
    readme() {
        return `USV Terminal 定位实验
=====================

坐标约定
  x 向前、y 向左、逆时针为正，单位米/弧度。
  地图坐标系 = 建图首帧位姿为 (0,0,0)；origin 为栅格左下角的世界坐标。
  scans.jsonl 的 angles 已从 C1 的「顺时针」转换成上述约定，可直接回放。

文件
  meta.json          开始/结束状态、船端与应用信息、地图名与 hash
  config.json        定位器参数（搜索步长、阈值、鲁棒尺度等）
  localization.csv   每帧位姿与指标：recv_ms,boat_t_ms,x_m,y_m,yaw_rad,yaw_deg,
                     status,pose_valid,rmse_m,inlier,confidence,matched_points,dt_ms
  scans.jsonl        原始扫描（Scan v1，一行一圈，含时间戳/角度/距离/质量/valid）
  events.jsonl       地图载入、全局搜索结果、手动位姿、相位切换、算法重启
  map.png/pgm/yaml   本次使用的先验地图副本
  summary.json       结束统计；异常退出时可能缺失
  README.txt         本说明

回放
  cd desktop
  python algo/run_slam.py --input <本目录>/scans.jsonl --output out/replay-<时间>

注意
  ★ scans.jsonl 的 timestamp 是本机接收时间（秒），不是船端时钟。
  ★ map.pgm 为 ROS map_server 三态：0=占据 254=空闲 205=未知。
  ★ 仿真/合成数据上的精度不代表实船精度，需用现场记录复核。
`;
    }
    /** 记录一个定位位姿（建图位姿不要传进来） */
    pose(p, recvMs = Date.now()) {
        if (this.finalized)
            return;
        this.lastPose = p;
        const c = this.counters;
        c.frames++;
        const phase = (p.phase ?? p.status ?? '').toLowerCase();
        if (phase.startsWith('tracking'))
            c.tracking++;
        else if (phase.startsWith('lost'))
            c.lost++;
        else if (phase.startsWith('ambiguous'))
            c.ambiguous++;
        else if (phase.startsWith('searching') || phase.startsWith('waiting'))
            c.searching++;
        if (p.rmse != null && Number.isFinite(p.rmse)) {
            c.rmseSum += p.rmse;
            c.rmseCount++;
        }
        if (p.inlier != null)
            c.inlierSum += p.inlier;
        if (p.confidence != null)
            c.confidenceSum += p.confidence;
        if (p.dtMs != null)
            c.dtSum += p.dtMs;
        const line = [
            String(recvMs),
            String(p.t ?? ''),
            csvNumber(p.x),
            csvNumber(p.y),
            csvNumber(p.yaw),
            csvNumber((p.yaw * 180) / Math.PI, 3),
            (p.phase ?? p.status ?? '').replace(/[,\n]/g, ' '),
            p.poseValid === false ? '0' : '1',
            csvNumber(p.rmse),
            p.inlier == null ? '' : csvNumber(p.inlier, 4),
            p.confidence == null ? '' : csvNumber(p.confidence, 4),
            p.matched == null ? '' : String(p.matched),
            p.dtMs == null ? '' : csvNumber(p.dtMs, 2),
        ].join(',') + '\n';
        this.write('pose', line);
    }
    /** 记录一圈原始扫描；积压过多时丢弃并计数 */
    scan(scan, tStartMs, recvMs = Date.now()) {
        if (this.finalized)
            return;
        if (this.queuedBytes > MAX_BACKLOG_BYTES) {
            this.counters.scansDropped++;
            return;
        }
        let timestamp = recvMs / 1000;
        if (timestamp <= this.lastScanTs)
            timestamp = this.lastScanTs + 0.001;
        this.lastScanTs = timestamp;
        const angles = [];
        const ranges = [];
        const quality = [];
        const valid = [];
        for (let i = 0; i < scan.count; i++) {
            const r = scan.rangesM[i] ?? 0;
            const q = scan.qualities[i] ?? 0;
            // C1 原始角度是顺时针；Scan v1 要 x 前 / y 左 / 逆时针
            angles.push(Number(wrap(-(scan.anglesRad[i] ?? 0)).toFixed(4)));
            ranges.push(Number(r.toFixed(3)));
            quality.push(q);
            valid.push(r > 0 && q > 0);
        }
        const obj = {
            version: 1,
            frame: 'x_forward_y_left_ccw',
            timestamp: Number(timestamp.toFixed(3)),
            angles,
            ranges,
            quality,
            valid,
            source: 'c1-sdk',
            range_min: 0.05,
            range_max: 12.0,
        };
        // tStartMs 仅用于诊断，不写进 Scan v1（时间基准保持一致）
        void tStartMs;
        const line = `${JSON.stringify(obj)}\n`;
        this.counters.scans++;
        this.write('scan', line);
    }
    event(type, data = {}, atMs = Date.now()) {
        if (this.finalized)
            return;
        const line = `${JSON.stringify({ t: atMs, type, ...data })}\n`;
        this.write('event', line);
    }
    /** 全局搜索的结果（候选位姿 / 歧义）写进事件，便于事后分析失败原因。 */
    localizationState(state, atMs = Date.now()) {
        if (state.phase.startsWith('searching'))
            this.globalSearches++;
        this.event('localization-state', {
            phase: state.phase,
            message: state.message,
            candidates: state.candidates,
            metrics: state.metrics,
        }, atMs);
    }
    stats() {
        return {
            active: !this.finalized,
            dir: this.dir || null,
            startedAt: this.startedAt,
            durationMs: Date.now() - this.startedAt,
            frames: this.counters.frames,
            tracking: this.counters.tracking,
            lost: this.counters.lost,
            ambiguous: this.counters.ambiguous,
            scans: this.counters.scans,
            scansDropped: this.counters.scansDropped,
            bytes: this.writtenBytes + this.queuedBytes,
            map: this.opts.map.name,
            error: this.error,
        };
    }
    /** 结束记录：等待队列排空并写 summary.json（幂等） */
    async finalize(reason = 'stopped') {
        if (this.finalized)
            return this.dir;
        this.event('experiment-stop', { reason });
        this.finalized = true;
        await Promise.all(Object.values(this.queues));
        const c = this.counters;
        const summary = {
            version: 1,
            name: this.name,
            reason,
            startedAt: new Date(this.startedAt).toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - this.startedAt,
            app: { name: 'USV Terminal', version: this.opts.appVersion },
            ship: this.opts.ship,
            map: this.opts.map,
            frames: c.frames,
            tracking: c.tracking,
            lost: c.lost,
            ambiguous: c.ambiguous,
            searching: c.searching,
            globalSearches: this.globalSearches,
            trackingRatio: c.frames ? Number((c.tracking / c.frames).toFixed(4)) : 0,
            rmseMean: c.rmseCount ? Number((c.rmseSum / c.rmseCount).toFixed(6)) : null,
            inlierMean: c.frames ? Number((c.inlierSum / c.frames).toFixed(4)) : null,
            confidenceMean: c.frames ? Number((c.confidenceSum / c.frames).toFixed(4)) : null,
            dtMsMean: c.frames ? Number((c.dtSum / c.frames).toFixed(2)) : null,
            scans: c.scans,
            scansDropped: c.scansDropped,
            finalPose: this.lastPose
                ? {
                    x: this.lastPose.x,
                    y: this.lastPose.y,
                    yaw: this.lastPose.yaw,
                    phase: this.lastPose.phase ?? this.lastPose.status,
                    valid: this.lastPose.poseValid !== false,
                }
                : null,
            sessionLogDir: this.opts.sessionLogDir ?? null,
            error: this.error,
        };
        try {
            await promises_1.default.writeFile(node_path_1.default.join(this.dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
            const metaPath = node_path_1.default.join(this.dir, 'meta.json');
            const meta = JSON.parse(await promises_1.default.readFile(metaPath, 'utf8'));
            meta.state = this.error ? 'error' : 'done';
            meta.endedAt = summary.endedAt;
            meta.error = this.error;
            await promises_1.default.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
        }
        catch (err) {
            console.error(`[experiment] 写 summary 失败: ${err.message}`);
            this.error = err.message;
        }
        return this.dir;
    }
    write(kind, line) {
        if (this.error)
            return;
        const bytes = Buffer.byteLength(line, 'utf8');
        this.queuedBytes += bytes;
        const file = kind === 'pose' ? this.posePath : kind === 'scan' ? this.scanPath : this.eventPath;
        this.queues[kind] = this.queues[kind]
            .then(async () => {
            await promises_1.default.appendFile(file, line, 'utf8');
            this.writtenBytes += bytes;
        })
            .catch((err) => {
            this.error = err.message;
            console.error(`[experiment] 写入失败: ${err.message}`);
        })
            .finally(() => {
            this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
        });
    }
}
exports.ExperimentRecorder = ExperimentRecorder;
//# sourceMappingURL=experimentRecorder.js.map