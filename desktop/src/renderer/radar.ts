import type { ScanView } from '../shared/api.js';

const AUTO_RINGS_M = [2, 3, 4, 6, 8, 12];

/** 角度桶：0.5°/桶（C1 角分辨率约 0.72°，一个桶基本只落一个点） */
const BUCKETS = 720;
const BUCKET_RAD = (Math.PI * 2) / BUCKETS;
/** 超过这个时间未更新的点开始变暗（毫秒） */
const STALE_MS = 1500;
const MAX_ALPHA_AGE_MS = 6000;

/**
 * PPI 雷达视图。
 *
 * 采用**角度桶暂留**：每个 0.5° 桶保存最近一次落在该角度上的点，
 * 只有该角度被新数据覆盖时才替换。这样即使某圈漏点、
 * 或雷达圈率低于刷新率，画面也不会「整圈闪烁 / 只有零星点」。
 *
 * 坐标约定：`anglesRad` 是 C1 原始角度——0=正前、**顺时针**增大。
 * 俯视图里顺时针 = 屏幕上的「上 → 右 → 下 → 左」，所以绘制用 `+sin`；
 * 若写成 `-sin`，星避障物会跑到左舷去（整幅画面镜像）。
 */
export class RadarView {
  private rangeAt = new Float32Array(BUCKETS);
  private qualityAt = new Uint8Array(BUCKETS);
  private updatedAt = new Float64Array(BUCKETS);

  private rangeM = 3;
  private fixedRangeM = 3;
  private p95 = 0;
  private lastFill = 0;
  private rateHz = 0;

  lastCount = 0;
  lastAt = 0;
  /** 当前画面上有效的桶数 */
  filled = 0;

  setRange(mode: number): void {
    this.fixedRangeM = mode;
    if (mode > 0) this.rangeM = mode;
  }

  reset(): void {
    this.rangeAt.fill(0);
    this.qualityAt.fill(0);
    this.updatedAt.fill(0);
    this.filled = 0;
  }

  push(scan: ScanView): void {
    const now = Date.now();
    const n = scan.count;
    const ranges = scan.rangesM;
    const angles = scan.angles;
    const quals = scan.qualities;

    for (let i = 0; i < n; i++) {
      const r = ranges[i] ?? 0;
      if (r <= 0) continue;
      const a = angles[i] ?? 0;
      let b = Math.round(a / BUCKET_RAD) % BUCKETS;
      if (b < 0) b += BUCKETS;
      // 暂留：只有更新的数据才覆盖同一角度的旧点
      this.rangeAt[b] = r;
      this.qualityAt[b] = quals[i] ?? 0;
      this.updatedAt[b] = now;
    }

    this.lastCount = n;
    this.lastAt = now;
    if (scan.rateHz && scan.rateHz > 0) this.rateHz = scan.rateHz;

    // 每 500ms 重算一次有效桶数与分位数，避免每帧遍历
    if (now - this.lastFill > 500) {
      this.lastFill = now;
      this.recompute();
    }
  }

  private recompute(): void {
    let filled = 0;
    const sample: number[] = [];
    for (let i = 0; i < BUCKETS; i++) {
      const r = this.rangeAt[i] ?? 0;
      if (r > 0) {
        filled++;
        if (sample.length < 400) sample.push(r);
      }
    }
    this.filled = filled;
    if (sample.length) {
      sample.sort((a, b) => b - a);
      this.p95 = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.05))] ?? 0;
    }
  }

  get ageMs(): number {
    return this.lastAt ? Date.now() - this.lastAt : Number.POSITIVE_INFINITY;
  }

  get range(): number {
    return this.rangeM;
  }

  get scanRateHz(): number {
    return this.rateHz;
  }

  render(ctx: CanvasRenderingContext2D, size: number, dpr: number): void {
    if (this.fixedRangeM > 0) {
      this.rangeM = this.fixedRangeM;
    } else if (this.p95 > 0) {
      const target =
        AUTO_RINGS_M.find((r) => r >= this.p95 * 1.15) ?? AUTO_RINGS_M[AUTO_RINGS_M.length - 1]!;
      this.rangeM += (target - this.rangeM) * 0.15;
    }

    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 14 * dpr;
    const k = radius / this.rangeM;
    const now = Date.now();

    ctx.clearRect(0, 0, size, size);

    // 量程环
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(72, 86, 110, 0.55)';
    const step = this.rangeM / 4;
    for (let r = step; r <= this.rangeM + 1e-6; r += step) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 30° 辐条
    ctx.strokeStyle = 'rgba(72, 86, 110, 0.3)';
    for (let deg = 0; deg < 360; deg += 30) {
      const t = (deg * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + radius * Math.sin(t), cy - radius * Math.cos(t));
      ctx.stroke();
    }

    // 量程标注
    ctx.fillStyle = 'rgba(130, 145, 170, 0.9)';
    ctx.font = `${11 * dpr}px Consolas, monospace`;
    ctx.textAlign = 'left';
    for (let r = step; r <= this.rangeM + 1e-6; r += step) {
      ctx.fillText(`${Math.round(r * 10) / 10}m`, cx + 4 * dpr, cy - r * k + 12 * dpr);
    }

    // 绘制所有有效桶（暂留的点）
    const dot = Math.max(2, Math.round(2.2 * dpr));
    for (let i = 0; i < BUCKETS; i++) {
      const r = this.rangeAt[i] ?? 0;
      if (r <= 0 || r > this.rangeM) continue;
      const age = now - (this.updatedAt[i] ?? 0);
      let alpha = 1;
      if (age > STALE_MS) {
        alpha = Math.max(0.18, 1 - (age - STALE_MS) / MAX_ALPHA_AGE_MS);
      }
      const a = i * BUCKET_RAD;
      const x = cx + r * k * Math.sin(a);
      const y = cy - r * k * Math.cos(a);
      const q = (this.qualityAt[i] ?? 0) / 255;
      const bright = 0.55 + q * 0.45;
      // 越近越亮，便于分辨近处障碍
      const near = 1 - Math.min(1, r / this.rangeM) * 0.35;
      const c = Math.round(180 * near + 75 * (1 - near));
      ctx.fillStyle = `rgba(${c}, 235, 255, ${(alpha * bright).toFixed(2)})`;
      ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    }

    // 船头三角
    ctx.fillStyle = 'rgba(76, 194, 255, 0.95)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 11 * dpr);
    ctx.lineTo(cx - 6 * dpr, cy + 6 * dpr);
    ctx.lineTo(cx + 6 * dpr, cy + 6 * dpr);
    ctx.closePath();
    ctx.fill();
  }
}
