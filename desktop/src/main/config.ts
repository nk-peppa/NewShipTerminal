import path from 'node:path';

export interface AppConfig {
  ship: { host: string | null; port: number };
  /** OTA 端口（新固件默认 9530） */
  ota: { port: number };
  link: { rateHz: number; reconnectMs: number; statusUiHz: number };
  control: { maxThrottlePct: number; rudderMaxDeg: number; uiTimeoutMs: number; deadband: number };
  discovery: { enabled: boolean; udpPort: number; probeIntervalMs: number; ttlMs: number };
  algo: { enabled: boolean; python: string; script: string };
  ui: { window: boolean };
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
  };
}
