//! 运行配置（JSON）。默认值即出厂参数，缺失字段自动回落。

use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    pub network: NetworkCfg,
    pub discovery: DiscoveryCfg,
    pub control: ControlCfg,
    pub lidar: LidarCfg,
    pub ota: OtaCfg,
    pub hardware: HardwareCfg,
    pub ntp: NtpCfg,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            network: NetworkCfg::default(),
            discovery: DiscoveryCfg::default(),
            control: ControlCfg::default(),
            lidar: LidarCfg::default(),
            ota: OtaCfg::default(),
            hardware: HardwareCfg::default(),
            ntp: NtpCfg::default(),
        }
    }
}

/// 开机联网校时 + 「时间偏差过大」告警
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct NtpCfg {
    /// 是否在开机后自动校时（需 root 才能写系统时钟）
    pub sync_on_boot: bool,
    /// 开机后等多久再校时（等 NetworkManager 把网卡拉起来）
    pub boot_delay_s: u32,
    /// NTP 服务器（主机名或 IP，端口固定 123）
    pub server: String,
    /// 单次查询超时
    pub timeout_ms: u32,
    /// |偏差| ≥ 此秒数时在 STATUS 里置 ST_TIME_BAD，提示客户端引导校时
    pub bad_threshold_s: i32,
}

impl Default for NtpCfg {
    fn default() -> Self {
        Self {
            sync_on_boot: true,
            boot_delay_s: 15,
            // 国内可达的公共服务器；也可换成用户自建 NTP
            server: "ntp.aliyun.com".into(),
            timeout_ms: 3000,
            bad_threshold_s: 3600,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct NetworkCfg {
    pub bind: String,
    pub port: u16,
}

impl Default for NetworkCfg {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0".into(),
            port: 9527,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct DiscoveryCfg {
    pub enabled: bool,
    pub udp_port: u16,
    pub interval_ms: u64,
    pub name: String,
}

impl Default for DiscoveryCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            udp_port: 9528,
            interval_ms: 1000,
            name: "USV-Edge".into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ControlCfg {
    /// 控制循环频率（协议要求 50Hz）
    pub freq_hz: u32,
    /// 超时未收到有效 CMD 即失联保护
    pub watchdog_ms: u32,
    /// 必须置 ARM 位才输出
    pub require_arm: bool,
    /// 油门上限（%）
    pub max_throttle_pct: i16,
    /// 油门死区（%）：小于此值视为停车（旧实现默认 1.0%）
    pub throttle_deadband_pct: i16,
    /// 舵角软限位（相对中位，度）
    pub rudder_limit_deg: i16,
    /// 舵机脉宽标定（微秒）
    pub servo_min_us: u16,
    pub servo_mid_us: u16,
    pub servo_max_us: u16,
    /// 舵机电气方向与指令相反时为 true（本船实测为 true）
    pub servo_reverse: bool,
    /// 舵机机械行程对应的角度范围（旧配置 angle_range_deg=90 → ±45° 满量程）
    pub servo_angle_range_deg: f32,
    /// 机械限位的安全余量（微秒），软限位 = [min+margin, max-margin]
    pub servo_margin_us: u16,
    /// 实时优先级（1..=99），0 表示不提升
    pub rt_priority: i32,
}

impl Default for ControlCfg {
    fn default() -> Self {
        Self {
            freq_hz: 50,
            watchdog_ms: 300,
            require_arm: true,
            max_throttle_pct: 60,
            throttle_deadband_pct: 1,
            rudder_limit_deg: 30,
            servo_min_us: 1070,
            servo_mid_us: 1590,
            servo_max_us: 2110,
            servo_reverse: true,
            servo_angle_range_deg: 90.0,
            servo_margin_us: 30,
            rt_priority: 1,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct LidarCfg {
    pub enabled: bool,
    /// Linux 串口设备；dry-run 时忽略
    pub port: String,
    pub baud: u32,
    /// 每圈最多点数，超出按角度抽稀
    pub max_points_per_scan: u16,
    /// zlib 压缩点数据
    pub compress: bool,
    /// 真实串口打开失败时是否退回模拟点云。
    /// 默认 **false**：宁可没有点云，也不能让客户端把假数据当成真雷达。
    pub mock_fallback: bool,
}

impl Default for LidarCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            port: "/dev/ttyUSB0".into(),
            baud: 460_800,
            max_points_per_scan: 1000,
            compress: true,
            mock_fallback: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct OtaCfg {
    pub enabled: bool,
    pub port: u16,
    /// 版本目录根（内含 releases/ 与 current 软链）
    pub dir: String,
    /// 允许未签名包（仅限联调/内网）
    pub allow_unsigned: bool,
    /// 新版本启动后等待客户端 HELLO 的宽限时间
    pub grace_ms: u64,
}

impl Default for OtaCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            port: 9530,
            dir: "/opt/usv".into(),
            allow_unsigned: true,
            grace_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct HardwareCfg {
    /// dry-run：不触碰真实 PWM/GPIO
    pub dry_run: bool,
    pub pwm_chip: String,
    /// PWM 通道号（pwmchip0 下）：油门 PI11→1，舵机 PI13→3
    pub throttle_pwm: u32,
    pub rudder_pwm: u32,
    /// 全局 GPIO 编号（= 端口序号×32 + 脚号；I 口 = 256）
    /// 本船实测：正转 PI3=259，反转 PI4=260，指示灯 PI16=272
    pub dir_fwd_gpio: u32,
    pub dir_rev_gpio: u32,
    pub led_gpio: u32,
    /// PWM 周期（纳秒），50Hz = 20_000_000
    pub pwm_period_ns: u32,
}

impl Default for HardwareCfg {
    fn default() -> Self {
        Self {
            dry_run: true,
            pwm_chip: "/sys/class/pwm/pwmchip0".into(),
            throttle_pwm: 1,
            rudder_pwm: 3,
            dir_fwd_gpio: 259,
            dir_rev_gpio: 260,
            led_gpio: 272,
            pwm_period_ns: 20_000_000,
        }
    }
}

impl Config {
    pub fn load(path: Option<&Path>) -> Result<Self, String> {
        match path {
            None => Ok(Self::default()),
            Some(p) if !p.exists() => Err(format!("配置文件不存在: {}", p.display())),
            Some(p) => {
                let text = std::fs::read_to_string(p).map_err(|e| format!("读取配置失败: {e}"))?;
                serde_json::from_str(&text).map_err(|e| format!("解析配置失败: {e}"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_protocol_compliant() {
        let c = Config::default();
        assert_eq!(c.control.freq_hz, 50);
        assert_eq!(c.control.watchdog_ms, 300);
        assert!(c.control.require_arm);
        assert_eq!(c.network.port, 9527);
        assert_eq!(c.discovery.udp_port, 9528);
        assert_eq!(c.ota.port, 9530);
    }

    #[test]
    fn partial_json_falls_back_to_defaults() {
        let c: Config = serde_json::from_str(r#"{"control":{"max_throttle_pct":40}}"#).unwrap();
        assert_eq!(c.control.max_throttle_pct, 40);
        assert_eq!(c.control.freq_hz, 50, "未给出的字段应回落默认值");
        assert_eq!(c.network.port, 9527);
    }
}
