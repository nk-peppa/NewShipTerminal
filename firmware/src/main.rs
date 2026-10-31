//! usv-edge：船端固件入口。
//!
//! 线程布局：
//! * control：50Hz 绝对时间睡眠，唯一写硬件的线程
//! * tcp：每客户端一个读线程 + 一个 50Hz 写线程
//! * discovery：UDP 广播/应答
//! * ota：9530 升级通道（独立于控制链路）
//! * lidar：串口或模拟数据源

mod config;
mod control;
mod hal;
mod lidar;
mod link;
mod ntp;
mod ota;
mod protocol;
mod thermal;

use config::Config;
use hal::Hal;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 进程内统一单调时钟（毫秒）。控制线程与网络线程必须共用，
/// 否则 CMD 时间戳与 now_ms 属于不同基准，会误判看门狗超时。
pub fn now_ms() -> u32 {
    static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let t0 = T0.get_or_init(Instant::now);
    t0.elapsed().as_millis() as u32
}

pub struct QueuedScan {
    pub data: protocol::Scan,
    pub v2: bool,
}

pub struct Shared {
    pub cmd: link::CmdSlot,
    pub telemetry: link::Telemetry,
    pub scans: Mutex<VecDeque<QueuedScan>>,
    pub rx_seq: AtomicU16,
    pub rx_errors: AtomicU16,
    pub points_last: AtomicU16,
    pub scans_total: AtomicU16,
    pub tx_seq: AtomicU16,
    pub client_caps: AtomicU32,
    pub client_v2: AtomicBool,
    pub hello_ms: AtomicU32,
    pub lidar_ok: AtomicBool,
    /// 系统时间与 NTP 偏差超过阈值（STATUS 的 ST_TIME_BAD 位）
    pub time_bad: AtomicBool,
    /// 最近一次校时看到的偏差（秒），供 beacon / 日志参考
    pub ntp_offset_sec: std::sync::atomic::AtomicI32,
    /// NTP 配置快照（收到校时请求时用，避免跨线程再读文件）
    pub ntp_cfg: config::NtpCfg,
    /// systemd 层的回滚看门狗是否已装（决定 HELLO_ACK 的 CAP_WATCHDOG 位）
    pub watchdog_armed: AtomicBool,
}

impl Shared {
    pub fn new() -> Self {
        Self::with_cfg(&Config::default())
    }

