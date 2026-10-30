import type {
  AlgoHealthView,
  MapView,
  PoseView,
  ShipView,
  StatusView,
  UsvApi,
} from '../shared/api.js';
import { RadarView } from './radar.js';
import { PadMenu } from './padMenu.js';
import { xboxIcon } from './icons/xbox.js';
import { SlamMapView } from './slamMap.js';

declare global {
  interface Window {
    usv: UsvApi;
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const el = {
  linkPill: $('link-pill'),
  shipPill: $('ship-pill'),
  padPill: $('pad-pill'),
  armBtn: $<HTMLButtonElement>('arm-btn'),
  estopBtn: $<HTMLButtonElement>('estop-btn'),
  thrVal: $('thr-val'),
  rudVal: $('rud-val'),
  thrBar: $('thr-bar'),
  rudBar: $('rud-bar'),
  stHz: $('st-hz'),
  stUp: $('st-up'),
  stDown: $('st-down'),
  stThr: $('st-thr'),
  stDir: $('st-dir'),
  stFlags: $('st-flags'),
  stPts: $('st-pts'),
  stErr: $('st-err'),
  pose: $('pose'),
  poseStatus: $('pose-status'),
  algo: $('algo'),
  ships: $('ships'),
  reconnectBtn: $<HTMLButtonElement>('reconnect-btn'),
  linkHint: $('link-hint'),
  fwVersion: $('fw-version'),
  fwWatchdog: $('fw-watchdog'),
  fwBtn: $<HTMLButtonElement>('fw-btn'),
  fwFill: $('fw-fill'),
  fwStatus: $('fw-status'),
  radarInfo: $('radar-info'),
  radarRange: $<HTMLSelectElement>('radar-range'),
  radarWrap: $('radar-wrap'),
  canvas: $<HTMLCanvasElement>('radar'),
  mapWrap: $('map-wrap'),
  mapCanvas: $<HTMLCanvasElement>('map'),
  mapInfo: $('map-info'),
  clearMapBtn: $<HTMLButtonElement>('clear-map-btn'),
  saveSlamBtn: $<HTMLButtonElement>('save-slam-btn'),
  saveSlamKey: $('save-slam-key'),
  slamIo: $('slam-io'),
  logInfo: $('log-info'),
  logOpenBtn: $<HTMLButtonElement>('log-open-btn'),
  logSaveBtn: $<HTMLButtonElement>('log-save-btn'),
  logIo: $('log-io'),
  telemetry: $('telemetry'),
  telemetryScroll: $('telemetry-scroll'),
  menuBtn: $<HTMLButtonElement>('menu-btn'),
  menuIcon: $('menu-icon'),
  menuHint: $('menu-hint'),
};

const state = {
  arm: false,
  estop: false,
  connected: false,
  deadzone: 0.08,
  /** 船端是否已装 systemd 回滚保险（来自 HELLO_ACK caps） */
  watchdogArmed: false,
  /** 船端固件是否会通过 caps 上报保险状态（0.4.0 起） */
  watchdogReportable: false,
  status: null as StatusView | null,
  pose: null as PoseView | null,
  ships: [] as ShipView[],
  target: '—',
  disconnectedSince: null as number | null,
  lastLinkError: null as string | null,
  lastClickAt: 0,
  lidarWasOk: false,
  padId: '',
  lastSend: 0,
  scanTimes: [] as number[],
  lastFrameAt: 0,
  armWarnUntil: 0,
  estopWarnUntil: 0,
};

const radar = new RadarView();
// 初始量程以 HTML 里的 selected 为准：不然下拉框显示 12m、视图还在用组件默认的 3m
radar.setRange(Number(el.radarRange.value));

/** 解锁/急停按钮右侧的按键提示图标（只生成一次） */
const ARM_KEY_SVG = xboxIcon('dpadUp', { size: 24, title: '十字键 上：解锁' });
const ESTOP_KEY_SVG = xboxIcon('dpadDown', { size: 24, title: '十字键 下：急停' });
const WARN_SVG = xboxIcon('warn', { size: 24 });

const ctx = el.canvas.getContext('2d')!;
const slamMap = new SlamMapView();
const mapCtx = el.mapCanvas.getContext('2d')!;

/* ---------------- 手柄菜单导航 ---------------- */

el.menuIcon.innerHTML = xboxIcon('menu', { size: 22, title: '菜单' });
el.menuBtn.addEventListener('click', () => padMenu.toggle());

/** 让画布尺寸跟随容器（正方形，取短边），返回设备像素边长 */
function fitCanvas(canvas: HTMLCanvasElement, wrap: HTMLElement): { px: number; dpr: number } {
  const box = wrap.getBoundingClientRect();
  const size = Math.max(80, Math.floor(Math.min(box.width, box.height)));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  return { px, dpr };
}

/** 矩形画布：铺满容器（地图面板宽高比不必是 1:1） */
function fitCanvasRect(
  canvas: HTMLCanvasElement,
  wrap: HTMLElement,
): { w: number; h: number; dpr: number } {
  const box = wrap.getBoundingClientRect();
  const w = Math.max(120, Math.floor(box.width));
  const h = Math.max(120, Math.floor(box.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  return { w: pw, h: ph, dpr };
}

/* ---------------- 手柄 ---------------- */

const deadzoneRescale = (v: number, dz: number): number => {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / (1 - dz));
};

let padThrottle = 0;
let padRudder = 0;

/**
 * 菜单模式：左摇杆改为控件导航，油门/舵角强制归零。
 * 放在这里是因为它要读写 padThrottle/padRudder。
 *
 * 导航范围限定在 `main` 内：标题栏里的菜单按钮不该被摇杆选中，
 * 否则从右栏往上推会一路逃到标题栏并卡在那里（B 键才是退出方式）。
 */
const padMenu = new PadMenu(document.querySelector('main') ?? document.body, {
  onModeChange: (active) => {
    el.menuBtn.classList.toggle('on', active);
    el.menuHint.classList.toggle('show', active);
    if (active) {
      padThrottle = 0;
      padRudder = 0;
      window.usv.sendCmd(0, 0);
    }
  },
});
/** 右摇杆按下（R3）上一帧状态，用于边沿检测 */
let prevR3 = false;
/** 十字键上/下上一帧状态，用于边沿检测 */
let prevDpadUp = false;
let prevDpadDown = false;
/** View 键（保存 SLAM 数据）上一帧状态 */
let prevView = false;
/** Menu 键 / A / B 上一帧状态 */
let prevMenu = false;
let prevA = false;
let prevB = false;
/**
 * 按下 R3 必然会把摇杆带偏（手指发力），如果同一帧就接受平移，
 * 刚回正的视角会立刻被"自由视角"，看起来像 R3 没生效。
 * 所以要等摇杆真正回到中位，才重新接受平移输入。
 */
let r3NeedsRecenter = false;
/** 未装回滚保险时的二次确认窗口（epoch ms）；0 表示不在确认态 */
let fwConfirmUntil = 0;
let fwLabelTimer = 0;

function pollPad(): void {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads && pads[0] ? pads[0] : null;
  state.padId = pad ? pad.id : '';
  if (!pad) {
    padThrottle = 0;
    padRudder = 0;
    prevR3 = false;
    prevDpadUp = false;
    prevDpadDown = false;
    prevView = false;
    r3NeedsRecenter = false;
    return;
  }
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  // 菜单模式下左摇杆用于选控件；保存对话框弹出期间也一样，
  // 否则原生对话框挡住窗口时摇杆仍在改油门，看不到屏幕很危险
  if (padMenu.isActive || modalBusy) {
    padThrottle = 0;
    padRudder = 0;
  } else {
    padThrottle = deadzoneRescale(-y, state.deadzone);
    padRudder = deadzoneRescale(x, state.deadzone);
  }
}

/** 右摇杆 / 肩键 / 扳机 / 十字键 → 地图视角与解锁急停。dtMs 用于把「按住」换算成连续动作 */
function pollMapPad(dtMs: number): void {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads && pads[0] ? pads[0] : null;
  if (!pad) {
    prevR3 = false;
    prevDpadUp = false;
    prevDpadDown = false;
    prevView = false;
    prevMenu = false;
    prevA = false;
    prevB = false;
    return;
  }
  const dt = Math.min(0.05, dtMs / 1000);
  const now = performance.now();

  // ---- Menu 键（buttons[9]）：进出菜单模式 ----
  const menu = !!pad.buttons[9]?.pressed;
  if (menu && !prevMenu) padMenu.toggle();
  prevMenu = menu;

  // ---- 菜单模式：左摇杆选控件，A 确认，B 退出；其余控制全部旁路 ----
  if (padMenu.isActive) {
    const nx = deadzoneRescale(pad.axes[0] ?? 0, 0.35);
    const ny = deadzoneRescale(pad.axes[1] ?? 0, 0.35);
    padMenu.move(nx, ny, now);

    const a = !!pad.buttons[0]?.pressed;
    if (a && !prevA) padMenu.activate();
    prevA = a;

    const b = !!pad.buttons[1]?.pressed;
    if (b && !prevB) padMenu.exit();
    prevB = b;

    // <select> 用方向键改值（原生下拉无法用代码弹出）
    const sel = document.querySelector('.nav-focus');
    const down = !!pad.buttons[13]?.pressed;
    const up = !!pad.buttons[12]?.pressed;
    if (sel instanceof HTMLSelectElement) {
      if (down && !prevDpadDown) padMenu.adjust(1);
      if (up && !prevDpadUp) padMenu.adjust(-1);
    }
    // 边沿状态每帧都要更新：否则在 <select> 外松开十字键，prev 会永远停在 true，
    // 下次回到 <select> 时第一次按键会被漏掉
    prevDpadDown = down;
    prevDpadUp = up;
    return;
  }
  prevA = !!pad.buttons[0]?.pressed;
  prevB = !!pad.buttons[1]?.pressed;

  // ---- R3（右摇杆按下，标准映射 buttons[11]）：视角三态循环 ----
  const r3 = !!pad.buttons[11]?.pressed;
  if (r3 && !prevR3) {
    slamMap.cycleView();
    r3NeedsRecenter = true;
  }
  prevR3 = r3;

  // ---- 右摇杆：平移 ----
  const rawX = pad.axes[2] ?? 0;
  const rawY = pad.axes[3] ?? 0;
  // 回中判定用原始轴值，避免死区把"其实还在偏"误判成中位
  if (r3NeedsRecenter && !r3 && Math.abs(rawX) < 0.2 && Math.abs(rawY) < 0.2) {
    r3NeedsRecenter = false;
  }
  const canPan = !r3 && !r3NeedsRecenter;
  const rx = canPan ? deadzoneRescale(rawX, 0.14) : 0;
  const ry = canPan ? deadzoneRescale(rawY, 0.14) : 0;
  if (rx !== 0 || ry !== 0) {
    const speed = 0.55 * Math.max(200, Math.min(el.mapWrap.clientWidth, el.mapWrap.clientHeight));
    slamMap.panByScreenPx(rx * speed * dt, ry * speed * dt);
  }

  // ---- LB / RB：逆 / 顺时针旋转 ----
  const lb = pad.buttons[4]?.pressed ? 1 : 0;
  const rb = pad.buttons[5]?.pressed ? 1 : 0;
  if (lb || rb) slamMap.rotateBy((lb - rb) * 1.7 * dt);

  // ---- LT / RT：缩小 / 放大（扳机是模拟量，按深度调速率） ----
  const lt = pad.buttons[6]?.value ?? 0;
  const rt = pad.buttons[7]?.value ?? 0;
  if (lt > 0.06 || rt > 0.06) slamMap.zoomBy(Math.exp((rt - lt) * 2.0 * dt));

  // ---- 十字键 ↑ / ↓：解锁、急停（边沿触发，避免按住连发） ----
  const up = !!pad.buttons[12]?.pressed;
  if (up && !prevDpadUp) toggleArm();
  prevDpadUp = up;

  const down = !!pad.buttons[13]?.pressed;
  if (down && !prevDpadDown) toggleEstop();
  prevDpadDown = down;

  // ---- View 键：导出 SLAM 数据（边沿触发） ----
  const view = !!pad.buttons[8]?.pressed;
  if (view && !prevView) void saveSlam();
  prevView = view;
}

/* ---------------- 指令下发（30Hz 兼心跳） ---------------- */

/**
 * 心跳必须独立于渲染循环：窗口最小化时 Chromium 会停掉 requestAnimationFrame，
 * 若把指令挂在 rAF 上，30Hz 心跳就断了，Supervisor 的 500ms UI 超时会把人
 * 误判成「UI 卡死」而撤防。setInterval + backgroundThrottling:false 才能持续。
 */
function sendLoop(): void {
  const now = Date.now();
  // 门限 20ms：Windows 定时器粒度 15.6ms，16ms 的 tick 落在 31.2ms 上，
  // 门限若取 33ms 就会漏到下一拍（46.8ms ≈ 21Hz）；20ms 能稳定在 ~32Hz。
  if (now - state.lastSend >= 20) {
    state.lastSend = now;
    window.usv.sendCmd(padThrottle, padRudder);
  }
}

/* ---------------- 渲染 ---------------- */

function drawLoop(): void {
  const now = performance.now();
  const dtMs = state.lastFrameAt ? now - state.lastFrameAt : 16;
  state.lastFrameAt = now;

  pollMapPad(dtMs);

  const r = fitCanvas(el.canvas, el.radarWrap);
  radar.render(ctx, r.px, r.dpr);

  const m = fitCanvasRect(el.mapCanvas, el.mapWrap);
  slamMap.render(mapCtx, m.w, m.h, m.dpr);

  renderControls();
  renderLinkHint();
  renderRadarInfo();
  renderMapInfo();

  requestAnimationFrame(drawLoop);
}

/**
 * 渲染解锁/急停按钮。警示时整块控件被替换成「⚠ + 提示」，而不只是改文字，
 * 这样在窄条按钮里也能一眼看到是拒绝执行而不是状态变化。
 */
function paintBtn(
  btn: HTMLButtonElement,
  kind: 'arm' | 'estop',
  warn: boolean,
  label: string,
  keySvg: string,
): void {
  btn.classList.toggle('warn', warn);
  const html = warn
    ? `<span class="btn-label">请先将左摇杆回中</span><span class="btn-key">${WARN_SVG}</span>`
    : `<span class="btn-label">${label}</span><span class="btn-key">${keySvg}</span>`;
  // 只在内容变化时重写，避免每帧重建 DOM
  if (btn.dataset.html !== html) {
    btn.dataset.html = html;
    btn.innerHTML = html;
  }
  btn.dataset.kind = kind;
}

/** 升级按钮：保险未装时切成黄色警示 + 两段确认文案 */
function paintUpgradeBtn(): void {
  const warn = Date.now() < fwConfirmUntil;
  el.fwBtn.classList.toggle('warn', warn);
  const text = warn ? '⚠ 未装回滚保险，再点一次确认' : '选择固件包并升级';
  if (el.fwBtn.textContent !== text) el.fwBtn.textContent = text;
}

function renderControls(): void {
  el.thrVal.textContent = `${(padThrottle * 100).toFixed(0)}%`;
  el.rudVal.textContent = `${(padRudder * 30).toFixed(0)}°`;
  el.thrBar.style.transform = `scaleY(${Math.abs(padThrottle)})`;
  el.rudBar.style.transform = `scaleX(${Math.abs(padRudder)})`;

  el.armBtn.classList.toggle('on', state.arm);
  el.armBtn.disabled = !state.connected;
  paintBtn(
    el.armBtn,
    'arm',
    Date.now() < state.armWarnUntil,
    state.arm ? '已解锁' : '解锁 ARM',
    ARM_KEY_SVG,
  );

  el.estopBtn.classList.toggle('on', state.estop);
  paintBtn(
    el.estopBtn,
    'estop',
    Date.now() < state.estopWarnUntil,
    state.estop ? '急停中' : '急停',
    ESTOP_KEY_SVG,
  );

  el.linkPill.textContent = state.connected ? `链路：已连接 ${state.target}` : `链路：未连接 ${state.target}`;
  el.linkPill.className = `pill ${state.connected ? 'ok' : 'bad'}`;
  el.padPill.textContent = state.padId ? `手柄：${state.padId.slice(0, 28)}` : '手柄：未检测到';
  el.padPill.className = `pill ${state.padId ? 'ok' : 'idle'}`;
  el.shipPill.textContent = state.ships.length ? `在场船只：${state.ships.length}` : '在场船只：0';
  el.shipPill.className = `pill ${state.ships.length ? 'ok' : 'idle'}`;
}

/** 断链引导：超过 3s 仍未恢复就给出船端一键拉起命令 */
function renderLinkHint(): void {
  if (state.connected) {
    el.linkHint.textContent = '已连接';
    el.linkHint.classList.remove('warn');
    if (sopEl && sopEl.open) sopEl.open = false;
    return;
  }

  const secs = state.disconnectedSince ? (Date.now() - state.disconnectedSince) / 1000 : 0;
  el.linkHint.classList.add('warn');

  if (secs < 3 || Date.now() - state.lastClickAt < 1500) {
    el.linkHint.textContent = '正在重连…';
    return;
  }

  // 断链超过 3s：自动展开排查步骤，并给出与状态相关的判断
  if (sopEl && !sopEl.open) sopEl.open = true;
  const err = state.lastLinkError;
  const why = err
    ? `最近错误：${err}`
    : '无 socket 错误（多为船端服务未启动或不在同一网段）';
  el.linkHint.textContent = `已断开 ${secs.toFixed(0)}s · ${state.target} · ${why}`;
}

function renderRadarInfo(): void {
  const age = radar.ageMs;
  if (!Number.isFinite(age)) {
    el.radarInfo.textContent = '等待点云…';
    return;
  }
  const hz = radar.scanRateHz || scanHz();
  const text =
    `${radar.lastCount} 点 · ${radar.filled}/720 桶 · ${hz.toFixed(1)} 圈/s · ${radar.range.toFixed(1)} m`;
  el.radarInfo.textContent = age > 3000 ? `${text} · ⚠ 已停止` : text;
}

function scanHz(): number {
  const t = state.scanTimes;
  if (t.length < 2) return 0;
  const dt = ((t[t.length - 1] ?? 0) - (t[0] ?? 0)) / 1000;
  return dt > 0 ? (t.length - 1) / dt : 0;
}

function renderMapInfo(): void {
  const age = slamMap.lastMapAt ? Date.now() - slamMap.lastMapAt : Infinity;
  if (!Number.isFinite(age)) {
    el.mapInfo.textContent = '等待 SLAM 地图…';
    return;
  }
  const p = state.pose;
  const v = slamMap.viewInfo;
  const bits = [
    `占据格子 ${slamMap.observed}`,
    p ? `位姿 (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) ${((p.yaw * 180) / Math.PI).toFixed(1)}°` : '无位姿',
  ];
  if (p?.rmse != null) bits.push(`残差 ${(p.rmse * 100).toFixed(1)}cm`);
  if (p?.inlier != null) bits.push(`内点 ${(p.inlier * 100).toFixed(0)}%`);
  const modeText =
    v.mode === 'free'
      ? `自由视角 ${v.zoom.toFixed(2)}× ${v.rotDeg.toFixed(0)}°`
      : v.mode === 'headUp'
        ? `船头朝上 ${v.zoom.toFixed(2)}×`
        : '跟随船';
  bits.push(modeText);
  if (age > 3000) bits.push('⚠ 地图已停止更新');
  el.mapInfo.textContent = bits.join(' · ');
}

/* ---------------- 业务事件 ---------------- */

/** `CAP_WATCHDOG` 是 0.4.0 才加进 HELLO_ACK 的；更老的固件装了保险也报不出来 */
const WATCHDOG_CAP_MIN_FW = [0, 4, 0] as const;

function fwAtLeast(ver: string | null, min: readonly number[]): boolean {
  if (!ver) return false;
  const p = ver.split('.').map((v) => Number(v) || 0);
  for (let i = 0; i < min.length; i++) {
    const a = p[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

window.usv.onLink((link) => {
  state.connected = link.connected;
  state.target = `${link.host}:${link.port}`;
  state.disconnectedSince = link.connected ? null : (state.disconnectedSince ?? Date.now());
  state.lastLinkError = link.lastError;
  el.stErr.textContent = `${link.crcErrors}`;
  el.stUp.textContent = link.upMs != null ? `${link.upMs.toFixed(1)} ms` : '—';
  el.stDown.textContent = link.downMs != null ? `${link.downMs.toFixed(1)} ms` : '—';
    el.stUp.title = link.rttMs != null ? `往返 ${link.rttMs} ms（对称假设下各取一半）` : '';
    el.stDown.title = el.stUp.title;
  el.fwVersion.textContent = link.fwVersion
    ? `船端固件 ${link.fwVersion} · caps=0x${link.caps.toString(16)}`
    : '船端固件：未知（未握手，按 v1 运行）';

  // 回滚保险状态。三种可能必须区分开，否则会把「老固件不会上报」误报成「未装」：
  //   已装  → 绿
  //   会上报且明确未装 → 红
  //   固件太老根本不上报 → 黄（装了也看不见，无法确认）
  state.watchdogArmed = link.connected && link.watchdogArmed;
  state.watchdogReportable = fwAtLeast(link.fwVersion, WATCHDOG_CAP_MIN_FW);
  if (!link.connected) {
    el.fwWatchdog.textContent = '启动回滚保险：—';
    el.fwWatchdog.className = 'mono muted';
  } else if (link.watchdogArmed) {
    el.fwWatchdog.textContent = '启动回滚保险：已装 ✓';
    el.fwWatchdog.className = 'mono t-ok';
  } else if (!state.watchdogReportable) {
    el.fwWatchdog.textContent =
      `启动回滚保险：无法确认（船端 ${link.fwVersion ?? '未握手'} 不上报此能力）`;
    el.fwWatchdog.className = 'mono t-warn';
  } else {
    el.fwWatchdog.textContent = '启动回滚保险：未装（坏版本会失联，需先 ssh 装）';
    el.fwWatchdog.className = 'mono t-bad';
  }
  fwConfirmUntil = 0;
  paintUpgradeBtn();
});

window.usv.onFirmware((fw) => {
  const pct = fw.total ? Math.floor((fw.received * 100) / fw.total) : 0;
  el.fwFill.style.width = `${pct}%`;
  el.fwStatus.textContent =
    `${fw.phase} ${pct}%` + (fw.message ? ` · ${fw.message}` : '');
  if (fw.done) {
    el.fwBtn.disabled = false;
    el.fwStatus.textContent += fw.ok ? ' ✅' : ' ❌';
  }
});

el.radarRange.addEventListener('change', () => {
  radar.setRange(Number(el.radarRange.value));
});

el.reconnectBtn.addEventListener('click', () => {
  // 保留首次断链时间，便于判断总停机时长；只更新提示文字
  state.lastClickAt = Date.now();
  el.linkHint.textContent = '正在重连…';
  window.usv.reconnect();
});

// SOP 命令一键复制
for (const code of Array.from(document.querySelectorAll<HTMLElement>('code.copy'))) {
  code.title = '点击复制';
  code.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent?.trim() ?? '');
      code.classList.add('copied');
      const old = code.textContent;
      code.textContent = '已复制 ✓';
      setTimeout(() => {
        code.classList.remove('copied');
        code.textContent = old;
      }, 900);
    } catch {
      /* 剪贴板不可用时保持原样，用户可手动选中 */
    }
  });
}

// 断链时自动展开 SOP，恢复后收起
const sopEl = document.getElementById('sop') as HTMLDetailsElement | null;

el.fwBtn.addEventListener('click', async () => {
  if (!state.connected) {
    el.fwStatus.textContent = '未连接船端';
    return;
  }
  // 保险没装（或无法确认）时要求点两次：第一次只把按钮变成警示，5s 内再点才真的去选包
  if (!state.watchdogArmed && Date.now() > fwConfirmUntil) {
    fwConfirmUntil = Date.now() + 5000;
    paintUpgradeBtn();
    el.fwStatus.textContent = state.watchdogReportable
      ? '船端未装启动回滚保险：升级失败可能再也连不上，只能上台处理。确要继续请再点一次。'
      : '船端固件不上报回滚保险状态，无法确认是否已装。升级失败可能再也连不上，只能上台处理。确要继续请再点一次。';
    clearTimeout(fwLabelTimer);
    fwLabelTimer = window.setTimeout(paintUpgradeBtn, 5100);
    return;
  }
  fwConfirmUntil = 0;
  paintUpgradeBtn();

  const file = await window.usv.pickFirmware();
  if (!file) return;
  el.fwBtn.disabled = true;
  el.fwFill.style.width = '0%';
  el.fwStatus.textContent = `准备升级：${file.split('\\').pop() ?? file}`;
  const r = await window.usv.updateFirmware(file);
  el.fwStatus.textContent = r.ok ? `升级完成：${r.message}` : `升级失败：${r.message}`;
  el.fwBtn.disabled = false;
});

window.usv.onStatus((st) => {
  state.status = st;
  // 雷达掉线时清空暂留点，避免把过时数据当成现场画面
  if (!st.lidarOk && state.lidarWasOk) radar.reset();
  state.lidarWasOk = st.lidarOk;
  el.stHz.textContent = `${st.loopHz.toFixed(1)} Hz`;
  el.stThr.textContent = `${st.throttlePct >= 0 ? '+' : ''}${st.throttlePct.toFixed(1)}%`;
  el.stDir.textContent = ['停', '前进', '后退', '急停'][st.direction] ?? '?';
  const flags: string[] = [];
  if (st.armed) flags.push('已解锁');
  if (st.estop) flags.push('急停');
  if (st.failsafe) flags.push('失联保护');
  flags.push(st.lidarOk ? '雷达在线' : '雷达离线');
  el.stFlags.textContent = flags.join('|') || '—';
  el.stPts.textContent = `${st.pointsLast} / ${st.scansTotal}`;
  el.stErr.textContent = `${st.rxErrors}`;
});

window.usv.onScan((scan) => {
  radar.push(scan);
  state.scanTimes.push(Date.now());
  if (state.scanTimes.length > 10) state.scanTimes.shift();
});

window.usv.onShips((ships) => {
  state.ships = ships;
  el.ships.textContent = ships.length
    ? ships.map((s) => `${s.name} ${s.host}:${s.tcpPort} ${s.state}`).join('\n')
    : '（未发现）';
});

window.usv.onPose((pose) => {
  state.pose = pose;
  slamMap.pushPose(pose);
  el.pose.textContent = `x=${pose.x.toFixed(2)} m  y=${pose.y.toFixed(2)} m  yaw=${((pose.yaw * 180) / Math.PI).toFixed(1)}°`;
  const extra: string[] = [pose.status];
  if (pose.rmse != null) extra.push(`残差 ${(pose.rmse * 100).toFixed(1)}cm`);
  if (pose.inlier != null) extra.push(`内点 ${(pose.inlier * 100).toFixed(0)}%`);
  if (pose.scans != null) extra.push(`${pose.scans} 圈`);
  el.poseStatus.textContent = extra.join(' · ');
});

window.usv.onMap((m: MapView) => {
  slamMap.pushMap(m);
});

window.usv.onAlgoHealth((h: AlgoHealthView) => {
  el.algo.textContent = h.running
    ? `运行中 · 已处理 ${h.scansSent} 圈 · 重启 ${h.restarts} 次`
    : `未运行 · 重启 ${h.restarts} 次`;
});

/* ---------------- 交互 ---------------- */

el.armBtn.addEventListener('click', () => toggleArm());
el.estopBtn.addEventListener('click', () => toggleEstop());

/** 摇杆是否已回到中位（用于解锁 / 解除急停前的拦截） */
function sticksCentered(): boolean {
  return Math.abs(padThrottle) <= 0.15 && Math.abs(padRudder) <= 0.15;
}

/** 解锁/撤防。解锁前要求摇杆回中，避免一解锁就满舵窜出去 */
function toggleArm(): void {
  if (!state.arm && !sticksCentered()) {
    state.armWarnUntil = Date.now() + 1800;
    return;
  }
  state.arm = !state.arm;
  state.armWarnUntil = 0;
  window.usv.setArm(state.arm);
}

/** 急停。踩下不需要条件；**解除**急停时同样要求摇杆回中，否则一解除就带残留油门窜出去 */
function toggleEstop(): void {
  if (state.estop && !sticksCentered()) {
    state.estopWarnUntil = Date.now() + 1800;
    return;
  }
  state.estop = !state.estop;
  state.estopWarnUntil = 0;
  window.usv.setEstop(state.estop);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    state.estop = !state.estop;
    window.usv.setEstop(state.estop);
  }
});

