//! RPLIDAR C1 数据解析与按圈聚合。
//!
//! 5 字节节点（S 系列紧凑格式，小端）：
//!   b0     : bit0=同步标志, bits2..7=quality(0..63)
//!   b1..b2 : u16 = (angle_q6 << 1) | check_bit，check_bit 恒为 1
//!   b3..b4 : u16 = distance_q2（0.25mm）
//!
//! 关键点：串口字节流不一定从节点边界开始（START_SCAN 应答头、上电噪声），
//! 因此必须先用 5 个候选偏移做**角度连续性对齐**，再用角度回绕判定新圈。
//! 只靠 start 标志会严重误判：错位时 b0 恰好是上一节点的 check bit（恒 1），
//! 表现为「每几字节一圈、每圈 1 个点」。

use crate::protocol::Scan;

const NODE: usize = 5;
const ALIGN_NODES: usize = 128;
const ALIGN_MIN_NODES: usize = 48;
const ALIGN_SCORE: f32 = 0.90;
const IRREGULAR_MAX: u32 = 48;
/// 相邻角度增量上限（raw = angle_q6<<1，约 1000 个 q6 单位 ≈ 15.6°）
const DELTA_MAX: i32 = 2000;
/// 角度回绕阈值：正常一圈从 ~71999 回到 ~0，delta ≈ -72000
const WRAP_DROP: i32 = -30000;
const MIN_POINTS_PER_SCAN: usize = 10;
/// START_SCAN 应答描述符
const SCAN_HEADER: [u8; 7] = [0xA5, 0x5A, 0x05, 0x00, 0x00, 0x40, 0x81];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Node {
    pub start: bool,
    pub quality: u8,
    pub angle_cdeg: u16,
    pub dist_mm: u16,
}

/// 解析单个已对齐节点（供单测/工具使用）
pub fn parse_node(b: &[u8; 5]) -> Option<Node> {
    let raw = u16::from_le_bytes([b[1], b[2]]);
    if raw & 0x01 == 0 {
        return None; // check bit 必须为 1
    }
    let angle_q6 = (raw >> 1) as u32;
    let dist_q2 = u16::from_le_bytes([b[3], b[4]]);
    Some(Node {
        start: b[0] & 0x01 != 0,
        quality: b[0] >> 2,
        angle_cdeg: ((angle_q6 * 100 / 64) % 36_000) as u16,
        dist_mm: dist_q2 / 4,
    })
}

/// C1 流式解析器：对齐 → 逐节点 → 角度回绕出圈
pub struct C1Parser {
    buf: Vec<u8>,
    offset: Option<usize>,
    prev_raw: Option<i32>,
    irregular: u32,
    points: Vec<(u16, u16, u8)>,
    max_points: usize,
    quality_max: u8,
    scan_seq: u32,
    t_start_ms: u32,
    /// 统计：成功对齐次数 / 因异常重新对齐次数 / 丢弃节点数
    pub aligns: u32,
    pub resyncs: u32,
    pub dropped_nodes: u64,
}

impl C1Parser {
    pub fn new(max_points: u16) -> Self {
        Self {
            buf: Vec::with_capacity(8192),
            offset: None,
            prev_raw: None,
            irregular: 0,
            points: Vec::with_capacity(600),
            max_points: max_points.max(16) as usize,
            quality_max: 63,
            scan_seq: 0,
            t_start_ms: 0,
            aligns: 0,
            resyncs: 0,
            dropped_nodes: 0,
        }
    }

    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// 喂入原始字节，返回本次完成的整圈（一般为 0~2 个）
    pub fn feed(&mut self, data: &[u8], now_ms: u32) -> Vec<Scan> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();

        if self.offset.is_none() {
            // 有 START_SCAN 应答头时直接从它后面开始
            if let Some(pos) = find_subslice(&self.buf, &SCAN_HEADER) {
                self.buf.drain(..pos + SCAN_HEADER.len());
                self.offset = Some(0);
                self.aligns += 1;
            } else if !self.try_align() {
                let keep = NODE * ALIGN_MIN_NODES;
                if self.buf.len() > keep {
                    let drop = self.buf.len() - keep;
                    self.buf.drain(..drop);
                }
                return out;
            }
        }

