import type { MapView, PoseView } from '../shared/api.js';

/** 视野半边长（米）：以地图中心为基准的可视半宽 */
const VIEW_SPAN_M = 9;
/** 轨迹最多保留点数（10Hz × 120s） */
const MAX_TRACK = 1200;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;

interface Frame {
  img: HTMLImageElement;
  size: number;
  resolution: number;
  origin: [number, number];
}

/** 视角模式：free 自由 · locked 跟随船（保留原角度）· headUp 跟随船且船头朝上 */
export type ViewMode = 'free' | 'locked' | 'headUp';

/**
 * SLAM 占据栅格 + 位姿 + 轨迹的俯视渲染。
 *
 * 地图由 Python 侧车以 RGBA PNG 推送；未知区域透明，所以深色 UI 能透出来。
 * 坐标系是「首帧为原点、x 前 y 左、逆时针」。
 *
 * R3 三态循环：
 *   free    → locked    （回跟随；保留当前自由视角的旋转角）
 *   locked  → headUp    （跟随 + 船头朝上；记住进入前的角度）
 *   headUp  → locked    （转回进入 headUp 前的角度）
 * 也就是说：**不管在哪，自由视角按一次永远先回 locked，不会直接跳到 headUp。**
 */
export class SlamMapView {
  private frame: Frame | null = null;
  private pendingData: string | null = null;
  private loading = false;
  private track: Array<[number, number]> = [];
  private pose: PoseView | null = null;

  private center = { x: 0, y: 0 };
  private zoom = 1;
  /** 世界系逆时针旋转量（屏幕上同样逆时针） */
  private rot = 0;
  private mode: ViewMode = 'locked';
  /** 进入 headUp 之前的锁定角度，退出时用来还原 */
  private savedRot = 0;

  /** 最近一次渲染用的标尺，供像素→世界换算 */
  private lastScale = 20;

  observed = 0;
  lastMapAt = 0;
  lastStatus = '—';

  get isFree(): boolean {
    return this.mode === 'free';
  }

  get viewInfo(): { zoom: number; rotDeg: number; mode: ViewMode } {
    return { zoom: this.zoom, rotDeg: (this.rot * 180) / Math.PI, mode: this.mode };
  }

  pushMap(m: MapView): void {
    if (m.cleared || !m.png) {
      this.reset();
      this.lastMapAt = Date.now();
      return;
    }
    this.observed = m.observed;
    this.lastMapAt = Date.now();
    this.pendingData = `data:image/png;base64,${m.png}`;
    this.frame = this.frame
      ? { ...this.frame, size: m.size, resolution: m.resolution, origin: m.origin }
      : { img: new Image(), size: m.size, resolution: m.resolution, origin: m.origin };
    this.loadImage();
  }

  /** 同一时刻只解码一张，避免地图快照堆积 */
  private loadImage(): void {
    if (this.loading || !this.pendingData || !this.frame) return;
    const data = this.pendingData;
    this.pendingData = null;
    this.loading = true;
    const img = this.frame.img;
    img.onload = () => {
      this.loading = false;
      this.loadImage();
    };
    img.onerror = () => {
      this.loading = false;
    };
    img.src = data;
  }

