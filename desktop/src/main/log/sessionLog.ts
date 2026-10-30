/*
 * 会话日志（主进程）。
 *
 * 每次启动在 <base>/session-<YYYYMMDD-HHmmss>/ 下落盘一套文件，
 * 用于事后 debug 与实验原始数据回溯：
 *
 *   meta.json     启动信息（版本 / 平台 / 配置 / 开始时间）
 *   client.jsonl  运行事件，一行一个 JSON
 *   status.csv    船端 STATUS 全量（50Hz，不受 UI 限速影响）
 *   cmd.csv       实际下发的 CMD 全量（50Hz）
 *   ui.csv        渲染进程上报的原始指令（30Hz，未过安全阀）
 *   scan.csv      每圈点云摘要（点云本体在 rx.*.bin）
 *   pose.csv      SLAM 位姿（~10Hz）
 *   rx.000.bin    收到的原始 TCP 字节流
 *   tx.000.bin    发出的原始帧
 *   summary.json  正常退出时的统计
 *   README.txt    格式说明（随日志一起带走）
 *
 * rx/tx 记录格式（小端）：u32 长度 | f64 epoch_ms | 原始字节。
 * 原始流按 rawPartBytes 自动分片，避免单个文件无限增长。
 *
 * 写入全部使用同步 IO：进程崩溃时已写内容不丢，而且日志写盘期间不会与
 * 同一事件循环里的其他操作交错（导出 ZIP 时天然是一致快照）。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PoseView } from '../../shared/api.js';
import {
  CMD_FLAG_ARM,
  CMD_FLAG_ESTOP,
  ST_ARMED,
  ST_ARM_REQUIRED,
  ST_ESTOP,
  ST_FAILSAFE,
  ST_LIDAR_OK,
  type ScanFrame,
  type Status,
} from '../../shared/protocol.js';

export type LogLevel = 'info' | 'warn' | 'error';
export type WireDirection = 'rx' | 'tx';

/** 原始流记录头：u32 长度 + f64 epoch ms */
export const WIRE_RECORD_HEADER = 12;
/** 默认单个原始流分片大小 */
const DEFAULT_RAW_PART_BYTES = 128 * 1024 * 1024;
/** 默认保留的会话数（含本次） */
const DEFAULT_KEEP_SESSIONS = 10;
const SESSION_DIR_RE = /^session-\d{8}-\d{6}(-\d+)?$/;

const STATUS_CSV_HEADER =
  'recv_ms,boat_ms,throttle_pct,direction,servo1_deg,armed,estop,failsafe,lidar_ok,' +
  'arm_required,rx_seq,rx_errors,points_last,scans_total,loop_hz';
const CMD_CSV_HEADER = 'send_ms,throttle_pct,servo1_deg,flags,armed,estop';
const UI_CSV_HEADER = 'recv_ms,throttle_norm,rudder_norm';
const SCAN_CSV_HEADER =
  'recv_ms,boat_ms,count,encoding,quality_max,min_range_m,max_range_m,' +
  't_start_ms,scan_seq,rate_hz';
const POSE_CSV_HEADER = 'recv_ms,boat_t_ms,x_m,y_m,yaw_rad,status,rmse_m,inlier,scans,skipped';