        let mut pos = 0usize;
        let mut re_aligned = false;
        while self.buf.len() >= pos + NODE {
            let i = pos;
            let raw = u16::from_le_bytes([self.buf[i + 1], self.buf[i + 2]]) as i32;
            let dist_q2 = u16::from_le_bytes([self.buf[i + 3], self.buf[i + 4]]);
            let quality = self.buf[i] >> 2;
            pos += NODE;

            if raw & 1 == 0 {
                self.dropped_nodes += 1;
                self.irregular += 1;
                if self.irregular > IRREGULAR_MAX {
                    self.reset_alignment();
                    re_aligned = true;
                    break;
                }
                continue;
            }

            let mut wrapped = false;
            if let Some(prev) = self.prev_raw {
                let delta = raw - prev;
                if delta < WRAP_DROP {
                    wrapped = true;
                } else if delta <= 0 || delta > DELTA_MAX {
                    self.irregular += 1;
                    if self.irregular > IRREGULAR_MAX {
                        self.reset_alignment();
                        re_aligned = true;
                        break;
                    }
                } else {
                    self.irregular = 0;
                }
            }
            self.prev_raw = Some(raw);

            if wrapped {
                if let Some(scan) = self.finish(now_ms) {
                    out.push(scan);
                }
            }
            if self.points.is_empty() {
                self.t_start_ms = now_ms;
            }

            if dist_q2 > 0 {
                let angle_q6 = (raw >> 1) as u32;
                let angle_cdeg = ((angle_q6 * 100 / 64) % 36_000) as u16;
                self.points.push((angle_cdeg, dist_q2 / 4, quality));
                if self.points.len() >= self.max_points {
                    if let Some(scan) = self.finish(now_ms) {
                        out.push(scan);
                    }
                }
            }
        }

        if pos > 0 {
            let drain = pos.min(self.buf.len());
            self.buf.drain(..drain);
        }
        let _ = re_aligned;
        out
    }

    /// 5 个候选偏移打分：check bit 命中率 + 角度连续性
    fn try_align(&mut self) -> bool {
        let need = NODE * ALIGN_MIN_NODES;
        if self.buf.len() < need {
            return false;
        }
        let window_len = (NODE * ALIGN_NODES).min(self.buf.len());
        let mut best_score = -1.0f32;
        let mut best_off = 0usize;

        for off in 0..NODE {
            let mut prev: Option<i32> = None;
            let mut total = 0u32;
            let mut smooth = 0u32;
            let mut i = off;
            while i + NODE <= window_len {
                let raw = u16::from_le_bytes([self.buf[i + 1], self.buf[i + 2]]) as i32;
                let check_ok = raw & 1 == 1;
                if let Some(p) = prev {
                    total += 1;
                    let delta = raw - p;
                    if check_ok && delta > 0 && delta <= DELTA_MAX {
                        smooth += 1;
                    }
                }
                prev = Some(raw);
                i += NODE;
            }
            let score = smooth as f32 / total.max(1) as f32;
            if score > best_score {
                best_score = score;
                best_off = off;
            }
        }

        if best_score >= ALIGN_SCORE {
            self.offset = Some(0);
            self.prev_raw = None;
            self.irregular = 0;
            self.aligns += 1;
            if best_off > 0 {
                self.buf.drain(..best_off);
            }
            true
        } else {
            false
        }
    }

    fn reset_alignment(&mut self) {
        self.offset = None;
        self.prev_raw = None;
        self.irregular = 0;
        self.resyncs += 1;
        let keep = NODE * ALIGN_MIN_NODES;
        if self.buf.len() > keep {
            let drop = self.buf.len() - keep;
            self.buf.drain(..drop);
        }
    }

    fn finish(&mut self, now_ms: u32) -> Option<Scan> {
        if self.points.len() < MIN_POINTS_PER_SCAN {
            self.points.clear();
            return None;
        }
        let mut points = std::mem::replace(&mut self.points, Vec::with_capacity(600));
        points.sort_unstable_by_key(|p| p.0);
        let original = points.len() as u16;
        self.scan_seq = self.scan_seq.wrapping_add(1);
        Some(Scan {
            t_start_ms: self.t_start_ms,
            t_end_ms: now_ms,
            scan_seq: self.scan_seq,
            original_count: original,
            rate_x100: 1000,
            quality_max: self.quality_max,
            lidar_ok: true,
            decimated: false,
            t_start_estimated: false,
            points,
        })
    }
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/* ---------------- 数据源 ---------------- */

