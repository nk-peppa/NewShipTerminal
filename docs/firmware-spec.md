# USV Edge 固件规格 v2（Rust）

- 状态：**已定稿，待实现**
- 平台：Orange Pi Zero2W（H618，4×A53，Ubuntu 20.04 + vendor 内核，**不换系统**）
- 语言：**Rust**（单二进制，无 GC，tickless）
- 兼容：线协议 v1 全部保留；v2 能力经 `HELLO` 协商，旧客户端连新固件仍可用

## 1. 为什么要重写（散热优先）

现有 Python 实现的问题不是算力，而是**空转**：多线程 + GIL + 轮询使多核长期活跃，
SoC 温度高且无法在船体内被动散热。

约束（已确认）：**不改系统、不换内核、不限频、不关核**；只允许关服务与关 HDMI。
因此热设计完全落在程序侧：

| 设计点 | 做法 | 预期 |
|---|---|---|
| 唤醒次数 | tickless：控制 50Hz 用 `clock_nanosleep` 绝对时间；网络用 epoll/tokio；串口阻塞读 | 每秒唤醒 ≈ 60 次 |
| 线程数 | 2 条：RT 控制线程 + tokio 运行时（网络/雷达/OTA） | 无 GC/解释器后台线程 |
| 忙等 | 禁止任何 poll/spin 循环 | 单核利用率 <2% |
| 压缩 | 每圈 2.5KB zlib，在雷达线程内完成 | ~0.2ms/圈 |
| 日志 | 默认只写 systemd journal，关闭逐帧日志 | 无磁盘抖动 |

目标：平均功耗 ≤1.5W、SoC ≤62°C（实测校准）。

### 1.1 实测（2026-10-27，Orange Pi Zero2W · Ubuntu 20.04 · aarch64）

```
cargo build --release        → 361 KB 二进制，0 warning
cargo test  --release        → 27 passed / 0 failed
--bench-tick 500 @ 50Hz      → mean=19999  p50=19999  p95=20099  p99=20120  max=20191 us
```

结论：20 ms 周期里实际占用约 1%，抖动 ≤0.2 ms。与 Python 实现（多线程 + GIL，常见 2–20 ms 抖动）相比，
**同一硬件上无需限频/关核即可把 CPU 压到接近空闲**，这正是船体无强制散热条件下的关键。

### 1.2 交叉编译（Windows → aarch64）

固件依赖 **100% 纯 Rust**（`flate2` 用 `rust_backend`，不碰 zlib；没有 `libudev` 之类的 C 库），
所以 Windows 上不需要 Windows SDK，只要两样东西：

| 作用 | 工具 | 安装 |
| --- | --- | --- |
| 宿主 C 链接器（编 `serde_derive` 这类 proc-macro） | MinGW-w64 | `winget install -e --id BrechtSanders.WinLibs.POSIX.MSVCRT` |
| aarch64 链接器 + glibc sysroot | zig | `python -m pip install ziglang` |

还需要 `cargo-zigbuild`（放进 `%USERPROFILE%\.cargo\bin`）和 `rustup target add aarch64-unknown-linux-gnu`。

一条命令出包：

```
firmware\build-local.cmd
```

产物 `desktop\dist\firmware\usv-edge-<ver>-aarch64.tar.gz`（含 `manifest.json`），
客户端「选择固件包并升级」直接选它。首次数十秒，之后增量 1 秒内。

注意两点：

1. **target 目录必须在无空格路径下**（脚本默认 `C:\usv-target`）。源码所在的 OneDrive 目录名含空格和单引号，
   MinGW 的 `ld` 会把 `-Wl,<带空格的 .def 路径>` 拆错，报 `unrecognized option '--dynamicbase-Wl'`。
2. 产物要求的最高 glibc 符号是 `GLIBC_2.30`，低于 Pi 上 Ubuntu 20.04 的 2.31，可直接运行。

Pi 在线的场合仍可用 `firmware\build-remote.cmd`（同步源码 → Pi 原生编译 → 取回），两者产物布局一致。

