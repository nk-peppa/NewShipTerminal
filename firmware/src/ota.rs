//! OTA 服务端（TCP 9530）。
//!
//! 目录约定：
//! ```text
//! <dir>/releases/<ver>/          解包后的版本
//! <dir>/current -> releases/<ver>  当前版本（原子切换）
//! <dir>/incoming/<ver>.pkg       上传中的包（可续传）
//! <dir>/rollback.json            切换前的版本，用于启动自检失败回滚
//! ```
//!
//! 安全约定：只在「未解锁」时接受；升级期间控制输出保持 0；包 SHA-256 必须匹配。

use crate::config::Config;
use crate::protocol::*;
use crate::Shared;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

struct Session {
    begin: Option<OtaBegin>,
    received: u32,
    file: Option<File>,
    last_progress: u32,
}

pub fn spawn(shared: Arc<Shared>, cfg: Config) -> Result<(), String> {
    if !cfg.ota.enabled {
        return Ok(());
    }
    let addr = format!("{}:{}", cfg.network.bind, cfg.ota.port);
    let listener = TcpListener::bind(&addr).map_err(|e| format!("绑定 OTA {addr} 失败: {e}"))?;
    println!("[ota] TCP 监听 {addr}（目录 {}）", cfg.ota.dir);

    std::thread::Builder::new()
        .name("ota-accept".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        let sh = Arc::clone(&shared);
                        let c = cfg.clone();
                        let _ = std::thread::Builder::new()
                            .name("ota-conn".into())
                            .spawn(move || handle(s, sh, c));
                    }
                    Err(e) => eprintln!("[ota] accept 失败: {e}"),
                }
            }
        })
        .map_err(|e| format!("启动 OTA 线程失败: {e}"))?;
    Ok(())
}

fn dirs(cfg: &Config) -> (PathBuf, PathBuf, PathBuf) {
    let base = PathBuf::from(&cfg.ota.dir);
    (base.join("releases"), base.join("incoming"), base.join("current"))
}

