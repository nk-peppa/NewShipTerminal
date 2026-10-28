/*
 * USV Edge 协议 v1（TCP 二进制帧）
 *
 *   帧: AA 55 | ver(u8) | type(u8) | seq(u16) | len(u16) | payload | crc16(u16)
 *   CRC16-CCITT-FALSE (poly=0x1021, init=0xFFFF)，覆盖 ver..payload，小端
 *
 * 与船端 usv/protocol.py 一致；黄金帧见 test/protocol.test.ts。
 */

import zlib from 'node:zlib';

export const FRAME_HEADER = Buffer.from([0xaa, 0x55]);
export const PROTO_VER = 0x01;

export const T_CMD = 0x01;
export const T_HELLO = 0x03;
export const T_PING = 0x04;
export const T_TIME_SYNC = 0x05;
export const T_STATUS = 0x81;
export const T_SCAN = 0x82;
export const T_HELLO_ACK = 0x83;
export const T_PONG = 0x84;
export const T_SCAN2 = 0x85;
export const T_TIME_SYNC_RESULT = 0x86;

export const T_OTA_BEGIN = 0x11;
export const T_OTA_DATA = 0x12;
export const T_OTA_COMMIT = 0x13;
export const T_OTA_ABORT = 0x14;
export const T_OTA_ACK = 0x91;
export const T_OTA_PROGRESS = 0x92;
export const T_OTA_RESULT = 0x93;

export const CAP_SCAN2 = 1 << 0;
export const CAP_OTA = 1 << 1;
export const CAP_SELFTEST = 1 << 4;
/** 船端 systemd 启动失败回滚看门狗已装（OnFailure + rollback.sh） */
export const CAP_WATCHDOG = 1 << 5;

export const CMD_FLAG_ARM = 0x01;
export const CMD_FLAG_ESTOP = 0x02;

export const ST_ARMED = 1 << 0;
export const ST_ESTOP = 1 << 1;
export const ST_FAILSAFE = 1 << 2;
export const ST_LIDAR_OK = 1 << 3;
export const ST_ARM_REQUIRED = 1 << 4;
/** 船端系统时间与 NTP 偏差超过阈值 → 应引导用户校时 */
export const ST_TIME_BAD = 1 << 5;

export const MAX_PAYLOAD = 8192;

export const CMD_LEN = 12;
export const STATUS_LEN = 26;

export function crc16(data: Buffer, crc = 0xffff): number {
  let c = crc;
  for (let i = 0; i < data.length; i++) {
    c ^= (data[i] ?? 0) << 8;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
  }
  return c;
}

export function buildFrame(type: number, seq: number, payload: Buffer): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`载荷过大: ${payload.length} > ${MAX_PAYLOAD}`);
  }
  const body = Buffer.alloc(6 + payload.length);
  body.writeUInt8(PROTO_VER, 0);
  body.writeUInt8(type & 0xff, 1);
  body.writeUInt16LE(seq & 0xffff, 2);
  body.writeUInt16LE(payload.length, 4);
  payload.copy(body, 6);

  const frame = Buffer.alloc(2 + body.length + 2);
  FRAME_HEADER.copy(frame, 0);
  body.copy(frame, 2);
  frame.writeUInt16LE(crc16(body), 2 + body.length);
  return frame;
}

/* ---------------- CMD ---------------- */

/** CMD 载荷：throttle i16(0.1%) + 4×servo i16(0.1°) + flags u8 + rsv u8 */
export function packCmd(throttleX10: number, servosX10: readonly number[], flags: number): Buffer {
  const p = Buffer.alloc(CMD_LEN);
  p.writeInt16LE(clampI16(throttleX10), 0);
  for (let i = 0; i < 4; i++) p.writeInt16LE(clampI16(servosX10[i] ?? 0), 2 + i * 2);
  p.writeUInt8(flags & 0xff, 10);
  p.writeUInt8(0, 11);
  return p;
}

function clampI16(v: number): number {
  const n = Math.round(Number.isFinite(v) ? v : 0);
  return Math.max(-32768, Math.min(32767, n));
}

/* ---------------- STATUS ---------------- */

export interface Status {
  timeMs: number;
  throttleX10: number;
  direction: number;
  servosX10: [number, number, number, number];
  flags: number;
  rxSeq: number;
  rxErrors: number;
  pointsLast: number;
  scansTotal: number;
  loopHzX10: number;
}

