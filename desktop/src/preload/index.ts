import { contextBridge, ipcRenderer } from 'electron';

import type {
  AlgoHealthView,
  ConfigView,
  FirmwareStateView,
  LinkStateView,
  LogSaveView,
  LogStatusView,
  MapView,
  PoseView,
  ScanView,
  ShipView,
  SlamSaveView,
  StatusView,
  UsvApi,
} from '../shared/api.js';

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: UsvApi = {
  sendCmd: (throttle, rudder) => ipcRenderer.send('ui:cmd', { throttle, rudder }),
  setArm: (on) => ipcRenderer.send('ui:arm', on),
  setEstop: (on) => ipcRenderer.send('ui:estop', on),
  getConfig: () => ipcRenderer.invoke('ui:config') as Promise<ConfigView>,
  pickFirmware: () => ipcRenderer.invoke('fw:pick') as Promise<string | null>,
  reconnect: () => ipcRenderer.send('link:reconnect'),
  clearMap: () => ipcRenderer.send('algo:reset'),
  saveSlam: () => ipcRenderer.invoke('slam:save') as Promise<SlamSaveView>,
  getLogStatus: () => ipcRenderer.invoke('log:info') as Promise<LogStatusView>,
  openLogDir: () => ipcRenderer.invoke('log:open') as Promise<{ ok: boolean; message: string }>,
  saveLog: () => ipcRenderer.invoke('log:save') as Promise<LogSaveView>,
  updateFirmware: (file) =>
    ipcRenderer.invoke('fw:update', file) as Promise<{ ok: boolean; message: string }>,
  onFirmware: (cb) => subscribe<FirmwareStateView>('evt:fw', cb),
  onStatus: (cb) => subscribe<StatusView>('evt:status', cb),
  onScan: (cb) => subscribe<ScanView>('evt:scan', cb),
  onLink: (cb) => subscribe<LinkStateView>('evt:link', cb),
  onShips: (cb) => subscribe<ShipView[]>('evt:ships', cb),
  onPose: (cb) => subscribe<PoseView>('evt:pose', cb),
  onMap: (cb) => subscribe<MapView>('evt:map', cb),
  onAlgoHealth: (cb) => subscribe<AlgoHealthView>('evt:algo', cb),
};

contextBridge.exposeInMainWorld('usv', api);