## 2. 进程与线程模型

```
usv-edge (单一二进制)
├─ control 线程   SCHED_FIFO 1，50Hz 绝对时间睡眠
│    · 读命令槽（原子三缓冲，最新覆盖）
│    · PWM 油门 / 舵机 / 方向 GPIO / 软限位 / 油门限幅
│    · 300ms 看门狗 → 0 油门 + 舵回中
│    · LED 状态机
│    · 发布状态快照（原子）
├─ tokio 运行时
│    · TCP 9527 服务端：单客户端，收 CMD，50Hz 发 STATUS，按圈发 SCAN
│    · UDP 9528：beac/prob 发现
│    · TCP 9530：OTA（独立端口，不占控制链路）
│    · 雷达阻塞线程：460800 串口、START_SCAN、5B 节点解析、自动重连
│    · zlib 压缩（每圈一次）
└─ 共享：命令槽 = 最新值；扫描队列 = 长度 3，丢旧保新
```

关键约束：

1. 控制线程**永不分配内存**（预分配）。
2. 控制线程与网络之间只通过原子快照交互，不用锁。
3. 雷达断开/压缩失败只影响点云，不影响控制。
4. 任何解码异常丢弃该帧并计数，不 panic。

## 3. 硬件抽象（HAL）

`trait Hal`：`set_throttle(percent)`、`set_rudder(deg)`、`set_dir(fwd, rev)`、`set_led(state)`、
`read_inputs()`。两个实现：

- `SysfsHal`：vendor 内核的 `/sys/class/pwm`、`/sys/class/gpio`（与现 Python 实现同路径）
- `MockHal`：`--dry-run` 用，记录最后一次输出，供测试与无硬件联调

## 4. 协议 v2

### 4.1 帧结构（不变）

```
AA 55 | ver(1) | type(1) | seq(u16) | len(u16) | payload | crc16
CRC16-CCITT-FALSE，覆盖 ver..payload，小端
```

新增帧类型（不影响 v1 客户端：未知类型直接忽略）：

| type | 名称 | 方向 | 频率 | 载荷 |
|---|---|---|---|---|
| 0x03 | HELLO | 客户端 → 设备 | 连接时/重连 | `u16 proto_max, u16 proto_min, u16 client_ver, u32 client_caps` (10B) |
| 0x04 | PING | 客户端 → 设备 | 1Hz | `u64 t1_ms`（客户端 epoch 毫秒）(8B) |
| 0x05 | TIME_SYNC | 客户端 → 设备 | 手动 | 空载荷，请求船端做一次 SNTP 校时 |
| 0x83 | HELLO_ACK | 设备 → 客户端 | 应答 | `u16 proto, u16 fw_major, u16 fw_minor, u16 fw_patch, u32 caps, u32 uptime_s, u8 hw_id[8]` (26B) |
| 0x84 | PONG | 设备 → 客户端 | 应答 PING | `u64 t1_ms, u32 t2_ms, u32 t3_ms`（t2/t3 为船端单调时钟）(16B) |
| 0x85 | SCAN2 | 设备 → 客户端 | ~10Hz | 见下（仅当客户端声明支持时发送，否则发 0x82） |
| 0x86 | TIME_SYNC_RESULT | 设备 → 客户端 | 应答 TIME_SYNC | `u8 status, u8 rsv, i32 offset_sec, u16 rtt_ms` (8B) |
| 0x87 | SYS | 设备 → 客户端 | 1Hz | `i16 temp_c_x10, u16 rsv` (4B)：SoC 温度（0.1 °C），`0x8000` = 读不到 |

`caps` 位：bit0 `SCAN2`、bit1 `OTA`、bit2 `IMU`、bit3 `VIDEO`、bit4 `SELFTEST`、bit5 `WATCHDOG`（启动失败回滚看门狗已装，见 §5.4）、bit6 `TEST_BUILD`（版本号带 `-test` 后缀的预发布构建，客户端界面标「测试版」）。