fn handle(mut stream: TcpStream, shared: Arc<Shared>, cfg: Config) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut parser = FrameParser::new();
    let mut buf = [0u8; 8192];
    let mut session = Session {
        begin: None,
        received: 0,
        file: None,
        last_progress: 0,
    };

    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue
            }
            Err(_) => break,
        };

        for (frame, payload) in parser.feed(&buf[..n]) {
            match frame.kind {
                T_OTA_BEGIN => {
                    let Some(begin) = OtaBegin::decode(&payload) else {
                        send_result(&mut stream, 4, (0, 0, 0), "OTA_BEGIN 长度错误");
                        continue;
                    };
                    // 必须未解锁
                    let flags = shared.telemetry.flags.load(Ordering::Relaxed);
                    if flags & ST_ARMED != 0 || flags & ST_ESTOP != 0 {
                        send_result(&mut stream, 6, begin.version, "设备已解锁或急停中，拒绝升级");
                        continue;
                    }
                    if !cfg.ota.allow_unsigned && begin.sig.iter().all(|b| *b == 0) {
                        send_result(&mut stream, 1, begin.version, "缺少签名");
                        continue;
                    }
                    let (_, incoming, _) = dirs(&cfg);
                    if let Err(e) = fs::create_dir_all(&incoming) {
                        send_result(&mut stream, 4, begin.version, &format!("创建目录失败: {e}"));
                        continue;
                    }
                    let name = version_name(begin.version);
                    let path = incoming.join(format!("{name}.pkg"));
                    let existing = fs::metadata(&path).map(|m| m.len() as u32).unwrap_or(0);
                    let file = if begin.resume_offset > 0 && existing >= begin.resume_offset {
                        OpenOptions::new().append(true).open(&path)
                    } else {
                        File::create(&path)
                    };
                    match file {
                        Ok(f) => {
                            session.received = if begin.resume_offset > 0 { existing } else { 0 };
                            session.file = Some(f);
                            session.begin = Some(begin);
                            session.last_progress = session.received;
                            send_ack(&mut stream, 0, session.received);
                        }
                        Err(e) => {
                            send_result(&mut stream, 4, (0, 0, 0), &format!("打开包文件失败: {e}"))
                        }
                    }
                }

                T_OTA_DATA => {
                    if payload.len() < 5 {
                        continue;
                    }
                    let offset = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                    let body = &payload[4..];
                    if session.file.is_none() {
                        send_result(&mut stream, 4, (0, 0, 0), "未收到 OTA_BEGIN");
                        continue;
                    }
                    if offset != session.received {
                        send_ack(&mut stream, 0, session.received); // 请求从正确偏移续传
                        continue;
                    }
                    let ok = session
                        .file
                        .as_mut()
                        .map(|f| f.write_all(body).is_ok())
                        .unwrap_or(false);
                    if !ok {
                        send_result(&mut stream, 4, (0, 0, 0), "写包失败");
                        continue;
                    }
                    session.received += body.len() as u32;
                    if session.received - session.last_progress >= 64 * 1024 {
                        session.last_progress = session.received;
                        let total = session.begin.as_ref().map(|b| b.total_size).unwrap_or(0);
                        send_progress(&mut stream, session.received, total, 0);
                    }
                }

                T_OTA_COMMIT => {
                    let Some(begin) = session.begin.clone() else {
                        send_result(&mut stream, 4, (0, 0, 0), "未收到 OTA_BEGIN");
                        continue;
                    };
                    let (releases, incoming, current) = dirs(&cfg);
                    let name = version_name(begin.version);
                    let path = incoming.join(format!("{name}.pkg"));

                    send_progress(&mut stream, session.received, begin.total_size, 1);
                    match verify(&path, &begin.sha256) {
                        Ok(true) => {}
                        Ok(false) => {
                            send_result(&mut stream, 2, begin.version, "SHA-256 不匹配");
                            continue;
                        }
                        Err(e) => {
                            send_result(&mut stream, 4, begin.version, &format!("读取包失败: {e}"));
                            continue;
                        }
                    }

                    send_progress(&mut stream, session.received, begin.total_size, 2);
                    let target = releases.join(&name);
                    if target.exists() {
                        let _ = fs::remove_dir_all(&target);
                    }
                    if let Err(e) = unpack(&path, &target) {
                        let _ = fs::remove_dir_all(&target);
                        send_result(&mut stream, 4, begin.version, &format!("解包失败: {e}"));
                        continue;
                    }
                    // 先确认新二进制能跑，再动 current —— 坏包停在这步，船上原版本不受影响
                    if let Err(e) = smoke_new_binary(&target) {
                        eprintln!("[ota] 新版本自检失败: {e}");
                        let _ = fs::remove_dir_all(&target);
                        send_result(&mut stream, 3, begin.version, &format!("自检失败: {e}"));
                        continue;
                    }

                    send_progress(&mut stream, session.received, begin.total_size, 4);
                    let prev = read_link(&current);
                    if let Err(e) = write_rollback_marker(&cfg, prev.as_deref()) {
                        eprintln!("[ota] 写回滚标记失败: {e}");
                    }
                    if let Err(e) = switch_current(&releases, &current, &name) {
                        send_result(&mut stream, 4, begin.version, &format!("切换版本失败: {e}"));
                        continue;
                    }
                    let _ = fs::remove_file(&path);
                    send_result(&mut stream, 0, begin.version, "升级完成，正在重启");
                    send_progress(&mut stream, begin.total_size, begin.total_size, 5);
                    println!("[ota] 已切换到 {name}，准备重启");
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    // 交给 systemd 重启（Restart=always），加载新版本
                    std::process::exit(0);
                }

                T_OTA_ABORT => {
                    if let Some(begin) = session.begin.take() {
                        let (_, incoming, _) = dirs(&cfg);
                        let _ = fs::remove_file(incoming.join(format!("{}.pkg", version_name(begin.version))));
                    }
                    session.file = None;
                    send_ack(&mut stream, 0, 0);
                }

                _ => {}
            }
        }
    }
}

fn version_name(v: (u16, u16, u16)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

fn verify(path: &Path, expect: &[u8; 32]) -> std::io::Result<bool> {
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 32 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let got = hasher.finalize();
    Ok(got[..] == expect[..])
}

fn unpack(pkg: &Path, target: &Path) -> std::io::Result<()> {
    use flate2::read::GzDecoder;
    let file = File::open(pkg)?;
    let gz = GzDecoder::new(file);
    let mut ar = tar::Archive::new(gz);
    fs::create_dir_all(target)?;
    ar.unpack(target)?;
    // tar crate 会按包头里的 mode 落盘，所以**不能**假设包里的执行位是对的
    // （Windows 的 bsdtar 打出来是 0666）。这里统一补 0755。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = target.join("usv-edge");
        if bin.is_file() {
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

/// 切换软链**之前**的冒烟测试：确认新二进制在这台机器上真的能跑。
///
/// 覆盖两类事故：包里的执行位丢了（203/EXEC），以及架构/target 打错（ENOEXEC）。
/// 有了它，坏包会在 OTA 阶段就报错，而不是切过去再靠看门狗回滚。
fn smoke_new_binary(target: &Path) -> Result<(), String> {
    let bin = target.join("usv-edge");
    if !bin.is_file() {
        return Err("包内缺少 usv-edge".into());
    }
    match std::process::Command::new(&bin).arg("--version").output() {
        Ok(o) if o.status.success() => {
            let out = String::from_utf8_lossy(&o.stdout);
            println!("[ota] 新版本自检通过: {}", out.trim());
            Ok(())
        }
        Ok(o) => Err(format!(
            "新版本 --version 退出码 {:?}: {}",
            o.status.code(),
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => Err(format!("新版本无法执行: {e}")),
    }
}

fn switch_current(releases: &Path, current: &Path, name: &str) -> std::io::Result<()> {
    let target = releases.join(name);
    if !target.join("usv-edge").exists() && !target.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "包内缺少 usv-edge",
        ));
    }
    let base = current.parent().unwrap_or(Path::new("."));
    let tmp = base.join(".current.tmp");
    let _ = fs::remove_file(&tmp);
    #[cfg(unix)]
    std::os::unix::fs::symlink(Path::new("releases").join(name), &tmp)?;
    #[cfg(not(unix))]
    return Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "仅支持 unix 平台切换版本",
    ));
    #[cfg(unix)]
    {
        fs::rename(&tmp, current)?;
    }
    Ok(())
}

