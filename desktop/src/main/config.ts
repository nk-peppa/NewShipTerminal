import path from 'node:path';
import { app } from 'electron';

export interface AppConfig {
  ship: { host: string | null; port: number };
  /** OTA 端口（新固件默认 9530） */
  ota: { port: number };
  link: { rateHz: number; reconnectMs: number; statusUiHz: number };
  control: { maxThrottlePct: number; rudderMaxDeg: number; uiTimeoutMs: number; deadband: number };
  discovery: { enabled: boolean; udpPort: number; probeIntervalMs: number; ttlMs: number };
  algo: { enabled: boolean; python: string; script: string };
  ui: { window: boolean };
  log: { enabled: boolean; dir: string | null; keep: number; rawPartMiB: number };
  /** 地图与实验数据：默认与日志同一父目录 */
  storage: { mapsDir: string; experimentsDir: string };
}

function argOf(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

export function loadConfig(argv: string[] = process.argv.slice(1)): AppConfig {
  const host = argOf(argv, '--host');
  const port = Number(argOf(argv, '--port') ?? 0);
  const algoScript =
    argOf(argv, '--algo-script') ?? path.join(__dirname, '..', '..', 'tools', 'algo-sidecar.py');

  const otaPort = Number(argOf(argv, '--ota-port') ?? 0);
  const logKeep = Number(argOf(argv, '--log-keep') ?? 0);
  const logDir = argOf(argv, '--log-dir');
  // 地图/实验默认与日志同父目录；日志路径不传时用 Electron 的 userData/logs。
  // app.getPath('userData') 在 whenReady 之前也可用。
  const logParent = path.dirname(path.resolve(logDir ?? path.join(app.getPath('userData'), 'logs')));
  const mapsDir = argOf(argv, '--maps-dir') ?? path.join(logParent, 'maps');
  const experimentsDir = argOf(argv, '--experiments-dir') ?? path.join(logParent, 'experiments');

  return {
    ship: { host, port: port > 0 ? port : 9527 },
    ota: { port: otaPort > 0 ? otaPort : 9530 },
    link: { rateHz: 50, reconnectMs: 2000, statusUiHz: 20 },
    control: { maxThrottlePct: 60, rudderMaxDeg: 30, uiTimeoutMs: 500, deadband: 0.08 },
    discovery: {
      enabled: !argv.includes('--no-discovery') && !host,
      udpPort: Number(argOf(argv, '--udp-port') ?? 9528),
      probeIntervalMs: 2500,
      ttlMs: 6000,
    },
    algo: {
      enabled: !argv.includes('--no-algo'),
      python: argOf(argv, '--python') ?? 'python',
      script: algoScript,
    },
    ui: { window: !argv.includes('--no-window') },
    log: {
      enabled: !argv.includes('--no-log'),
      dir: logDir,
      // 实船一次实验 ≤10 分钟、单次约 15MB，留 20 次 ≈ 300MB
      keep: logKeep > 0 ? Math.floor(logKeep) : 20,
      rawPartMiB: 128,
    },
    storage: { mapsDir, experimentsDir },
  };
}
