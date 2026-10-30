import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';

import { runOta } from '../firmware/ota.js';

import type {
  AlgoHealthView,
  ConfigView,
  LinkStateView,
  LogSaveView,
  LogStatusView,
  MapView,
  PoseView,
  ScanView,
  StatusView,
} from '../../shared/api.js';
import {
  ST_ARMED,
  ST_ARM_REQUIRED,
  ST_ESTOP,
  ST_FAILSAFE,
  ST_LIDAR_OK,
} from '../../shared/protocol.js';
import { buildSlamArchive, SlamRecorder, stampName, type SaveOutcome } from '../algo/slamExport.js';
import type { AlgoSidecar } from '../algo/sidecar.js';
import type { AppConfig } from '../config.js';
import type { ShipDiscovery } from '../link/discovery.js';
import type { ReceivedScan, TcpLink } from '../link/tcpLink.js';
import { zipDirectoryToFile } from '../log/logArchive.js';
import type { SessionLogger } from '../log/sessionLog.js';
import type { SafetySupervisor } from '../safety/supervisor.js';

export interface Runtime {
  cfg: AppConfig;
  link: TcpLink;
  safety: SafetySupervisor;
  discovery: ShipDiscovery | null;
  algo: AlgoSidecar | null;
  log: SessionLogger | null;
  /** 日志初始化失败原因；正常关闭（--no-log）为 null */
  logError: string | null;
}

export function configView(cfg: AppConfig): ConfigView {
  return { ship: cfg.ship, control: cfg.control, algo: { enabled: cfg.algo.enabled } };
}

