import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { AlgoHealthView, MapView, PoseView } from '../../shared/api.js';
import type { ScanFrame } from '../../shared/protocol.js';

export interface AlgoOptions {
  python: string;
  script: string;
  cwd?: string;
}

export type AlgoMode = 'mapping' | 'localization';

/**
 * Python 算法进程（SLAM / 定位）的宿主。
 * v3 契约：stdin/stdout 逐行 JSON；
 *   → {"type":"scan", t, angles:[rad], ranges:[m], qualities:[u8]}
 *   → {"type":"load_map","path":...} / {"type":"set_initial_pose",x,y,yaw}
 *   → {"type":"clear_pose"} / {"type":"unload_map"}
 *   ← {"type":"pose", mode, phase, x, y, yaw, ...}
 *   ← {"type":"map_loaded", ok, ...} / {"type":"localization", phase, ...}
 * 算法崩溃只影响本进程，不影响控制链路。侧车重启后自动重发地图与初始位姿。
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
  private mode: AlgoMode = 'mapping';
  private mapPath: string | null = null;
  private initialPose: { x: number; y: number; yaw: number } | null = null;
  private api: number | null = null;

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

  /** 清空：建图模式重建 SLAM；定位模式清位姿、重新全局定位 */
  reset(): void {
    if (this.mode === 'localization') {
      this.clearPose();
      return;
    }
    this.send({ type: 'reset' });
    this.lastPoseAt = 0;
  }

  /** 进入定位模式：加载 map.yaml（先验地图） */
  loadMap(yamlPath: string): void {
    this.mode = 'localization';
    this.mapPath = yamlPath;
    this.initialPose = null;
    this.send({ type: 'load_map', path: yamlPath });
  }

  setInitialPose(x: number, y: number, yaw: number): void {
    this.initialPose = { x, y, yaw };
    this.send({ type: 'set_initial_pose', x, y, yaw });
  }

  clearPose(): void {
    this.initialPose = null;
    this.send({ type: 'clear_pose' });
  }

  unloadMap(): void {
    this.mode = 'mapping';
    this.mapPath = null;
    this.initialPose = null;
    this.send({ type: 'unload_map' });
  }

  get currentMode(): AlgoMode {
    return this.mode;
  }

  get loadedMap(): string | null {
    return this.mapPath;
  }

  health(): AlgoHealthView {
    return {
      running: this.child !== null,
      restarts: this.restarts,
      lastPoseAgoMs: this.lastPoseAt ? Date.now() - this.lastPoseAt : null,
      scansSent: this.scansSent,
      mode: this.mode,
      mapLoaded: this.mapPath !== null,
      api: this.api,
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

  private send(msg: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private spawnChild(): void {
    const child = spawn(this.opts.python, [this.opts.script], {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stdoutBuf = '';
    this.api = null;

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

  /** 侧车重启后恢复定位状态：重发地图与初始位姿（stdin 保序，无需延时） */
  private resync(): void {
    if (this.mapPath) {
      this.send({ type: 'load_map', path: this.mapPath });
      if (this.initialPose) {
        this.send({ type: 'set_initial_pose', ...this.initialPose });
      }
      this.emit('log', '[algo] 已重发地图与初始位姿');
    }
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
        } else if (msg.type === 'map_loaded') {
          this.emit('map-loaded', msg);
        } else if (msg.type === 'map_unloaded') {
          this.emit('map-unloaded', msg);
        } else if (msg.type === 'localization') {
          this.emit('localization', msg);
        } else if (msg.type === 'error') {
          this.emit('log', `[algo] ${String(msg.message ?? '未知错误')}`);
        } else if (msg.type === 'ready') {
          this.api = typeof msg.api === 'number' ? msg.api : null;
          this.emit('ready', msg);
          this.resync();
          this.emit('log', `[algo] ready api=${String(msg.api)}`);
        } else if (msg.type === 'pong') {
          /* 心跳回执，不影响 UI */
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
