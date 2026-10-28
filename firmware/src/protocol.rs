//! USV Edge 协议 v1/v2 编解码。
//!
//! 帧: `AA 55 | ver | type | seq(u16) | len(u16) | payload | crc16(u16)`，小端，
//! CRC16-CCITT-FALSE 覆盖 `ver..payload`。与客户端 `desktop/src/shared/protocol.ts` 一致。

// 本模块是客户端/服务端共用的协议镜像：encode/decode 两侧都保留，
// 固件端只用到其中一部分，因此整体允许 dead_code。
#![allow(dead_code)]

pub const HEADER: [u8; 2] = [0xaa, 0x55];
pub const PROTO_VER: u8 = 1;
pub const MAX_PAYLOAD: usize = 8192;

pub const T_CMD: u8 = 0x01;
pub const T_HELLO: u8 = 0x03;
pub const T_PING: u8 = 0x04;
pub const T_TIME_SYNC: u8 = 0x05;
pub const T_STATUS: u8 = 0x81;
pub const T_SCAN: u8 = 0x82;
pub const T_HELLO_ACK: u8 = 0x83;
pub const T_PONG: u8 = 0x84;
pub const T_SCAN2: u8 = 0x85;
pub const T_TIME_SYNC_RESULT: u8 = 0x86;

pub const T_OTA_BEGIN: u8 = 0x11;
pub const T_OTA_DATA: u8 = 0x12;
pub const T_OTA_COMMIT: u8 = 0x13;
pub const T_OTA_ABORT: u8 = 0x14;
pub const T_OTA_ACK: u8 = 0x91;
pub const T_OTA_PROGRESS: u8 = 0x92;
pub const T_OTA_RESULT: u8 = 0x93;

pub const CMD_FLAG_ARM: u8 = 0x01;
pub const CMD_FLAG_ESTOP: u8 = 0x02;

pub const ST_ARMED: u8 = 1 << 0;
pub const ST_ESTOP: u8 = 1 << 1;
pub const ST_FAILSAFE: u8 = 1 << 2;
pub const ST_LIDAR_OK: u8 = 1 << 3;
pub const ST_ARM_REQUIRED: u8 = 1 << 4;
/// 系统时间与 NTP 相差超过阈值（默认 1h）→ 客户端应弹窗引导校时
pub const ST_TIME_BAD: u8 = 1 << 5;

pub const CAP_SCAN2: u32 = 1 << 0;
pub const CAP_OTA: u32 = 1 << 1;
pub const CAP_IMU: u32 = 1 << 2;
pub const CAP_VIDEO: u32 = 1 << 3;
pub const CAP_SELFTEST: u32 = 1 << 4;
/// systemd 层的启动失败回滚看门狗已装（OnFailure + rollback.sh）。
/// 装好之后坏版本会自己退回上一版，客户端据此决定是否需要二次确认升级。
pub const CAP_WATCHDOG: u32 = 1 << 5;

pub const CMD_LEN: usize = 12;
pub const STATUS_LEN: usize = 26;
pub const HELLO_LEN: usize = 10;
pub const HELLO_ACK_LEN: usize = 26;
pub const SCAN2_HDR_LEN: usize = 24;

pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xffff;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

pub fn build_frame(kind: u8, seq: u16, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(6 + payload.len());
    body.push(PROTO_VER);
    body.push(kind);
    body.extend_from_slice(&seq.to_le_bytes());
    body.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    body.extend_from_slice(payload);

    let mut out = Vec::with_capacity(2 + body.len() + 2);
    out.extend_from_slice(&HEADER);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc16(&body).to_le_bytes());
    out
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Cmd {
    pub throttle_x10: i16,
    pub servos_x10: [i16; 4],
    pub flags: u8,
}