window.addEventListener('beforeunload', () => {
  window.usv.setArm(false);
  window.usv.sendCmd(0, 0);
});

/**
 * 右栏覆盖式滚动指示条。
 * Windows 的经典滚动条会实打实占掉 ~13px 宽度，且带动整个右栏内容抖动，
 * 所以原生条宽度设为 0，另画一条绝对定位的半透明竖条覆盖在内容右侧。
 */
function setupOverlayScrollbar(): void {
  const host = el.telemetry;
  const scroller = el.telemetryScroll;
  if (!host || !scroller) return;

  const bar = document.createElement('div');
  bar.className = 'sb';
  host.appendChild(bar);

  let hideTimer = 0;
  const sync = (): void => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 1) {
      bar.classList.remove('on');
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const r = scroller.getBoundingClientRect();
    const trackH = r.height;
    const thumbH = Math.max(trackH * 0.08, (scroller.clientHeight / scroller.scrollHeight) * trackH);
    bar.style.height = `${thumbH}px`;
    bar.style.top = `${r.top - hostRect.top + (scroller.scrollTop / max) * (trackH - thumbH)}px`;
    bar.style.right = `${hostRect.right - r.right + 2}px`;
    bar.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => bar.classList.remove('on'), 900);
  };

  scroller.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  // 手柄导航用 scrollIntoView 滚动，同样走 scroll 事件
  sync();
}