### 4.2.1 时钟同步（NTP 四时间戳法）

```
T1 客户端发出 → T2 船端收到 → T3 船端发出 → T4 客户端收到
delay  = (T4−T1) − (T3−T2)          纯网络往返
offset = ((T2−T1) + (T3−T4)) / 2     船钟 − 本地钟
上行   = offset + delay/2
下行   = delay/2 − offset            （基于「上下行对称」假设）
```

- 客户端 1Hz 发 PING，取最近 5 次采样的**中位数**（热点抖动大，均值不可靠）。
- 船端同一帧内填 t2/t3，`T3−T2 ≈ 0`，因此 `delay ≈ T4−T1`。
- **精度预期 1–5 ms**（局域网/热点）。限制来自路径不对称、TCP 延迟 ACK、晶振漂移
  （典型 20 ppm ≈ 每天 1.7 s，所以 offset 需要周期重估），以及船端 u32 毫秒的 ±0.5 ms 量化。
- 做不到亚毫秒；需要硬件时间戳（PTP）才行。

STATUS 的 `flags` bit5 `ST_TIME_BAD`：船端系统时间曾与 NTP 相差 ≥ `bad_threshold_s`（默认 3600）。
置位后由客户端提示校时；用户主动发 TIME_SYNC 且成功即清除。

### 4.2.2 系统遥测（SYS 0x87）与温度告警

设备每秒随 STATUS 追加一帧 SYS：

```
i16 temp_c_x10   SoC 温度，0.1 °C；0x8000 = sysfs 读不到
u16 rsv          0（预留给负载/电压）
```

取 `/sys/class/thermal/thermal_zone*/temp` 中 cpu/ddr/gpu/ve 四个 zone 的最高值。
SYS 是独立帧类型：v1 客户端按「未知类型忽略」，不影响 50Hz 的 STATUS 解码。

终端配色阈值**取自本机内核 DTS 的 thermal trip point**，实机可复核
`/sys/class/thermal/thermal_zone0/trip_point_*_temp`（Orange Pi Zero2W / H618）：

| 温度 | 界面 | 依据 |
|---|---|---|
| < 70 °C | 正常（灰白） | 低于第一个 passive 点；固件设计目标 ≤ 62 °C（§1） |
| 70–89 °C | 黄 + 「偏高」 | `trip_point_0 = 70000`（passive）：内核开始降频，50Hz 控制节拍可能失守 |
| ≥ 90 °C | 红 + 「过热」 | `trip_point_1 = 90000`（passive，二次降频）；`trip_point_2 = 115000`（critical）会直接关机 |

### 4.2 SCAN2 头（24B）

| 偏移 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 0 | u32 | t_start_ms | 圈起始（首个 start flag） |
| 4 | u32 | t_end_ms | 圈完成 |
| 8 | u32 | scan_seq | 每圈 +1 |
| 12 | u16 | count | 抽稀后点数 |
| 14 | u16 | original_count | 抽稀前点数 |
| 16 | u8 | encoding | 0=raw, 1=zlib |
| 17 | u8 | flags | bit0 lidar_ok, bit1 decimated, bit2 t_start_estimated |
| 18 | u16 | scan_rate_x100 | 1000 = 10.00Hz |
| 20 | u8 | quality_max | 63 / 255 |
| 21 | u8 | rsv | 0 |
| 22 | u16 | rsv2 | 0 |

点数据同 v1：`u16 angle_cdeg, u16 dist_mm, u8 quality`（5B/点）。

### 4.3 协商规则

- 客户端不发 `HELLO` → 设备按 v1 行为（0x82 SCAN，无版本信息）。
- 客户端发 `HELLO` 且 `proto_max ≥ 2` → 设备回 `HELLO_ACK`，此后发 SCAN2。
- `HELLO` 缺失不影响 CMD/STATUS。

## 5. OTA（端口 9530）

### 5.1 帧类型