impl Cmd {
    pub fn armed(&self) -> bool {
        self.flags & CMD_FLAG_ARM != 0
    }
    pub fn estop(&self) -> bool {
        self.flags & CMD_FLAG_ESTOP != 0
    }
    pub fn encode(&self) -> [u8; CMD_LEN] {
        let mut b = [0u8; CMD_LEN];
        b[0..2].copy_from_slice(&self.throttle_x10.to_le_bytes());
        for (i, s) in self.servos_x10.iter().enumerate() {
            b[2 + i * 2..4 + i * 2].copy_from_slice(&s.to_le_bytes());
        }
        b[10] = self.flags;
        b
    }
    pub fn decode(p: &[u8]) -> Option<Cmd> {
        if p.len() != CMD_LEN {
            return None;
        }
        Some(Cmd {
            throttle_x10: i16::from_le_bytes([p[0], p[1]]),
            servos_x10: [
                i16::from_le_bytes([p[2], p[3]]),
                i16::from_le_bytes([p[4], p[5]]),
                i16::from_le_bytes([p[6], p[7]]),
                i16::from_le_bytes([p[8], p[9]]),
            ],
            flags: p[10],
        })
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Status {
    pub time_ms: u32,
    pub throttle_x10: i16,
    pub direction: u8,
    pub servos_x10: [i16; 4],
    pub flags: u8,
    pub rx_seq: u16,
    pub rx_errors: u16,
    pub points_last: u16,
    pub scans_total: u16,
    pub loop_hz_x10: u16,
}

impl Status {
    pub fn encode(&self) -> [u8; STATUS_LEN] {
        let mut b = [0u8; STATUS_LEN];
        b[0..4].copy_from_slice(&self.time_ms.to_le_bytes());
        b[4..6].copy_from_slice(&self.throttle_x10.to_le_bytes());
        b[6] = self.direction;
        for (i, s) in self.servos_x10.iter().enumerate() {
            b[7 + i * 2..9 + i * 2].copy_from_slice(&s.to_le_bytes());
        }
        b[15] = self.flags;
        b[16..18].copy_from_slice(&self.rx_seq.to_le_bytes());
        b[18..20].copy_from_slice(&self.rx_errors.to_le_bytes());
        b[20..22].copy_from_slice(&self.points_last.to_le_bytes());
        b[22..24].copy_from_slice(&self.scans_total.to_le_bytes());
        b[24..26].copy_from_slice(&self.loop_hz_x10.to_le_bytes());
        b
    }

    pub fn decode(p: &[u8]) -> Option<Status> {
        if p.len() != STATUS_LEN {
            return None;
        }
        Some(Status {
            time_ms: u32::from_le_bytes([p[0], p[1], p[2], p[3]]),
            throttle_x10: i16::from_le_bytes([p[4], p[5]]),
            direction: p[6],
            servos_x10: [
                i16::from_le_bytes([p[7], p[8]]),
                i16::from_le_bytes([p[9], p[10]]),
                i16::from_le_bytes([p[11], p[12]]),
                i16::from_le_bytes([p[13], p[14]]),
            ],
            flags: p[15],
            rx_seq: u16::from_le_bytes([p[16], p[17]]),
            rx_errors: u16::from_le_bytes([p[18], p[19]]),
            points_last: u16::from_le_bytes([p[20], p[21]]),
            scans_total: u16::from_le_bytes([p[22], p[23]]),
            loop_hz_x10: u16::from_le_bytes([p[24], p[25]]),
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Hello {
    pub proto_max: u16,
    pub proto_min: u16,
    pub client_ver: u16,
    pub client_caps: u32,
}

impl Hello {
    pub fn decode(p: &[u8]) -> Option<Hello> {
        if p.len() != HELLO_LEN {
            return None;
        }
        Some(Hello {
            proto_max: u16::from_le_bytes([p[0], p[1]]),
            proto_min: u16::from_le_bytes([p[2], p[3]]),
            client_ver: u16::from_le_bytes([p[4], p[5]]),
            client_caps: u32::from_le_bytes([p[6], p[7], p[8], p[9]]),
        })
    }
    pub fn encode(&self) -> [u8; HELLO_LEN] {
        let mut b = [0u8; HELLO_LEN];
        b[0..2].copy_from_slice(&self.proto_max.to_le_bytes());
        b[2..4].copy_from_slice(&self.proto_min.to_le_bytes());
        b[4..6].copy_from_slice(&self.client_ver.to_le_bytes());
        b[6..10].copy_from_slice(&self.client_caps.to_le_bytes());
        b
    }
}

#[derive(Debug, Clone, Default)]
pub struct HelloAck {
    pub proto: u16,
    pub fw: (u16, u16, u16),
    pub caps: u32,
    pub uptime_s: u32,
    pub hw_id: [u8; 8],
}

impl HelloAck {
    pub fn encode(&self) -> [u8; HELLO_ACK_LEN] {
        let mut b = [0u8; HELLO_ACK_LEN];
        b[0..2].copy_from_slice(&self.proto.to_le_bytes());
        b[2..4].copy_from_slice(&self.fw.0.to_le_bytes());
        b[4..6].copy_from_slice(&self.fw.1.to_le_bytes());
        b[6..8].copy_from_slice(&self.fw.2.to_le_bytes());
        b[8..12].copy_from_slice(&self.caps.to_le_bytes());
        b[12..16].copy_from_slice(&self.uptime_s.to_le_bytes());
        b[16..24].copy_from_slice(&self.hw_id);
        b
    }
    pub fn decode(p: &[u8]) -> Option<HelloAck> {
        if p.len() != HELLO_ACK_LEN {
            return None;
        }
        let mut hw = [0u8; 8];
        hw.copy_from_slice(&p[16..24]);
        Some(HelloAck {
            proto: u16::from_le_bytes([p[0], p[1]]),
            fw: (
                u16::from_le_bytes([p[2], p[3]]),
                u16::from_le_bytes([p[4], p[5]]),
                u16::from_le_bytes([p[6], p[7]]),
            ),
            caps: u32::from_le_bytes([p[8], p[9], p[10], p[11]]),
            uptime_s: u32::from_le_bytes([p[12], p[13], p[14], p[15]]),
            hw_id: hw,
        })
    }
}

/* ---------------- 时钟同步（NTP 四时间戳法） ----------------
 *
 *   T1 客户端发出 → T2 船端收到 → T3 船端发出 → T4 客户端收到
 *   delay  = (T4-T1) - (T3-T2)     网络往返（不含船端处理）
 *   offset = ((T2-T1) + (T3-T4)) / 2   船钟 - 客户钟
 *   上行 = offset + delay/2 ；下行 = delay/2 - offset   （基于路径对称假设）
 */

pub const PING_LEN: usize = 8;
pub const PONG_LEN: usize = 16;
pub const TIME_SYNC_RESULT_LEN: usize = 8;

/// 客户端 → 船端：T1 用客户端 epoch 毫秒（u64，u32 装不下 1970 以来）
#[derive(Debug, Clone, Copy, Default)]
pub struct Ping {
    pub t1_ms: u64,
}

impl Ping {
    pub fn encode(&self) -> [u8; PING_LEN] {
        let mut b = [0u8; PING_LEN];
        b[0..8].copy_from_slice(&self.t1_ms.to_le_bytes());
        b
    }
    pub fn decode(p: &[u8]) -> Option<Ping> {
        if p.len() < PING_LEN {
            return None;
        }
        let mut t = [0u8; 8];
        t.copy_from_slice(&p[0..8]);
        Some(Ping { t1_ms: u64::from_le_bytes(t) })
    }
}

/// 船端 → 客户端：回显 T1，并带上船端收/发的单调时刻
#[derive(Debug, Clone, Copy, Default)]
pub struct Pong {
    pub t1_ms: u64,
    pub t2_ms: u32,
    pub t3_ms: u32,
}

impl Pong {
    pub fn encode(&self) -> [u8; PONG_LEN] {
        let mut b = [0u8; PONG_LEN];
        b[0..8].copy_from_slice(&self.t1_ms.to_le_bytes());
        b[8..12].copy_from_slice(&self.t2_ms.to_le_bytes());
        b[12..16].copy_from_slice(&self.t3_ms.to_le_bytes());
        b
    }
    pub fn decode(p: &[u8]) -> Option<Pong> {
        if p.len() < PONG_LEN {
            return None;
        }
        let mut t = [0u8; 8];
        t.copy_from_slice(&p[0..8]);
        Some(Pong {
            t1_ms: u64::from_le_bytes(t),
            t2_ms: u32::from_le_bytes([p[8], p[9], p[10], p[11]]),
            t3_ms: u32::from_le_bytes([p[12], p[13], p[14], p[15]]),
        })
    }
}

/// 校时结果。status: 0=成功 1=网络失败 2=设置时间失败
#[derive(Debug, Clone, Copy, Default)]
pub struct TimeSyncResult {
    pub status: u8,
    /// 校时前本地时间与 NTP 的偏差（秒）；正=本地慢，负=本地快
    pub offset_sec: i32,
    pub rtt_ms: u16,
}

impl TimeSyncResult {
    pub fn encode(&self) -> [u8; TIME_SYNC_RESULT_LEN] {
        let mut b = [0u8; TIME_SYNC_RESULT_LEN];
        b[0] = self.status;
        b[1] = 0;
        b[2..6].copy_from_slice(&self.offset_sec.to_le_bytes());
        b[6..8].copy_from_slice(&self.rtt_ms.to_le_bytes());
        b
    }
    pub fn decode(p: &[u8]) -> Option<TimeSyncResult> {
        if p.len() < TIME_SYNC_RESULT_LEN {
            return None;
        }
        Some(TimeSyncResult {
            status: p[0],
            offset_sec: i32::from_le_bytes([p[2], p[3], p[4], p[5]]),
            rtt_ms: u16::from_le_bytes([p[6], p[7]]),
        })
    }
}

/// 一圈点云（未压缩形式，5 字节/点）
#[derive(Debug, Clone, Default)]
pub struct Scan {
    pub t_start_ms: u32,
    pub t_end_ms: u32,
    pub scan_seq: u32,
    pub original_count: u16,
    pub rate_x100: u16,
    pub quality_max: u8,
    pub lidar_ok: bool,
    pub decimated: bool,
    pub t_start_estimated: bool,
    /// (angle_cdeg, dist_mm, quality)
    pub points: Vec<(u16, u16, u8)>,
}

impl Scan {
    fn raw_points(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.points.len() * 5);
        for &(a, d, q) in &self.points {
            out.extend_from_slice(&a.to_le_bytes());
            out.extend_from_slice(&d.to_le_bytes());
            out.push(q);
        }
        out
    }

    fn flags(&self) -> u8 {
        (self.lidar_ok as u8) | ((self.decimated as u8) << 1) | ((self.t_start_estimated as u8) << 2)
    }

    fn encode_body(&self, compress: bool) -> (u8, Vec<u8>) {
        if !compress {
            return (0, self.raw_points());
        }
        use std::io::Write;
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        let _ = enc.write_all(&self.raw_points());
        (1, enc.finish().unwrap_or_default())
    }

    /// v1 载荷：8 字节头 + 点（zlib 可选）
    pub fn encode_v1(&self, compress: bool) -> Vec<u8> {
        let (enc, body) = self.encode_body(compress);
        let mut out = Vec::with_capacity(8 + body.len());
        out.extend_from_slice(&self.t_end_ms.to_le_bytes());
        out.extend_from_slice(&(self.points.len() as u16).to_le_bytes());
        out.push(enc);
        out.push(0);
        out.extend_from_slice(&body);
        out
    }

    /// v2 载荷：24 字节头 + 点（zlib 可选）
    pub fn encode_v2(&self, compress: bool) -> Vec<u8> {
        let (enc, body) = self.encode_body(compress);
        let mut out = Vec::with_capacity(SCAN2_HDR_LEN + body.len());
        out.extend_from_slice(&self.t_start_ms.to_le_bytes());
        out.extend_from_slice(&self.t_end_ms.to_le_bytes());
        out.extend_from_slice(&self.scan_seq.to_le_bytes());
        out.extend_from_slice(&(self.points.len() as u16).to_le_bytes());
        out.extend_from_slice(&self.original_count.to_le_bytes());
        out.push(enc);
        out.push(self.flags());
        out.extend_from_slice(&self.rate_x100.to_le_bytes());
        out.push(self.quality_max);
        out.push(0);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&body);
        out
    }
}

pub fn decode_scan2(p: &[u8]) -> Option<Scan> {
    if p.len() < SCAN2_HDR_LEN {
        return None;
    }
    let count = u16::from_le_bytes([p[12], p[13]]) as usize;
    let enc = p[16];
    let flags = p[17];
    let mut body = &p[SCAN2_HDR_LEN..];
    let inflated;
    if enc == 1 {
        use std::io::Read;
        let mut d = flate2::read::ZlibDecoder::new(body);
        let mut v = Vec::new();
        d.read_to_end(&mut v).ok()?;
        inflated = v;
        body = &inflated;
    } else if enc != 0 {
        return None;
    }
    if body.len() < count * 5 {
        return None;
    }
    let mut points = Vec::with_capacity(count);
    for i in 0..count {
        let o = i * 5;
        points.push((
            u16::from_le_bytes([body[o], body[o + 1]]),
            u16::from_le_bytes([body[o + 2], body[o + 3]]),
            body[o + 4],
        ));
    }
    Some(Scan {
        t_start_ms: u32::from_le_bytes([p[0], p[1], p[2], p[3]]),
        t_end_ms: u32::from_le_bytes([p[4], p[5], p[6], p[7]]),
        scan_seq: u32::from_le_bytes([p[8], p[9], p[10], p[11]]),
        original_count: u16::from_le_bytes([p[14], p[15]]),
        rate_x100: u16::from_le_bytes([p[18], p[19]]),
        quality_max: p[20],
        lidar_ok: flags & 0x01 != 0,
        decimated: flags & 0x02 != 0,
        t_start_estimated: flags & 0x04 != 0,
        points,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub ver: u8,
    pub kind: u8,
    pub seq: u16,
}

pub struct FrameParser {
    buf: Vec<u8>,
    pub crc_errors: u32,
}

impl Default for FrameParser {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameParser {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
            crc_errors: 0,
        }
    }

    /// 返回本次解析出的帧：(元信息, 载荷)
    pub fn feed(&mut self, data: &[u8]) -> Vec<(Frame, Vec<u8>)> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();

        loop {
            let Some(idx) = find_header(&self.buf) else {
                let keep = self.buf.last() == Some(&0xaa);
                let len = self.buf.len();
                if keep {
                    self.buf.drain(..len - 1);
                } else {
                    self.buf.clear();
                }
                break;
            };
            if idx > 0 {
                self.buf.drain(..idx);
            }
            if self.buf.len() < 8 {
                break;
            }
            let plen = u16::from_le_bytes([self.buf[6], self.buf[7]]) as usize;
            if plen > MAX_PAYLOAD {
                self.buf.drain(..2);
                continue;
            }
            let total = 8 + plen + 2;
            if self.buf.len() < total {
                break;
            }
            let body = &self.buf[2..8 + plen];
            let want = u16::from_le_bytes([self.buf[8 + plen], self.buf[9 + plen]]);
            if crc16(body) != want {
                self.crc_errors += 1;
                self.buf.drain(..2);
                continue;
            }
            let frame = Frame {
                ver: self.buf[2],
                kind: self.buf[3],
                seq: u16::from_le_bytes([self.buf[4], self.buf[5]]),
            };
            let payload = self.buf[8..8 + plen].to_vec();
            self.buf.drain(..total);
            out.push((frame, payload));
        }
        out
    }
}

fn find_header(buf: &[u8]) -> Option<usize> {
    if buf.len() < 2 {
        return None;
    }
    buf.windows(2).position(|w| w == HEADER)
}

/* ---------------- OTA 载荷 ---------------- */

#[derive(Debug, Clone)]
pub struct OtaBegin {
    pub version: (u16, u16, u16),
    pub total_size: u32,
    pub sha256: [u8; 32],
    pub sig: [u8; 64],
    pub resume_offset: u32,
}

// `[u8; 64]` 没有实现 Default（只有 ≤32 的数组有），因此手写
impl Default for OtaBegin {
    fn default() -> Self {
        Self {
            version: (0, 0, 0),
            total_size: 0,
            sha256: [0; 32],
            sig: [0; 64],
            resume_offset: 0,
        }
    }
}

pub const OTA_BEGIN_LEN: usize = 6 + 4 + 32 + 64 + 4;

impl OtaBegin {
    pub fn decode(p: &[u8]) -> Option<OtaBegin> {
        if p.len() != OTA_BEGIN_LEN {
            return None;
        }
        let mut sha = [0u8; 32];
        sha.copy_from_slice(&p[10..42]);
        let mut sig = [0u8; 64];
        sig.copy_from_slice(&p[42..106]);
        Some(OtaBegin {
            version: (
                u16::from_le_bytes([p[0], p[1]]),
                u16::from_le_bytes([p[2], p[3]]),
                u16::from_le_bytes([p[4], p[5]]),
            ),
            total_size: u32::from_le_bytes([p[6], p[7], p[8], p[9]]),
            sha256: sha,
            sig,
            resume_offset: u32::from_le_bytes([p[106], p[107], p[108], p[109]]),
        })
    }

    pub fn encode(&self) -> [u8; OTA_BEGIN_LEN] {
        let mut b = [0u8; OTA_BEGIN_LEN];
        b[0..2].copy_from_slice(&self.version.0.to_le_bytes());
        b[2..4].copy_from_slice(&self.version.1.to_le_bytes());
        b[4..6].copy_from_slice(&self.version.2.to_le_bytes());
        b[6..10].copy_from_slice(&self.total_size.to_le_bytes());
        b[10..42].copy_from_slice(&self.sha256);
        b[42..106].copy_from_slice(&self.sig);
        b[106..110].copy_from_slice(&self.resume_offset.to_le_bytes());
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        hex::decode(s.replace(' ', "")).expect("hex")
    }

    #[test]
    fn crc_standard_vector() {
        assert_eq!(crc16(b"123456789"), 0x29b1);
    }

    #[test]
    fn cmd_golden_frame_matches_doc() {
        let cmd = Cmd {
            throttle_x10: 150,
            servos_x10: [100, 0, 0, 0],
            flags: CMD_FLAG_ARM,
        };
        let frame = build_frame(T_CMD, 1, &cmd.encode());
        assert_eq!(frame, hex("aa55010101000c009600640000000000000001004e58"));
    }

    #[test]
    fn status_golden_frame_roundtrip() {
        let raw = hex("aa55018100001a00e803000096000164000000000000000901000000e0010300f401476d");
        let mut p = FrameParser::new();
        let frames = p.feed(&raw);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0.kind, T_STATUS);
        let st = Status::decode(&frames[0].1).expect("status");
        assert_eq!(st.time_ms, 1000);
        assert_eq!(st.throttle_x10, 150);
        assert_eq!(st.servos_x10, [100, 0, 0, 0]);
        assert_eq!(st.flags, 0x09);
        assert_eq!(st.points_last, 480);
        assert_eq!(st.scans_total, 3);
        assert_eq!(st.loop_hz_x10, 500);
        assert_eq!(st.encode().to_vec(), frames[0].1);
    }

    #[test]
    fn scan_v1_golden_frame_parses() {
        let raw = hex("aa55018200001700e8030000030000000000e80350e02ed0075ac05db80b64edb0");
        let mut p = FrameParser::new();
        let frames = p.feed(&raw);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0.kind, T_SCAN);
        assert_eq!(frames[0].1.len(), 23);
    }

    #[test]
    fn parser_resyncs_after_noise_and_split() {
        let a = build_frame(T_STATUS, 7, &[0x11; STATUS_LEN]);
        let b = build_frame(T_SCAN, 8, &[0x22; 8]);
        let mut stream = vec![0x00, 0xaa, 0x99];
        stream.extend_from_slice(&a);
        stream.extend_from_slice(&b);

        let mut p = FrameParser::new();
        let mut got = Vec::new();
        for byte in stream {
            got.extend(p.feed(&[byte]));
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0.kind, T_STATUS);
        assert_eq!(got[1].0.kind, T_SCAN);
    }

    #[test]
    fn parser_counts_crc_errors() {
        let mut f = build_frame(T_STATUS, 1, &[0; STATUS_LEN]);
        let last = f.len() - 1;
        f[last] ^= 0xff;
        let mut p = FrameParser::new();
        assert!(p.feed(&f).is_empty());
        assert_eq!(p.crc_errors, 1);
        assert_eq!(p.feed(&build_frame(T_STATUS, 2, &[0; STATUS_LEN])).len(), 1);
    }

    #[test]
    fn scan2_roundtrip_zlib() {
        let scan = Scan {
            t_start_ms: 1000,
            t_end_ms: 1100,
            scan_seq: 42,
            original_count: 450,
            rate_x100: 1000,
            quality_max: 63,
            lidar_ok: true,
            decimated: false,
            t_start_estimated: false,
            points: vec![(0, 1000, 60), (9000, 2500, 30), (18000, 500, 10)],
        };
        let payload = scan.encode_v2(true);
        let back = decode_scan2(&payload).expect("scan2");
        assert_eq!(back.scan_seq, 42);
        assert_eq!(back.t_start_ms, 1000);
        assert_eq!(back.t_end_ms, 1100);
        assert_eq!(back.rate_x100, 1000);
        assert_eq!(back.quality_max, 63);
        assert!(back.lidar_ok);
        assert_eq!(back.points, scan.points);
    }

    #[test]
    fn hello_roundtrip() {
        let hello = Hello {
            proto_max: 2,
            proto_min: 1,
            client_ver: 1,
            client_caps: CAP_SCAN2 | CAP_OTA,
        };
        let back = Hello::decode(&hello.encode()).expect("hello");
        assert_eq!(back.proto_max, 2);
        assert_eq!(back.client_caps, CAP_SCAN2 | CAP_OTA);

        let ack = HelloAck {
            proto: 2,
            fw: (0, 2, 0),
            caps: CAP_SCAN2 | CAP_OTA | CAP_SELFTEST,
            uptime_s: 12,
            hw_id: *b"USVH6180",
        };
        let back = HelloAck::decode(&ack.encode()).expect("ack");
        assert_eq!(back.fw, (0, 2, 0));
        assert_eq!(back.hw_id, *b"USVH6180");
    }

    #[test]
    fn ota_begin_roundtrip() {
        let begin = OtaBegin {
            version: (0, 2, 0),
            total_size: 1234,
            sha256: [7; 32],
            sig: [9; 64],
            resume_offset: 512,
        };
        let back = OtaBegin::decode(&begin.encode()).expect("begin");
        assert_eq!(back.version, (0, 2, 0));
        assert_eq!(back.total_size, 1234);
        assert_eq!(back.sha256, [7; 32]);
        assert_eq!(back.resume_offset, 512);
    }
}