    pub fn with_cfg(cfg: &Config) -> Self {
        Self {
            cmd: link::CmdSlot::default(),
            telemetry: link::Telemetry::default(),
            scans: link::make_queue(),
            rx_seq: AtomicU16::new(0),
            rx_errors: AtomicU16::new(0),
            points_last: AtomicU16::new(0),
            scans_total: AtomicU16::new(0),
            tx_seq: AtomicU16::new(0),
            client_caps: AtomicU32::new(0),
            client_v2: AtomicBool::new(false),
            hello_ms: AtomicU32::new(0),
            lidar_ok: AtomicBool::new(false),
            time_bad: AtomicBool::new(false),
            ntp_offset_sec: std::sync::atomic::AtomicI32::new(0),
            ntp_cfg: cfg.ntp.clone(),
            watchdog_armed: AtomicBool::new(ota::watchdog_armed(&cfg.ota.dir)),
        }
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

struct Args {
    config: Option<PathBuf>,
    dry_run: bool,
    bench: Option<u32>,
    port: Option<u16>,
    udp_port: Option<u16>,
    ota_port: Option<u16>,
    ota_dir: Option<String>,
    lidar_mock: bool,
}

fn parse_args() -> Args {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let val = |name: &str| -> Option<String> {
        a.iter()
            .position(|x| x == name)
            .and_then(|i| a.get(i + 1))
            .cloned()
    };
    Args {
        config: val("--config").map(PathBuf::from),
        dry_run: a.iter().any(|x| x == "--dry-run"),
        bench: if a.iter().any(|x| x == "--bench-tick") {
            Some(val("--bench-tick").and_then(|v| v.parse().ok()).unwrap_or(1000))
        } else {
            None
        },
        port: val("--port").and_then(|v| v.parse().ok()),
        udp_port: val("--udp-port").and_then(|v| v.parse().ok()),
        ota_port: val("--ota-port").and_then(|v| v.parse().ok()),
        ota_dir: val("--ota-dir"),
        lidar_mock: a.iter().any(|x| x == "--lidar-mock"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|x| x == "--version" || x == "-V") {
        println!("usv-edge {} (protocol v1/v2)", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|x| x == "--help" || x == "-h") {
        println!(
            "usv-edge {}\n\
             --config <path>    配置文件（JSON）\n\
             --dry-run          不触碰真实 PWM/GPIO\n\
             --port <n>         覆盖 TCP 控制端口（默认 9527）\n\
             --udp-port <n>     覆盖发现端口（默认 9528）\n\
             --ota-port <n>     覆盖 OTA 端口（默认 9530）\n\
             --ota-dir <path>   覆盖版本目录（默认 /opt/usv）\n\
             --lidar-mock       雷达串口不可用时退回模拟点云（默认关闭）\n\
             --bench-tick [N]   节拍基准测试\n\
             --version          版本",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }

    let a = parse_args();
    // 未显式 --config 时自动找配置：否则会静默退回内置默认值（dry_run=true，
    // 即 HAL=mock + 模拟雷达），表现为「端口对但舵机油门不动作」。
    let cfg_path = a.config.clone().or_else(default_config_path);
    match &cfg_path {
        Some(p) => println!("[cfg] 使用配置 {}", p.display()),
        None => println!("[cfg] 未找到配置文件，使用内置默认值（dry_run=true，不碰真实 PWM）"),
    }
    let mut cfg = match Config::load(cfg_path.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[cfg] {e}");
            std::process::exit(2);
        }
    };
    if a.dry_run {
        cfg.hardware.dry_run = true;
    }
    if let Some(p) = a.port {
        cfg.network.port = p;
    }
    if let Some(p) = a.udp_port {
        cfg.discovery.udp_port = p;
    }
    if let Some(p) = a.ota_port {
        cfg.ota.port = p;
    }
    if let Some(d) = a.ota_dir {
        cfg.ota.dir = d;
    }
    if a.lidar_mock {
        cfg.lidar.mock_fallback = true;
    }

    let (maj, min, pat) = link::fw_version();
    println!(
        "[main] usv-edge {}.{}.{}{} · {}Hz · watchdog {}ms · max_throttle {}% · dry_run={}",
        maj,
        min,
        pat,
        if link::is_test_build() { " (TEST BUILD)" } else { "" },
        cfg.control.freq_hz,
        cfg.control.watchdog_ms,
        cfg.control.max_throttle_pct,
        cfg.hardware.dry_run
    );

    if let Some(n) = a.bench {
        bench_tick(&cfg, n);
        return;
    }

    let shared = Arc::new(Shared::with_cfg(&cfg));
    ota::startup_guard(Arc::clone(&shared), cfg.clone());

    let hal: Arc<dyn Hal> = make_hal(&cfg);
    hal.set_led(hal::LedState::WaitLink);
    println!("[main] HAL = {}", hal.name());

    spawn_control(Arc::clone(&shared), cfg.clone(), Arc::clone(&hal));
    spawn_lidar(Arc::clone(&shared), cfg.clone());

    if let Err(e) = link::spawn_tcp(Arc::clone(&shared), &cfg) {
        eprintln!("[main] {e}");
    }
    if let Err(e) = link::spawn_discovery(Arc::clone(&shared), &cfg) {
        eprintln!("[main] {e}");
    }
    if let Err(e) = ota::spawn(Arc::clone(&shared), cfg.clone()) {
        eprintln!("[main] {e}");
    }

    spawn_boot_time_sync(Arc::clone(&shared), &cfg);

    wait_for_shutdown(Arc::clone(&shared), hal);
}

/// 开机联网校时。网络要几十秒才起来，所以先睡 `boot_delay_s` 再查。
/// 查到的偏差同时用来置 `ST_TIME_BAD`，让客户端知道「该引导用户校时了」。
fn spawn_boot_time_sync(shared: Arc<Shared>, cfg: &Config) {
    if !cfg.ntp.sync_on_boot {
        println!("[ntp] 开机自动校时已关闭");
        return;
    }
    let ntp_cfg = cfg.ntp.clone();
    let _ = std::thread::Builder::new()
        .name("ntp-boot".into())
        .spawn(move || {
            let delay = Duration::from_secs(ntp_cfg.boot_delay_s as u64);
            println!(
                "[ntp] {}s 后向 {} 校时",
                ntp_cfg.boot_delay_s, ntp_cfg.server
            );
            std::thread::sleep(delay);
            let timeout = Duration::from_millis(ntp_cfg.timeout_ms as u64);
            match ntp::sync(&ntp_cfg.server, timeout, true) {
                Ok((offset, rtt)) => {
                    shared.ntp_offset_sec.store(offset, Ordering::Relaxed);
                    let bad = offset.abs() >= ntp_cfg.bad_threshold_s;
                    // 时间已经改对了，但「曾严重偏离」这件事要让操作员知道：
                    // 置位后由客户端提示，直到用户主动点一次校时按钮才清除。
                    if bad {
                        shared.time_bad.store(true, Ordering::Relaxed);
                    }
                    println!(
                        "[ntp] 开机校时成功：偏差 {}s（阈值 {}s），rtt {}ms{}",
                        offset,
                        ntp_cfg.bad_threshold_s,
                        rtt,
                        if bad { "  ⚠ 已置 ST_TIME_BAD，等待用户确认" } else { "" }
                    );
                }
                Err(e) => {
                    // 查不到就不知道偏差，保守起见不置 time_bad（避免误报）
                    eprintln!("[ntp] 开机校时失败: {e}");
                }
            }
        });
}

/// 未显式 `--config` 时按优先级找配置文件。
///
/// 部署布局是 `/opt/usv/releases/<ver>/usv-edge` 与 `/opt/usv/config/usv-edge.json`，
/// 所以从可执行文件往上两级就是部署根；再兜底一个绝对路径，覆盖二进制直接放在
/// `/opt/usv` 下的老布局。都找不到才返回 None，由调用方退回内置默认值。
fn default_config_path() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("../config/usv-edge.json"));
            cands.push(dir.join("../../config/usv-edge.json"));
        }
    }
    cands.push(PathBuf::from("/opt/usv/config/usv-edge.json"));
    cands.into_iter().find(|p| p.is_file())
}