const README_TEXT = `USV Terminal 会话日志
=====================

每次启动一个目录：session-YYYYMMDD-HHmmss（本地时间）

文件说明
  meta.json      启动信息：版本、平台、配置、开始时间
  client.jsonl   运行事件，一行一个 JSON：{"t":<epoch ms>,"level":"info|warn|error","type":"..."}
  status.csv     船端 STATUS 全量（50Hz）
  cmd.csv        实际下发的 CMD 全量（50Hz）
  ui.csv         渲染进程上报的原始指令（30Hz，未过安全阀）
  scan.csv       每圈雷达摘要（点云本体在 rx.*.bin）
  pose.csv       SLAM 位姿（约 10Hz）
  rx.NNN.bin     收到的原始 TCP 字节流（000 起分片）
  tx.NNN.bin     发出的原始帧（000 起分片）
  summary.json   正常退出时的统计（异常退出时没有）
  README.txt     本说明

原始流记录格式（小端）
  u32 length | f64 epoch_ms | length 字节的原始数据

  直接按上述格式切分即可；每个 payload 是完整的 TCP 收/发数据块，
  可能包含多帧，也可能是一帧的一部分。用 src/shared/protocol.ts 的
  FrameParser 依次喂入即可还原 STATUS / SCAN / HELLO_ACK 等帧。

注意
  ★ 会话按启动时间保留最近若干次，旧目录会自动清理。
  ★ 导出 ZIP 时日志仍在记录，ZIP 里另有 snapshot.json 说明导出时状态。
`;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 与 SLAM 导出同款的时间戳：20261030-164103 */
export function sessionStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function createSessionDir(baseDir: string, at: Date): string {
  fs.mkdirSync(baseDir, { recursive: true });
  const stamp = sessionStamp(at);
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? `session-${stamp}` : `session-${stamp}-${i}`;
    const dir = path.join(baseDir, name);
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`无法创建日志目录: ${baseDir}`);
}

/**
 * 删除超出保留数量的旧会话；只认本程序自己的目录名。
 * protect 为当前正在写的目录名，即使系统时钟回拨导致它排在末尾也不会被删。
 */
export function pruneLogSessions(baseDir: string, keep: number, protect?: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = entries
    .filter((e) => e.isDirectory() && SESSION_DIR_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const removed: string[] = [];
  for (const name of sessions.slice(Math.max(1, keep))) {
    if (name === protect) continue;
    try {
      fs.rmSync(path.join(baseDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      console.warn(`[log] 清理旧日志失败 ${name}: ${(err as Error).message}`);
    }
  }
  return removed;
}

function rawRecord(data: Buffer, atMs: number): Buffer {
  const head = Buffer.allocUnsafe(WIRE_RECORD_HEADER);
  head.writeUInt32LE(data.length, 0);
  head.writeDoubleLE(atMs, 4);
  return head;
}

/** 单条原始流（rx 或 tx），超过分片上限自动写下一个文件 */
class WireStream {
  private fd: number | null = null;
  private part = -1;
  private partBytes = 0;
  private total = 0;

  constructor(
    private readonly dir: string,
    private readonly baseName: string,
    private readonly maxPartBytes: number,
  ) {
    this.nextPart();
  }

  get bytes(): number {
    return this.total;
  }

  private nextPart(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* 忽略关闭失败 */
      }
    }
    this.part++;
    this.partBytes = 0;
    const name = `${this.baseName}.${String(this.part).padStart(3, '0')}.bin`;
    this.fd = fs.openSync(path.join(this.dir, name), 'a');
  }

  write(data: Buffer, atMs: number): void {
    if (this.fd === null || data.length === 0) return;
    if (this.maxPartBytes > 0 && this.partBytes > 0) {
      if (this.partBytes + WIRE_RECORD_HEADER + data.length > this.maxPartBytes) this.nextPart();
    }
    const head = rawRecord(data, atMs);
    fs.writevSync(this.fd, [head, data]);
    this.partBytes += head.length + data.length;
    this.total += head.length + data.length;
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* 忽略关闭失败 */
    }
    this.fd = null;
  }
}

export interface SessionLoggerOptions {
  /** 会话目录的上级目录 */
  baseDir: string;
  /** 写进 meta.json 的启动信息 */
  meta?: Record<string, unknown>;
  /** 保留最近多少个会话（含本次），默认 10 */
  keepSessions?: number;
  /** 原始流单文件上限（字节），默认 128 MiB；<=0 表示不分片 */
  rawPartBytes?: number;
  /** STATUS 船钟间隔超过该值就记为一次缺口（ms），默认 100（50Hz 的 5 拍） */
  statusGapMs?: number;
  now?: () => number;
}

