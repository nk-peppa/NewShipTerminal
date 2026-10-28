//! 控制律与安全逻辑（纯函数，可单测）。
//!
//! 输入最新 CMD + 时间戳，输出本拍实际下发量与 STATUS 标志。
//! 规则优先级：急停 > 未解锁 > 失联超时 > 正常输出。

use crate::config::ControlCfg;
use crate::protocol::{Cmd, ST_ARMED, ST_ARM_REQUIRED, ST_ESTOP, ST_FAILSAFE, ST_LIDAR_OK};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Output {
    pub throttle_x10: i16,
    pub servos_x10: [i16; 4],
    pub direction: u8,
    pub flags: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafeReason {
    Ok,
    Estop,
    Disarmed,
    Watchdog,
}

impl Output {
    pub fn reason(&self) -> SafeReason {
        if self.flags & ST_ESTOP != 0 {
            SafeReason::Estop
        } else if self.flags & ST_FAILSAFE != 0 {
            SafeReason::Watchdog
        } else if self.flags & ST_ARMED == 0 {
            SafeReason::Disarmed
        } else {
            SafeReason::Ok
        }
    }
}

fn clamp(v: i16, lo: i16, hi: i16) -> i16 {
    v.clamp(lo, hi)
}

/// 计算本拍输出。`last_cmd_ms` 为最近一次有效 CMD 的单调毫秒时间。
pub fn step(
    cmd: &Cmd,
    last_cmd_ms: Option<u32>,
    now_ms: u32,
    cfg: &ControlCfg,
    lidar_ok: bool,
) -> Output {
    let mut flags = 0u8;
    if cfg.require_arm && !cmd.armed() {
        flags |= ST_ARM_REQUIRED;
    }
    if cmd.armed() {
        flags |= ST_ARMED;
    }
    if cmd.estop() {
        flags |= ST_ESTOP;
    }
    if lidar_ok {
        flags |= ST_LIDAR_OK;
    }

    let timed_out = match last_cmd_ms {
        None => true,
        Some(t) => now_ms.wrapping_sub(t) > cfg.watchdog_ms,
    };
    if timed_out {
        flags |= ST_FAILSAFE;
    }

    let blocked = cmd.estop() || timed_out || (cfg.require_arm && !cmd.armed());
    if blocked {
        return Output {
            throttle_x10: 0,
            servos_x10: [0; 4],
            direction: if cmd.estop() { 3 } else { 0 },
            flags,
        };
    }

    let max_thr = cfg.max_throttle_pct.saturating_mul(10);
    let max_rud = cfg.rudder_limit_deg.saturating_mul(10);
    let deadband = cfg.throttle_deadband_pct.saturating_mul(10);

    // 死区内视为停车（与旧实现 server.py 的 throttle_deadband_pct 一致）
    let raw_thr = clamp(cmd.throttle_x10, -max_thr, max_thr);
    let throttle = if raw_thr.abs() < deadband { 0 } else { raw_thr };

    let mut servos = [0i16; 4];
    for (i, s) in cmd.servos_x10.iter().enumerate() {
        servos[i] = clamp(*s, -max_rud, max_rud);
    }

    Output {
        throttle_x10: throttle,
        servos_x10: servos,
        direction: if throttle > 0 {
            1
        } else if throttle < 0 {
            2
        } else {
            0
        },
        flags,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CMD_FLAG_ARM, CMD_FLAG_ESTOP};

    fn cfg() -> ControlCfg {
        ControlCfg::default()
    }

    fn armed_cmd(thr: i16, rud: i16) -> Cmd {
        Cmd {
            throttle_x10: thr,
            servos_x10: [rud, 0, 0, 0],
            flags: CMD_FLAG_ARM,
        }
    }

    #[test]
    fn disarmed_gives_zero_output() {
        let out = step(&armed_cmd(500, 200), Some(1000), 1010, &cfg(), true);
        let mut cmd = armed_cmd(500, 200);
        cmd.flags = 0;
        let out2 = step(&cmd, Some(1000), 1010, &cfg(), true);
        assert_eq!(out.throttle_x10, 500);
        assert_eq!(out2.throttle_x10, 0);
        assert_eq!(out2.flags & ST_ARM_REQUIRED, ST_ARM_REQUIRED);
    }

    #[test]
    fn clamps_to_configured_limits() {
        let out = step(&armed_cmd(1000, 900), Some(1000), 1010, &cfg(), true);
        assert_eq!(out.throttle_x10, 600, "油门上限 60%");
        assert_eq!(out.servos_x10[0], 300, "舵角上限 30 度");
    }

    #[test]
    fn watchdog_zeroes_after_timeout() {
        let c = cfg();
        let ok = step(&armed_cmd(300, 100), Some(1000), 1000 + 299, &c, true);
        assert_eq!(ok.throttle_x10, 300);
        let late = step(&armed_cmd(300, 100), Some(1000), 1000 + 301, &c, true);
        assert_eq!(late.throttle_x10, 0);
        assert_eq!(late.direction, 0);
        assert_eq!(late.flags & ST_FAILSAFE, ST_FAILSAFE);
    }

    #[test]
    fn estop_dominates_and_reports_direction_3() {
        let mut cmd = armed_cmd(300, 100);
        cmd.flags |= CMD_FLAG_ESTOP;
        let out = step(&cmd, Some(1000), 1010, &cfg(), true);
        assert_eq!(out.throttle_x10, 0);
        assert_eq!(out.direction, 3);
        assert_eq!(out.flags & ST_ESTOP, ST_ESTOP);
        assert_eq!(out.reason(), SafeReason::Estop);
    }

    #[test]
    fn reverse_throttle_reports_direction_2() {
        let out = step(&armed_cmd(-200, 0), Some(1000), 1010, &cfg(), true);
        assert_eq!(out.throttle_x10, -200);
        assert_eq!(out.direction, 2);
    }

    #[test]
    fn lidar_flag_passes_through() {
        let on = step(&armed_cmd(0, 0), Some(1000), 1010, &cfg(), true);
        let off = step(&armed_cmd(0, 0), Some(1000), 1010, &cfg(), false);
        assert_ne!(on.flags & ST_LIDAR_OK, 0);
        assert_eq!(off.flags & ST_LIDAR_OK, 0);
    }

    #[test]
    fn watchdog_handles_u32_wrap() {
        let c = cfg();
        let out = step(&armed_cmd(100, 0), Some(u32::MAX - 10), 20, &c, true);
        assert_eq!(out.throttle_x10, 100, "跨 u32 回绕仍应视为未超时");
    }
}
