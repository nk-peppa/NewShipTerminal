/*
 * 主进程 ↔ 渲染进程 ↔ Python 算法进程 的数据契约。
 * 这里只有类型，编译后不产生运行时代码。
 */

export interface StatusView {
  /** 本机接收时刻（epoch ms） */
  t: number;
  throttlePct: number;
  direction: number;
  servo1Deg: number;
  armed: boolean;
  estop: boolean;
  failsafe: boolean;
  lidarOk: boolean;
  armRequired: boolean;
  rxSeq: number;
  rxErrors: number;
  pointsLast: number;
  scansTotal: number;
  loopHz: number;
}

export interface ScanView {
  /** 船端单调时钟，圈完成时刻 */
  t: number;
  count: number;
  /** 0=正前，顺时针，rad */
  angles: Float32Array;
  rangesM: Float32Array;
  qualities: Uint8Array;
  /** SCAN2 才有：圈起始时刻 / 圈号 / 实测圈率 */
  tStartMs?: number;
  scanSeq?: number;
  rateHz?: number;
}

export interface LinkStateView {
  connected: boolean;
  host: string;
  port: number;
  lastError: string | null;
  rxStatusHz: number;
  rxScanHz: number;
  txHz: number;
  crcErrors: number;
  /** HELLO 协商到的固件版本（旧固件为 null） */
  fwVersion: string | null;
  caps: number;
  /** 船端 systemd 回滚看门狗是否已装（caps 的 CAP_WATCHDOG 位）；未握手为 false */
  watchdogArmed: boolean;
  /** 上下行延迟（ms）；对称假设下的分解，未握手或旧固件为 null */
  upMs: number | null;
  downMs: number | null;
  /** 实测往返（ms），这是唯一可直接测量的量 */
  rttMs: number | null;
  /** 船钟 − 本地钟（ms）。本地时间 = 船端时间 − 该值 */
  clockOffsetMs: number | null;
}

export interface FirmwareStateView {
  phase: string;
  received: number;
  total: number;
  message?: string;
  done: boolean;
  ok?: boolean;
}

export interface ShipView {
  name: string;
  sn: string;
  host: string;
  tcpPort: number;
  state: string;
  lidar: boolean;
  armed: boolean;
  estop: boolean;
  failsafe: boolean;
  hz: number;
  lastSeenMs: number;
}

export interface PoseView {
  t: number;
  x: number;
  y: number;
  yaw: number;
  status: string;
  /**
   * 该位姿是否为当前估计。false 表示 SLAM 处于 LOST / DEGENERATE / WAITING，
   * 坐标是上次可信位姿（或原点），不能当作当前定位结果。
   */
  poseValid?: boolean;
  /** 匹配残差（m），LOST 时为 null */
  rmse?: number | null;
  /** 内点率 0..1 */
  inlier?: number;
  /** 已处理圈数 / 被丢弃的异常圈数 */
  scans?: number;
  skipped?: number;
  covariance?: number[];
}

/** SLAM 占据栅格的一次快照（PNG base64，灰度：白=空闲 灰=未知 黑=占据） */
export interface MapView {
  t: number;
  /** data:image/png;base64,... */
  png: string;
  /** 栅格边长（cell 数） */
  size: number;
  /** 每 cell 米数 */
  resolution: number;
  /** 栅格左下角在世界系里的坐标 */
  origin: [number, number];
  /** 已观测 cell 数 */
  observed: number;
  /** 清空指令回执：png 为空，界面应丢弃旧图 */
  cleared?: boolean;
}

export interface AlgoHealthView {
  running: boolean;
  restarts: number;
  lastPoseAgoMs: number | null;
  scansSent: number;
}

export interface ConfigView {
  ship: { host: string | null; port: number };
  control: { maxThrottlePct: number; rudderMaxDeg: number; uiTimeoutMs: number };
  algo: { enabled: boolean };
}

/** 保存 SLAM 数据的结果 */
export interface SlamSaveView {
  ok: boolean;
  /** 用户在保存对话框里点了取消 */
  canceled?: boolean;
  message: string;
  /** 写出的字节数 */
  bytes?: number;
}

export interface UsvApi {
  sendCmd(throttle: number, rudder: number): void;
  setArm(on: boolean): void;
  setEstop(on: boolean): void;
  getConfig(): Promise<ConfigView>;
  /** 选择固件包（.tar.gz），取消返回 null */
  pickFirmware(): Promise<string | null>;
  /** 立即重连（跳过 2s 退避），用于船端重启后手动恢复 */
  reconnect(): void;
  /** 清空 SLAM 地图（重建侧车状态 + 清空显示） */
  clearMap(): void;
  /** 弹出保存对话框，把 SLAM 地图与轨迹导出成 ZIP */
  saveSlam(): Promise<SlamSaveView>;
  /** 把包上传到当前连接的船端 */
  updateFirmware(file: string): Promise<{ ok: boolean; message: string }>;
  onFirmware(cb: (s: FirmwareStateView) => void): () => void;
  onStatus(cb: (s: StatusView) => void): () => void;
  onScan(cb: (s: ScanView) => void): () => void;
  onLink(cb: (s: LinkStateView) => void): () => void;
  onShips(cb: (s: ShipView[]) => void): () => void;
  onPose(cb: (p: PoseView) => void): () => void;
  onMap(cb: (m: MapView) => void): () => void;
  onAlgoHealth(cb: (h: AlgoHealthView) => void): () => void;
}
