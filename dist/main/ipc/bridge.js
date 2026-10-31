"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.configView = configView;
exports.attachIpc = attachIpc;
const electron_1 = require("electron");
const promises_1 = __importDefault(require("node:fs/promises"));
const ota_js_1 = require("../firmware/ota.js");
const protocol_js_1 = require("../../shared/protocol.js");
const slamExport_js_1 = require("../algo/slamExport.js");
const logArchive_js_1 = require("../log/logArchive.js");
function configView(cfg) {
    return { ship: cfg.ship, control: cfg.control, algo: { enabled: cfg.algo.enabled } };
}
function attachIpc(win, rt) {
    const send = (channel, payload) => {
        if (!win.isDestroyed())
            win.webContents.send(channel, payload);
    };
    // SLAM 结果录制：地图留最新一张 + 轨迹全量，供「保存 SLAM 数据」导出
    const slamLog = new slamExport_js_1.SlamRecorder();
    electron_1.ipcMain.on('ui:cmd', (_e, msg) => {
        const throttle = Number(msg?.throttle) || 0;
        const rudder = Number(msg?.rudder) || 0;
        rt.safety.onUiCmd(throttle, rudder);
        rt.log?.uiCommand(throttle, rudder);
    });
    electron_1.ipcMain.on('ui:arm', (_e, on) => {
        rt.safety.setArm(!!on);
        rt.log?.event('info', 'ui-arm', { on: !!on });
    });
    electron_1.ipcMain.on('ui:estop', (_e, on) => {
        rt.safety.setEstop(!!on);
        rt.log?.event('info', 'ui-estop', { on: !!on });
    });
    electron_1.ipcMain.handle('ui:config', () => configView(rt.cfg));
    electron_1.ipcMain.on('link:reconnect', () => {
        console.log('[ui] 手动重连');
        rt.log?.event('info', 'ui-reconnect');
        rt.link.reconnectNow();
    });
    electron_1.ipcMain.on('algo:reset', () => {
        console.log('[ui] 清空 SLAM 地图');
        rt.log?.event('info', 'ui-clear-map');
        slamLog.clear();
        rt.algo?.reset();
    });
    // 导出 SLAM 结果：地图 + 轨迹 + 元信息，打成一个 ZIP
    electron_1.ipcMain.handle('slam:save', async () => {
        if (!slamLog.hasData) {
            return { ok: false, message: '还没有 SLAM 数据，先让船跑一圈' };
        }
        const st = rt.link.state();
        const r = await electron_1.dialog.showSaveDialog(win, {
            title: '保存 SLAM 数据',
            defaultPath: `usv-slam-${(0, slamExport_js_1.stampName)()}.zip`,
            filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
            properties: ['createDirectory', 'showOverwriteConfirmation'],
        });
        if (r.canceled || !r.filePath)
            return { ok: false, canceled: true, message: '已取消' };
        try {
            const { zip, files } = (0, slamExport_js_1.buildSlamArchive)(slamLog, {
                appVersion: electron_1.app.getVersion(),
                exportedAt: Date.now(),
                ship: { host: st.host, port: st.port, firmware: st.fwVersion, caps: st.caps },
                recording: { since: slamLog.stats().firstPoseAt },
            });
            // 先写临时文件再改名：中途失败不会留下半截 ZIP
            const tmp = `${r.filePath}.part`;
            await promises_1.default.writeFile(tmp, zip);
            await promises_1.default.rename(tmp, r.filePath);
            console.log(`[slam] 已导出 ${files.join(', ')} → ${r.filePath} (${zip.length} B)`);
            rt.log?.event('info', 'slam-export', {
                file: r.filePath,
                files: files.length,
                bytes: zip.length,
            });
            return { ok: true, message: `${files.length} 个文件`, bytes: zip.length };
        }
        catch (err) {
            rt.log?.error('slam-export-failed', { message: err.message });
            return { ok: false, message: `保存失败：${err.message}` };
        }
    });
    /* ---------------- 会话日志 ---------------- */
    // 船端是否已解锁/急停：OTA 与日志导出前都要求先 disarm
    let boatArmed = false;
    rt.link.on('status', (st) => {
        boatArmed = (st.flags & (protocol_js_1.ST_ARMED | protocol_js_1.ST_ESTOP)) !== 0;
    });
    const logOff = () => ({
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
    electron_1.ipcMain.handle('log:info', () => rt.log?.stats() ?? logOff());
    electron_1.ipcMain.handle('log:open', async () => {
        if (!rt.log)
            return { ok: false, message: '日志未启用（--no-log）' };
        rt.log.event('info', 'log-open-dir');
        const err = await electron_1.shell.openPath(rt.log.dir);
        return err ? { ok: false, message: err } : { ok: true, message: rt.log.dir };
    });
    electron_1.ipcMain.handle('log:save', async () => {
        const lg = rt.log;
        if (!lg)
            return { ok: false, message: '日志未启用（--no-log）' };
        const probe = lg.stats();
        if (!probe.enabled)
            return { ok: false, message: `日志写盘失败：${probe.error ?? '未知原因'}` };
        // 导出要读几十 MB，虽然已经分块让出事件循环，仍不该在船动着的时候做
        if (boatArmed || rt.safety.snapshot().armRequested) {
            return { ok: false, message: '船端已解锁/急停中，请先撤防再导出日志' };
        }
        const r = await electron_1.dialog.showSaveDialog(win, {
            title: '保存会话日志',
            defaultPath: `usv-log-${(0, slamExport_js_1.stampName)()}.zip`,
            filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
            properties: ['createDirectory', 'showOverwriteConfirmation'],
        });
        if (r.canceled || !r.filePath)
            return { ok: false, canceled: true, message: '已取消' };
        try {
            lg.flush();
            // 同一拍里定住所有文件长度与统计：中间不让出事件循环，两者一定自洽
            const files = (0, logArchive_js_1.snapshotLogFiles)(lg.dir);
            const stats = lg.stats();
            const snapshot = {
                exportedAt: new Date().toISOString(),
                note: '导出时日志仍在记录，本包只含该时刻之前的数据；原始流格式见 README.txt',
                bytesByFile: Object.fromEntries(files.map((f) => [f.name, f.size])),
                ...stats,
            };
            const outcome = await (0, logArchive_js_1.zipDirectoryToFile)(lg.dir, `${r.filePath}.part`, [
                {
                    name: 'snapshot.json',
                    data: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'),
                },
            ], new Date(), files);
            await promises_1.default.rename(`${r.filePath}.part`, r.filePath);
            console.log(`[log] 已导出 ${outcome.files.length} 个文件 → ${r.filePath} (${outcome.bytes} B)`);
            lg.event('info', 'log-export', {
                file: r.filePath,
                files: outcome.files.length,
                bytes: outcome.bytes,
            });
            return { ok: true, message: `${outcome.files.length} 个文件`, bytes: outcome.bytes };
        }
        catch (err) {
            await promises_1.default.rm(`${r.filePath}.part`, { force: true }).catch(() => undefined);
            lg.error('log-export-failed', { message: err.message });
            return { ok: false, message: `导出失败：${err.message}` };
        }
    });
    electron_1.ipcMain.handle('fw:pick', async () => {
        const r = await electron_1.dialog.showOpenDialog(win, {
            title: '选择固件包',
            filters: [{ name: 'Firmware package', extensions: ['gz', 'tgz'] }],
            properties: ['openFile'],
        });
        return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    electron_1.ipcMain.handle('fw:update', async (_e, file) => {
        const st = rt.link.state();
        if (!st.connected)
            return { ok: false, message: '未连接船端' };
        if (boatArmed)
            return { ok: false, message: '船端已解锁/急停中，请先撤防' };
        if (!file)
            return { ok: false, message: '未选择固件包' };
        rt.log?.event('info', 'fw-update-start', { file });
        const outcome = await (0, ota_js_1.runOta)({
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
        if (now - lastStatusSent < statusPeriodMs)
            return;
        lastStatusSent = now;
        const view = {
            t: now,
            throttlePct: st.throttleX10 / 10,
            direction: st.direction,
            servo1Deg: (st.servosX10[0] ?? 0) / 10,
            armed: !!(st.flags & protocol_js_1.ST_ARMED),
            estop: !!(st.flags & protocol_js_1.ST_ESTOP),
            failsafe: !!(st.flags & protocol_js_1.ST_FAILSAFE),
            lidarOk: !!(st.flags & protocol_js_1.ST_LIDAR_OK),
            armRequired: !!(st.flags & protocol_js_1.ST_ARM_REQUIRED),
            rxSeq: st.rxSeq,
            rxErrors: st.rxErrors,
            pointsLast: st.pointsLast,
            scansTotal: st.scansTotal,
            loopHz: st.loopHzX10 / 10,
        };
        send('evt:status', view);
    });
    // SYS 只有 1Hz，直接转发；界面自行判断过期与配色
    rt.link.on('sys', (sys) => {
        const view = { t: Date.now(), mcuTempC: sys.tempC };
        send('evt:sys', view);
    });
    rt.link.on('scan', ({ scan, recvMs }) => {
        const view = {
            t: scan.timeMs || recvMs,
            count: scan.count,
            angles: scan.anglesRad,
            rangesM: scan.rangesM,
            qualities: scan.qualities,
        };
        send('evt:scan', view);
        rt.algo?.pushScan(scan);
    });
    rt.link.on('state', (state) => send('evt:link', state));
    rt.link.on('decode-error', (err) => {
        const text = err instanceof Error ? err.message : String(err);
        console.warn(`[link] 解码失败: ${text}`);
    });
    rt.discovery?.on('ships', (ships) => send('evt:ships', ships));
    rt.algo?.on('pose', (pose) => {
        slamLog.onPose(pose);
        send('evt:pose', pose);
    });
    rt.algo?.on('map', (map) => {
        slamLog.onMap(map);
        send('evt:map', map);
    });
    rt.algo?.on('health', (h) => send('evt:algo', h));
    rt.algo?.on('log', (line) => console.log(line));
}
//# sourceMappingURL=bridge.js.map