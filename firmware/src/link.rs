//! 控制链路（TCP 9527）与 UDP 发现（9528）。
//!
//! 设计要点：
//! * 控制线程只写 `Telemetry`/只读 `CmdSlot`，两者都是无锁原子；
//! * 网络线程不做任何控制决策，只搬运；
//! * 点云进有界队列（长度 3，丢旧保新），不反压雷达线程；
//! * 单客户端：新连接顶替旧连接。

use crate::config::Config;
use crate::control::Output;
use crate::protocol::*;
use crate::Shared;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 控制线程 → 网络线程 的只读快照
#[derive(Debug, Default)]
pub struct Telemetry {
    pub throttle: std::sync::atomic::AtomicI16,
    pub rudder: std::sync::atomic::AtomicI16,
    pub direction: std::sync::atomic::AtomicU8,
    pub flags: std::sync::atomic::AtomicU8,
    pub loop_hz_x10: std::sync::atomic::AtomicU16,
    pub lidar_ok: std::sync::atomic::AtomicBool,
}

impl Telemetry {
    pub fn store(&self, out: &Output) {
        self.throttle.store(out.throttle_x10, Ordering::Relaxed);
        self.rudder.store(out.servos_x10[0], Ordering::Relaxed);
        self.direction.store(out.direction, Ordering::Relaxed);
        self.flags.store(out.flags, Ordering::Relaxed);
        self.lidar_ok
            .store(out.flags & ST_LIDAR_OK != 0, Ordering::Relaxed);
    }
}

/// 一键打包的 CMD 槽（无锁，控制线程不会阻塞在网络上）
#[derive(Debug, Default)]
pub struct CmdSlot {
    word: std::sync::atomic::AtomicU64,
    last_ms: std::sync::atomic::AtomicU32,
    /// 0 是合法时间戳，不能用它表示「尚未收到」——需要独立标志
    has_cmd: std::sync::atomic::AtomicBool,
}

impl CmdSlot {
    pub fn store(&self, cmd: &Cmd, seq: u16, now_ms: u32) {
        let w = (cmd.throttle_x10 as u16 as u64)
            | ((cmd.servos_x10[0] as u16 as u64) << 16)
            | ((cmd.flags as u64) << 32)
            | ((seq as u64) << 40);
        self.word.store(w, Ordering::Release);
        self.last_ms.store(now_ms, Ordering::Release);
        self.has_cmd.store(true, Ordering::Release);
    }

    pub fn load(&self) -> (Cmd, Option<u32>) {
        let w = self.word.load(Ordering::Acquire);
        let cmd = Cmd {
            throttle_x10: (w & 0xffff) as u16 as i16,
            servos_x10: [((w >> 16) & 0xffff) as u16 as i16, 0, 0, 0],
            flags: ((w >> 32) & 0xff) as u8,
        };
        let has = self.has_cmd.load(Ordering::Acquire);
        (cmd, if has { Some(self.last_ms.load(Ordering::Acquire)) } else { None })
    }

    pub fn clear_flag(&self, flag: u8) {
        loop {
            let w = self.word.load(Ordering::Acquire);
            let flags = ((w >> 32) & 0xff) as u8;
            let new_flags = flags & !flag;
            let new = (w & !(0xffu64 << 32)) | ((new_flags as u64) << 32);
            if self
                .word
                .compare_exchange(w, new, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return;
            }
        }
    }
}

pub fn spawn_tcp(shared: Arc<Shared>, cfg: &Config) -> Result<(), String> {
    let addr = format!("{}:{}", cfg.network.bind, cfg.network.port);
    let listener = TcpListener::bind(&addr).map_err(|e| format!("绑定 {addr} 失败: {e}"))?;
    println!("[link] TCP 监听 {addr}");

    std::thread::Builder::new()
        .name("tcp-accept".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        let sh = Arc::clone(&shared);
                        let _ = std::thread::Builder::new()
                            .name("tcp-client".into())
                            .spawn(move || handle_client(s, sh));
                    }
                    Err(e) => eprintln!("[link] accept 失败: {e}"),
                }
            }
        })
        .map_err(|e| format!("启动 TCP 线程失败: {e}"))?;
    Ok(())
}

