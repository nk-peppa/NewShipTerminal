import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { AlgoHealthView, MapView, PoseView } from '../../shared/api.js';
import type { ScanFrame } from '../../shared/protocol.js';

export interface AlgoOptions {
  python: string;
  script: string;
  cwd?: string;
}

/**
 * Python 算法进程（SLAM / 视觉 / 规划）的宿主。
 * v0 契约：stdin/stdout 逐行 JSON；
 *   → {"type":"scan", t, angles:[rad], ranges:[m], qualities:[u8]}
 *   ← {"type":"pose", t, x, y, yaw, status, covariance}
 * 算法崩溃只影响本进程，不影响控制链路。
 */
export class AlgoSidecar extends EventEmitter {
  private child: ChildProcess | null = null;
  private stdoutBuf = '';
  private restarts = 0;
  private scansSent = 0;
  private lastPoseAt = 0;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: AlgoOptions) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.spawnChild();
    this.healthTimer = setInterval(() => this.emit('health', this.health()), 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.restartTimer = this.healthTimer = null;
    this.child?.kill();
    this.child = null;
  }

  /** 清空 SLAM 状态：侧车重建实例，回到 INITIALIZED 之前的空白状态 */
  reset(): void {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ type: 'reset' })}\n`);
    this.lastPoseAt = 0;
  }

  health(): AlgoHealthView {
    return {
      running: this.child !== null,
      restarts: this.restarts,
      lastPoseAgoMs: this.lastPoseAt ? Date.now() - this.lastPoseAt : null,
      scansSent: this.scansSent,
    };
  }

  pushScan(scan: ScanFrame): void {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return;

    const payload = {
      type: 'scan',
      t: scan.timeMs,
      // SCAN2 的圈起始时刻用于时间戳单调化与后续去畸变
      tStart: 'tStartMs' in scan ? (scan as { tStartMs?: number }).tStartMs : undefined,
      angles: roundArray(scan.anglesRad, 4),
      ranges: roundArray(scan.rangesM, 3),
      qualities: Array.from(scan.qualities),
    };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    this.scansSent++;
  }

  private spawnChild(): void {
    const child = spawn(this.opts.python, [this.opts.script], {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stdoutBuf = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.emit('log', chunk));

    child.on('error', (err) => {
      this.emit('log', `[algo] spawn 失败: ${err.message}`);
      this.child = null;
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopped) return;
      this.restarts++;
      this.emit('log', `[algo] 退出 code=${code} signal=${signal}，2 秒后重启`);
      this.restartTimer = setTimeout(() => this.spawnChild(), 2000);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (;;) {
      const idx = this.stdoutBuf.indexOf('\n');
      if (idx < 0) break;
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === 'pose') {
          this.lastPoseAt = Date.now();
          this.emit('pose', msg as unknown as PoseView);
        } else if (msg.type === 'map') {
          this.emit('map', { t: Date.now(), ...msg } as unknown as MapView);
        } else if (msg.type === 'error') {
          this.emit('log', `[algo] ${String(msg.message ?? '未知错误')}`);
        } else if (msg.type === 'pong' || msg.type === 'ready') {
          this.emit('log', `[algo] ${line.slice(0, 200)}`);
        }
      } catch {
        this.emit('log', `[algo] 非法输出: ${line.slice(0, 200)}`);
      }
    }
  }
}

function roundArray(src: Float32Array, digits: number): number[] {
  const k = 10 ** digits;
  const out = new Array<number>(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.round((src[i] ?? 0) * k) / k;
  return out;
}