// 清空地图按钮（仅鼠标 / 手柄菜单 A 键）
function clearMap(): void {
  slamMap.reset();
  el.pose.textContent = '等待位姿…';
  el.poseStatus.textContent = '—';
  el.slamIo.textContent = '';
  window.usv.clearMap();
}
el.clearMapBtn.addEventListener('click', clearMap);

// 原生保存对话框打开期间禁止摇杆驱动（saveSlam / saveLog 共用）
let modalBusy = false;

// 保存 SLAM 数据（鼠标 / 手柄 View 键）：走主进程的保存对话框
async function saveSlam(): Promise<void> {
  if (modalBusy) return;
  modalBusy = true;
  el.saveSlamBtn.disabled = true;
  el.slamIo.textContent = '正在准备导出…';
  try {
    const r = await window.usv.saveSlam();
    if (r.canceled) {
      el.slamIo.textContent = '已取消保存';
    } else if (r.ok) {
      const kb = Math.max(1, Math.round((r.bytes ?? 0) / 1024));
      el.slamIo.textContent = `已保存 ${r.message}（${kb} KB）`;
    } else {
      el.slamIo.textContent = r.message;
    }
    el.slamIo.className = `mono ${r.ok ? 't-ok' : r.canceled ? 'muted' : 't-bad'}`;
  } finally {
    modalBusy = false;
    el.saveSlamBtn.disabled = false;
  }
}
el.saveSlamBtn.addEventListener('click', () => void saveSlam());
el.saveSlamKey.innerHTML = xboxIcon('view', { size: 24, title: 'View 键：保存 SLAM 数据' });

