"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SafetySupervisor = void 0;
const protocol_js_1 = require("../../shared/protocol.js");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/**
 * 应用内第一道安全门：把 UI 的归一化指令变成协议量，并在
 * 未解锁 / 急停 / UI 失联时强制归零（并且不携带 ARM 位）。
 */
class SafetySupervisor {
    limits;
    now;
    armRequested = false;
    estop = false;
    throttle = 0;
    rudder = 0;
    lastUiCmdAt = 0;
    constructor(limits, now = () => Date.now()) {
        this.limits = limits;
        this.now = now;
    }
    setArm(on) {
        this.armRequested = on;
        if (!on) {
            this.throttle = 0;
            this.rudder = 0;
        }
    }
    setEstop(on) {
        this.estop = on;
        if (on) {
            this.throttle = 0;
            this.rudder = 0;
        }
    }
    onUiCmd(throttle, rudder) {
        this.throttle = clamp(Number.isFinite(throttle) ? throttle : 0, -1, 1);
        this.rudder = clamp(Number.isFinite(rudder) ? rudder : 0, -1, 1);
        this.lastUiCmdAt = this.now();
    }
    /** 强制归零（退出、断链等），不改变解锁/急停请求状态 */
    forceZero() {
        this.throttle = 0;
        this.rudder = 0;
    }
    uiAlive() {
        return this.now() - this.lastUiCmdAt <= this.limits.uiTimeoutMs;
    }
    snapshot() {
        const uiAlive = this.uiAlive();
        let safeReason = 'ok';
        if (this.estop)
            safeReason = 'estop';
        else if (!this.armRequested)
            safeReason = 'disarmed';
        else if (!uiAlive)
            safeReason = 'ui-timeout';
        return { armRequested: this.armRequested, estop: this.estop, uiAlive, safeReason };
    }
    /** 每个控制周期调用一次，返回本拍要下发的指令 */
    tick() {
        const state = this.snapshot();
        const engaged = state.safeReason === 'ok';
        // 急停始终生效，即使未解锁
        const flags = (engaged ? protocol_js_1.CMD_FLAG_ARM : 0) | (this.estop ? protocol_js_1.CMD_FLAG_ESTOP : 0);
        const thr = engaged ? this.throttle : 0;
        const rud = engaged ? this.rudder : 0;
        return {
            throttleX10: Math.round(thr * this.limits.maxThrottlePct * 10),
            servosX10: [Math.round(rud * this.limits.rudderMaxDeg * 10), 0, 0, 0],
            flags,
        };
    }
}
exports.SafetySupervisor = SafetySupervisor;
//# sourceMappingURL=supervisor.js.map