| type | 名称 | 方向 | 载荷 |
|---|---|---|---|
| 0x11 | OTA_BEGIN | 客户端 → 设备 | `u16 ver_major, u16 ver_minor, u16 ver_patch, u32 total_size, u8 sha256[32], u8 sig[64], u32 resume_offset` (110B) |
| 0x91 | OTA_ACK | 设备 → 客户端 | `u8 status, u32 offset` |
| 0x12 | OTA_DATA | 客户端 → 设备 | `u32 offset + bytes` |
| 0x92 | OTA_PROGRESS | 设备 → 客户端 | `u32 received, u32 total, u8 stage` |
| 0x13 | OTA_COMMIT | 客户端 → 设备 | 空 |
| 0x93 | OTA_RESULT | 设备 → 客户端 | `u8 status, u16 ver_major, u16 ver_minor, u16 ver_patch, char msg[64]` |
| 0x14 | OTA_ABORT | 客户端 → 设备 | 空 |

`stage`：0=接收 1=校验 2=解包 3=自检 4=切换 5=完成。
`status`：0=ok 1=bad_sig 2=bad_hash 3=selftest_fail 4=io_error 5=busy 6=not_disarmed。

### 5.2 包与目录

```
/opt/usv/releases/0.2.0/usv-edge        ← 新版本（解包后）
/opt/usv/releases/0.2.0/manifest.json
/opt/usv/current -> releases/0.2.0      ← 原子软链
/opt/usv/releases/0.1.0/                ← 保留上一版
/opt/usv/config/hardware.json
```

包格式：`usv-edge-<ver>-aarch64.tar.zst`，`manifest.json` 含
`version / arch / sha256 / files[] / built_at / min_client`。签名 = Ed25519(sha256(package))，
公钥编译进固件，私钥离线保管。

### 5.3 流程与安全

1. 设备未解锁（`armed=false`）才接受 `OTA_BEGIN`，否则回 `not_disarmed`。
2. 接收期间：控制输出保持 0（看门狗照常），CMD 帧被忽略但连接保持。
3. `OTA_COMMIT` → 校验 sha256 + 签名 → 解包到新 release 目录 → **补 `0755` + `--version` 冒烟** → 原子切软链 → 重启服务。
4. 重启后 30s 内未收到客户端 `HELLO`（或自检失败）→ 自动切回上一版软链并重启。
5. 进度：每 64KB 或每 100ms 上报一次 `OTA_PROGRESS`。
6. 中断/断电：已写文件保留，`resume_offset` 支持续传；未 COMMIT 的版本目录在启动时清理。

### 5.3.1 解包后必须补权限 + 冒烟

`tar` crate 的 `unpack()` 会按**包头里的 mode** 落盘。Windows 的 `bsdtar` 不支持 `--mode`，
打出来的 `usv-edge` 是 `0666`（没有执行位）；切过软链之后 systemd 直接 `203/EXEC`，
表现为**客户端显示「升级完成」但版本仍是旧的**。

2026-10-28 真机上踩过一次，完整日志指纹：

```
usv-edge.service: Failed at step EXEC spawning /opt/usv/current/usv-edge: Permission denied
usv-edge.service: Main process exited, code=exited, status=203/EXEC
... restart counter is at 5 → Start request repeated too quickly → Failed
usv-edge.service: Triggering OnFailure= dependencies.      ← 回滚看门狗兜住了
[main] usv-edge 0.3.3 ...                                  ← 已自动切回旧版
```

两道防线：

| 位置 | 措施 |
|---|---|
| `ota.rs::unpack()` | 解包后对 `usv-edge` 强制 `set_permissions(0o755)` |
| `ota.rs::smoke_new_binary()` | 切换软链**之前**跑一次 `--version`，失败则删掉新目录、回 `selftest_fail`，**原版本不受影响** |

冒烟测试顺带能挡住「架构/target 打错」（`ENOEXEC`）和「二进制根本起不来」这两类问题，
所以坏包会在 OTA 阶段报错，而不是切过去再靠看门狗回滚。

