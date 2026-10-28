import { CMD_FLAG_ARM, CMD_FLAG_ESTOP } from '../../shared/protocol.js';

export interface OutCommand {
  throttleX10: number;
  servosX10: number[];
  flags: number;
}

export interface SafetyLimits {
  maxThrottlePct: number;
  rudderMaxDeg: number;
  uiTimeoutMs: number;
}

export interface SafetySnapshot {
  armRequested: boolean;
  estop: boolean;
  uiAlive: boolean;
  safeReason: 'ok' | 'disarmed' | 'estop' | 'ui-timeout';
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 应用内第一道安全门：把 UI 的归一化指令变成协议量，并在
 * 未解锁 / 急停 / UI 失联时强制归零（并且不携带 ARM 位）。
 */
export class SafetySupervisor {
  private armRequested = false;
  private estop = false;
  private throttle = 0;
  private rudder = 0;
  private lastUiCmdAt = 0;

  constructor(
    private readonly limits: SafetyLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setArm(on: boolean): void {
    this.armRequested = on;
    if (!on) {
      this.throttle = 0;
      this.rudder = 0;
    }
  }

  setEstop(on: boolean): void {
    this.estop = on;
    if (on) {
      this.throttle = 0;
      this.rudder = 0;
    }
  }

  onUiCmd(throttle: number, rudder: number): void {
    this.throttle = clamp(Number.isFinite(throttle) ? throttle : 0, -1, 1);
    this.rudder = clamp(Number.isFinite(rudder) ? rudder : 0, -1, 1);
    this.lastUiCmdAt = this.now();
  }

  /** 强制归零（退出、断链等），不改变解锁/急停请求状态 */
  forceZero(): void {
    this.throttle = 0;
    this.rudder = 0;
  }

  uiAlive(): boolean {
    return this.now() - this.lastUiCmdAt <= this.limits.uiTimeoutMs;
  }

  snapshot(): SafetySnapshot {
    const uiAlive = this.uiAlive();
    let safeReason: SafetySnapshot['safeReason'] = 'ok';
    if (this.estop) safeReason = 'estop';
    else if (!this.armRequested) safeReason = 'disarmed';
    else if (!uiAlive) safeReason = 'ui-timeout';
    return { armRequested: this.armRequested, estop: this.estop, uiAlive, safeReason };
  }

  /** 每个控制周期调用一次，返回本拍要下发的指令 */
  tick(): OutCommand {
    const state = this.snapshot();
    const engaged = state.safeReason === 'ok';

    // 急停始终生效，即使未解锁
    const flags = (engaged ? CMD_FLAG_ARM : 0) | (this.estop ? CMD_FLAG_ESTOP : 0);
    const thr = engaged ? this.throttle : 0;
    const rud = engaged ? this.rudder : 0;

    return {
      throttleX10: Math.round(thr * this.limits.maxThrottlePct * 10),
      servosX10: [Math.round(rud * this.limits.rudderMaxDeg * 10), 0, 0, 0],
      flags,
    };
  }
}
