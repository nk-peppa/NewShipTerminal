import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';

import type { ShipView } from '../shared/api.js';
import { AlgoSidecar } from './algo/sidecar.js';
import { loadConfig } from './config.js';
import { attachIpc } from './ipc/bridge.js';
import { ShipDiscovery } from './link/discovery.js';
import { TcpLink, type ReceivedScan } from './link/tcpLink.js';
import { SessionLogger } from './log/sessionLog.js';
import { SafetySupervisor } from './safety/supervisor.js';

const cfg = loadConfig();

const safety = new SafetySupervisor(cfg.control);

const link = new TcpLink({
  host: cfg.ship.host ?? '127.0.0.1',
  port: cfg.ship.port,
  rateHz: cfg.link.rateHz,
  reconnectMs: cfg.link.reconnectMs,
  getCommand: () => safety.tick(),
});

const discovery = cfg.discovery.enabled
  ? new ShipDiscovery({
      udpPort: cfg.discovery.udpPort,
      probeIntervalMs: cfg.discovery.probeIntervalMs,
      ttlMs: cfg.discovery.ttlMs,
    })
  : null;

const algo = cfg.algo.enabled
  ? new AlgoSidecar({
      python: cfg.algo.python,
      script: cfg.algo.script,
      cwd: path.dirname(cfg.algo.script),
    })
  : null;

let win: BrowserWindow | null = null;
let quitting = false;
let logger: SessionLogger | null = null;
let logError: string | null = null;

function readBuildInfo(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 把链路/算法事件接进会话日志：原始字节 + 解码后的 CSV/事件 */
function attachSessionLog(lg: SessionLogger): void {
  link.setWireTap((dir, data, atMs) => lg.wire(dir, data, atMs));
  link.on('status', (st) => lg.status(st));
  link.on('cmd', (cmd) => lg.command(cmd));
  link.on('scan', ({ scan, recvMs }: ReceivedScan) => lg.scan(scan, recvMs));
  link.on('state', (state) => lg.event('info', 'link-state', { ...state }));
  link.on('hello', (hello) => lg.event('info', 'hello', { ...hello }));
  link.on('timesync', (result) => lg.event('info', 'timesync', { ...result }));
  link.on('decode-error', (err) =>
    lg.warn('decode-error', { message: err instanceof Error ? err.message : String(err) }),
  );

  discovery?.on('ships', (ships: ShipView[]) =>
    lg.event('info', 'ships', {
      ships: ships.map((s) => ({
        name: s.name,
        sn: s.sn,
        host: s.host,
        tcpPort: s.tcpPort,
        state: s.state,
        lidar: s.lidar,
        armed: s.armed,
        estop: s.estop,
        failsafe: s.failsafe,
        hz: s.hz,
      })),
    }),
  );

  algo?.on('pose', (pose) => lg.pose(pose));
  algo?.on('health', (h) => lg.event('info', 'algo-health', { ...h }));
  algo?.on('log', (line: string) =>
    lg.event('info', 'algo-log', { line: line.length > 2000 ? `${line.slice(0, 2000)}…` : line }),
  );
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1280,
    height: 720,
    // 最低 720p；配合下方 setAspectRatio 保证窗口始终 16:9
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#05080c',
    title: 'USV Terminal',
    // 去掉标题栏与菜单栏，只留右上角三个系统按钮（Windows 的 titleBarOverlay）
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0e151d',
      symbolColor: '#9fb0c4',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 窗口被遮挡/最小化时 Chromium 会把 rAF 降到 ~1Hz，30Hz 指令心跳随之断流，
      // Supervisor 的 500ms UI 超时会误判为「UI 卡死」而撤防停车。操作员只是
      // 切了个窗口而已，因此关闭后台节流。安全兜底仍由摇杆回中、ESTOP 与船端
      // 300ms 看门狗负责。
      backgroundThrottling: false,
    },
  });
  // 锁死 16:9（用户拖边框时按比例缩放；最大化/贴边由系统处理）
  created.setAspectRatio(16 / 9);
  created.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 渲染进程故障始终留档，不能只在调试开关下才可见
  created.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[ui] 加载失败 ${code} ${desc} ${url}`);
    logger?.error('renderer-load-failed', { code, description: desc, url });
  });
  created.webContents.on('preload-error', (_e, file, err) => {
    console.error(`[ui] preload 失败 ${file}: ${err.message}`);
    logger?.error('preload-error', { file, message: err.message });
  });
  created.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[ui] 渲染进程退出: ${details.reason}`);
    logger?.error('renderer-gone', { reason: details.reason, exitCode: details.exitCode });
  });

  if (process.env.USV_DEBUG) {
    created.webContents.on('did-finish-load', () => {
      console.log('[ui] 渲染进程已加载');
      const shot = process.env.USV_SHOT;
      if (shot) {
        const delayMs = Number(process.env.USV_SHOT_DELAY ?? 2500);
        setTimeout(() => {
          void created.webContents.capturePage().then(async (img) => {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(shot, img.toPNG());
            console.log(`[ui] 截图已保存 ${shot}（延迟 ${delayMs}ms）`);
          });
        }, delayMs);
      }

      // 自检钩子：USV_CLICK=<selector>[,delayMs] 定时点击某元素（仅调试用）
      const clickSpec = process.env.USV_CLICK;
      if (clickSpec) {
        const [selector, delay = '3000'] = clickSpec.split(',');
        setTimeout(() => {
          void created.webContents
            .executeJavaScript(
              `(() => { const e = document.querySelector(${JSON.stringify(selector)});
                        if (!e) return 'not-found';
                        e.click(); return 'clicked'; })()`,
            )
            .then((r) => console.log(`[ui] 点击 ${selector} → ${r}`))
            .catch((e) => console.error('[ui] 点击失败', e.message));
        }, Number(delay));
      }

      void created.webContents
        .executeJavaScript(
          `JSON.stringify({
             viewport: [window.innerWidth, window.innerHeight],
             bodyScroll: document.body.scrollWidth,
             main: (() => { const m = document.querySelector('main'); return m ? [m.clientWidth, m.scrollWidth] : null; })(),
             cols: [...document.querySelectorAll('main > section')].map((s) => Math.round(s.getBoundingClientRect().width)),
             dpr: window.devicePixelRatio,
           })`,
        )
        .then((r) => console.log('[ui] 布局', r))
        .catch((e) => console.error('[ui] 布局检测失败', e.message));
    });
  }

  created.on('closed', () => {
    win = null;
  });
  return created;
}

