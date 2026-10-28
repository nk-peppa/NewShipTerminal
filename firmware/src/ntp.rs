//! SNTP 客户端（RFC 4330 客户端子集）。
//!
//! 只做一件事：问一句「现在几点」，然后可选地把系统时钟改成它。
//! 不实现 NTP 的漂移建模和分层服务器选择——对船端「开机后时间可能是几个月前」
//! 这个量级的误差，单次采样已经完全够用。
//!
//! 需要 root（`settimeofday`），本固件以 systemd 服务运行，天然满足。

use std::net::{ToSocketAddrs, UdpSocket};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// NTP 纪元（1900-01-01）与 Unix 纪元（1970-01-01）相差的秒数
const NTP_UNIX_DELTA: u64 = 2_208_988_800;

#[derive(Debug, Clone, Copy)]
pub struct Sample {
    /// 服务器给出的 Unix 毫秒时间（已按 rtt/2 补偿到「本地收包时刻」）
    pub epoch_ms: i64,
    /// 网络往返毫秒
    pub rtt_ms: u32,
}

/// 本地系统时间（Unix 毫秒）
pub fn local_epoch_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// 向 `server` 查询当前时间。`server` 可以是主机名或 IP，端口固定 123。
pub fn query(server: &str, timeout: Duration) -> Result<Sample, String> {
    let target = if server.contains(':') {
        server.to_string()
    } else {
        format!("{server}:123")
    };
    let addr = target
        .to_socket_addrs()
        .map_err(|e| format!("解析 {target} 失败: {e}"))?
        .next()
        .ok_or_else(|| format!("解析 {target} 无结果"))?;

    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("绑定 UDP 失败: {e}"))?;
    sock.connect(addr)
        .map_err(|e| format!("连接 {addr} 失败: {e}"))?;
    sock.set_read_timeout(Some(timeout))
        .map_err(|e| format!("设置超时失败: {e}"))?;
    sock.set_write_timeout(Some(timeout))
        .map_err(|e| format!("设置超时失败: {e}"))?;

    // 48 字节请求：LI=0 VN=3 Mode=3(client) → 0x1B，其余全 0
    let mut req = [0u8; 48];
    req[0] = 0x1b;

    let t_send = std::time::Instant::now();
    sock.send(&req).map_err(|e| format!("发送失败: {e}"))?;

    let mut buf = [0u8; 48];
    let n = sock.recv(&mut buf).map_err(|e| format!("接收失败: {e}"))?;
    let rtt_ms = t_send.elapsed().as_millis() as u32;
    if n < 48 {
        return Err(format!("响应过短: {n} 字节"));
    }

    // 人工检查：Mode 必须为 4(server)、stratum 不能是 0(KoD)
    let mode = buf[0] & 0x07;
    let stratum = buf[1];
    if mode != 4 {
        return Err(format!("非 server 响应 mode={mode}"));
    }
    if stratum == 0 {
        // Kiss-o'-Death，最后 4 字节是原因码
        let code = String::from_utf8_lossy(&buf[12..16]).to_string();
        return Err(format!("服务器拒绝 (KoD {code})"));
    }

    // transmit timestamp：偏移 40，前 4 字节整秒、后 4 字节小数
    let secs = u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]) as u64;
    let frac = u32::from_be_bytes([buf[44], buf[45], buf[46], buf[47]]) as u64;
    if secs < NTP_UNIX_DELTA {
        return Err(format!("时间戳异常 secs={secs}"));
    }
    let unix_secs = secs - NTP_UNIX_DELTA;
    let frac_ms = (frac * 1000) >> 32;

    // 服务器时间对应「它发出的那一刻」，所以本地收包时刻 ≈ 服务器时刻 + rtt/2
    let epoch_ms = (unix_secs as i64) * 1000 + frac_ms as i64 + (rtt_ms as i64) / 2;
    Ok(Sample { epoch_ms, rtt_ms })
}

/// 把系统时钟设为给定的 Unix 毫秒时间。需要 root。
pub fn set_system_time(epoch_ms: i64) -> Result<(), String> {
    #[cfg(unix)]
    unsafe {
        let tv = libc::timeval {
            tv_sec: (epoch_ms.div_euclid(1000)) as libc::time_t,
            tv_usec: (epoch_ms.rem_euclid(1000) * 1000) as libc::suseconds_t,
        };
        if libc::settimeofday(&tv, std::ptr::null::<libc::timezone>()) != 0 {
            return Err(format!("settimeofday 失败: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = epoch_ms;
        Err("此平台不支持设置系统时间".into())
    }
}

/// 合理性区间：2020-01-01 ~ 2100-01-01。
/// 防止坏服务器/报文错位把系统时钟设成 1970 或未来，那比时间不准更糟。
const MIN_SANE_EPOCH_MS: i64 = 1_577_836_800_000;
const MAX_SANE_EPOCH_MS: i64 = 4_102_444_800_000;

/// 查一次并（可选）写回系统时钟。
/// 返回 `(校时前偏差秒, rtt_ms)`；偏差为正表示本地变慢。
pub fn sync(server: &str, timeout: Duration, apply: bool) -> Result<(i32, u16), String> {
    let before = local_epoch_ms();
    let sample = query(server, timeout)?;
    if !(MIN_SANE_EPOCH_MS..MAX_SANE_EPOCH_MS).contains(&sample.epoch_ms) {
        return Err(format!("服务器时间不合理: {} ms", sample.epoch_ms));
    }
    let offset_sec = ((sample.epoch_ms - before) as f64 / 1000.0).round() as i32;
    if apply {
        set_system_time(sample.epoch_ms)?;
    }
    Ok((offset_sec, sample.rtt_ms.min(u16::MAX as u32) as u16))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ntp_delta_is_70_years() {
        // 1900-01-01 → 1970-01-01 = 25567 天
        assert_eq!(NTP_UNIX_DELTA, 25_567 * 86_400);
    }

    #[test]
    fn local_clock_is_plausible() {
        // 2020-01-01 之后、2100 之前
        let now = local_epoch_ms();
        assert!(now > 1_577_836_800_000, "本地时钟太旧: {now}");
        assert!(now < 4_102_444_800_000, "本地时钟太新: {now}");
    }

    #[test]
    fn fractional_math_is_sane() {
        // 0.5 秒的小数部分应换算成 500ms 左右
        let frac: u64 = 0x8000_0000;
        assert_eq!((frac * 1000) >> 32, 500);
    }
}