export function unpackStatus(payload: Buffer): Status {
  if (payload.length !== STATUS_LEN) {
    throw new Error(`STATUS 长度错误: ${payload.length}`);
  }
  return {
    timeMs: payload.readUInt32LE(0),
    throttleX10: payload.readInt16LE(4),
    direction: payload.readUInt8(6),
    servosX10: [
      payload.readInt16LE(7),
      payload.readInt16LE(9),
      payload.readInt16LE(11),
      payload.readInt16LE(13),
    ],
    flags: payload.readUInt8(15),
    rxSeq: payload.readUInt16LE(16),
    rxErrors: payload.readUInt16LE(18),
    pointsLast: payload.readUInt16LE(20),
    scansTotal: payload.readUInt16LE(22),
    loopHzX10: payload.readUInt16LE(24),
  };
}

/* ---------------- SCAN（领域对象 Scan2D） ---------------- */

export interface ScanFrame {
  /** 船端单调时钟，圈完成时刻 */
  timeMs: number;
  /** 原始编码：0=raw 1=zlib */
  encoding: number;
  count: number;
  /** C1 原始角度：0=正前，顺时针增大，单位 rad */
  anglesRad: Float32Array;
  /** 距离，单位 m（0 表示无效，船端通常已剔除） */
  rangesM: Float32Array;
  /** 信号质量，0..qualityMax */
  qualities: Uint8Array;
  qualityMax: number;
}

export function unpackScan(payload: Buffer): ScanFrame {
  if (payload.length < 8) throw new Error('SCAN 过短');
  const timeMs = payload.readUInt32LE(0);
  const count = payload.readUInt16LE(4);
  const encoding = payload.readUInt8(6);

  let data = payload.subarray(8);
  if (encoding === 1) data = zlib.inflateSync(data);
  else if (encoding !== 0) throw new Error(`未知 SCAN 编码 ${encoding}`);

  if (data.length < count * 5) {
    throw new Error(`SCAN 点数据不足: ${data.length} < ${count * 5}`);
  }

  const anglesRad = new Float32Array(count);
  const rangesM = new Float32Array(count);
  const qualities = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 5;
    anglesRad[i] = ((data.readUInt16LE(o) / 100) * Math.PI) / 180;
    rangesM[i] = data.readUInt16LE(o + 2) / 1000;
    qualities[i] = data.readUInt8(o + 4);
  }

  return { timeMs, encoding, count, anglesRad, rangesM, qualities, qualityMax: 255 };
}

/* ---------------- HELLO / SCAN2 ---------------- */

export interface HelloAck {
  proto: number;
  fw: [number, number, number];
  caps: number;
  uptimeS: number;
  hwId: string;
}

export function packHello(
  protoMax = 2,
  protoMin = 1,
  clientVer = 1,
  caps = CAP_SCAN2 | CAP_OTA,
): Buffer {
  const p = Buffer.alloc(10);
  p.writeUInt16LE(protoMax, 0);
  p.writeUInt16LE(protoMin, 2);
  p.writeUInt16LE(clientVer, 4);
  p.writeUInt32LE(caps, 6);
  return p;
}

export function unpackHelloAck(payload: Buffer): HelloAck {
  if (payload.length !== 26) throw new Error(`HELLO_ACK 长度错误: ${payload.length}`);
  const hw = payload.subarray(16, 24).toString('utf8').replace(/\0+$/, '');
  return {
    proto: payload.readUInt16LE(0),
    fw: [payload.readUInt16LE(2), payload.readUInt16LE(4), payload.readUInt16LE(6)],
    caps: payload.readUInt32LE(8),
    uptimeS: payload.readUInt32LE(12),
    hwId: hw,
  };
}

/** 船端/仿真器侧构造 HELLO_ACK（hwId 最长 8 字节，不足补 0） */
export function packHelloAck(ack: HelloAck): Buffer {
  const p = Buffer.alloc(26);
  p.writeUInt16LE(ack.proto, 0);
  p.writeUInt16LE(ack.fw[0], 2);
  p.writeUInt16LE(ack.fw[1], 4);
  p.writeUInt16LE(ack.fw[2], 6);
  p.writeUInt32LE(ack.caps >>> 0, 8);
  p.writeUInt32LE(ack.uptimeS >>> 0, 12);
  Buffer.from(ack.hwId, 'utf8').copy(p, 16, 0, 8);
  return p;
}

export interface Scan2Frame extends ScanFrame {
  tStartMs: number;
  scanSeq: number;
  originalCount: number;
  rateHz: number;
  decimated: boolean;
  lidarOk: boolean;
  tStartEstimated: boolean;
}