#[derive(Debug)]
pub enum ReadOutcome {
    Scan(Scan),
    /// 暂时没有整圈数据（正常，不要据此断开）
    Idle,
    /// 串口不可用（设备拔出/错误），调用方应关闭并重连
    Lost(String),
}

pub trait LidarSource: Send {
    fn next_scan(&mut self) -> ReadOutcome;
}

/// 合成雷达：450 点、10Hz，用于 dry-run。
pub struct MockSource {
    tick: u32,
    t0: std::time::Instant,
    points_per_rev: u32,
    max_points: u16,
}

impl MockSource {
    pub fn new(max_points: u16) -> Self {
        Self {
            tick: 0,
            t0: std::time::Instant::now(),
            points_per_rev: 450,
            max_points,
        }
    }
}

impl LidarSource for MockSource {
    fn next_scan(&mut self) -> ReadOutcome {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let now_ms = self.t0.elapsed().as_millis() as u32;
        let n = (self.points_per_rev as usize).min(self.max_points.max(16) as usize);
        let mut scan = Scan {
            t_start_ms: now_ms.saturating_sub(100),
            t_end_ms: now_ms,
            scan_seq: self.tick,
            original_count: n as u16,
            rate_x100: 1000,
            quality_max: 63,
            lidar_ok: true,
            decimated: false,
            t_start_estimated: false,
            points: Vec::with_capacity(n),
        };
        for i in 0..n {
            let angle = (i as u32 * 36_000 / n as u32) as u16;
            let a = angle as f32 * std::f32::consts::PI / 18_000.0;
            let r = 4000.0 + 150.0 * (a * 3.0).sin();
            scan.points.push((angle, r as u16, 60));
        }
        self.tick = self.tick.wrapping_add(1);
        ReadOutcome::Scan(scan)
    }
}

/// 真实串口源
#[cfg(unix)]
pub struct SerialSource {
    parser: C1Parser,
    t0: std::time::Instant,
    fd: std::os::unix::io::RawFd,
    empty_reads: u32,
}

#[cfg(unix)]
impl SerialSource {
    pub fn open(path: &str, baud: u32, max_points: u16) -> Result<Self, String> {
        use std::os::unix::io::IntoRawFd;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| format!("打开 {path} 失败: {e}"))?;
        let fd = file.into_raw_fd();
        let speed = match baud {
            115_200 => libc::B115200,
            460_800 => libc::B460800,
            other => return Err(format!("不支持的波特率 {other}")),
        };
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut t) != 0 {
                return Err("tcgetattr 失败".into());
            }
            libc::cfmakeraw(&mut t);
            libc::cfsetispeed(&mut t, speed);
            libc::cfsetospeed(&mut t, speed);
            if libc::tcsetattr(fd, libc::TCSANOW, &t) != 0 {
                return Err("tcsetattr 失败".into());
            }
            // 先 STOP 再 START，确保从已知状态开始
            let stop: [u8; 2] = [0xA5, 0x25];
            libc::write(fd, stop.as_ptr() as *const libc::c_void, 2);
            std::thread::sleep(std::time::Duration::from_millis(60));
            let start: [u8; 2] = [0xA5, 0x20];
            libc::write(fd, start.as_ptr() as *const libc::c_void, 2);
        }
        Ok(Self {
            parser: C1Parser::new(max_points),
            t0: std::time::Instant::now(),
            fd,
            empty_reads: 0,
        })
    }
}

#[cfg(unix)]
impl Drop for SerialSource {
    fn drop(&mut self) {
        unsafe {
            let stop: [u8; 2] = [0xA5, 0x25];
            libc::write(self.fd, stop.as_ptr() as *const libc::c_void, 2);
            libc::close(self.fd);
        }
    }
}

