//! 硬件抽象层。
//!
//! `MockHal` 用于 dry-run 与单测；`SysfsHal` 走 vendor 内核的 /sys 接口
//! （与现有 Python 实现同样的路径风格），仅在 unix 下编译。

use std::sync::atomic::{AtomicI16, AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedState {
    #[allow(dead_code)] // 预留给上电自检阶段
    Boot,
    WaitLink,
    Ready,
    Active,
    Failsafe,
    Estop,
}

impl LedState {
    pub fn code(self) -> u8 {
        match self {
            LedState::Boot => 0,
            LedState::WaitLink => 1,
            LedState::Ready => 2,
            LedState::Active => 3,
            LedState::Failsafe => 4,
            LedState::Estop => 5,
        }
    }
}

/// 硬件只暴露「设置目标」与「读取最近状态」，不做任何控制逻辑。
pub trait Hal: Send + Sync {
    /// 下发油门（0.1%）与舵角（0.1°）、方向（0=停 1=前进 2=后退）
    fn apply(&self, throttle_x10: i16, rudder_x10: i16, direction: u8);
    fn set_led(&self, state: LedState);
    fn name(&self) -> &'static str;
}

/// 记录最后一次输出，供测试/自检读取，不触碰任何设备。
#[derive(Debug, Default)]
pub struct MockHal {
    throttle: AtomicI16,
    rudder: AtomicI16,
    direction: AtomicU8,
    led: AtomicU8,
}

impl MockHal {
    pub fn new() -> Self {
        Self::default()
    }
    #[allow(dead_code)] // 供测试/自检读取最后下发值
    pub fn last(&self) -> (i16, i16, u8) {
        (
            self.throttle.load(Ordering::Relaxed),
            self.rudder.load(Ordering::Relaxed),
            self.direction.load(Ordering::Relaxed),
        )
    }
    #[allow(dead_code)] // 供测试/自检读取 LED 状态码
    pub fn led(&self) -> u8 {
        self.led.load(Ordering::Relaxed)
    }
}

impl Hal for MockHal {
    fn apply(&self, throttle_x10: i16, rudder_x10: i16, direction: u8) {
        self.throttle.store(throttle_x10, Ordering::Relaxed);
        self.rudder.store(rudder_x10, Ordering::Relaxed);
        self.direction.store(direction, Ordering::Relaxed);
    }
    fn set_led(&self, state: LedState) {
        self.led.store(state.code(), Ordering::Relaxed);
    }
    fn name(&self) -> &'static str {
        "mock"
    }
}

#[cfg(unix)]
pub mod sysfs {
    use super::{Hal, LedState};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

    pub struct SysfsHal {
        period_ns: u32,
        /// 软限位（已含安全余量），与旧实现一致：1070+30 .. 2110-30
        servo_lo_us: i32,
        servo_hi_us: i32,
        servo_mid_us: i32,
        /// 满量程对应的角度（±angle_range/2），本船 90° → ±45°
        servo_half_deg: f32,
        servo_reverse: bool,
        throttle_pwm: PathBuf,
        rudder_pwm: PathBuf,
        dir_fwd: PathBuf,
        dir_rev: PathBuf,
        led: PathBuf,
        warned: AtomicBool,
        last_dir: AtomicU8,
    }

