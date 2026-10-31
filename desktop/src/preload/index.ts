import { contextBridge, ipcRenderer } from 'electron';

import type {
  AlgoHealthView,
  ConfigView,
  ExperimentStatusView,
  FirmwareStateView,
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
  ShipView,
  SlamModeView,
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
  listMaps: () => ipcRenderer.invoke('maps:list') as Promise<MapEntryView[]>,
  saveMap: (name?: string) => ipcRenderer.invoke('maps:save', name) as Promise<MapSaveView>,
  deleteMap: (name: string) => ipcRenderer.invoke('maps:delete', name) as Promise<MapLoadView>,
  openMapsDir: () =>
    ipcRenderer.invoke('maps:open') as Promise<{ ok: boolean; message: string }>,
  startLocalization: (name: string) =>
    ipcRenderer.invoke('localization:start', name) as Promise<MapLoadView>,
  stopLocalization: () => ipcRenderer.invoke('localization:stop') as Promise<MapLoadView>,
  setInitialPose: (x: number, y: number, yaw: number) =>
    ipcRenderer.invoke('localization:pose', { x, y, yaw }) as Promise<MapLoadView>,
  clearPose: () => ipcRenderer.invoke('localization:clear-pose') as Promise<MapLoadView>,
  getLocalization: () =>
    ipcRenderer.invoke('localization:info') as Promise<LocalizationStateView | null>,
  getSlamMode: () => ipcRenderer.invoke('slam:mode') as Promise<SlamModeView>,
  getExperiment: () => ipcRenderer.invoke('experiments:info') as Promise<ExperimentStatusView>,
  openExperimentDir: () =>
    ipcRenderer.invoke('experiments:open') as Promise<{ ok: boolean; message: string }>,
  finalizeExperiment: () =>
    ipcRenderer.invoke('experiments:finalize') as Promise<{ ok: boolean; message: string }>,
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
  onLocalization: (cb) => subscribe<LocalizationStateView>('evt:loc', cb),
  onMapLoaded: (cb) => subscribe<MapLoadView & { name?: string }>('evt:map-loaded', cb),
  onExperiment: (cb) => subscribe<ExperimentStatusView>('evt:experiment', cb),
  onMode: (cb) => subscribe<SlamModeView>('evt:mode', cb),
};

contextBridge.exposeInMainWorld('usv', api);
