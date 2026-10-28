/*
 * OTA 客户端（TCP 9530）。
 *
 * 流程：读取包 → sha256 → OTA_BEGIN → 分块 OTA_DATA → OTA_COMMIT → 等 OTA_RESULT。
 * 服务端在偏移不一致时会回 ACK(offset)，这里据此续传。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

import {
  buildFrame,
  FrameParser,
  packHello,
  packOtaBegin,
  packOtaData,
  T_CMD,
  T_HELLO_ACK,
  T_OTA_ACK,
  T_OTA_BEGIN,
  T_OTA_COMMIT,
  T_OTA_DATA,
  T_OTA_PROGRESS,
  T_OTA_RESULT,
  unpackHelloAck,
  unpackOtaAck,
  unpackOtaProgress,
  unpackOtaResult,
  type HelloAck,
  type OtaAck,
  type OtaProgressMsg,
  type OtaResultMsg,
} from '../../shared/protocol.js';

export type OtaPhase =
  | 'hashing'
  | 'connecting'
  | 'begin'
  | 'sending'
  | 'verifying'
  | 'installing'
  | 'done'
  | 'error';

export interface OtaEvent {
  phase: OtaPhase;
  received: number;
  total: number;
  /** 设备上报阶段：1=校验 2=解包 4=切换 5=完成 */
  stage?: number;
  message?: string;
}

export interface OtaOptions {
  host: string;
  port: number;
  file: string;
  chunkSize?: number;
  onEvent?: (e: OtaEvent) => void;
}

export interface OtaOutcome {
  ok: boolean;
  status: number;
  message: string;
  version: [number, number, number];
}

const STAGE_TEXT: Record<number, OtaPhase> = {
  1: 'verifying',
  2: 'installing',
  4: 'installing',
  5: 'done',
};

/** 从文件名解析版本：usv-edge-0.2.0-aarch64.tar.gz */
export function versionFromFilename(file: string): [number, number, number] | null {
  const m = /usv-edge-(\d+)\.(\d+)\.(\d+)/.exec(file);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

class Inbox {
  private acks: Buffer[] = [];
  private results: Buffer[] = [];
  private progresses: Buffer[] = [];
  private ackWaiters: Array<(v: OtaAck) => void> = [];
  private resultWaiters: Array<(v: OtaResultMsg) => void> = [];

  pushAck(p: Buffer): void {
    const parsed = unpackOtaAck(p);
    const w = this.ackWaiters.shift();
    if (w) w(parsed);
    else this.acks.push(p);
  }
  pushResult(p: Buffer): void {
    const parsed = unpackOtaResult(p);
    const w = this.resultWaiters.shift();
    if (w) w(parsed);
    else this.results.push(p);
  }
  pushProgress(p: Buffer): void {
    this.progresses.push(p);
  }

  takeProgress(): OtaProgressMsg | null {
    const p = this.progresses.shift();
    return p ? unpackOtaProgress(p) : null;
  }

  nextAck(timeoutMs = 10_000): Promise<OtaAck> {
    const ready = this.acks.shift();
    if (ready) return Promise.resolve(unpackOtaAck(ready));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 OTA_ACK 超时')), timeoutMs);
      this.ackWaiters.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  nextResult(timeoutMs = 180_000): Promise<OtaResultMsg> {
    const ready = this.results.shift();
    if (ready) return Promise.resolve(unpackOtaResult(ready));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 OTA_RESULT 超时')), timeoutMs);
      this.resultWaiters.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }
}

/** 连接控制端口发 HELLO，读回固件版本（用于「升级前后」对比） */
export function probeFirmware(host: string, port: number, timeoutMs = 2000): Promise<HelloAck> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const parser = new FrameParser();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('HELLO 超时'));
    }, timeoutMs);

    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.write(buildFrame(0x03, 0, packHello()));
    });
    socket.on('data', (chunk) => {
      for (const f of parser.feed(chunk)) {
        if (f.type === T_HELLO_ACK) {
          clearTimeout(timer);
          socket.destroy();
          try {
            resolve(unpackHelloAck(f.payload));
          } catch (e) {
            reject(e);
          }
        }
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export async function runOta(opts: OtaOptions): Promise<OtaOutcome> {
  const emit = (e: OtaEvent) => opts.onEvent?.(e);
  // 帧 payload 是 u16，且设备侧上限 8192；减去 4 字节 offset 后取 4KB 更稳
  const chunkSize = Math.min(opts.chunkSize ?? 4096, 8188);

  const version = versionFromFilename(opts.file);
  if (!version) {
    const message = '文件名需包含版本号，例如 usv-edge-0.2.1-aarch64.tar.gz';
    emit({ phase: 'error', received: 0, total: 0, message });
    return { ok: false, status: -1, message, version: [0, 0, 0] };
  }

  const buf = await fs.promises.readFile(opts.file);
  const total = buf.length;
  emit({ phase: 'hashing', received: 0, total });
  const sha256 = crypto.createHash('sha256').update(buf).digest();

  emit({ phase: 'connecting', received: 0, total });
  const socket = net.createConnection({ host: opts.host, port: opts.port });
  socket.setNoDelay(true);

  const inbox = new Inbox();
  const parser = new FrameParser();
  let closed = false;

  socket.on('data', (chunk) => {
    for (const f of parser.feed(chunk)) {
      if (f.type === T_OTA_ACK) inbox.pushAck(f.payload);
      else if (f.type === T_OTA_RESULT) inbox.pushResult(f.payload);
      else if (f.type === T_OTA_PROGRESS) inbox.pushProgress(f.payload);
      else if (f.type === T_CMD) {
        /* OTA 端口不应出现控制帧，忽略 */
      }
    }
  });
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => {
    closed = true;
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  let seq = 0;
  const send = (type: number, payload: Buffer) => {
    if (closed) throw new Error('连接已断开');
    socket.write(buildFrame(type, seq++, payload));
  };

  try {
    // BEGIN：签名位留空（内网 allow_unsigned）
    emit({ phase: 'begin', received: 0, total });
    send(T_OTA_BEGIN, packOtaBegin(version, total, sha256, Buffer.alloc(64), 0));
    const ack0 = await inbox.nextAck();
    if (ack0.status !== 0) {
      const message = `设备拒绝升级: status=${ack0.status}`;
      emit({ phase: 'error', received: 0, total, message });
      return { ok: false, status: ack0.status, message, version };
    }

    let offset = Math.min(ack0.offset, total);
    while (offset < total) {
      const end = Math.min(offset + chunkSize, total);
      send(T_OTA_DATA, packOtaData(offset, buf.subarray(offset, end)));
      offset = end;

      for (let p = inbox.takeProgress(); p; p = inbox.takeProgress()) {
        emit({
          phase: STAGE_TEXT[p.stage] ?? 'sending',
          received: p.received,
          total: p.total || total,
          stage: p.stage,
        });
      }
      emit({ phase: 'sending', received: offset, total });
      if (offset % (chunkSize * 8) === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }

    emit({ phase: 'verifying', received: total, total });
    send(T_OTA_COMMIT, Buffer.alloc(0));
    const result = await inbox.nextResult();
    const phase: OtaPhase = result.status === 0 ? 'done' : 'error';
    emit({ phase, received: total, total, message: result.message });
    socket.destroy();
    return {
      ok: result.status === 0,
      status: result.status,
      message: result.message,
      version: result.fw,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ phase: 'error', received: 0, total, message });
    socket.destroy();
    return { ok: false, status: -1, message, version };
  }
}