export interface ScanLogFrame extends ScanFrame {
  tStartMs?: number;
  scanSeq?: number;
  rateHz?: number;
}

/** 结构上兼容 SafetySupervisor 的 OutCommand，避免日志模块依赖安全模块 */
export interface LoggedCommand {
  throttleX10: number;
  servosX10: readonly number[];
  flags: number;
}

export interface LogStats {
  enabled: boolean;
  dir: string;
  startedAt: number;
  durationMs: number;
  /** 本次会话写入的字节数（含原始流记录头） */
  bytes: number;
  events: number;
  statusRows: number;
  /** STATUS 之间船钟跳变超过 statusGapMs 的次数（>0 说明现场丢了 50Hz 帧） */
  statusGaps: number;
  /** 相邻 STATUS 的最大船钟间隔；正常 50Hz 约 20ms，>100ms 即丢帧 */
  maxStatusGapMs: number;
  cmdRows: number;
  uiRows: number;
  scanRows: number;
  poseRows: number;
  errorEvents: number;
  rxBytes: number;
  txBytes: number;
  /** 写入失败后的原因；正常时为 null */
  error: string | null;
}

export class SessionLogger {
  readonly dir: string;
  readonly startedAt: number;

  private readonly now: () => number;
  private readonly rx: WireStream;
  private readonly tx: WireStream;
  private readonly eventFd: number;
  private readonly statusFd: number;
  private readonly cmdFd: number;
  private readonly uiFd: number;
  private readonly scanFd: number;
  private readonly poseFd: number;

  private ownBytes = 0;
  private eventCount = 0;
  private statusCount = 0;
  private cmdCount = 0;
  private uiCount = 0;
  private scanCount = 0;
  private poseCount = 0;
  private errorCount = 0;
  private failure: string | null = null;
  private closed = false;

  private readonly statusGapMs: number;
  private lastStatusBoatMs: number | null = null;
  private statusGapCount = 0;
  private maxStatusGapMs = 0;

  constructor(opts: SessionLoggerOptions) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.statusGapMs = opts.statusGapMs ?? 100;

    this.dir = createSessionDir(opts.baseDir, new Date(this.startedAt));
    const rawPartBytes = opts.rawPartBytes ?? DEFAULT_RAW_PART_BYTES;

    const meta = {
      schema: 1,
      kind: 'usv-terminal-session-log',
      startedAt: new Date(this.startedAt).toISOString(),
      startedAtMs: this.startedAt,
      dir: this.dir,
      ...opts.meta,
    };
    this.writeInitial('meta.json', `${JSON.stringify(meta, null, 2)}\n`);
    this.writeInitial('README.txt', README_TEXT);

    this.statusFd = this.openCsv('status.csv', STATUS_CSV_HEADER);
    this.cmdFd = this.openCsv('cmd.csv', CMD_CSV_HEADER);
    this.uiFd = this.openCsv('ui.csv', UI_CSV_HEADER);
    this.scanFd = this.openCsv('scan.csv', SCAN_CSV_HEADER);
    this.poseFd = this.openCsv('pose.csv', POSE_CSV_HEADER);
    this.eventFd = fs.openSync(path.join(this.dir, 'client.jsonl'), 'a');
    this.rx = new WireStream(this.dir, 'rx', rawPartBytes);
    this.tx = new WireStream(this.dir, 'tx', rawPartBytes);

