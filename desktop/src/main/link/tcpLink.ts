import net from 'node:net';
import { EventEmitter } from 'node:events';

import {
  buildFrame,
  CAP_WATCHDOG,
  computeRtt,
  FrameParser,
  packCmd,
  packHello,
  packPing,
  T_CMD,
  T_HELLO,
  T_HELLO_ACK,
  T_PING,
  T_PONG,
  T_SCAN,
  T_SCAN2,
  T_STATUS,
  T_TIME_SYNC,
  T_TIME_SYNC_RESULT,
  unpackHelloAck,
  unpackPong,
  unpackScan,
  unpackScan2,
  unpackStatus,
  unpackTimeSyncResult,
  type HelloAck,
  type RttSample,
  type ScanFrame,
  type Status,
} from '../../shared/protocol.js';
import type { OutCommand } from '../safety/supervisor.js';

export interface LinkOptions {
  host: string;
  port: number;
  rateHz: number;
  reconnectMs: number;
  getCommand: () => OutCommand;
}

export interface LinkState {
  connected: boolean;
  host: string;
  port: number;
  lastError: string | null;
  txHz: number;
  rxStatusHz: number;
  rxScanHz: number;
  rxBytesPerSec: number;
  decodeErrors: number;
  crcErrors: number;
  /** HELLO 协商结果（旧固件为 null） */
  fwVersion: string | null;
  caps: number;
  /** 船端 systemd 回滚看门狗是否已装（caps 的 CAP_WATCHDOG 位） */
  watchdogArmed: boolean;
  /** 上下行延迟（ms）；未握手或旧固件为 null */
  upMs: number | null;
  downMs: number | null;
  /** 实测往返（ms） */
  rttMs: number | null;
  /** 船钟 − 本地钟（ms） */
  clockOffsetMs: number | null;
}

export interface ReceivedScan {
  scan: ScanFrame;
  /** 本机接收时刻（epoch ms） */
  recvMs: number;
}

export type WireDirection = 'rx' | 'tx';
/** 原始收/发字节旁路回调（会话日志用）；回调里不要抛异常 */
export type WireTap = (dir: WireDirection, data: Buffer, atMs: number) => void;

/**
 * TCP 控制链路：50Hz 下发 CMD、解析 STATUS/SCAN、断线自动重连。
 * 发送节拍用单调时钟自校正，不允许 setTimeout 漂移累积。
 */
export class TcpLink extends EventEmitter {
  private socket: net.Socket | null = null;
  private readonly parser = new FrameParser();
  private connected = false;
  private stopped = false;
  private seq = 0;
  private lastError: string | null = null;
  private decodeErrors = 0;

  private timer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private rateTimer: NodeJS.Timeout | null = null;

  private txCount = 0;
  private statusCount = 0;
  private scanCount = 0;
  private txHz = 0;
  private rxStatusHz = 0;
  private rxScanHz = 0;
  private rxBytes = 0;
  private rxBytesPerSec = 0;
  private hello: HelloAck | null = null;
  private wireTap: WireTap | null = null;

  /* ---- 时钟同步（NTP 四时间戳法） ---- */
  private pingTimer: NodeJS.Timeout | null = null;
  /** 发出但未回的 PING：t1 → 本地发出时刻 */
  private pendingPing: { t1: number } | null = null;
  /** 最近若干次采样（取中位数，抗热点抖动） */
  private samples: RttSample[] = [];
  private rtt: RttSample | null = null;

  constructor(private readonly opts: LinkOptions) {
    super();
  }

  /** 旁路抓包：所有收/发字节原样交给回调，供会话日志落盘 */
  setWireTap(tap: WireTap | null): void {
    this.wireTap = tap;
  }

  private tap(dir: WireDirection, data: Buffer): void {
    if (!this.wireTap) return;
    try {
      this.wireTap(dir, data, Date.now());
    } catch (err) {
      // 日志失败不能影响控制链路
      console.warn(`[link] wire tap 失败: ${(err as Error).message}`);
    }
  }

  /** 发送统一入口：写 socket + 抓包 */
  private writeFrame(socket: net.Socket, frame: Buffer): void {
    socket.write(frame);
    this.tap('tx', frame);
  }