/* ---------------- 会话日志 ---------------- */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 每 2 秒轮询一次日志状态（只读统计，不影响日志写入） */
async function refreshLog(): Promise<void> {
  try {
    const s = await window.usv.getLogStatus();
    const usable = s.enabled && !s.error;
    el.logOpenBtn.disabled = !s.dir;
    el.logSaveBtn.disabled = !usable;
    el.logInfo.title = s.dir ?? '';
    if (s.error) {
      el.logInfo.textContent = `记录失败：${s.error}`;
      el.logInfo.className = 'mono t-bad';
      return;
    }
    if (!s.enabled || !s.dir) {
      el.logInfo.textContent = s.dir ? '已停止记录' : '日志已关闭（--no-log）';
      el.logInfo.className = 'mono muted';
      return;
    }
    // 丢帧在面板上直接变成警示色：这比事后翻日志更早发现问题
    const lossy = s.statusGaps > 0;
    el.logInfo.className = `mono ${lossy ? 't-warn' : 'muted'}`;
    el.logInfo.textContent =
      `记录中 ${fmtDuration(s.durationMs)} · ${fmtBytes(s.bytes)} · ` +
      `STATUS ${s.statusRows} · 点云 ${s.scanRows} 圈 · 位姿 ${s.poseRows} · 事件 ${s.events}` +
      (lossy ? ` · 丢帧 ${s.statusGaps} 次（最长 ${s.maxStatusGapMs} ms）` : '');
  } catch {
    el.logInfo.textContent = '日志状态读取失败';
    el.logInfo.className = 'mono t-bad';
  }
}