app.whenReady().then(() => {
  // 去掉原生菜单栏（File / Edit / View …）
  Menu.setApplicationMenu(null);

  if (cfg.log.enabled) {
    try {
      logger = new SessionLogger({
        baseDir: cfg.log.dir ?? path.join(app.getPath('userData'), 'logs'),
        keepSessions: cfg.log.keep,
        rawPartBytes: cfg.log.rawPartMiB > 0 ? cfg.log.rawPartMiB * 1024 * 1024 : 0,
        meta: {
          app: {
            name: app.getName(),
            version: app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            locale: app.getLocale(),
          },
          cwd: process.cwd(),
          argv: process.argv.slice(1),
          config: cfg,
          build: readBuildInfo(),
        },
      });
      attachSessionLog(logger);
      logger.event('info', 'app-start', { argv: process.argv.slice(1) });
      console.log(`[log] 会话日志 → ${logger.dir}`);
    } catch (err) {
      console.error('[log] 初始化失败，本次不记录', err);
      logError = err instanceof Error ? err.message : String(err);
      logger = null;
    }
  }

  if (cfg.ui.window) {
    win = createWindow();
    attachIpc(win, { cfg, link, safety, discovery, algo, log: logger, logError });
  }

  if (discovery) {
    discovery.on('error', (err: Error) => {
      console.warn(`[discovery] ${err.message}`);
      logger?.warn('discovery-error', { message: err.message });
    });
    discovery.on('ships', (ships: ShipView[]) => {
      if (cfg.ship.host) return;
      const primary = ships.find((s) => !s.armed) ?? ships[0];
      if (primary) link.setTarget(primary.host, primary.tcpPort);
    });
    discovery.start();
  }

  link.start();
  algo?.start();

  console.log(
    `[main] 启动完成: ship=${cfg.ship.host ?? '自动发现'}:${cfg.ship.port} ` +
      `rate=${cfg.link.rateHz}Hz algo=${cfg.algo.enabled ? 'on' : 'off'}`,
  );

  if (process.env.USV_DEBUG) {
    setInterval(() => {
      const s = link.state();
      console.log(
        `[link] connected=${s.connected} tx=${s.txHz}Hz rxStatus=${s.rxStatusHz}Hz ` +
          `rxScan=${s.rxScanHz}Hz bytes=${s.rxBytesPerSec}B/s ` +
          `crc=${s.crcErrors} decode=${s.decodeErrors} err=${s.lastError ?? '-'}`,
      );
    }, 1000);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;

  // 退出前保持连接 600ms，连续下发「未解锁 + 油门 0 + 舵回中」安全帧
  safety.setEstop(false);
  safety.setArm(false);
  safety.forceZero();

  setTimeout(() => {
    link.stop();
    discovery?.stop();
    algo?.stop();
    logger?.close('quit');
    app.quit();
  }, 600);
});

let crashing = false;

/**
 * 未捕获异常之后不能只记一笔就继续跑：此时进程状态可能已经不一致，
 * 而 50Hz 控制环还在往船上发指令。先撤防归零，再走正常退出流程
 * （before-quit 会保持连接 600ms 连发安全帧），2 秒没退就强退。
 */
function crashShutdown(kind: string, err: unknown): void {
  if (crashing) {
    process.exit(1);
  }
  crashing = true;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[main] ${kind}，安全停车后退出`, err);
  logger?.error(kind, { message, stack });

  safety.setArm(false);
  safety.setEstop(false);
  safety.forceZero();
  setTimeout(() => process.exit(1), 2000);
  if (app.isReady()) app.quit();
  else process.exit(1);
}

process.on('uncaughtException', (err) => crashShutdown('uncaught-exception', err));

process.on('unhandledRejection', (reason) => {
  // 单个 Promise 失败（对话框取消、读盘失败等）不影响控制环，留痕即可；
  // 真到状态不可信时由 uncaughtException 兜底安全停车。
  console.error('[main] 未处理的 Promise 拒绝', reason);
  logger?.error('unhandled-rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