打包侧同步修掉根因：`firmware/tools/pack-tgz.mjs` 自己写 tar，显式写入
`usv-edge=0755` / `manifest.json=0644`（Windows 上没有 GNU tar 的 `--mode`）。
Pi 上的 `scripts/make-package.sh` 用 GNU tar 且有 `chmod 755`，本来就正确。

### 5.4 启动失败回滚（systemd 看门狗）

5.3 第 4 条的回滚逻辑写在固件里（`ota.rs::startup_guard`），但它有两个救不了的场景：

1. **新二进制在 `startup_guard` 之前就 panic**（配置解析、`Shared` 创建阶段）——自检代码根本没机会跑。
2. **在 30s 宽限窗口内反复 panic**——进程一死，guard 线程的 `sleep` 一起陪葬，窗口永远走不完。

后果很严重：`Restart=always` 会一直拉起，`systemd` 默认 5 次/10s 之后把 unit 置为 `failed`，
9530 端口不再监听，**远程 OTA 通道彻底消失**，只能上台接键盘或拔卡。

所以在 Rust 之外再加一层，判据完全交给 systemd：

```ini
# usv-edge.service 的 [Unit] 段（必须放 [Unit]，systemd >= 229）
StartLimitIntervalSec=60
StartLimitBurst=4
OnFailure=usv-edge-rollback.service
```

`usv-edge-rollback.service` 是 `Type=oneshot`，执行 `/opt/usv/bin/rollback.sh`：

| 状态 | 动作 |
|---|---|
| `rollback.json` 存在且 `prev` 目录可用 | 原子切软链回 `prev` → 删标记 → `reset-failed` + `restart` |
| `rollback.json` 存在但 `prev` 不可用 | 丢掉标记，走下一行 |
| 没有标记（非 OTA 引起的崩溃循环） | 5 分钟冷却，只重试一次，避免刷爆 journal 与 SD 卡 |

要点：

- **脚本只依赖 `sh` + coreutils/sed，绝不调用 `current/usv-edge`** —— 要防的正是「新二进制一行代码都跑不了」。
- 切换用 `ln -sfn` 建 `.current.tmp` 再 `mv -Tf`，与 `ota.rs::switch_current()` 同一手法，断电只会是旧或新。
- **unit 文件始终静态**：`ExecStart=/opt/usv/current/usv-edge` 不变，被改的只有 `current` 这个软链。
  绝不能让被验证中的新版本去改写自己的 unit —— 写到一半断电，下次上电就再也起不来了。
- 副作用：`StartLimitBurst` 对**手动 `systemctl restart` 同样计数**，调试时 60s 内连着重启 4 次会被置为 `failed`，
  `systemctl reset-failed usv-edge` 即可清除。

覆盖矩阵：

| 失败形态 | `startup_guard` | systemd 看门狗 |
|---|---|---|
| 启动即 panic（自检前） | ❌ | ✅ |
| 宽限窗口内反复 panic | ❌ | ✅ |
| 起来了但 30s 内没收到 HELLO | ✅ | — |
| 起来了、握手了、30s 后崩 | — | ✅（继续崩就撞 start limit） |

#### 5.4.1 为什么保险必须装在包外

它保护的是「OTA 这个动作本身」。如果跟包一起下发，同一个坏包可以同时打坏程序和安全网；
`OnFailure` / `StartLimitBurst` 写在 `/etc/systemd/system/usv-edge.service` 里，而这个文件天生不在 OTA 载荷中。
让 OTA 去改 unit，等于让还没被验证的二进制去改「能不能开机自启」。

所以它是一次性**投产**步骤，不是每次升级步骤：装一次，之后所有 OTA 永续受保护。
以后要改回滚逻辑，只替换 `/opt/usv/bin/rollback.sh`，unit 一个字都不用动。

#### 5.4.2 投产清单（每台船一次）

```sh
# Pi 上执行，只装保险、不动正在跑的版本
sh scripts/install-usv-edge.sh --units-only
```

脚本会做四项自检，全 PASS 才算装好：