  pushPose(p: PoseView): void {
    this.pose = p;
    this.lastStatus = p.status;
    const last = this.track[this.track.length - 1];
    if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > 0.03) {
      this.track.push([p.x, p.y]);
      if (this.track.length > MAX_TRACK) this.track.shift();
    }
    if (this.mode !== 'free') {
      // 跟随视角：中心平滑跟随船
      this.center.x += (p.x - this.center.x) * 0.08;
      this.center.y += (p.y - this.center.y) * 0.08;
    }
    if (this.mode === 'headUp') {
      // 船头朝上：屏幕角 = -(yaw + rot) = 0（向上）→ rot = π/2 - yaw
      this.rot = this.normAngle(Math.PI / 2 - p.yaw);
    }
  }

  private normAngle(a: number): number {
    let v = a;
    while (v > Math.PI) v -= 2 * Math.PI;
    while (v < -Math.PI) v += 2 * Math.PI;
    return v;
  }

  /** 右摇杆平移：参数是屏幕像素位移，内部换算成世界位移并抵消旋转 */
  panByScreenPx(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.mode = 'free';
    const k = this.lastScale;
    // 屏幕位移 → 旋转前坐标（屏幕 y 向下，故取负）
    const sx = dx / k;
    const sy = -dy / k;
    // 反向旋转回世界系
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    this.center.x += sx * c + sy * s;
    this.center.y += -sx * s + sy * c;
  }

  zoomBy(factor: number): void {
    if (factor === 1) return;
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * factor));
  }

  rotateBy(rad: number): void {
    if (rad === 0) return;
    // 在 headUp 状态下用户主动旋转，就退出 headUp（否则会被每帧覆写）
    if (this.mode === 'headUp') this.mode = 'locked';
    this.rot = this.normAngle(this.rot + rad);
  }

  /**
   * R3：视角三态循环。
   *   free   → locked（回跟随，保留当前旋转角）
   *   locked → headUp（跟随 + 船头朝上，记住进入前的角度）
   *   headUp → locked（转回进入 headUp 前的角度）
   */
  cycleView(): void {
    if (this.mode === 'free') {
      this.mode = 'locked';
      if (this.pose) {
        this.center.x = this.pose.x;
        this.center.y = this.pose.y;
      }
      return;
    }
    if (this.mode === 'locked') {
      this.savedRot = this.rot;
      this.mode = 'headUp';
      if (this.pose) this.rot = this.normAngle(Math.PI / 2 - this.pose.yaw);
      return;
    }
    // headUp → locked
    this.rot = this.savedRot;
    this.mode = 'locked';
  }

  reset(): void {
    this.track = [];
    this.pose = null;
    this.frame = null;
    this.observed = 0;
    this.mode = 'locked';
    this.rot = 0;
    this.savedRot = 0;
    this.zoom = 1;
    this.center.x = 0;
    this.center.y = 0;
  }

  get hasMap(): boolean {
    return this.frame !== null && this.frame.img.complete && this.frame.img.naturalWidth > 0;
  }

  render(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number): void {
    const cx = w / 2;
    const cy = h / 2;
    const scale = (Math.min(w, h) / (VIEW_SPAN_M * 2)) * this.zoom;
    this.lastScale = scale;

    const w2c = (wx: number, wy: number): [number, number] => {
      const dx = wx - this.center.x;
      const dy = wy - this.center.y;
      const c = Math.cos(this.rot);
      const s = Math.sin(this.rot);
      return [cx + (dx * c - dy * s) * scale, cy - (dx * s + dy * c) * scale];
    };

    ctx.clearRect(0, 0, w, h);

    /* ---- 世界坐标系内绘制（y 向上） ---- */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, -1);
    ctx.rotate(this.rot);
    ctx.scale(scale, scale);
    ctx.translate(-this.center.x, -this.center.y);

    // 背景网格（2m 一格），覆盖当前可见范围
    const halfW = w / 2 / scale;
    const halfH = h / 2 / scale;
    const r = Math.hypot(halfW, halfH) + 2;
    const gx0 = Math.floor((this.center.x - r) / 2) * 2;
    const gx1 = this.center.x + r;
    const gy0 = Math.floor((this.center.y - r) / 2) * 2;
    const gy1 = this.center.y + r;
    ctx.strokeStyle = 'rgba(56, 68, 92, 0.45)';
    ctx.lineWidth = (1 * dpr) / scale;
    ctx.beginPath();
    for (let x = gx0; x <= gx1; x += 2) {
      ctx.moveTo(x, gy0);
      ctx.lineTo(x, gy1);
    }
    for (let y = gy0; y <= gy1; y += 2) {
      ctx.moveTo(gx0, y);
      ctx.lineTo(gx1, y);
    }
    ctx.stroke();

    // 占据栅格
    if (this.hasMap && this.frame) {
      const f = this.frame;
      const span = f.size * f.resolution;
      const [x0, y0] = f.origin;
      ctx.save();
      // 图像左上角 = 世界 (x0, y0+span)，再翻转 y 让 drawImage 向世界下方铺开
      ctx.translate(x0, y0 + span);
      ctx.scale(1, -1);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(f.img, 0, 0, span, span);
      ctx.restore();
    }

    // 原点标记（SLAM 首帧位置）
    ctx.strokeStyle = 'rgba(120, 140, 170, 0.5)';
    ctx.lineWidth = (1 * dpr) / scale;
    ctx.beginPath();
    ctx.moveTo(-0.25, 0);
    ctx.lineTo(0.25, 0);
    ctx.moveTo(0, -0.25);
    ctx.lineTo(0, 0.25);
    ctx.stroke();

    // 轨迹
    if (this.track.length > 1) {
      ctx.strokeStyle = 'rgba(96, 214, 255, 0.85)';
      ctx.lineWidth = (1.6 * dpr) / scale;
      ctx.beginPath();
      this.track.forEach(([wx, wy], i) => {
        if (i === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      });
      ctx.stroke();
    }

    ctx.restore();

    /* ---- 屏幕坐标系内绘制 ---- */
    if (this.pose) {
      const [bx, by] = w2c(this.pose.x, this.pose.y);
      // 世界航向 + 视角旋转 → 屏幕角度（屏幕 y 向下，故取负）
      const hd = -(this.pose.yaw + this.rot);
      const L = 15 * dpr;
      const W = 9 * dpr;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(hd);
      ctx.fillStyle = this.poseColor();
      ctx.beginPath();
      ctx.moveTo(L, 0);
      ctx.lineTo(-W * 0.7, W * 0.62);
      ctx.lineTo(-W * 0.7, -W * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 比例尺
    const barM = 2;
    const barPx = barM * scale;
    ctx.strokeStyle = 'rgba(150, 165, 190, 0.9)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(12 * dpr, h - 14 * dpr);
    ctx.lineTo(12 * dpr + barPx, h - 14 * dpr);
    ctx.stroke();
    ctx.fillStyle = 'rgba(160, 175, 200, 0.95)';
    ctx.font = `${11 * dpr}px Consolas, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`${barM} m`, 14 * dpr, h - 20 * dpr);

    // 左上角：标题 + 视角状态（三种模式都有标签，不留空白）
    const fs = Math.max(10, Math.min(w, h) * 0.019);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${fs}px Consolas, monospace`;
    ctx.fillStyle = 'rgba(127, 144, 165, 0.95)';
    ctx.fillText('SLAM 实时地图', 12 * dpr, 12 * dpr + fs);

    let modeText: string;
    let modeColor: string;
    if (this.mode === 'free') {
      modeText = `自由视角  ${this.zoom.toFixed(2)}×  ${((this.rot * 180) / Math.PI).toFixed(0)}°`;
      modeColor = 'rgba(255, 176, 32, 0.95)';
    } else if (this.mode === 'headUp') {
      modeText = `船头朝上  ${this.zoom.toFixed(2)}×`;
      modeColor = 'rgba(96, 214, 255, 0.95)';
    } else {
      modeText = `跟随锁定  ${this.zoom.toFixed(2)}×`;
      modeColor = 'rgba(74, 222, 128, 0.95)';
    }
    ctx.fillStyle = modeColor;
    ctx.fillText(modeText, 12 * dpr, 12 * dpr + fs * 2.7);
  }

  private poseColor(): string {
    const s = (this.pose?.status ?? '').toUpperCase();
    if (s.startsWith('TRACKING')) return 'rgba(74, 222, 128, 0.95)';
    if (s.startsWith('INITIALIZED') || s.startsWith('INITIALIZING')) return 'rgba(250, 204, 21, 0.95)';
    return 'rgba(248, 113, 113, 0.95)';
  }
}