#[cfg(unix)]
impl LidarSource for SerialSource {
    fn next_scan(&mut self) -> ReadOutcome {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(150);
        while std::time::Instant::now() < deadline {
            let mut tmp = [0u8; 1024];
            let n = unsafe { libc::read(self.fd, tmp.as_mut_ptr() as *mut libc::c_void, tmp.len()) };
            if n < 0 {
                let err = std::io::Error::last_os_error();
                return match err.kind() {
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted => {
                        ReadOutcome::Idle
                    }
                    _ => ReadOutcome::Lost(format!("读串口失败: {err}")),
                };
            }
            if n == 0 {
                self.empty_reads += 1;
                if self.empty_reads > 30 {
                    return ReadOutcome::Lost("串口长时间无数据（设备可能已拔出）".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }
            self.empty_reads = 0;
            let now_ms = self.t0.elapsed().as_millis() as u32;
            let mut scans = self.parser.feed(&tmp[..n as usize], now_ms);
            if !scans.is_empty() {
                return ReadOutcome::Scan(scans.swap_remove(0));
            }
        }
        ReadOutcome::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按真实协议编码一个节点（角度 q6、距离 mm）
    fn enc(angle_q6: u16, dist_mm: u16, quality: u8) -> [u8; 5] {
        let raw = (angle_q6 << 1) | 0x01;
        let d = dist_mm * 4;
        [
            (quality & 0x3f) << 2,
            (raw & 0xff) as u8,
            (raw >> 8) as u8,
            (d & 0xff) as u8,
            (d >> 8) as u8,
        ]
    }

    fn one_rev(with_header: bool) -> Vec<u8> {
        let mut v = Vec::new();
        if with_header {
            v.extend_from_slice(&SCAN_HEADER);
        }
        for i in 0..450u32 {
            let q6 = (i * 16_384 / 450) as u16; // 0..16384 → 0..360°
            v.extend_from_slice(&enc(q6, 1500 + (i % 50) as u16, 60));
        }
        v.extend_from_slice(&enc(0, 1200, 60)); // 回绕
        v.extend_from_slice(&enc(100, 1200, 60));
        v
    }

    #[test]
    fn parses_node_fields() {
        let b = enc(9000, 1500, 60);
        let n = parse_node(&b).expect("node");
        assert_eq!(n.quality, 60);
        assert_eq!(n.dist_mm, 1500);
        assert!((n.angle_cdeg as i32 - 14062).abs() <= 2, "{}", n.angle_cdeg);
    }

    #[test]
    fn rejects_when_check_bit_missing() {
        let mut b = enc(1000, 500, 10);
        b[1] &= 0xfe;
        assert!(parse_node(&b).is_none());
    }

    #[test]
    fn aligns_and_produces_full_revolution() {
        let mut p = C1Parser::new(1000);
        let scans = p.feed(&one_rev(true), 100);
        assert_eq!(scans.len(), 1, "应产出 1 圈");
        assert!(scans[0].points.len() >= 440, "点数 {}", scans[0].points.len());
        assert_eq!(p.resyncs, 0, "不应触发重新对齐");
    }

    #[test]
    fn aligns_without_scan_header() {
        let mut p = C1Parser::new(1000);
        let scans = p.feed(&one_rev(false), 100);
        assert_eq!(scans.len(), 1);
        assert!(scans[0].points.len() >= 440);
    }

    #[test]
    fn survives_arbitrary_prefix_bytes() {
        let mut p = C1Parser::new(1000);
        let mut data = vec![0x00, 0xde, 0xad, 0xbe, 0xef, 0x11];
        data.extend_from_slice(&one_rev(false));
        let scans = p.feed(&data, 100);
        assert_eq!(scans.len(), 1);
        assert!(scans[0].points.len() >= 430, "点数 {}", scans[0].points.len());
    }

    #[test]
    fn fragmented_input_is_reassembled() {
        let mut p = C1Parser::new(1000);
        let data = one_rev(true);
        let mut total = Vec::new();
        for chunk in data.chunks(7) {
            total.extend(p.feed(chunk, 100));
        }
        assert_eq!(total.len(), 1);
        assert!(total[0].points.len() >= 440);
    }

    #[test]
    fn does_not_emit_scans_with_too_few_points() {
        let mut p = C1Parser::new(1000);
        let mut data = Vec::new();
        for i in 0..6u32 {
            data.extend_from_slice(&enc((i * 100) as u16, 800, 40));
        }
        data.extend_from_slice(&enc(0, 800, 40));
        assert!(p.feed(&data, 100).is_empty());
    }

    #[test]
    fn mock_source_is_stable() {
        let mut src = MockSource::new(1000);
        match src.next_scan() {
            ReadOutcome::Scan(a) => {
                assert_eq!(a.points.len(), 450);
                match src.next_scan() {
                    ReadOutcome::Scan(b) => assert_eq!(b.scan_seq, 1),
                    other => panic!("expect scan, got {other:?}"),
                }
            }
            other => panic!("expect scan, got {other:?}"),
        }
    }
}