  /** 切换目标船端（自动发现选船时使用） */
  setTarget(host: string, port: number): void {
    if (this.opts.host === host && this.opts.port === port) return;
    this.opts.host = host;
    this.opts.port = port;
    this.lastError = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.socket;
    this.socket = null;
    this.connected = false;
    if (old) {
      old.removeAllListeners();
      old.destroy();
    }
    this.emitState();
    if (!this.stopped) this.connect();
  }

  /** 立即重连：跳过退避等待，用于船端刚重启/服务刚拉起时的一键恢复 */
  reconnectNow(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.socket;
    this.socket = null;
    this.connected = false;
    if (old) {
      old.removeAllListeners();
      old.destroy();
    }
    this.emitState();
    if (!this.stopped) this.connect();
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.startScheduler();
    this.rateTimer = setInterval(() => {
      this.txHz = this.txCount;
      this.rxStatusHz = this.statusCount;
      this.rxScanHz = this.scanCount;
      this.rxBytesPerSec = this.rxBytes;
      this.txCount = this.statusCount = this.scanCount = this.rxBytes = 0;
      this.emitState();
    }, 1000);
    // 1Hz 时钟同步探针：只发一帧 PING，不影响 50Hz 控制环
    this.pingTimer = setInterval(() => this.sendPing(), 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rateTimer) clearInterval(this.rateTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.timer = this.reconnectTimer = this.rateTimer = this.pingTimer = null;
    this.pendingPing = null;
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  /** 立即测量一次（校时按钮/手动刷新用） */
  sendPing(): void {
    const s = this.socket;
    if (!this.connected || !s || s.destroyed) return;
    const t1 = Date.now();
    this.pendingPing = { t1 };
    try {
      this.writeFrame(s, buildFrame(T_PING, this.nextSeq(), packPing(t1)));
    } catch {
      this.pendingPing = null;
    }
  }

  /** 请求船端做一次网络校时；结果通过 'timesync' 事件返回 */
  requestTimeSync(): boolean {
    const s = this.socket;
    if (!this.connected || !s || s.destroyed) return false;
    try {
      this.writeFrame(s, buildFrame(T_TIME_SYNC, this.nextSeq(), Buffer.alloc(0)));
      return true;
    } catch {
      return false;
    }
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** 取最近 5 次采样的中位数：手机热点抖动大，均值不可靠 */
  private pushSample(sample: RttSample): void {
    this.samples.push(sample);
    if (this.samples.length > 5) this.samples.shift();
    const med = (pick: (s: RttSample) => number) => {
      const v = this.samples.map(pick).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)] ?? 0;
    };
    this.rtt = {
      delayMs: med((s) => s.delayMs),
      offsetMs: med((s) => s.offsetMs),
      upMs: med((s) => s.upMs),
      downMs: med((s) => s.downMs),
    };
  }

  state(): LinkState {
    return {
      connected: this.connected,
      host: this.opts.host,
      port: this.opts.port,
      lastError: this.lastError,
      txHz: this.txHz,
      rxStatusHz: this.rxStatusHz,
      rxScanHz: this.rxScanHz,
      rxBytesPerSec: this.rxBytesPerSec,
      decodeErrors: this.decodeErrors,
      crcErrors: this.parser.crcErrors,
      fwVersion: this.hello ? this.hello.fw.join('.') : null,
      caps: this.hello?.caps ?? 0,
      watchdogArmed: (((this.hello?.caps ?? 0) & CAP_WATCHDOG) !== 0),
      upMs: this.rtt ? Math.round(this.rtt.upMs * 10) / 10 : null,
      downMs: this.rtt ? Math.round(this.rtt.downMs * 10) / 10 : null,
      rttMs: this.rtt ? Math.round(this.rtt.delayMs * 10) / 10 : null,
      clockOffsetMs: this.rtt ? Math.round(this.rtt.offsetMs) : null,
    };
  }

  private emitState(): void {
    this.emit('state', this.state());
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 1000);

    socket.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      this.hello = null;
      // 先握手：声明 v2 + SCAN2/OTA 能力；旧固件会忽略未知帧，行为回落到 v1
      try {
        this.writeFrame(socket, buildFrame(T_HELLO, 0, packHello()));
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
      }
      this.emit('state', this.state());
    });

    socket.on('data', (chunk) => this.onData(chunk));

    socket.on('error', (err) => {
      this.lastError = err.message;
    });

    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.emit('state', this.state());
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.opts.reconnectMs);
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.rxBytes += chunk.length;
    // 抓包必须在解析前：解析失败/丢帧的原始字节同样值得留档
    this.tap('rx', chunk);
    let frames;
    try {
      frames = this.parser.feed(chunk);
    } catch (err) {
      this.reportDecodeError(err);
      return;
    }

    for (const frame of frames) {
      if (frame.type === T_STATUS) {
        try {
          const st: Status = unpackStatus(frame.payload);
          this.statusCount++;
          this.emit('status', st);
        } catch (err) {
          this.reportDecodeError(err);
        }
      } else if (frame.type === T_SCAN || frame.type === T_SCAN2) {
        try {
          const scan: ScanFrame =
            frame.type === T_SCAN2 ? unpackScan2(frame.payload) : unpackScan(frame.payload);
          this.scanCount++;
          const received: ReceivedScan = { scan, recvMs: Date.now() };
          this.emit('scan', received);
        } catch (err) {
          this.reportDecodeError(err);
        }
      } else if (frame.type === T_PONG) {
        try {
          const pong = unpackPong(frame.payload);
          // 只认自己最近发出的那一次，避免乱序响应污染统计
          if (this.pendingPing && pong.t1Ms === this.pendingPing.t1) {
            this.pendingPing = null;
            this.pushSample(computeRtt(pong, Date.now()));
            this.emitState();
          }
        } catch (err) {
          this.reportDecodeError(err);
        }
      } else if (frame.type === T_TIME_SYNC_RESULT) {
        try {
          this.emit('timesync', unpackTimeSyncResult(frame.payload));
        } catch (err) {
          this.reportDecodeError(err);
        }
      } else if (frame.type === T_HELLO_ACK) {
        try {
          this.hello = unpackHelloAck(frame.payload);
          this.emit('hello', this.hello);
          this.emitState();
        } catch (err) {
          this.reportDecodeError(err);
        }
      } else if (process.env.USV_DEBUG) {
        console.warn(`[link] 未知帧类型 0x${frame.type.toString(16)} len=${frame.payload.length}`);
      }
    }
  }

  private reportDecodeError(err: unknown): void {
    this.decodeErrors++;
    this.emit('decode-error', err);
    const text = err instanceof Error ? err.message : String(err);
    // 解码失败必须留痕：没有监听者时也要能看到（否则表现为「扫描突然没了」）
    console.warn(`[link] 解码失败 #${this.decodeErrors}: ${text}`);
  }

  private startScheduler(): void {
    const periodMs = 1000 / this.opts.rateHz;
    const periodNs = BigInt(Math.round(1e9 / this.opts.rateHz));
    let nextAt = process.hrtime.bigint() + periodNs;

    const loop = () => {
      if (this.stopped) return;
      try {
        this.sendOnce();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error('[link] 发送异常', err);
      }

      // 无论发送成败都要续上下一拍，否则节拍链会永久中断
      const now = process.hrtime.bigint();
      nextAt += periodNs;
      if (nextAt <= now) nextAt = now + periodNs;

      const delayMs = Math.max(0, Number(nextAt - now) / 1e6);
      this.timer = setTimeout(loop, Math.min(delayMs, periodMs * 4));
    };

    this.timer = setTimeout(loop, periodMs);
  }

  private sendOnce(): void {
    const socket = this.socket;
    if (!socket || !this.connected || socket.destroyed) return;

    const cmd = this.opts.getCommand();
    const frame = buildFrame(T_CMD, this.seq++, packCmd(cmd.throttleX10, cmd.servosX10, cmd.flags));
    try {
      this.writeFrame(socket, frame);
      this.txCount++;
      this.emit('cmd', cmd);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