    pruneLogSessions(
      opts.baseDir,
      opts.keepSessions ?? DEFAULT_KEEP_SESSIONS,
      path.basename(this.dir),
    );
  }

  private writeInitial(name: string, text: string): void {
    const buf = Buffer.from(text, 'utf8');
    fs.writeFileSync(path.join(this.dir, name), buf);
    this.ownBytes += buf.length;
  }

  private openCsv(name: string, header: string): number {
    const file = path.join(this.dir, name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* 新文件 */
    }
    const fd = fs.openSync(file, 'a');
    if (size === 0) this.append(fd, `${header}\n`);
    return fd;
  }

  private append(fd: number, text: string): void {
    const buf = Buffer.from(text, 'utf8');
    fs.writeSync(fd, buf);
    this.ownBytes += buf.length;
  }

  private get ready(): boolean {
    return !this.failure && !this.closed;
  }

  private guard(write: () => void): void {
    if (!this.ready) return;
    try {
      write();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    if (this.failure) return;
    this.failure = err instanceof Error ? err.message : String(err);
    console.error(`[log] 写盘失败，本次会话停止记录: ${this.failure}`);
    this.closeFds();
  }

  private closeFds(): void {
    for (const fd of [this.eventFd, this.statusFd, this.cmdFd, this.uiFd, this.scanFd, this.poseFd]) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关闭或从未打开 */
      }
    }
    this.rx?.close();
    this.tx?.close();
  }

  event(level: LogLevel, type: string, data?: Record<string, unknown>): void {
    this.guard(() => this.appendEvent(level, type, data));
  }

  /** 已经处在 guard 内部时直接写，不再嵌套 try/catch */
  private appendEvent(level: LogLevel, type: string, data?: Record<string, unknown>): void {
    const rec: Record<string, unknown> = { ...(data ?? {}), t: this.now(), level, type };
    this.append(this.eventFd, `${JSON.stringify(rec)}\n`);
    this.eventCount++;
    if (level === 'error') this.errorCount++;
  }

  warn(type: string, data?: Record<string, unknown>): void {
    this.event('warn', type, data);
  }

  error(type: string, data?: Record<string, unknown>): void {
    this.event('error', type, data);
  }

  status(st: Status, atMs = this.now()): void {
    this.guard(() => {
      // 船钟连续性自检：50Hz 时相邻两帧应相距 ~20ms，跳变说明现场丢了帧。
      // 船端重启会让 timeMs 归零，按「重置」而不是缺口处理。
      const prev = this.lastStatusBoatMs;
      if (prev !== null) {
        if (st.timeMs < prev) {
          this.appendEvent('info', 'status-time-reset', { prevMs: prev, boatMs: st.timeMs });
        } else {
          const gap = st.timeMs - prev;
          // 最大值按真实间隔统计（正常 50Hz 约 20ms），缺口只在超过阈值时计数
          if (gap > this.maxStatusGapMs) this.maxStatusGapMs = gap;
          if (gap > this.statusGapMs) {
            this.statusGapCount++;
            this.appendEvent('warn', 'status-gap', { gapMs: gap, boatMs: st.timeMs });
          }
        }
      }
      this.lastStatusBoatMs = st.timeMs;

      const f = st.flags;
      const row = [
        atMs,
        st.timeMs,
        (st.throttleX10 / 10).toFixed(1),
        st.direction,
        ((st.servosX10[0] ?? 0) / 10).toFixed(1),
        (f & ST_ARMED) !== 0 ? 1 : 0,
        (f & ST_ESTOP) !== 0 ? 1 : 0,
        (f & ST_FAILSAFE) !== 0 ? 1 : 0,
        (f & ST_LIDAR_OK) !== 0 ? 1 : 0,
        (f & ST_ARM_REQUIRED) !== 0 ? 1 : 0,
        st.rxSeq,
        st.rxErrors,
        st.pointsLast,
        st.scansTotal,
        (st.loopHzX10 / 10).toFixed(1),
      ];
      this.append(this.statusFd, `${row.join(',')}\n`);
      this.statusCount++;
    });
  }

  command(cmd: LoggedCommand, atMs = this.now()): void {
    this.guard(() => {
      const row = [
        atMs,
        (cmd.throttleX10 / 10).toFixed(1),
        ((cmd.servosX10[0] ?? 0) / 10).toFixed(1),
        cmd.flags,
        (cmd.flags & CMD_FLAG_ARM) !== 0 ? 1 : 0,
        (cmd.flags & CMD_FLAG_ESTOP) !== 0 ? 1 : 0,
      ];
      this.append(this.cmdFd, `${row.join(',')}\n`);
      this.cmdCount++;
    });
  }

  /** 渲染进程的原始归一化指令（−1..1），用于区分「没操作」与「被安全阀归零」 */
  uiCommand(throttle: number, rudder: number, atMs = this.now()): void {
    this.guard(() => {
      this.append(this.uiFd, `${atMs},${throttle.toFixed(3)},${rudder.toFixed(3)}\n`);
      this.uiCount++;
    });
  }

  scan(scan: ScanLogFrame, recvMs = this.now()): void {
    this.guard(() => {
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      for (let i = 0; i < scan.rangesM.length; i++) {
        const r = scan.rangesM[i] ?? 0;
        if (!(r > 0)) continue;
        if (r < min) min = r;
        if (r > max) max = r;
      }
      const row = [
        recvMs,
        scan.timeMs,
        scan.count,
        scan.encoding,
        scan.qualityMax,
        Number.isFinite(min) ? min.toFixed(3) : '',
        max > 0 ? max.toFixed(3) : '',
        scan.tStartMs ?? '',
        scan.scanSeq ?? '',
        scan.rateHz != null ? scan.rateHz.toFixed(2) : '',
      ];
      this.append(this.scanFd, `${row.join(',')}\n`);
      this.scanCount++;
    });
  }

  pose(p: PoseView, atMs = this.now()): void {
    this.guard(() => {
      const row = [
        atMs,
        p.t,
        p.x,
        p.y,
        p.yaw,
        p.status,
        p.rmse ?? '',
        p.inlier ?? '',
        p.scans ?? '',
        p.skipped ?? '',
      ];
      this.append(this.poseFd, `${row.join(',')}\n`);
      this.poseCount++;
    });
  }

  wire(dir: WireDirection, data: Buffer, atMs = this.now()): void {
    this.guard(() => {
      if (dir === 'rx') this.rx.write(data, atMs);
      else this.tx.write(data, atMs);
    });
  }

  /** 把已写内容刷到磁盘（导出前调用；同步写已经保证可见性，这里只做 fsync） */
  flush(): void {
    if (!this.ready) return;
    for (const fd of [this.eventFd, this.statusFd, this.cmdFd, this.uiFd, this.scanFd, this.poseFd]) {
      try {
        fs.fsyncSync(fd);
      } catch {
        /* 某些文件系统不支持 fsync，忽略 */
      }
    }
  }

  stats(): LogStats {
    return {
      enabled: !this.failure,
      dir: this.dir,
      startedAt: this.startedAt,
      durationMs: Math.max(0, this.now() - this.startedAt),
      bytes: this.ownBytes + this.rx.bytes + this.tx.bytes,
      events: this.eventCount,
      statusRows: this.statusCount,
      statusGaps: this.statusGapCount,
      maxStatusGapMs: this.maxStatusGapMs,
      cmdRows: this.cmdCount,
      uiRows: this.uiCount,
      scanRows: this.scanCount,
      poseRows: this.poseCount,
      errorEvents: this.errorCount,
      rxBytes: this.rx.bytes,
      txBytes: this.tx.bytes,
      error: this.failure,
    };
  }

  /** 正常退出：写 summary.json 并关闭所有句柄（可重复调用） */
  close(reason = 'quit'): LogStats {
    if (this.closed) return this.stats();
    if (!this.failure) {
      try {
        this.event('info', 'session-close', { reason, durationMs: this.now() - this.startedAt });
        const summary = {
          ...this.stats(),
          closedAt: new Date(this.now()).toISOString(),
          closeReason: reason,
        };
        const buf = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(this.dir, 'summary.json'), buf);
        this.ownBytes += buf.length;
      } catch (err) {
        console.error(`[log] 写 summary.json 失败: ${(err as Error).message}`);
      }
    }
    this.closeFds();
    this.closed = true;
    return this.stats();
  }
}