```
[PASS] unit 含 OnFailure=usv-edge-rollback.service
[PASS] usv-edge-rollback.service 已安装
[PASS] /opt/usv/bin/rollback.sh 可执行
[PASS] systemd 已加载 OnFailure（daemon-reload 生效）
启动失败判定：StartLimitBurst=4
== 保险就绪：现在可以安全 OTA ==
```

任何一项 FAIL 都以非 0 退出，并明确提示「先别推 OTA」。

#### 5.4.3 客户端如何知道

固件启动时读两个文件判断是否已装（不 spawn 进程），结果通过 `HELLO_ACK.caps` 的 `CAP_WATCHDOG` 位上报：

- 已装 → 客户端固件面板显示绿色「启动回滚保险：已装 ✓」，升级按钮行为不变。
- 未装 → 显示红色「未装（坏版本会失联）」，升级按钮变黄，**需在 5 秒内点第二次**才真正去选包；
  同时状态行提示「升级失败可能再也连不上，只能上台处理」。
- 未握手 → 显示「—」，按未装处理（保守）。

不做硬拒绝：万一保险真的丢了而现场又必须推一个修复包，硬拒会连修的机会都没有。

### 5.5 测试版构建与回滚

试验性的包必须一眼能认出来，避免和量产版本混在一起：

| 标记 | 位置 | 例子 |
|---|---|---|
| Cargo 版本带 `-test.N` | `Cargo.toml` / 包名 / `manifest.json` | `usv-edge-0.4.1-test.1-aarch64.tar.gz` |
| `--version` 与启动横幅 | journal：`[main] usv-edge 0.4.1 (TEST BUILD)` | 版本号本身带后缀 |
| `caps` bit6 `CAP_TEST_BUILD` | `HELLO_ACK`；终端固件行显示黄色「（测试版）」 | `caps=0x73` |

版本号去掉 `-test` 后缀后，`CAP_TEST_BUILD` 自动消失（由 `CARGO_PKG_VERSION` 推导，不需要改代码）。
**设备上的目录仍用三段数字版本**（`releases/0.4.1`），OTA 客户端也只从文件名解析三段版本。

回滚到上一版有三条路，`prev` 记录在 `/opt/usv/rollback.json`：

1. **自动（推荐验证）**：OTA 切换后 30s 内没有客户端 `HELLO`，新固件自己切回 `prev` 并退出，
   `systemd` 拉起旧版本 —— journal 里是 `[ota] 新版本未收到 HELLO，回滚到 0.4.0`。
2. **启动失败**：`StartLimitBurst` 触发 `usv-edge-rollback.service` → `/opt/usv/bin/rollback.sh`（§5.4）。
3. **手动**：`sh /opt/usv/bin/rollback.sh`（标记存在时），或直接
   `ln -sfn releases/0.4.0 /opt/usv/.current.tmp && mv -Tf /opt/usv/.current.tmp /opt/usv/current && systemctl restart usv-edge`。

回滚后确认：`readlink /opt/usv/current` 指回旧版本、`/opt/usv/current/usv-edge --version` 正确、
`rollback.json` 已删除、服务 `active`。旧版本目录不会被 OTA 删除，可反复回滚。

> 2026-10-31 实测：0.4.0 → OTA `0.4.1-test.1` → 不握手 30s 自动回滚 0.4.0 → 再次 OTA 并握手，
> 停在新版本且标记清除；`releases/0.4.0` 始终保留。

## 6. 配置

`/opt/usv/config/usv-edge.json`（引脚、PWM、舵机标定、限幅、NTP）。改配置需 `systemctl restart usv-edge`。

### 6.1 配置查找顺序（0.4.0 起）

`--config` **不传时**按顺序找，找到即用：

1. `<exe>/../config/usv-edge.json`（即 `/opt/usv/releases/<ver>/../config/…`）
2. `<exe>/../../config/usv-edge.json`（即 `/opt/usv/config/usv-edge.json`）
3. `/opt/usv/config/usv-edge.json`

