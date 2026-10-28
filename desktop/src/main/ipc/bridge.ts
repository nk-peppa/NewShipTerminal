import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';

import { runOta } from '../firmware/ota.js';

import type {
  AlgoHealthView,
  ConfigView,
  LinkStateView,
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
import type { SafetySupervisor } from '../safety/supervisor.js';

export interface Runtime {
  cfg: AppConfig;
  link: TcpLink;
  safety: SafetySupervisor;
  discovery: ShipDiscovery | null;
  algo: AlgoSidecar | null;
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
    rt.safety.onUiCmd(Number(msg?.throttle) || 0, Number(msg?.rudder) || 0);
  });
  ipcMain.on('ui:arm', (_e, on: boolean) => rt.safety.setArm(!!on));
  ipcMain.on('ui:estop', (_e, on: boolean) => rt.safety.setEstop(!!on));
  ipcMain.handle('ui:config', () => configView(rt.cfg));

  ipcMain.on('link:reconnect', () => {
    console.log('[ui] 手动重连');
    rt.link.reconnectNow();
  });

  ipcMain.on('algo:reset', () => {
    console.log('[ui] 清空 SLAM 地图');
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
      return { ok: true, message: `${files.length} 个文件`, bytes: zip.length };
    } catch (err) {
      return { ok: false, message: `保存失败：${(err as Error).message}` };
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

    const outcome = await runOta({
      host: st.host,
      port: rt.cfg.ota.port,
      file,
      onEvent: (ev) =>
        send('evt:fw', {
          phase: ev.phase,
          received: ev.received,
          total: ev.total,
          message: ev.message,
          done: ev.phase === 'done' || ev.phase === 'error',
          ok: ev.phase === 'done',
        }),
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