fn handle_client(mut stream: TcpStream, shared: Arc<Shared>) {
    let peer = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "?".into());
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    let writer = match stream.try_clone() {
        Ok(w) => Arc::new(Mutex::new(w)),
        Err(e) => {
            eprintln!("[link] {peer} 克隆流失败: {e}");
            return;
        }
    };
    println!("[link] 客户端接入 {peer}");

    let connected = Arc::new(std::sync::atomic::AtomicBool::new(true));

    // 写线程：50Hz STATUS + 点云
    let w_shared = Arc::clone(&shared);
    let w_stream = Arc::clone(&writer);
    let w_flag = Arc::clone(&connected);
    let writer_thread = std::thread::Builder::new()
        .name("tcp-writer".into())
        .spawn(move || {
            let period = Duration::from_millis(20);
            let mut next = Instant::now();
            let t0 = Instant::now();
            while w_flag.load(Ordering::Relaxed) {
                let st = Status {
                    time_ms: crate::now_ms(),
                    throttle_x10: w_shared.telemetry.throttle.load(Ordering::Relaxed),
                    direction: w_shared.telemetry.direction.load(Ordering::Relaxed),
                    servos_x10: [
                        w_shared.telemetry.rudder.load(Ordering::Relaxed),
                        0,
                        0,
                        0,
                    ],
                    flags: w_shared.telemetry.flags.load(Ordering::Relaxed)
                        | if w_shared.time_bad.load(Ordering::Relaxed) {
                            ST_TIME_BAD
                        } else {
                            0
                        },
                    rx_seq: w_shared.rx_seq.load(Ordering::Relaxed),
                    rx_errors: w_shared.rx_errors.load(Ordering::Relaxed),
                    points_last: w_shared.points_last.load(Ordering::Relaxed),
                    scans_total: w_shared.scans_total.load(Ordering::Relaxed),
                    loop_hz_x10: w_shared.telemetry.loop_hz_x10.load(Ordering::Relaxed),
                };
                let mut frame = build_frame(T_STATUS, w_shared.tx_seq.fetch_add(1, Ordering::Relaxed), &st.encode());

                // 每拍最多带一圈点云，避免突发
                let scan = {
                    let mut q = w_shared.scans.lock().unwrap_or_else(|e| e.into_inner());
                    q.pop_front()
                };
                if let Some(scan) = scan {
                    let (kind, payload) = if scan.v2 {
                        (T_SCAN2, scan.data.encode_v2(true))
                    } else {
                        (T_SCAN, scan.data.encode_v1(true))
                    };
                    frame.extend_from_slice(&build_frame(
                        kind,
                        w_shared.tx_seq.fetch_add(1, Ordering::Relaxed),
                        &payload,
                    ));
                }

                let mut s = w_stream.lock().unwrap_or_else(|e| e.into_inner());
                if s.write_all(&frame).is_err() {
                    break;
                }
                next += period;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
            w_flag.store(false, Ordering::Relaxed);
        })
        .ok();

    // 读线程（当前线程）
    let mut parser = FrameParser::new();
    let mut buf = [0u8; 2048];
    let t0 = Instant::now();
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for (frame, payload) in parser.feed(&buf[..n]) {
                    match frame.kind {
                        T_CMD => {
                            if let Some(cmd) = Cmd::decode(&payload) {
                                let now = crate::now_ms();
                                shared.cmd.store(&cmd, frame.seq, now);
                                shared.rx_seq.store(frame.seq, Ordering::Relaxed);
                                // 协议字段是 u16，计数器回绕可接受
                                shared
                                    .rx_errors
                                    .store(parser.crc_errors as u16, Ordering::Relaxed);
                            }
                        }
                        T_HELLO => {
                            if let Some(hello) = Hello::decode(&payload) {
                                let v2 = hello.proto_max >= 2;
                                shared
                                    .client_caps
                                    .store(hello.client_caps | if v2 { CAP_SCAN2 } else { 0 }, Ordering::Relaxed);
                                shared
                                    .client_v2
                                    .store(v2, Ordering::Relaxed);
                                // +1：0 是「尚未握手」的哨兵值
                                shared
                                    .hello_ms
                                    .store(crate::now_ms() + 1, Ordering::Relaxed);
                                let ack = HelloAck {
                                    proto: if v2 { 2 } else { 1 },
                                    fw: fw_version(),
                                    caps: CAP_SCAN2
                                        | CAP_OTA
                                        | CAP_SELFTEST
                                        | if shared.watchdog_armed.load(Ordering::Relaxed) {
                                            CAP_WATCHDOG
                                        } else {
                                            0
                                        },
                                    uptime_s: crate::now_ms() / 1000,
                                    hw_id: hw_id(),
                                };
                                let frame =
                                    build_frame(T_HELLO_ACK, 0, &ack.encode());
                                let mut s = writer.lock().unwrap_or_else(|e| e.into_inner());
                                let _ = s.write_all(&frame);
                            }
                        }
                        T_PING => {
                            // 时钟同步：把 T2/T3 都填成「现在」，两者差不超过 1ms
                            if let Some(ping) = Ping::decode(&payload) {
                                let t2 = crate::now_ms();
                                let pong = Pong { t1_ms: ping.t1_ms, t2_ms: t2, t3_ms: t2 };
                                let frame = build_frame(T_PONG, 0, &pong.encode());
                                let mut s = writer.lock().unwrap_or_else(|e| e.into_inner());
                                let _ = s.write_all(&frame);
                            }
                        }
                        T_TIME_SYNC => {
                            // 客户端请求校时：异步查询，别阻塞读线程（DNS + UDP 可能几秒）
                            let sh = Arc::clone(&shared);
                            let cfg = sh.ntp_cfg.clone();
                            let writer2 = Arc::clone(&writer);
                            let _ = std::thread::Builder::new()
                                .name("ntp-sync".into())
                                .spawn(move || {
                                    let timeout = Duration::from_millis(cfg.timeout_ms as u64);
                                    let (status, offset_sec, rtt_ms) =
                                        match crate::ntp::sync(&cfg.server, timeout, true) {
                                            Ok((off, rtt)) => {
                                                println!(
                                                    "[ntp] 校时成功：偏差 {off}s，rtt {rtt}ms"
                                                );
                                                sh.ntp_offset_sec.store(off, Ordering::Relaxed);
                                                // 用户主动校时 = 已处理，清除「时间不可信」告警
                                                sh.time_bad.store(false, Ordering::Relaxed);
                                                (0u8, off, rtt)
                                            }
                                            Err(e) => {
                                                eprintln!("[ntp] 校时失败: {e}");
                                                (1u8, 0, 0u16)
                                            }
                                        };
                                    let res = TimeSyncResult { status, offset_sec, rtt_ms };
                                    let frame = build_frame(T_TIME_SYNC_RESULT, 0, &res.encode());
                                    let mut s = writer2.lock().unwrap_or_else(|e| e.into_inner());
                                    let _ = s.write_all(&frame);
                                });
                        }
                        _ => {}
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
        if !connected.load(Ordering::Relaxed) {
            break;
        }
    }

    connected.store(false, Ordering::Relaxed);
    println!("[link] 客户端断开 {peer}");
    if let Some(t) = writer_thread {
        let _ = t.join();
    }
    // 失联即回安全态：清 ARM 位，控制线程下一拍会归零
    shared.cmd.clear_flag(CMD_FLAG_ARM);
}

pub fn fw_version() -> (u16, u16, u16) {
    (
        env!("CARGO_PKG_VERSION_MAJOR").parse().unwrap_or(0),
        env!("CARGO_PKG_VERSION_MINOR").parse().unwrap_or(0),
        env!("CARGO_PKG_VERSION_PATCH").parse().unwrap_or(0),
    )
}

pub fn hw_id() -> [u8; 8] {
    let mut id = *b"USV----\0";
    if let Ok(s) = std::fs::read_to_string("/etc/machine-id") {
        let hexs: String = s.trim().chars().take(4).collect();
        for (i, b) in hexs.bytes().enumerate().take(4) {
            id[3 + i] = b;
        }
    }
    id
}

/// 点云入队（容量 3，丢旧保新）
pub fn push_scan(shared: &Shared, scan: crate::protocol::Scan, v2: bool) {
    shared.points_last.store(scan.points.len() as u16, Ordering::Relaxed);
    shared.scans_total.store(scan.scan_seq as u16, Ordering::Relaxed);
    let mut q = shared.scans.lock().unwrap_or_else(|e| e.into_inner());
    if q.len() >= 3 {
        q.pop_front();
    }
    q.push_back(crate::QueuedScan { data: scan, v2 });
}

/* ---------------- UDP 发现 ---------------- */

pub fn spawn_discovery(shared: Arc<Shared>, cfg: &Config) -> Result<(), String> {
    if !cfg.discovery.enabled {
        return Ok(());
    }
    let port = cfg.discovery.udp_port;
    let sock = UdpSocket::bind(("0.0.0.0", port))
        .map_err(|e| format!("绑定 UDP {port} 失败: {e}"))?;
    let _ = sock.set_broadcast(true);
    let _ = sock.set_read_timeout(Some(Duration::from_millis(200)));
    println!("[disc] UDP 广播 {port}");

    let interval = Duration::from_millis(cfg.discovery.interval_ms.max(200));
    let name = cfg.discovery.name.clone();
    let tcp_port = cfg.network.port;

    std::thread::Builder::new()
        .name("discovery".into())
        .spawn(move || {
            let mut last = Instant::now() - interval;
            let mut buf = [0u8; 1024];
            loop {
                // 收到探测就立即应答
                if let Ok((n, from)) = sock.recv_from(&mut buf) {
                    if n >= 12 && &buf[0..8] == b"USVDISC1" && &buf[8..12] == b"prob" {
                        let beacon = beacon_json(&name, tcp_port, &shared);
                        let mut pkt = Vec::new();
                        pkt.extend_from_slice(b"USVDISC1");
                        pkt.extend_from_slice(b"beac");
                        pkt.extend_from_slice(beacon.as_bytes());
                        let _ = sock.send_to(&pkt, from);
                    }
                }
                if last.elapsed() >= interval {
                    last = Instant::now();
                    let beacon = beacon_json(&name, tcp_port, &shared);
                    let mut pkt = Vec::new();
                    pkt.extend_from_slice(b"USVDISC1");
                    pkt.extend_from_slice(b"beac");
                    pkt.extend_from_slice(beacon.as_bytes());
                    let _ = sock.send_to(&pkt, ("255.255.255.255", port));
                }
            }
        })
        .map_err(|e| format!("启动发现线程失败: {e}"))?;
    Ok(())
}

/// 最小 JSON 字符串转义：name/sn 来自配置或系统文件，不能直接拼接。
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

/// 硬件序列号的可打印形式：截断到首个 NUL 并丢弃非 ASCII 图形字符。
fn hw_id_str() -> String {
    let raw = hw_id();
    let s: String = raw
        .iter()
        .take_while(|&&b| b != 0)
        .filter(|b| b.is_ascii_graphic())
        .map(|&b| b as char)
        .collect();
    if s.is_empty() {
        "unknown".into()
    } else {
        s
    }
}

fn beacon_json(name: &str, tcp_port: u16, shared: &Shared) -> String {
    let flags = shared.telemetry.flags.load(Ordering::Relaxed);
    let state = if flags & ST_ESTOP != 0 {
        "estop"
    } else if flags & ST_FAILSAFE != 0 {
        "failsafe"
    } else if flags & ST_ARMED != 0 {
        "armed"
    } else {
        "ready"
    };
    format!(
        concat!(
            r#"{{"kind":"usv","ver":2,"name":"{name}","sn":"{sn}","tcp_port":{port},"ips":[],"#,
            r#""state":"{state}","lidar":{lidar},"armed":{armed},"estop":{estop},"#,
            r#""failsafe":{fs},"hz":{hz},"uptime_s":{up},"t":{t},"reply_to_probe":true}}"#
        ),
        name = json_escape(name),
        sn = json_escape(&hw_id_str()),
        port = tcp_port,
        state = state,
        lidar = shared.telemetry.lidar_ok.load(Ordering::Relaxed),
        armed = flags & ST_ARMED != 0,
        estop = flags & ST_ESTOP != 0,
        fs = flags & ST_FAILSAFE != 0,
        hz = shared.telemetry.loop_hz_x10.load(Ordering::Relaxed) as f32 / 10.0,
        up = 0,
        t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_slot_roundtrip() {
        let slot = CmdSlot::default();
        let cmd = Cmd {
            throttle_x10: -321,
            servos_x10: [123, 0, 0, 0],
            flags: CMD_FLAG_ARM | CMD_FLAG_ESTOP,
        };
        slot.store(&cmd, 7, 1000);
        let (back, ms) = slot.load();
        assert_eq!(back.throttle_x10, -321);
        assert_eq!(back.servos_x10[0], 123);
        assert_eq!(back.flags, CMD_FLAG_ARM | CMD_FLAG_ESTOP);
        assert_eq!(ms, Some(1000));
    }

    #[test]
    fn clearing_arm_flag_is_atomic() {
        let slot = CmdSlot::default();
        slot.store(
            &Cmd {
                throttle_x10: 100,
                servos_x10: [0; 4],
                flags: CMD_FLAG_ARM | CMD_FLAG_ESTOP,
            },
            1,
            10,
        );
        slot.clear_flag(CMD_FLAG_ARM);
        let (cmd, _) = slot.load();
        assert!(!cmd.armed(), "断链后必须撤销 ARM");
        assert!(cmd.estop(), "其它标志应保留");
    }

    /// 回归：CMD 时间戳与 now_ms 必须是同一时钟基准，
    /// 否则控制线程会误判看门狗超时（曾导致 STATUS 恒为「失联保护」）。
    #[test]
    fn cmd_timestamp_shares_process_clock() {
        let slot = CmdSlot::default();
        let t = crate::now_ms();
        slot.store(
            &Cmd {
                throttle_x10: 100,
                servos_x10: [0; 4],
                flags: CMD_FLAG_ARM,
            },
            1,
            t,
        );
        let (cmd, last) = slot.load();
        let out = crate::control::step(
            &cmd,
            last,
            crate::now_ms(),
            &crate::config::ControlCfg::default(),
            true,
        );
        assert_eq!(out.throttle_x10, 100, "同一拍内不应被判超时");
        assert_eq!(out.flags & crate::protocol::ST_FAILSAFE, 0);
    }

    #[test]
    fn beacon_contains_required_fields() {
        let shared = crate::Shared::new();
        let json = beacon_json("USV-Test", 9527, &shared);
        for key in [
            "\"kind\":\"usv\"",
            "\"tcp_port\":9527",
            "\"state\":\"ready\"",
            "\"reply_to_probe\":true",
        ] {
            assert!(json.contains(key), "缺少 {key}: {json}");
        }
        assert!(serde_json::from_str::<serde_json::Value>(&json).is_ok());
    }
}

/// 队列元素：点云 + 是否需要 v2 格式
pub fn make_queue() -> Mutex<VecDeque<crate::QueuedScan>> {
    Mutex::new(VecDeque::with_capacity(3))
}