/** SCAN2 载荷：24 字节头 + 点数据（可 zlib） */
export function unpackScan2(payload: Buffer): Scan2Frame {
  if (payload.length < 24) throw new Error('SCAN2 过短');
  const count = payload.readUInt16LE(12);
  const encoding = payload.readUInt8(16);
  const flags = payload.readUInt8(17);

  let data = payload.subarray(24);
  if (encoding === 1) data = zlib.inflateSync(data);
  else if (encoding !== 0) throw new Error(`未知 SCAN2 编码 ${encoding}`);
  if (data.length < count * 5) throw new Error('SCAN2 点数据不足');

  const anglesRad = new Float32Array(count);
  const rangesM = new Float32Array(count);
  const qualities = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 5;
    anglesRad[i] = ((data.readUInt16LE(o) / 100) * Math.PI) / 180;
    rangesM[i] = data.readUInt16LE(o + 2) / 1000;
    qualities[i] = data.readUInt8(o + 4);
  }

  const qualityMax = payload.readUInt8(20) || 63;
  return {
    timeMs: payload.readUInt32LE(4),
    encoding,
    count,
    anglesRad,
    rangesM,
    qualities,
    qualityMax,
    tStartMs: payload.readUInt32LE(0),
    scanSeq: payload.readUInt32LE(8),
    originalCount: payload.readUInt16LE(14),
    rateHz: (payload.readUInt16LE(18) || 0) / 100,
    decimated: (flags & 0x02) !== 0,
    lidarOk: (flags & 0x01) !== 0,
    tStartEstimated: (flags & 0x04) !== 0,
  };
}

/* ---------------- 时钟同步（NTP 四时间戳法） ---------------- */

export const PING_LEN = 8;
export const PONG_LEN = 16;
export const TIME_SYNC_RESULT_LEN = 8;

/**
 * 一次往返采样。
 *
 *   T1 本地发出 → T2 船端收到 → T3 船端发出 → T4 本地收到
 *   delay  = (T4−T1) − (T3−T2)         纯网络往返
 *   offset = ((T2−T1) + (T3−T4)) / 2   船钟 − 本地钟
 *   上行   = offset + delay/2
 *   下行   = delay/2 − offset          （基于「上下行对称」假设）
 */
export interface RttSample {
  /** 网络往返（ms，已扣除船端处理时间） */
  delayMs: number;
  /** 船钟 − 本地钟（ms） */
  offsetMs: number;
  /** 上行（本地→船端）ms，对称假设下的分解 */
  upMs: number;
  /** 下行（船端→本地）ms */
  downMs: number;
}

export function packPing(t1Ms: number): Buffer {
  const p = Buffer.alloc(PING_LEN);
  p.writeBigUInt64LE(BigInt(Math.max(0, Math.round(t1Ms))), 0);
  return p;
}

export interface Pong {
  t1Ms: number;
  t2Ms: number;
  t3Ms: number;
}

export function unpackPong(payload: Buffer): Pong {
  if (payload.length < PONG_LEN) throw new Error(`PONG 过短: ${payload.length}`);
  return {
    t1Ms: Number(payload.readBigUInt64LE(0)),
    t2Ms: payload.readUInt32LE(8),
    t3Ms: payload.readUInt32LE(12),
  };
}

export interface TimeSyncResult {
  /** 0=成功 1=网络失败 2=设置时间失败 */
  status: number;
  /** 校时前本地时间与 NTP 的偏差（秒） */
  offsetSec: number;
  rttMs: number;
}

export function unpackTimeSyncResult(payload: Buffer): TimeSyncResult {
  if (payload.length < TIME_SYNC_RESULT_LEN) {
    throw new Error(`TIME_SYNC_RESULT 过短: ${payload.length}`);
  }
  return {
    status: payload.readUInt8(0),
    offsetSec: payload.readInt32LE(2),
    rttMs: payload.readUInt16LE(6),
  };
}

/**
 * 由一次收发算出延迟与时钟偏差。
 *
 * 注意两处容易踩的坑：
 *
 * 1. `t1/t4` 是**客户端 epoch 毫秒**，`t2/t3` 是**船端单调时钟**，两者基准不同。
 *    所以 `offsetMs` 是一个巨大的负数（约 -1.7e12），这是正常的——它就是
 *    「船钟 − 客户钟」的差值，可用来把船端时间戳换算到本地时间轴：
 *        localMs = shipMs - offsetMs
 *
 * 2. **单程延迟无法从一次往返中分离**（分布式系统的固有约束，NTP 也一样）。
 *    在「上下行对称」假设下只能各取 `delayMs / 2`；不对称带来的误差会体现在
 *    `offsetMs` 里，无法进一步分解。要真正分离需要硬件时间戳（PTP）。
 */