export function attachIpc(win: BrowserWindow, rt: Runtime): void {
  const send = (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // SLAM 结果录制：地图留最新一张 + 轨迹全量，供「保存 SLAM 数据」导出
  const slamLog = new SlamRecorder();

  ipcMain.on('ui:cmd', (_e, msg: { throttle: number; rudder: number }) => {
    const throttle = Number(msg?.throttle) || 0;
    const rudder = Number(msg?.rudder) || 0;
    rt.safety.onUiCmd(throttle, rudder);
    rt.log?.uiCommand(throttle, rudder);
  });
  ipcMain.on('ui:arm', (_e, on: boolean) => {
    rt.safety.setArm(!!on);
    rt.log?.event('info', 'ui-arm', { on: !!on });
  });
  ipcMain.on('ui:estop', (_e, on: boolean) => {
    rt.safety.setEstop(!!on);
    rt.log?.event('info', 'ui-estop', { on: !!on });
  });
  ipcMain.handle('ui:config', () => configView(rt.cfg));

  ipcMain.on('link:reconnect', () => {
    console.log('[ui] 手动重连');
    rt.log?.event('info', 'ui-reconnect');
    rt.link.reconnectNow();
  });

  ipcMain.on('algo:reset', () => {
    console.log('[ui] 清空 SLAM 地图');
    rt.log?.event('info', 'ui-clear-map');
    slamLog.clear();
    rt.algo?.reset();
  });

  // 导出 SLAM 结果：地图 + 轨迹 + 元信息，打成一个 ZIP
  ipcMain.handle('slam:save', async (): Promise<SaveOutcome> => {
    if (!slamLog.hasData) {
      return { ok: false, message: '还没有 SLAM 数据，先让船跑一圈' };
    }
    const st = rt.link.state();
    const r = await dialog.showSaveDialog(win, {
      title: '保存 SLAM 数据',
      defaultPath: `usv-slam-${stampName()}.zip`,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true, message: '已取消' };

    try {
      const { zip, files } = buildSlamArchive(slamLog, {
        appVersion: app.getVersion(),
        exportedAt: Date.now(),
        ship: { host: st.host, port: st.port, firmware: st.fwVersion, caps: st.caps },
        recording: { since: slamLog.stats().firstPoseAt },
      });
      // 先写临时文件再改名：中途失败不会留下半截 ZIP
      const tmp = `${r.filePath}.part`;
      await fs.writeFile(tmp, zip);
      await fs.rename(tmp, r.filePath);
      console.log(`[slam] 已导出 ${files.join(', ')} → ${r.filePath} (${zip.length} B)`);
      rt.log?.event('info', 'slam-export', {
        file: r.filePath,
        files: files.length,
        bytes: zip.length,
      });
      return { ok: true, message: `${files.length} 个文件`, bytes: zip.length };
    } catch (err) {
      rt.log?.error('slam-export-failed', { message: (err as Error).message });
      return { ok: false, message: `保存失败：${(err as Error).message}` };
    }
  });

  /* ---------------- 会话日志 ---------------- */

  const logOff = (): LogStatusView => ({
    enabled: false,
    dir: null,
    startedAt: null,
    bytes: 0,
    events: 0,
    statusRows: 0,
    cmdRows: 0,
    uiRows: 0,
    scanRows: 0,
    poseRows: 0,
    rxBytes: 0,
    txBytes: 0,
    error: rt.logError,
  });

  ipcMain.handle('log:info', (): LogStatusView => rt.log?.stats() ?? logOff());

  ipcMain.handle('log:open', async (): Promise<{ ok: boolean; message: string }> => {
    if (!rt.log) return { ok: false, message: '日志未启用（--no-log）' };
    rt.log.event('info', 'log-open-dir');
    const err = await shell.openPath(rt.log.dir);
    return err ? { ok: false, message: err } : { ok: true, message: rt.log.dir };
  });

  ipcMain.handle('log:save', async (): Promise<LogSaveView> => {
    const lg = rt.log;
    if (!lg) return { ok: false, message: '日志未启用（--no-log）' };
    const probe = lg.stats();
    if (!probe.enabled) return { ok: false, message: `日志写盘失败：${probe.error ?? '未知原因'}` };

    const r = await dialog.showSaveDialog(win, {
      title: '保存会话日志',
      defaultPath: `usv-log-${stampName()}.zip`,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true, message: '已取消' };

    try {
      lg.flush();
      const snapshot = {
        exportedAt: new Date().toISOString(),
        note: '导出时日志仍在记录，此后的数据不在本包内；原始流格式见 README.txt',
        ...lg.stats(),
      };
      // 同步写盘 + 同步读取：导出期间日志不会变化，ZIP 天然是一致快照
      const outcome = zipDirectoryToFile(lg.dir, `${r.filePath}.part`, [
        {
          name: 'snapshot.json',
          data: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'),
        },
      ]);
      await fs.rename(`${r.filePath}.part`, r.filePath);
      console.log(`[log] 已导出 ${outcome.files.length} 个文件 → ${r.filePath} (${outcome.bytes} B)`);
      lg.event('info', 'log-export', {
        file: r.filePath,
        files: outcome.files.length,
        bytes: outcome.bytes,
      });
      return { ok: true, message: `${outcome.files.length} 个文件`, bytes: outcome.bytes };
    } catch (err) {
      await fs.rm(`${r.filePath}.part`, { force: true }).catch(() => undefined);
      lg.error('log-export-failed', { message: (err as Error).message });
      return { ok: false, message: `导出失败：${(err as Error).message}` };
    }
  });

  // 记录是否已解锁：升级前必须 disarm
  let boatArmed = false;
  rt.link.on('status', (st) => {
    boatArmed = (st.flags & (ST_ARMED | ST_ESTOP)) !== 0;
  });

  ipcMain.handle('fw:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择固件包',
      filters: [{ name: 'Firmware package', extensions: ['gz', 'tgz'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('fw:update', async (_e, file: string) => {
    const st = rt.link.state();
    if (!st.connected) return { ok: false, message: '未连接船端' };
    if (boatArmed) return { ok: false, message: '船端已解锁/急停中，请先撤防' };
    if (!file) return { ok: false, message: '未选择固件包' };

    rt.log?.event('info', 'fw-update-start', { file });
    const outcome = await runOta({
      host: st.host,
      port: rt.cfg.ota.port,
      file,
      onEvent: (ev) => {
        send('evt:fw', {
          phase: ev.phase,
          received: ev.received,
          total: ev.total,
          message: ev.message,
          done: ev.phase === 'done' || ev.phase === 'error',
          ok: ev.phase === 'done',
        });
        rt.log?.event('info', 'fw-update-progress', {
          phase: ev.phase,
          received: ev.received,
          total: ev.total,
          message: ev.message,
        });
      },
    });
    rt.log?.event(outcome.ok ? 'info' : 'error', 'fw-update-done', {
      ok: outcome.ok,
      message: outcome.message,
    });
    return { ok: outcome.ok, message: outcome.message };
  });

  // STATUS 限速到 statusUiHz：50Hz 全量推给界面没有意义，还会挤占 IPC
  const statusPeriodMs = 1000 / rt.cfg.link.statusUiHz;
  let lastStatusSent = 0;
  rt.link.on('status', (st) => {
    const now = Date.now();
    if (now - lastStatusSent < statusPeriodMs) return;
    lastStatusSent = now;

    const view: StatusView = {
      t: now,
      throttlePct: st.throttleX10 / 10,
      direction: st.direction,
      servo1Deg: (st.servosX10[0] ?? 0) / 10,
      armed: !!(st.flags & ST_ARMED),
      estop: !!(st.flags & ST_ESTOP),
      failsafe: !!(st.flags & ST_FAILSAFE),
      lidarOk: !!(st.flags & ST_LIDAR_OK),
      armRequired: !!(st.flags & ST_ARM_REQUIRED),
      rxSeq: st.rxSeq,
      rxErrors: st.rxErrors,
      pointsLast: st.pointsLast,
      scansTotal: st.scansTotal,
      loopHz: st.loopHzX10 / 10,
    };
    send('evt:status', view);
  });

  rt.link.on('scan', ({ scan, recvMs }: ReceivedScan) => {
    const view: ScanView = {
      t: scan.timeMs || recvMs,
      count: scan.count,
      angles: scan.anglesRad,
      rangesM: scan.rangesM,
      qualities: scan.qualities,
    };
    send('evt:scan', view);
    rt.algo?.pushScan(scan);
  });

  rt.link.on('state', (state: LinkStateView) => send('evt:link', state));
  rt.link.on('decode-error', (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    console.warn(`[link] 解码失败: ${text}`);
  });

  rt.discovery?.on('ships', (ships) => send('evt:ships', ships));
  rt.algo?.on('pose', (pose: PoseView) => {
    slamLog.onPose(pose);
    send('evt:pose', pose);
  });
  rt.algo?.on('map', (map: MapView) => {
    slamLog.onMap(map);
    send('evt:map', map);
  });
  rt.algo?.on('health', (h: AlgoHealthView) => send('evt:algo', h));
  rt.algo?.on('log', (line: string) => console.log(line));
}