fn read_link(current: &Path) -> Option<String> {
    fs::read_link(current)
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Rollback {
    prev: Option<String>,
}

fn write_rollback_marker(cfg: &Config, prev: Option<&str>) -> std::io::Result<()> {
    let p = PathBuf::from(&cfg.ota.dir).join("rollback.json");
    let data = serde_json::to_vec(&Rollback {
        prev: prev.map(|s| s.to_string()),
    })
    .unwrap_or_default();
    fs::write(p, data)
}

/// 检测 systemd 层的回滚看门狗是否已装。
///
/// 两个条件缺一不可：
///   1. `usv-edge.service` 里有 `OnFailure=usv-edge-rollback.service`（systemd 会调它）
///   2. `<ota.dir>/bin/rollback.sh` 存在（被调时真的有东西可跑）
///
/// 只读两个文件，不 spawn 进程 —— 启动期做一次就够，结果缓存在 `Shared` 里。
pub fn watchdog_armed(ota_dir: &str) -> bool {
    let script_ok = PathBuf::from(ota_dir).join("bin").join("rollback.sh").is_file();
    let unit_ok = fs::read_to_string("/etc/systemd/system/usv-edge.service")
        .map(|s| {
            s.lines().any(|l| {
                let t = l.trim_start();
                t.starts_with("OnFailure=") && t.contains("usv-edge-rollback.service")
            })
        })
        .unwrap_or(false);
    script_ok && unit_ok
}

/// 启动自检：若存在回滚标记，等待客户端 HELLO；超时则切回上一版。
pub fn startup_guard(shared: Arc<Shared>, cfg: Config) {
    let base = PathBuf::from(&cfg.ota.dir);
    let marker = base.join("rollback.json");
    if !marker.exists() {
        return;
    }
    let rollback: Option<Rollback> = fs::read(&marker)
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok());
    let Some(prev) = rollback.and_then(|r| r.prev) else {
        let _ = fs::remove_file(&marker);
        return;
    };

    println!("[ota] 检测到回滚标记，{}ms 内等待客户端 HELLO", cfg.ota.grace_ms);
    std::thread::Builder::new()
        .name("ota-guard".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(cfg.ota.grace_ms));
            if shared.hello_ms.load(Ordering::Relaxed) == 0 {
                eprintln!("[ota] 新版本未收到 HELLO，回滚到 {prev}");
                let releases = base.join("releases");
                let current = base.join("current");
                if switch_current(&releases, &current, &prev).is_ok() {
                    let _ = fs::remove_file(&marker);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    std::process::exit(1); // systemd 重启后回到旧版本
                }
                eprintln!("[ota] 回滚失败，保留当前版本");
            } else {
                println!("[ota] 新版本已握手，清除回滚标记");
                let _ = fs::remove_file(&marker);
            }
        })
        .ok();
}

/* ---------------- 应答帧 ---------------- */

fn send_ack(stream: &mut TcpStream, status: u8, offset: u32) {
    let mut p = Vec::with_capacity(5);
    p.push(status);
    p.extend_from_slice(&offset.to_le_bytes());
    let _ = stream.write_all(&build_frame(T_OTA_ACK, 0, &p));
}

fn send_progress(stream: &mut TcpStream, received: u32, total: u32, stage: u8) {
    let mut p = Vec::with_capacity(9);
    p.extend_from_slice(&received.to_le_bytes());
    p.extend_from_slice(&total.to_le_bytes());
    p.push(stage);
    let _ = stream.write_all(&build_frame(T_OTA_PROGRESS, 0, &p));
}

fn send_result(stream: &mut TcpStream, status: u8, ver: (u16, u16, u16), msg: &str) {
    let mut p = Vec::with_capacity(6 + 64);
    p.push(status);
    p.extend_from_slice(&ver.0.to_le_bytes());
    p.extend_from_slice(&ver.1.to_le_bytes());
    p.extend_from_slice(&ver.2.to_le_bytes());
    let mut text = [0u8; 64];
    let bytes = msg.as_bytes();
    let n = bytes.len().min(63);
    text[..n].copy_from_slice(&bytes[..n]);
    p.extend_from_slice(&text);
    let _ = stream.write_all(&build_frame(T_OTA_RESULT, 0, &p));
}
