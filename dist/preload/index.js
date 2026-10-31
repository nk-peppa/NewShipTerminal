"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
function subscribe(channel, cb) {
    const handler = (_event, value) => cb(value);
    electron_1.ipcRenderer.on(channel, handler);
    return () => {
        electron_1.ipcRenderer.removeListener(channel, handler);
    };
}
const api = {
    sendCmd: (throttle, rudder) => electron_1.ipcRenderer.send('ui:cmd', { throttle, rudder }),
    setArm: (on) => electron_1.ipcRenderer.send('ui:arm', on),
    setEstop: (on) => electron_1.ipcRenderer.send('ui:estop', on),
    getConfig: () => electron_1.ipcRenderer.invoke('ui:config'),
    pickFirmware: () => electron_1.ipcRenderer.invoke('fw:pick'),
    reconnect: () => electron_1.ipcRenderer.send('link:reconnect'),
    clearMap: () => electron_1.ipcRenderer.send('algo:reset'),
    saveSlam: () => electron_1.ipcRenderer.invoke('slam:save'),
    getLogStatus: () => electron_1.ipcRenderer.invoke('log:info'),
    openLogDir: () => electron_1.ipcRenderer.invoke('log:open'),
    saveLog: () => electron_1.ipcRenderer.invoke('log:save'),
    updateFirmware: (file) => electron_1.ipcRenderer.invoke('fw:update', file),
    onFirmware: (cb) => subscribe('evt:fw', cb),
    onStatus: (cb) => subscribe('evt:status', cb),
    onScan: (cb) => subscribe('evt:scan', cb),
    onLink: (cb) => subscribe('evt:link', cb),
    onShips: (cb) => subscribe('evt:ships', cb),
    onPose: (cb) => subscribe('evt:pose', cb),
    onMap: (cb) => subscribe('evt:map', cb),
    onAlgoHealth: (cb) => subscribe('evt:algo', cb),
};
electron_1.contextBridge.exposeInMainWorld('usv', api);
//# sourceMappingURL=index.js.map