    impl SysfsHal {
        #[allow(clippy::too_many_arguments)]
        pub fn new(
            pwm_chip: &str,
            throttle_ch: u32,
            rudder_ch: u32,
            period_ns: u32,
            servo_min: u16,
            servo_mid: u16,
            servo_max: u16,
            servo_reverse: bool,
            servo_angle_range_deg: f32,
            servo_margin_us: u16,
            dir_fwd_gpio: u32,
            dir_rev_gpio: u32,
            led_gpio: u32,
        ) -> Self {
            let p = |ch: u32| PathBuf::from(format!("{pwm_chip}/pwm{ch}"));
            let dir_fwd = Self::ensure_gpio(dir_fwd_gpio);
            let dir_rev = Self::ensure_gpio(dir_rev_gpio);
            let led = Self::ensure_gpio(led_gpio);

            let throttle_pwm = p(throttle_ch);
            let rudder_pwm = p(rudder_ch);
            let margin = servo_margin_us as i32;
            let lo = servo_min as i32 + margin;
            let hi = servo_max as i32 - margin;
            let mid = (lo + hi) / 2;

            // 与旧实现 pwm.py#configure() 完全一致的写入顺序（顺序错了会被驱动拒绝）：
            //   disable -> duty=0 -> period -> polarity=normal -> duty -> enable
            //
            // polarity 必须显式写成 normal：Allwinner BSP 上电默认是 inversed（低电平有效），
            // 反相下 duty=0 实际是恒高电平，驱动板会当作满油门。
            for ch in [&throttle_pwm, &rudder_pwm] {
                let _ = fs::write(ch.join("enable"), "0");
                let _ = fs::write(ch.join("duty_cycle"), "0");
                let _ = fs::write(ch.join("period"), period_ns.to_string());
                let _ = fs::write(ch.join("polarity"), "normal");
            }
            let _ = fs::write(throttle_pwm.join("duty_cycle"), "0");
            let _ = fs::write(rudder_pwm.join("duty_cycle"), (mid * 1000).to_string());
            // 保持使能（禁用会让 PI11 悬空拾取干扰，旧实现同样保持 0% 使能）
            let _ = fs::write(throttle_pwm.join("enable"), "1");
            let _ = fs::write(rudder_pwm.join("enable"), "1");

            Self {
                period_ns,
                servo_lo_us: lo,
                servo_hi_us: hi,
                servo_mid_us: mid,
                servo_half_deg: servo_angle_range_deg / 2.0,
                servo_reverse,
                throttle_pwm,
                rudder_pwm,
                dir_fwd,
                dir_rev,
                led,
                warned: AtomicBool::new(false),
                last_dir: AtomicU8::new(0),
            }
        }

        fn warn_once(&self, err: &std::io::Error) {
            if !self.warned.swap(true, Ordering::Relaxed) {
                eprintln!("[hal] sysfs 写入失败（后续同类错误不再提示）: {err}");
            }
        }

        fn write(&self, path: &PathBuf, value: impl ToString) {
            if let Err(e) = fs::write(path, value.to_string()) {
                self.warn_once(&e);
            }
        }

