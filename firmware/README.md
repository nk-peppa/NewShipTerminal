# firmware — 船端固件（Rust）

单二进制，协议 v1/v2 + OTA。设计与决策见 [../docs/firmware-spec.md](../docs/firmware-spec.md)。

## 实机部署现状（Orange Pi Zero2W / 192.168.3.9）

| 项 | 值 |
|---|---|
| 版本 | 0.3.0（`/opt/usv/current` → `/opt/usv/releases/0.3.0`） |
| 服务 | `usv-edge.service`，**已 enable 开机自启**，`Restart=always` |
| 配置 | `/opt/usv/config/usv-edge.json`（与版本目录分离，OTA 不覆盖） |
| 端口 | 控制 9527 / 发现 9528 / 固件 9530 |
| HAL | `sysfs`（真实 PWM + GPIO） |
| 雷达 | `/dev/ttyUSB0`，离线时不产生点云（`mock_fallback: false`） |

## 实机调试命令

```sh
systemctl status usv-edge --no-pager     # 状态
journalctl -u usv-edge -f                # 实时日志
systemctl restart usv-edge               # 改完配置重启
systemctl start usv-edge                 # 未自启时手动拉起
systemctl is-enabled usv-edge            # 应为 enabled

# 看硬件实时状态
cat /sys/class/pwm/pwmchip0/pwm1/duty_cycle   # 油门占空比
cat /sys/class/pwm/pwmchip0/pwm3/duty_cycle   # 舵机脉宽（1590000 = 1590us 中位）
cat /sys/class/gpio/gpio259/value             # 方向 正转（PI3）
cat /sys/class/gpio/gpio260/value             # 方向 反转（PI4）
cat /sys/class/gpio/gpio272/value             # 指示灯（PI16）
```

关闭真实输出（安全调试）：

```sh
# 临时改配置里的 dry_run 为 true，然后重启
sed -i 's/"dry_run": false/"dry_run": true/' /opt/usv/config/usv-edge.json
systemctl restart usv-edge
```

## 打包与升级

两种构建路径，产物格式完全一致（`usv-edge` 0755 + `manifest.json`）：

| 在哪 | 命令 | 产物 |
|---|---|---|
| Windows（交叉编译） | `firmware\build-local.ps1` | `desktop\dist\firmware\usv-edge-<ver>-aarch64.tar.gz` |
| Pi 上（本机编译） | `sh scripts/make-package.sh` | `firmware/dist/usv-edge-<ver>-aarch64.tar.gz` |

然后在**客户端**「固件」卡片里选这个包上传，设备会完成
校验 → 解包 → 切软链 → 重启 → 新版本握手。

## 发布到 `release-fw` 分支

Windows 上一条命令完成「编译 → 校验 → 提交 → 推送」：

```powershell
node firmware\tools\ship-fw.mjs              # 全流程
node firmware\tools\ship-fw.mjs --dry        # 只构建 + 暂存，不碰 git
node firmware\tools\ship-fw.mjs --skip-build # 复用现有包重新发布
```

脚本会做三件额外的检查：包内 `manifest.json` 的版本/架构与 `Cargo.toml` 一致、
包内 `usv-edge` 有执行位（否则升级后 203/EXEC）、记录包与二进制的 sha256。

分支上只保留最新一版；旧版用 `git show <commit>:<pkg> > <pkg>` 取回。

## 发布新版本

1. 改 `Cargo.toml` 的 `version`
2. `cargo test --release`（应 32 passed）
3. `node firmware\tools\ship-fw.mjs`
4. 客户端「固件」卡片里选包上传；失败会自动回滚到上一版
   （`rollback.json` + 30s 未握手）

## 踩过的坑（务必保留这些约定）

| 现象 | 根因 | 修法 |
|---|---|---|
| 一解锁油门就**满输出** | Allwinner BSP 的 PWM 默认 `polarity=inversed`（低电平有效），`duty=0` 变成恒高电平 = 100% 占空比 | 初始化时显式写 `polarity=normal`，顺序必须是 disable→duty0→period→**polarity**→duty→enable |
| 舵机**完全不转** | 同上：`duty=1590µs` 在反相下变成 18410µs 高电平，远超舵机行程 | 同上 |
| 舵量偏大 ~50% | 用 ±30° 映射满量程；旧实现是 **±45°（angle_range/2）** 才满量程 | `us = mid + (deg/45) × 490`，软限位 1100..2080（含 30µs 余量） |
| 每次下发都写 `period` | 部分驱动在使能状态下拒绝改 period，且会打断波形 | `period`/`polarity`/`enable` 只在初始化写一次，运行期只写 `duty_cycle` |
| 换向瞬间大电流 | 同一拍内改方向脚又给油门 | 方向变化时先写 `duty=0`，再改方向脚，最后写新 duty |
| 点云 **49 圈/s、每圈 1 点** | 串口字节流未对齐：错位后 `b0` 恰是上一节点的 check bit（恒 1），被误判成「新一圈」 | 按旧 `lidar_stream.py` 重写：5 个候选偏移按**角度连续性**打分（阈值 0.9，窗口 128 节点），用**角度回绕**（`delta < -30000`）判定新圈，异常 48 节点后重新对齐 |
| 雷达**插上后不认** | 只在进程启动时 `open()` 一次，旧实现是 5s 重连 | 串口源改为「打开失败/读取失败 → 2s 重试」循环，`lidar_ok` 实时反映 |

雷达对齐参数（与旧实现一致）：`DELTA_MAX=2000`、`WRAP_DROP=-30000`、`ALIGN_NODES=128`、
`ALIGN_MIN_NODES=48`、`ALIGN_SCORE=0.9`、`IRREGULAR_MAX=48`、每圈最少 10 点才上报。

实测（0.3.3）：**10.4 圈/s、443 点/圈、re-sync 0 次**。

> 舵机通路已用真实硬件验证：`+20° → 1372000ns(1372µs)`、`0° → 1590000ns`、`-20° → 1808000ns`，与公式一致。

## 硬件标定（本船实测值，来自旧 `config/hardware.json`）

| 功能 | 引脚 | 内核编号 | 值 |
|---|---|---|---|
| 油门 PWM | PI11 | pwmchip0/pwm1 | 周期 20 ms，占空比 = 油门% |
| 舵机 PWM | PI13 | pwmchip0/pwm3 | 中位 1590 µs，软限位 1070–2110 µs |
| 方向 正转 | PI3 | GPIO **259** | 高有效（旧配置 `swap_dir: true`） |
| 方向 反转 | PI4 | GPIO **260** | 高有效 |
| 急停 | PI3+PI4 | 259+260 | 双高 |
| 指示灯 | PI16 | GPIO **272** | 亮 = 就绪/运行 |
| 舵机方向 | — | — | `servo_reverse: true`（正舵 → 脉宽低于中位） |

> GPIO 全局编号 = 端口序号 × 32 + 脚号；I 口 = 256，故 PI3=259、PI4=260、PI16=272。