async function openLogDir(): Promise<void> {
  try {
    const r = await window.usv.openLogDir();
    el.logIo.textContent = r.ok ? `已打开：${r.message}` : r.message;
    el.logIo.className = `mono ${r.ok ? 'muted' : 't-bad'}`;
  } catch (err) {
    el.logIo.textContent = `打开失败：${(err as Error).message}`;
    el.logIo.className = 'mono t-bad';
  }
}
el.logOpenBtn.addEventListener('click', () => void openLogDir());

async function saveLog(): Promise<void> {
  if (modalBusy) return;
  modalBusy = true;
  el.logSaveBtn.disabled = true;
  el.logIo.textContent = '正在打包日志…';
  try {
    const r = await window.usv.saveLog();
    if (r.canceled) {
      el.logIo.textContent = '已取消导出';
    } else if (r.ok) {
      el.logIo.textContent = `已导出 ${r.message}（${fmtBytes(r.bytes ?? 0)}）`;
    } else {
      el.logIo.textContent = r.message;
    }
    el.logIo.className = `mono ${r.ok ? 't-ok' : r.canceled ? 'muted' : 't-bad'}`;
  } catch (err) {
    el.logIo.textContent = `导出失败：${(err as Error).message}`;
    el.logIo.className = 'mono t-bad';
  } finally {
    modalBusy = false;
    el.logSaveBtn.disabled = false;
    void refreshLog();
  }
}
el.logSaveBtn.addEventListener('click', () => void saveLog());

void refreshLog();
window.setInterval(() => void refreshLog(), 2000);
setupOverlayScrollbar();

window.usv.getConfig().then((cfg) => {
  el.ships.dataset.algo = String(cfg.algo.enabled);
});

// 手柄采样与指令心跳走定时器（最小化/遮挡时也照常跑），渲染才走 rAF
window.setInterval(() => {
  pollPad();
  sendLoop();
}, 16);
requestAnimationFrame(drawLoop);