        /// sysfs GPIO 必须先用 export 把引脚导出，再把 direction 设为 out，
        /// 否则 `/sys/class/gpio/gpioN/value` 根本不存在。
        /// 已导出时 export 会返回 EBUSY，属正常情况，忽略。
        fn ensure_gpio(no: u32) -> PathBuf {
            let base = PathBuf::from("/sys/class/gpio");
            let dir = base.join(format!("gpio{no}"));
            if !dir.exists() {
                let _ = fs::write(base.join("export"), no.to_string());
                // 内核导出是异步的，给它一点时间
                for _ in 0..20 {
                    if dir.exists() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
            let direction = dir.join("direction");
            if direction.exists() {
                let _ = fs::write(&direction, "out");
            }
            dir.join("value")
        }

        /// 舵角 0.1° → 脉宽微秒。
        ///
        /// 与旧 servo.py#set_angle_deg 完全一致：
        /// ```text
        /// deg = clamp(x10/10, -half, +half)      // half = angle_range/2 = 45
        /// if reverse: deg = -deg
        /// us  = mid + (deg / half) * (hi - lo)/2 // mid=1590, (hi-lo)/2=490
        /// ```
        /// 注意 ±45° 才是满量程，不是 ±30°；之前用 ±30° 映射到满限位，
        /// 导致同样指令的舵量偏大 50%。
        pub fn rudder_us(&self, rudder_x10: i16) -> u16 {
            let half_deg = self.servo_half_deg.max(1.0);
            let half_span = (self.servo_hi_us - self.servo_lo_us) as f32 / 2.0;

            let mut deg = (rudder_x10 as f32) / 10.0;
            deg = deg.clamp(-half_deg, half_deg);
            if self.servo_reverse {
                deg = -deg;
            }

            let us = self.servo_mid_us as f32 + (deg / half_deg) * half_span;
            us.round().clamp(self.servo_lo_us as f32, self.servo_hi_us as f32) as u16
        }

        /// 油门 0.1% → 占空比纳秒（0..1000 → 0..period）
        fn throttle_ns(&self, throttle_x10: i16) -> u32 {
            let pct = throttle_x10.unsigned_abs().min(1000) as u64;
            ((pct * self.period_ns as u64) / 1000) as u32
        }
    }

    impl Hal for SysfsHal {
        /// 只写 duty（period / polarity / enable 已在 new() 里配好）。
        /// 重复写 period 会被部分驱动拒绝，也会造成波形抖动。
        fn apply(&self, throttle_x10: i16, rudder_x10: i16, direction: u8) {
            // 换向时先降油门再改方向脚，避免 H 桥在导通状态下换向产生大电流
            // （旧实现 motor.drive() 也是先 set_throttle(0) 再设方向）
            let prev = self.last_dir.swap(direction, Ordering::Relaxed);
            if prev != direction {
                self.write(&self.throttle_pwm.join("duty_cycle"), 0);
            }

            self.write(&self.throttle_pwm.join("duty_cycle"), self.throttle_ns(throttle_x10));

            let duty = (self.rudder_us(rudder_x10) as u64 * self.period_ns as u64) / 20_000;
            self.write(&self.rudder_pwm.join("duty_cycle"), duty);

            // 双高 = 急停，双低 = 待机，前进=反向脚高（与现实现一致）
            let (fwd, rev) = match direction {
                1 => (1, 0),
                2 => (0, 1),
                3 => (1, 1),
                _ => (0, 0),
            };
            self.write(&self.dir_fwd, fwd);
            self.write(&self.dir_rev, rev);
        }

        fn set_led(&self, state: LedState) {
            // v1 简化实现：只做亮/灭，闪灯节拍待补（旧实现由独立线程驱动）
            let on = matches!(
                state,
                LedState::Ready | LedState::Active | LedState::Failsafe | LedState::Estop
            );
            self.write(&self.led, if on { 1 } else { 0 });
        }

        fn name(&self) -> &'static str {
            "sysfs"
        }
    }
}

#[cfg(all(test, unix))]
mod servo_tests {
    use super::sysfs::SysfsHal;

    fn hal(reverse: bool) -> SysfsHal {
        SysfsHal::new(
            "/sys/class/pwm/pwmchip0",
            1,
            3,
            20_000_000,
            1070,
            1590,
            2110,
            reverse,
            90.0,
            30,
            259,
            260,
            272,
        )
    }

    #[test]
    fn center_is_mid_pulse() {
        assert_eq!(hal(true).rudder_us(0), 1590);
        assert_eq!(hal(false).rudder_us(0), 1590);
    }

    #[test]
    fn full_scale_is_half_angle_range() {
        // 满量程是 ±45°（angle_range 90°），软限位 1100..2080
        assert_eq!(hal(false).rudder_us(450), 2080);
        assert_eq!(hal(false).rudder_us(-450), 1100);
    }

    #[test]
    fn thirty_deg_is_two_thirds_of_travel() {
        // 30° 只应走 2/3 行程：1590 ± 490*2/3 = 1590 ± 327
        assert_eq!(hal(false).rudder_us(300), 1917);
        assert_eq!(hal(false).rudder_us(-300), 1263);
    }

    #[test]
    fn reverse_flips_direction() {
        assert_eq!(hal(true).rudder_us(300), 1263, "反向时正舵应低于中位");
        assert_eq!(hal(true).rudder_us(-300), 1917);
    }

    #[test]
    fn clamps_beyond_limits() {
        assert_eq!(hal(false).rudder_us(1000), 2080);
        assert_eq!(hal(false).rudder_us(-1000), 1100);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_records_last_output() {
        let hal = MockHal::new();
        hal.apply(123, -45, 1);
        assert_eq!(hal.last(), (123, -45, 1));
        hal.set_led(LedState::Active);
        assert_eq!(hal.led(), LedState::Active.code());
    }
}