fn make_hal(cfg: &Config) -> Arc<dyn Hal> {
    if cfg.hardware.dry_run {
        return Arc::new(hal::MockHal::new());
    }
    #[cfg(unix)]
    {
        let h = &cfg.hardware;
        return Arc::new(hal::sysfs::SysfsHal::new(
            &h.pwm_chip,
            h.throttle_pwm,
            h.rudder_pwm,
            h.pwm_period_ns,
            cfg.control.servo_min_us,
            cfg.control.servo_mid_us,
            cfg.control.servo_max_us,
            cfg.control.servo_reverse,
            cfg.control.servo_angle_range_deg,
            cfg.control.servo_margin_us,
            h.dir_fwd_gpio,
            h.dir_rev_gpio,
            h.led_gpio,
        ));
    }

    #[cfg(not(unix))]
    {
        eprintln!("[main] 非 unix 平台没有真实 HAL，自动使用 mock");
        Arc::new(hal::MockHal::new())
    }
}

/// 尝试打开点云源。失败时**不**回退到模拟数据（避免把假点云当真雷达），
/// 由调用方按间隔重试——雷达是 USB 热插拔设备，必须先插上再启动是旧实现的缺陷。
fn open_lidar(cfg: &Config) -> Result<Box<dyn lidar::LidarSource>, String> {
    let max_points = cfg.lidar.max_points_per_scan;
    if cfg.hardware.dry_run {
        return Ok(Box::new(lidar::MockSource::new(max_points)));
    }

    #[cfg(unix)]
    {
        match lidar::SerialSource::open(&cfg.lidar.port, cfg.lidar.baud, max_points) {
            Ok(s) => Ok(Box::new(s)),
            Err(e) => {
                if cfg.lidar.mock_fallback {
                    eprintln!("[lidar] {e}；按配置退回模拟数据（客户端不可信）");
                    Ok(Box::new(lidar::MockSource::new(max_points)))
                } else {
                    Err(e)
                }
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = max_points;
        Err("当前平台不支持串口雷达".into())
    }
}

fn spawn_control(shared: Arc<Shared>, cfg: Config, hal: Arc<dyn Hal>) {
    std::thread::Builder::new()
        .name("control".into())
        .spawn(move || {
            #[cfg(unix)]
            raise_rt_priority(cfg.control.rt_priority);

            let period = Duration::from_micros(1_000_000 / cfg.control.freq_hz.max(1) as u64);
            let t0 = Instant::now();
            let mut next = Instant::now();
            let mut window = Instant::now();
            let mut ticks_in_window = 0u32;
            let mut last_flags = 0u8;

            loop {
                if SHUTDOWN.load(Ordering::Relaxed) {
                    hal.apply(0, 0, 0);
                    hal.set_led(hal::LedState::WaitLink);
                    std::process::exit(0);
                }

                let now_ms = crate::now_ms();
                let (cmd, last_cmd) = shared.cmd.load();
                let lidar_ok = shared.lidar_ok.load(Ordering::Relaxed);
                let out = control::step(&cmd, last_cmd, now_ms, &cfg.control, lidar_ok);
                hal.apply(out.throttle_x10, out.servos_x10[0], out.direction);
                shared.telemetry.store(&out);

                if out.flags != last_flags {
                    last_flags = out.flags;
                    let led = if out.flags & protocol::ST_ESTOP != 0 {
                        hal::LedState::Estop
                    } else if out.flags & protocol::ST_FAILSAFE != 0 {
                        hal::LedState::Failsafe
                    } else if out.flags & protocol::ST_ARMED != 0 {
                        hal::LedState::Active
                    } else {
                        hal::LedState::Ready
                    };
                    hal.set_led(led);
                }

                ticks_in_window += 1;
                if window.elapsed() >= Duration::from_secs(1) {
                    let hz10 = (ticks_in_window * 10) as u16;
                    shared
                        .telemetry
                        .loop_hz_x10
                        .store(hz10.min(u16::MAX), Ordering::Relaxed);
                    ticks_in_window = 0;
                    window = Instant::now();
                }

                next += period;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
        })
        .expect("启动控制线程失败");
}

fn spawn_lidar(shared: Arc<Shared>, cfg: Config) {
    if !cfg.lidar.enabled {
        return;
    }

    std::thread::Builder::new()
        .name("lidar".into())
        .spawn(move || {
            let retry = Duration::from_millis(2000);
            let mut warned = false;

            loop {
                if SHUTDOWN.load(Ordering::Relaxed) {
                    return;
                }

                let mut source = match open_lidar(&cfg) {
                    Ok(s) => {
                        println!(
                            "[lidar] 已连接 {}（{}bps），开始扫描",
                            if cfg.hardware.dry_run { "模拟源" } else { &cfg.lidar.port },
                            cfg.lidar.baud
                        );
                        warned = false;
                        shared.lidar_ok.store(true, Ordering::Relaxed);
                        s
                    }
                    Err(e) => {
                        shared.lidar_ok.store(false, Ordering::Relaxed);
                        if !warned {
                            eprintln!("[lidar] {e}；每 2s 重试（雷达可热插拔）");
                            warned = true;
                        }
                        std::thread::sleep(retry);
                        continue;
                    }
                };

                // 单次连接内的读取循环
                let mut lost: Option<String> = None;
                loop {
                    if SHUTDOWN.load(Ordering::Relaxed) {
                        return;
                    }
                    match source.next_scan() {
                        lidar::ReadOutcome::Scan(scan) => {
                            shared.lidar_ok.store(true, Ordering::Relaxed);
                            let v2 = shared.client_v2.load(Ordering::Relaxed);
                            link::push_scan(&shared, scan, v2);
                        }
                        lidar::ReadOutcome::Idle => {}
                        lidar::ReadOutcome::Lost(e) => {
                            lost = Some(e);
                            break;
                        }
                    }
                }

                shared.lidar_ok.store(false, Ordering::Relaxed);
                if let Some(e) = lost {
                    eprintln!("[lidar] {e}；2s 后重连");
                }
                std::thread::sleep(retry);
            }
        })
        .expect("启动雷达线程失败");
}

/// 尝试实时调度；失败则退到 nice -10。
///
/// 实测（Orange Pi Zero2W / Ubuntu 20.04 / 5.4.125）：内核启用 RT_GROUP_SCHED，
/// 而 systemd 给 system.slice 的 `cpu.rt_runtime_us` 是 0，因此即使 root + CAP_SYS_NICE
/// 也会 EPERM（`chrt -f 1 /bin/true` 同样失败）。这属于系统的 cgroup 配置，
/// 不在「不改系统」的约束内去动它——软实时对我们 50Hz 足够（实测 p99 抖动 0.12ms）。
#[cfg(unix)]
fn raise_rt_priority(prio: i32) {
    if prio <= 0 {
        return;
    }
    unsafe {
        let param = libc::sched_param { sched_priority: prio };
        if libc::sched_setscheduler(0, libc::SCHED_FIFO, &param) == 0 {
            println!("[main] 调度策略 SCHED_FIFO，优先级 {prio}");
            return;
        }
        let err = std::io::Error::last_os_error();
        eprintln!("[main] SCHED_FIFO 不可用（{err}），改用 nice -10");
        if libc::setpriority(libc::PRIO_PROCESS, 0, -10) == 0 {
            println!("[main] 已设置 nice=-10（SCHED_OTHER）");
        } else {
            let e2 = std::io::Error::last_os_error();
            eprintln!("[main] nice 设置也失败（{e2}），使用默认调度");
        }
    }
}

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn on_signal(_sig: libc::c_int) {
    SHUTDOWN.store(true, Ordering::Relaxed);
}

fn wait_for_shutdown(_shared: Arc<Shared>, _hal: Arc<dyn Hal>) {
    #[cfg(unix)]
    unsafe {
        // 先转成裸指针再转 usize，避免 function_casts_as_integer 警告
        libc::signal(libc::SIGINT, on_signal as *const () as usize);
        libc::signal(libc::SIGTERM, on_signal as *const () as usize);
    }
    loop {
        std::thread::sleep(Duration::from_millis(200));
        if SHUTDOWN.load(Ordering::Relaxed) {
            // 控制线程会在下一拍归零并退出
            std::thread::sleep(Duration::from_millis(100));
            return;
        }
    }
}

fn bench_tick(cfg: &Config, n: u32) {
    let period = Duration::from_micros(1_000_000 / cfg.control.freq_hz.max(1) as u64);
    let mut next = Instant::now();
    let mut last = Instant::now();
    let mut samples: Vec<u128> = Vec::with_capacity(n as usize);

    for _ in 0..n {
        next += period;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        }
        let t = Instant::now();
        samples.push((t - last).as_micros());
        last = t;
    }

    samples.sort_unstable();
    let pct = |p: f32| samples[((samples.len() as f32 - 1.0) * p) as usize];
    let mean: u128 = samples.iter().sum::<u128>() / samples.len() as u128;
    println!(
        "[bench] {} 拍 @ {}Hz：interval us  mean={} p50={} p95={} p99={} max={}",
        n,
        cfg.control.freq_hz,
        mean,
        pct(0.50),
        pct(0.95),
        pct(0.99),
        samples.last().copied().unwrap_or(0)
    );
}