启动第一行会打印 `[cfg] 使用配置 <path>` 或 `[cfg] 未找到配置文件，使用内置默认值`。

**这个坑在 2026-10-28 真机上踩过**：`USV_ARGS` 里没有 `--config`，而 0.3.3 的
`Config::load(None)` 直接返回 `Config::default()`，其中 `hardware.dry_run = true`。
现象是**端口对、链路通、状态正常，但船一动不动**：

```
[main] usv-edge 0.3.3 · 50Hz · watchdog 300ms · max_throttle 60% · dry_run=true
[main] HAL = mock
[lidar] 已连接 模拟源（460800bps），开始扫描
```

`dry_run=true` 同时意味着 `HAL = MockHal`（不写 sysfs PWM）和 `MockSource` 雷达（忽略 `/dev/ttyUSB0`）。
内置默认值里除 `dry_run` 和 `ntp` 外与实机配置一致，所以这个错误**不会**在端口或限幅上暴露，只表现为船不动。

`install-usv-edge.sh` 因此改成两档显式参数，实机档强制带 `--config`：

```sh
sh scripts/install-usv-edge.sh                    # 实机：--config … --port 9527 …
sh scripts/install-usv-edge.sh --dry-run-profile  # 调试：--dry-run --port 19527 …
```

安装脚本末尾会打印当前档位，并在「有 `--config` 但文件里 `dry_run: true`」或
「既无 `--config` 也无 `--dry-run`」时给出显式警告。

排查小技巧：`ss -lntp | grep 9527` 会被 `19527` 命中（子串匹配），
判断端口要看完整输出，或用 `ss -lntp 'sport = :9527'`。

## 7. 系统集成（已确认允许的范围）

| 项 | 动作 |
|---|---|
| systemd | `usv-edge.service`，`Restart=always`，`TimeoutStopSec=5`，SIGTERM → 安全停车，**enable 开机自启** |
| 启动参数 | `/etc/default/usv-edge` 的 `USV_ARGS`，改后 `systemctl restart usv-edge` |
| 关服务 | `snapd avahi-daemon bluetooth ModemManager unattended-upgrades` disable |
| 关显示 | `hdmi_blanking`/fb blank 或 `/boot` 关闭 disp（无外接显示器） |
| 不做的 | 不改 governor、不限频、不 offline 核心、不换内核、**不动 cgroup** |

### 7.1 调度策略：为什么用 nice 而不是 SCHED_FIFO

实测（H618 / Ubuntu 20.04 / kernel 5.4.125）：

```
/sys/fs/cgroup/cpu/cpu.rt_runtime_us                  = 950000
/sys/fs/cgroup/cpu/system.slice/cpu.rt_runtime_us     = 0     ← 服务所在 cgroup
/sys/fs/cgroup/cpu/user.slice/cpu.rt_runtime_us       = 0
chrt -f 1 /bin/true                                  → EPERM（root 同样失败）
```

内核启用了 `CONFIG_RT_GROUP_SCHED`，systemd 给各 slice 分配的实时带宽为 0，
因此**任何** RT 请求（包括 `chrt`）都会 `EPERM`，与程序权限无关。

结论：不修改 cgroup（属于「不改系统」），固件启动时先尝试 `SCHED_FIFO`，
失败即退回 `nice -10` + systemd `Nice=-10`。实测 50 Hz 节拍 p99 抖动仅 0.12 ms，
软实时完全够用。

### 7.2 实测功耗/温度（0.2.3，dry-run，`--thermal-sample 30 6`）

```
16:19:32  temp=48.7C  load=1.54  freqMHz= 480 480 480 480  cpu%=0.3  rss=0.8MB
16:19:51  temp=48.0C  load=1.42  freqMHz= 480 480 480 480  cpu%=0.3  rss=0.8MB
```