export function computeRtt(pong: Pong, t4Ms: number): RttSample {
  const delayMs = Math.max(0, t4Ms - pong.t1Ms - (pong.t3Ms - pong.t2Ms));
  const offsetMs = (pong.t2Ms - pong.t1Ms + (pong.t3Ms - t4Ms)) / 2;
  const half = delayMs / 2;
  return { delayMs, offsetMs, upMs: half, downMs: half };
}

/* ---------------- OTA ---------------- */

export const OTA_BEGIN_LEN = 110;

export function packOtaBegin(
  version: readonly [number, number, number],
  totalSize: number,
  sha256: Buffer,
  sig: Buffer,
  resumeOffset = 0,
): Buffer {
  const p = Buffer.alloc(OTA_BEGIN_LEN);
  p.writeUInt16LE(version[0], 0);
  p.writeUInt16LE(version[1], 2);
  p.writeUInt16LE(version[2], 4);
  p.writeUInt32LE(totalSize, 6);
  sha256.copy(p, 10, 0, 32);
  sig.copy(p, 42, 0, Math.min(64, sig.length));
  p.writeUInt32LE(resumeOffset, 106);
  return p;
}

export function packOtaData(offset: number, chunk: Buffer): Buffer {
  const p = Buffer.alloc(4 + chunk.length);
  p.writeUInt32LE(offset, 0);
  chunk.copy(p, 4);
  return p;
}

export interface OtaAck {
  status: number;
  offset: number;
}
export interface OtaProgressMsg {
  received: number;
  total: number;
  stage: number;
}
export interface OtaResultMsg {
  status: number;
  fw: [number, number, number];
  message: string;
}

export function unpackOtaAck(p: Buffer): OtaAck {
  if (p.length < 5) throw new Error('OTA_ACK 过短');
  return { status: p.readUInt8(0), offset: p.readUInt32LE(1) };
}

export function unpackOtaProgress(p: Buffer): OtaProgressMsg {
  if (p.length < 9) throw new Error('OTA_PROGRESS 过短');
  return {
    received: p.readUInt32LE(0),
    total: p.readUInt32LE(4),
    stage: p.readUInt8(8),
  };
}

export function unpackOtaResult(p: Buffer): OtaResultMsg {
  if (p.length < 70) throw new Error('OTA_RESULT 过短');
  return {
    status: p.readUInt8(0),
    fw: [p.readUInt16LE(1), p.readUInt16LE(3), p.readUInt16LE(5)],
    message: p.subarray(7, 71).toString('utf8').replace(/\0+$/, ''),
  };
}

/* ---------------- 增量解析器 ---------------- */

export interface ParsedFrame {
  ver: number;
  type: number;
  seq: number;
  payload: Buffer;
}

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  crcErrors = 0;

  feed(data: Buffer): ParsedFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : Buffer.from(data);
    const out: ParsedFrame[] = [];

    for (;;) {
      const idx = this.buf.indexOf(FRAME_HEADER);
      if (idx < 0) {
        const keep = this.buf.length > 0 && this.buf[this.buf.length - 1] === 0xaa ? 1 : 0;
        this.buf = this.buf.subarray(this.buf.length - keep);
        break;
      }
      if (idx > 0) this.buf = this.buf.subarray(idx);
      if (this.buf.length < 8) break;

      const ver = this.buf.readUInt8(2);
      const type = this.buf.readUInt8(3);
      const seq = this.buf.readUInt16LE(4);
      const plen = this.buf.readUInt16LE(6);
      if (plen > MAX_PAYLOAD) {
        this.buf = this.buf.subarray(2);
        continue;
      }
      const total = 8 + plen + 2;
      if (this.buf.length < total) break;

      const bodyEnd = 8 + plen;
      const crcRx = this.buf.readUInt16LE(bodyEnd);
      if (crcRx !== crc16(this.buf.subarray(2, bodyEnd))) {
        this.crcErrors++;
        this.buf = this.buf.subarray(2);
        continue;
      }
      out.push({ ver, type, seq, payload: Buffer.from(this.buf.subarray(8, bodyEnd)) });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}
