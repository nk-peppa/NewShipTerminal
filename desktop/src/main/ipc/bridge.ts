import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

import { runOta } from '../firmware/ota.js';

import type {
  AlgoHealthView,
  ConfigView,
  ExperimentStatusView,
  LinkStateView,
  LocalizationStateView,
  LogSaveView,
  LogStatusView,
  MapEntryView,
  MapLoadView,
  MapSaveView,
  MapView,
  PoseView,
  ScanView,
  SlamModeView,
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
import { ExperimentRecorder } from '../experiments/experimentRecorder.js';
import type { ShipDiscovery } from '../link/discovery.js';
import type { ReceivedScan, TcpLink } from '../link/tcpLink.js';
import { snapshotLogFiles, zipDirectoryToFile } from '../log/logArchive.js';
import type { SessionLogger } from '../log/sessionLog.js';
import { MapLibrary } from '../maps/mapLibrary.js';
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
  /** 地图库（与日志同父目录） */
  maps: MapLibrary;
  /** 实验根目录 */
  experimentsDir: string;
  /** 退出时由 index.ts 调用，确保实验 summary 落盘 */
  finalizeExperiment?: () => void;
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
  const maps = rt.maps;

  /* ---------------- 建图 / 定位模式 ---------------- */

  let mode: 'mapping' | 'localization' = 'mapping';
  let loaded: { name: string; dir: string; yamlPath: string; hash: string | null; meta: unknown } | null =
    null;
  let locState: LocalizationStateView | null = null;
  let experiment: ExperimentRecorder | null = null;
  let lastExperiment: ExperimentStatusView | null = null;
  let mapLoadWaiter: ((value: Record<string, unknown>) => void) | null = null;

  const experimentOff = (): ExperimentStatusView => ({
    active: false,
    dir: null,
    startedAt: null,
    durationMs: 0,
    frames: 0,
    tracking: 0,
    lost: 0,
    ambiguous: 0,
    scans: 0,
    scansDropped: 0,
    bytes: 0,
    map: null,
    error: null,
  });

  const sendExperiment = (): void => {
    send('evt:experiment', experiment?.stats() ?? lastExperiment ?? experimentOff());
  };

  const stopExperiment = async (reason: string): Promise<void> => {
    const rec = experiment;
    if (!rec) return;
    experiment = null;
    // 归档后仍保留最后一条记录：面板还能显示目录并「打开目录」，
    // 只是不再记录、不能再归档。
    lastExperiment = { ...rec.stats(), active: false };
    const dir = await rec.finalize(reason).catch(() => null);
    rt.log?.event('info', 'experiment-finalized', { dir, reason });
    sendExperiment();
  };

  const leaveLocalization = async (reason: string): Promise<void> => {
    await stopExperiment(reason);
    rt.algo?.unloadMap();
    mode = 'mapping';
    loaded = null;
    locState = null;
    send('evt:loc', null);
    send('evt:mode', slamModeView());
    // 让界面丢掉先验地图
    send('evt:map', { t: Date.now(), png: '', size: 0, resolution: 0, origin: [0, 0], observed: 0, cleared: true });
  };

  const slamModeView = (): SlamModeView => ({ mode, mapName: loaded?.name ?? null });

  ipcMain.handle('slam:mode', (): SlamModeView => slamModeView());

  ipcMain.handle('maps:list', async (): Promise<MapEntryView[]> => maps.list());

  ipcMain.handle('maps:save', async (_e, name?: string): Promise<MapSaveView> => {
    if (!slamLog.hasMap) return { ok: false, message: '还没有 SLAM 地图，先让船跑一圈' };
    const st = rt.link.state();
    const result = await maps.save({
      recorder: slamLog,
      appVersion: app.getVersion(),
      ship: { host: st.host, port: st.port, firmware: st.fwVersion, caps: st.caps },
      name,
    });
    rt.log?.event(result.ok ? 'info' : 'warn', 'map-save', {
      name: result.name,
      dir: result.dir,
      ok: result.ok,
      message: result.message,
    });
    return {
      ok: result.ok,
      name: result.name,
      canceled: false,
      message: result.message,
      bytes: result.bytes,
    };
  });

  ipcMain.handle('maps:delete', async (_e, name: string): Promise<MapLoadView> => {
    if (mode === 'localization' && loaded?.name === name) {
      return { ok: false, message: '正在用这张地图定位，先停止定位' };
    }
    const r = await maps.delete(String(name ?? ''));
    rt.log?.event(r.ok ? 'info' : 'warn', 'map-delete', { name, ok: r.ok, message: r.message });
    return { ok: r.ok, name, message: r.message };
  });

  ipcMain.handle('maps:open', async (): Promise<{ ok: boolean; message: string }> => {
    const dir = await maps.openDir();
    const err = await shell.openPath(dir);
    return err ? { ok: false, message: err } : { ok: true, message: dir };
  });

  ipcMain.handle('localization:start', async (_e, name: string): Promise<MapLoadView> => {
    const algo = rt.algo;
    if (!algo) return { ok: false, message: '算法未启用（--no-algo）' };
    if (!rt.cfg.algo.enabled) return { ok: false, message: '算法未启用' };

    const loadedMap = await maps.load(String(name ?? ''));
    if (!loadedMap.ok || !loadedMap.yamlPath || !loadedMap.meta) {
      return { ok: false, message: loadedMap.message };
    }

    await stopExperiment('switch-map');
    mode = 'localization';
    loaded = {
      name: loadedMap.name!,
      dir: path.dirname(loadedMap.yamlPath),
      yamlPath: loadedMap.yamlPath,
      hash: loadedMap.meta.hash || null,
      meta: loadedMap.meta,
    };
    locState = null;

    const response = await new Promise<Record<string, unknown> | null>((resolve) => {
      mapLoadWaiter = resolve;
      algo.loadMap(loadedMap.yamlPath!);
      setTimeout(() => {
        if (mapLoadWaiter === resolve) {
          mapLoadWaiter = null;
          resolve(null);
        }
      }, 20000);
    });
    if (!response || response.ok !== true) {
      mode = 'mapping';
      loaded = null;
      send('evt:mode', slamModeView());
      const message =
        response && typeof response.message === 'string'
          ? response.message
          : '侧车没有在 20 秒内确认地图加载';
      rt.log?.event('error', 'localization-start-failed', { name, message });
      return { ok: false, message };
    }

    const st = rt.link.state();
    try {
      experiment = await ExperimentRecorder.create({
        baseDir: rt.experimentsDir,
        appVersion: app.getVersion(),
        ship: { host: st.host, port: st.port, firmware: st.fwVersion, caps: st.caps },
        map: { name: loaded.name, hash: loaded.hash, dir: loaded.dir },
        config:
          (response.config as Record<string, unknown> | undefined) ?? {
            note: 'sidecar did not report config',
          },
        sessionLogDir: rt.log?.dir ?? null,
      });
      rt.log?.event('info', 'experiment-start', {
        dir: experiment.directory,
        map: loaded.name,
      });
    } catch (err) {
      experiment = null;
      rt.log?.error('experiment-start-failed', { message: (err as Error).message });
      await leaveLocalization('experiment-failed');
      return { ok: false, message: `实验目录创建失败：${(err as Error).message}` };
    }

    send('evt:mode', slamModeView());
    sendExperiment();
    // 进入定位即结束本次建图会话：避免之后保存出「旧地图 + 新轨迹」的混合包
    slamLog.clear();
    rt.log?.event('info', 'localization-start', { name: loaded.name, dir: loaded.dir });
    return { ok: true, name: loaded.name, message: `已加载 ${loaded.name}，开始定位` };
  });

  ipcMain.handle('localization:stop', async (): Promise<MapLoadView> => {
    if (mode !== 'localization') return { ok: true, message: '当前不在定位模式' };
    await leaveLocalization('stopped');
    rt.log?.event('info', 'localization-stop');
    return { ok: true, message: '已停止定位，回到建图模式' };
  });

  ipcMain.handle('localization:pose', async (_e, p: { x: number; y: number; yaw: number }): Promise<MapLoadView> => {
    if (!rt.algo || mode !== 'localization') return { ok: false, message: '未进入定位模式' };
    const x = Number(p?.x);
    const y = Number(p?.y);
    const yaw = Number(p?.yaw);
    if (![x, y, yaw].every(Number.isFinite)) return { ok: false, message: '初始位姿无效' };
    rt.algo.setInitialPose(x, y, yaw);
    experiment?.event('manual-pose', { x, y, yaw });
    return { ok: true, message: '已设置初始位姿' };
  });

  ipcMain.handle('localization:clear-pose', async (): Promise<MapLoadView> => {
    if (!rt.algo || mode !== 'localization') return { ok: false, message: '未进入定位模式' };
    rt.algo.clearPose();
    experiment?.event('manual-global-search', {});
    return { ok: true, message: '已清空位姿，下一帧重新全局定位' };
  });

  ipcMain.handle('localization:info', (): LocalizationStateView | null => locState);

  ipcMain.handle('experiments:info', (): ExperimentStatusView =>
    experiment?.stats() ?? lastExperiment ?? experimentOff(),
  );

  ipcMain.handle('experiments:open', async (): Promise<{ ok: boolean; message: string }> => {
    const dir = experiment?.directory ?? lastExperiment?.dir ?? null;
    if (!dir) return { ok: false, message: '当前没有实验记录' };
    const err = await shell.openPath(dir);
    return err ? { ok: false, message: err } : { ok: true, message: dir };
  });

  ipcMain.handle('experiments:finalize', async (): Promise<{ ok: boolean; message: string }> => {
    if (!experiment) return { ok: false, message: '当前没有实验记录' };
    const dir = experiment.directory;
    await stopExperiment('manual');
    return { ok: true, message: dir };
  });

  rt.finalizeExperiment = () => {
    if (experiment) {
      const rec = experiment;
      experiment = null;
      void rec.finalize('app-quit');
    }
  };

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
    if (mode === 'localization') {
      console.log('[ui] 清空定位位姿');
      rt.log?.event('info', 'ui-clear-pose');
      rt.algo?.clearPose();
      experiment?.event('manual-global-search', { via: 'clear-map' });
      return;
    }
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

  // 船端是否已解锁/急停：OTA 与日志导出前都要求先 disarm
  let boatArmed = false;
  rt.link.on('status', (st) => {
    boatArmed = (st.flags & (ST_ARMED | ST_ESTOP)) !== 0;
  });

  const logOff = (): LogStatusView => ({
    enabled: false,
    dir: null,
    startedAt: null,
    durationMs: 0,
    bytes: 0,
    events: 0,
    statusRows: 0,
    statusGaps: 0,
    maxStatusGapMs: 0,
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
    // 导出要读几十 MB，虽然已经分块让出事件循环，仍不该在船动着的时候做
    if (boatArmed || rt.safety.snapshot().armRequested) {
      return { ok: false, message: '船端已解锁/急停中，请先撤防再导出日志' };
    }

    const r = await dialog.showSaveDialog(win, {
      title: '保存会话日志',
      defaultPath: `usv-log-${stampName()}.zip`,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true, message: '已取消' };

    try {
      lg.flush();
      // 同一拍里定住所有文件长度与统计：中间不让出事件循环，两者一定自洽
      const files = snapshotLogFiles(lg.dir);
      const stats = lg.stats();
      const snapshot = {
        exportedAt: new Date().toISOString(),
        note: '导出时日志仍在记录，本包只含该时刻之前的数据；原始流格式见 README.txt',
        bytesByFile: Object.fromEntries(files.map((f) => [f.name, f.size])),
        ...stats,
      };
      const outcome = await zipDirectoryToFile(
        lg.dir,
        `${r.filePath}.part`,
        [
          {
            name: 'snapshot.json',
            data: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'),
          },
        ],
        new Date(),
        files,
      );
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
    if (mode === 'localization' && experiment) {
      const tStart = 'tStartMs' in scan ? (scan as { tStartMs?: number }).tStartMs : undefined;
      experiment.scan(scan, tStart, recvMs);
    }
  });

  rt.link.on('state', (state: LinkStateView) => send('evt:link', state));
  rt.link.on('decode-error', (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    console.warn(`[link] 解码失败: ${text}`);
  });

  rt.discovery?.on('ships', (ships) => send('evt:ships', ships));
  rt.algo?.on('pose', (pose: PoseView) => {
    if (pose.mode === 'localization') {
      experiment?.pose(pose);
    } else {
      slamLog.onPose(pose);
    }
    send('evt:pose', pose);
  });
  rt.algo?.on('map', (map: MapView) => {
    // 先验地图只用于显示，绝不混进建图录制
    if (!map.prior) slamLog.onMap(map);
    send('evt:map', map);
  });
  rt.algo?.on('localization', (raw: Record<string, unknown>) => {
    const state = raw as unknown as LocalizationStateView;
    locState = {
      phase: state.phase,
      message: state.message,
      map: state.map ?? loaded?.name ?? null,
      frames: state.frames ?? 0,
      trackingFrames: state.trackingFrames ?? 0,
      candidates: state.candidates ?? [],
      metrics: state.metrics ?? {
        rmse: null,
        inlier: 0,
        coverage: 0,
        matched: 0,
        points: 0,
        confidence: 0,
        dtMs: 0,
        candidates: 0,
        margin: null,
      },
    };
    experiment?.localizationState(locState);
    send('evt:loc', locState);
    sendExperiment();
  });
  rt.algo?.on('map-loaded', (raw: Record<string, unknown>) => {
    if (mapLoadWaiter) {
      const resolve = mapLoadWaiter;
      mapLoadWaiter = null;
      resolve(raw);
    }
    send('evt:map-loaded', {
      ok: raw.ok === true,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      message: typeof raw.message === 'string' ? raw.message : '',
    });
    if (raw.ok !== true) {
      rt.log?.error('map-load-failed', { message: raw.message });
      experiment?.event('map-load-failed', { message: raw.message });
    } else {
      experiment?.event('map-loaded', {
        name: raw.name,
        occupied: raw.occupied,
        free: raw.free,
      });
    }
  });
  rt.algo?.on('map-unloaded', () => {
    experiment?.event('map-unloaded', {});
  });
  rt.algo?.on('health', (h: AlgoHealthView) => send('evt:algo', h));
  rt.algo?.on('log', (line: string) => {
    console.log(line);
    if (/退出 code=|spawn 失败|非法输出/.test(line)) {
      experiment?.event('algo-log', { line: line.slice(0, 500) });
    }
  });
}