- 固件进程 **0.3% CPU / 0.8 MB RSS**，SoC 自动降频到 **480 MHz**（最低档）。
- `load≈1.5` 与 0.3% CPU 不符，来源是**开发环境本身**：`vscode-server` 4 个 node 进程约 9% CPU、
  旧 `python3 main.py` 约 1%。**这很可能才是「跑脚本发热严重」的主因**，而非固件负载。
- 上船前应关闭 VS Code Remote（`kill` 掉 `~/.vscode-server*`）再复测一次基线。

## 8. 客户端配套

| 模块 | 内容 |
|---|---|
| `main/link/tcpLink` | 连接后发 `HELLO`，解析 `HELLO_ACK`，暴露 `fwVersion/caps`；`SCAN2` → 统一 `ScanFrame`（补 `tStartMs/scanSeq/rateHz`） |
| `main/firmware/ota.ts` | 9530 客户端：分块 64KB、sha256、Ed25519 校验、进度回调、取消、续传 |
| `main/ipc` | `fw:info` / `fw:update(path)` / `fw:cancel` / `evt:fw` |
| `renderer` | 固件面板：当前版本、目标版本、进度阶段、回滚提示、按钮禁用条件（未解锁才可升级） |
| 安全 | 升级前强制 `disarm`；升级中 UI 显示「固件更新中，控制已锁定」 |

## 9. 验证矩阵（无硬件）

| 层 | 手段 |
|---|---|
| 协议 | `cargo test`：黄金帧、CRC、分片、SCAN2 头、HELLO 协商 |
| 控制 | `--dry-run` + MockHal：50Hz 节拍抖动 p99、看门狗、软限位、油门限幅 |
| OTA | 客户端 → 本机 `usv-edge --dry-run --ota-dir ./tmp` 实传一个包，校验进度/结果/版本切换/回滚 |
| 回归 | 客户端既有 7 项单测 + 12 项烟测必须保持通过 |
| 实机 | Pi 上 `--dry-run` 跑 30min，记录温度/CPU；再切真 HAL 验证 PWM/舵机 |

## 9.1 验证记录（2026-10-28，Orange Pi Zero2W）

| 项 | 结果 |
|---|---|
| `cargo test --release` | **28 passed / 0 failed** |
| 协议 v1 兼容 | 旧客户端（不发 HELLO）仍收到 `0x82 SCAN`，雷达正常 |
| 协议 v2 | 客户端发 `HELLO` → `HELLO_ACK`（`fw=0.2.2 proto=2 caps=0x13`）→ 改发 `SCAN2` |
| OTA 0.2.0 → 0.2.1 | 上传 311 KB / 0.2 s，校验→解包→切软链→重启，1 s 内新版本握手 |
| OTA 0.2.1 → 0.2.2 | 同上，`releases/` 保留三个版本，`current` 软链正确 |
| 回滚标记 | 新版本收到 HELLO 后自动清除 `rollback.json` |

过程中发现并修复的两个真实缺陷：

1. **跨线程时钟基准不一致**：控制线程与网络线程各自 `Instant::now()`，导致 CMD 时间戳恒小于 `now_ms`，
   STATUS 永久显示「失联保护」。改为进程级 `now_ms()`（`OnceLock<Instant>`）。
2. **`last_ms == 0` 被当作「未收到 CMD」的哨兵**：进程启动首毫秒即误判超时。改为独立 `has_cmd` 标志。

遗留观察项：STATUS 实测约 46 Hz（控制循环 51 Hz），写入线程存在少量调度漂移，属遥测频率问题，不影响控制与安全。

## 10. 交付顺序

1. Rust 工程骨架 + 协议层 + 单测（可在任意平台 `cargo test`）
2. 控制线程 + MockHal + 看门狗（`--dry-run`）
3. TCP/UDP 服务 + 雷达解析（mock 数据源）
4. OTA 服务端 + 版本目录/回滚
5. 客户端 HELLO/SCAN2 + 固件面板 + OTA 客户端
6. 联调：客户端 ↔ 本机固件（dry-run）完成一次真实升级
7. 上船：编译 → 部署 → 真实硬件验证 → 温度记录
