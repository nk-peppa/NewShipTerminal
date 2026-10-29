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
        rt.safety.onUiCmd(Number(msg?.throttle) || 0, Number(msg?.rudder) || 0);
    });
    electron_1.ipcMain.on('ui:arm', (_e, on) => rt.safety.setArm(!!on));
    electron_1.ipcMain.on('ui:estop', (_e, on) => rt.safety.setEstop(!!on));
    electron_1.ipcMain.handle('ui:config', () => configView(rt.cfg));
    electron_1.ipcMain.on('link:reconnect', () => {
        console.log('[ui] 手动重连');
        rt.link.reconnectNow();
    });
    electron_1.ipcMain.on('algo:reset', () => {
        console.log('[ui] 清空 SLAM 地图');
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
            return { ok: true, message: `${files.length} 个文件`, bytes: zip.length };
        }
        catch (err) {
            return { ok: false, message: `保存失败：${err.message}` };
        }
    });
    // 记录是否已解锁：升级前必须 disarm
    let boatArmed = false;
    rt.link.on('status', (st) => {
        boatArmed = (st.flags & (protocol_js_1.ST_ARMED | protocol_js_1.ST_ESTOP)) !== 0;
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
        const outcome = await (0, ota_js_1.runOta)({
            host: st.host,
            port: rt.cfg.ota.port,
            file,
            onEvent: (ev) => send('evt:fw', {
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