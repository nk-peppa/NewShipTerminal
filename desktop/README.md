# desktop — 新版操作终端（Electron + TypeScript）

Windows 桌面程序，取代 v1 的「Node 桥接 + 浏览器」组合：指令链路、状态显示、雷达视图、
SLAM 接入、后续录制回放都收在一个应用内。架构决策见 [docs/architecture.md](docs/architecture.md)。

## 运行（实机模式）

**双击 `run-usv-terminal.cmd`** 即可（首次会自动装依赖并构建）。
默认就是实机模式：UDP 9528 自动发现船端，控制 9527，固件更新 9530，无需填写 IP。

仓库根目录另有 `run-usv-terminal.cmd`，与上面等价。

## 启动器（`run-terminal.ps1`）

真正的逻辑在 `run-terminal.ps1`，`.cmd` 只是薄壳（保持 ASCII，避免 cmd 代码页问题）。
同一份脚本既跑开发树，也跑 `release` 分支的部署快照（后者没有 `src/`，跳过构建）。

| 参数 | 作用 |
|---|---|
| `-Check` | 只体检，不安装不修改（退出码 0=可用 / 1=有硬性失败） |
| `-Fix` | 安装/修复依赖后退出，不启动 |
| `-Sim` | 先拉起假船端再启动（等价于旧的 `run-sim.cmd`） |
| `-Reinstall` | 强制重装 `node_modules` |
| `-NoUpdate` | 跳过自动更新 |

它做的五件事：

1. **Node.js** —— 缺失时用 `winget` 装 LTS；装完当前会话 PATH 不刷新，脚本会按
   `C:\Program Files\nodejs\` 显式探测。
2. **Git 与自动更新** —— 只在当前分支是 `release` 时执行 `git reset --hard origin/release`；
   开发树（`main`）直接跳过。失败一律非致命，继续启动。
3. **依赖** —— `package-lock.json` 的 SHA256 与 `.deps-ok` 比对决定是否 `npm ci`。
   ⚠️ npm 11 会拦 postinstall：`npm ci` 成功但 `electron.exe` 不存在，
   脚本会自动补跑 `node node_modules/electron/install.js`，失败再切
   `ELECTRON_MIRROR` 镜像重试。
4. **构建** —— 仅开发树；`src/` 里有文件比 `dist/main/index.js` 新时自动 `npm run build`。
5. **启动** —— 透传附加参数给 Electron。

联调 / 无实船时用假船端：

```powershell
cd desktop
npm run sim       # 本机假船端（9527/9528/9530）
npm start         # 另开一格
```

开发自检：

```powershell
npm test          # 协议黄金帧 / CRC / 分片 / zlib + 会话日志格式（19 项）
npm run smoke     # 假船端 ⇄ 真实链路：50Hz、解锁、急停、UI 超时归零 + 日志落盘（18 项）
npm run log:50hz  # 真 50Hz 突发压力：收帧 = CSV 行 = 原始流帧，零丢帧（7 项）
```

> npm 11 会拦截 postinstall。若 `node_modules\electron\dist\electron.exe` 不存在：
> `npm install-scripts approve electron`，或 `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node .\node_modules\electron\install.js`。

## 命令行参数

| 参数 | 作用 |
|---|---|
| `--host <ip>` | 固定船端地址（**同时关闭自动发现**；联调本地假船端时务必加 `--host 127.0.0.1`） |
| `--port <n>` | 船端 TCP 端口，默认 9527 |
| `--no-discovery` | 关闭 UDP 9528 自动发现 |
| `--no-algo` | 不启动 Python 算法侧车 |
| `--python <path>` | 指定 Python 解释器 |
| `--ota-port <n>` | 固件更新端口，默认 9530 |
| `--no-window` | 无界面运行（只跑链路与算法，便于 CI/自检） |
| `--no-log` | 关闭会话日志（默认启动即自动记录） |
| `--log-dir <path>` | 指定日志根目录（默认 `%APPDATA%\usv-terminal\logs`） |
| `--log-keep <n>` | 保留最近多少次会话（默认 20，单次约 15 MB） |
| 无参数 | **实机模式**：自动发现 + 9527/9530 |

环境变量：`USV_DEBUG=1` 每秒打印链路统计与渲染进程诊断；`USV_SHOT=<png>` 启动 2.5 s 后自截图。

## 目录

```
src/shared/   protocol.ts（协议 v1 + Scan2D）、api.ts（IPC 契约）
src/main/     index.ts / config.ts / link / safety / ipc / algo / log
src/preload/  contextBridge 白名单
src/renderer/ index.html / main.ts / radar.ts / style.css
test/         协议 + 会话日志单测（node:test）
tools/        sim-boat.cjs（假船端）/ link-smoke.cjs（端到端自检）/ algo-sidecar.py / copy-assets.mjs
              slam-export-check.cjs（导出 ZIP 自检）/ package-release.mjs（打发布包）
```

## 已验证（2026-10-30 更新）

| 项 | 结果 |
|---|---|
| 协议单测 | 7/7 通过（含 `protocol.md` 黄金帧） |
| 会话日志单测 | 7/7 通过（CSV/JSONL 内容、船钟缺口识别、原始流分片、保留策略、ZIP 结构 + CRC、边录边导前缀） |
| 端到端自检 | 18/18 通过（含 STATUS/CMD/SCAN 全量落盘、船钟无缺口、原始流可还原且 CRC 0） |
| 50Hz 完整性 | 7/7 通过：490 帧收发 1:1、CSV 行数 = 原始流帧数、最大间隔 20ms |
| 10 分钟满 session | 内存 407–440MB 无泄漏，日志 15.5MB，0 错误；离线回放 5540 帧 TRACKING |
| 日志 ZIP 实导 | 经 PowerShell `Expand-Archive` 反向验证：11 个文件、原始帧可还原 |
| SLAM 导出 | 22/22 通过（真仿真 + 真侧车，ZIP 经 `Expand-Archive` 反向验证） |
| UI 实跑 | 假船端 450 点 @9.2 圈/s，雷达 PPI、状态卡、SLAM 位姿均正常 |
| Python 侧车 | `TRACKING`，累计处理 18 圈，重启 0 次 |
| 发布包实跑（0.1.0） | 打包后 exe 直连仿真：侧车从包内启动、SLAM 建图、真实保存对话框导出 ZIP（7329 B / 5 文件）成功 |

## 保存 SLAM 数据

右栏「SLAM」段的**保存数据**按钮（或手柄 **View** 键）会弹出 Windows 保存对话框，
导出成一个 ZIP：

| 文件 | 内容 |
|---|---|
| `map.pgm` | 占据栅格，ROS `map_server` 三态（`0`=占据 `254`=空闲 `205`=未知） |
| `map.yaml` | `map_server` 元信息（`image` / `resolution` / `origin` / 阈值） |
| `map.png` | 侧车原样输出的彩色栅格（未知区透明，肉眼看好） |
| `trajectory.csv` | 位姿序列 `t_ms,x_m,y_m,yaw_rad,yaw_deg,status,rmse_m,inlier` |
| `session.json` | 本次运行元信息（固件版本、栅格参数、位数、末位姿、导出时间） |

要点：

- 录制在**主进程**里做（地图留最新一张，轨迹累积到 10 万点 ≈ 2.8 小时），
  所以窗口刷新、渲染进程重载都不影响导出内容。
- `map.pgm` 由 `map.png` 现解码现转（自实现 PNG 解码，支持全部 5 种行过滤器），
  转失败只会少一个文件，不影响整包。
- ZIP 用自实现的最小写入器（store/deflate 自适应 + CRC32），不引第三方依赖。
- 保存对话框弹出期间强制把油门舵角归零——原生对话框挡住窗口时摇杆不该还能驱动船。
- 导出中途失败不会留下半截文件（先写 `.part` 再改名）。

自检：`npm run slam:export`（真仿真 + 真侧车 + 真 ZIP，并用 PowerShell 的
`Expand-Archive` 反向验证 ZIP 合法，共 22 项）。

## 会话日志（debug / 实验原始数据）

**启动即自动记录**，不需要手动开始。每次运行一个目录：

```
%APPDATA%\usv-terminal\logs\session-YYYYMMDD-HHmmss\
```

（Electron 的 `userData` 取自 `package.json` 的 `name`，开发树与发布包一致；
运行 `--log-dir <path>` 可改到别处。）

右栏「日志」段实时显示大小 / 行数，并可**打开目录**或**导出日志**（ZIP）。
实船一次实验 ≤10 分钟、单次约 15 MB；默认保留最近 20 次会话（≈300 MB），
原始流每 128 MiB 自动分片（10 分钟用不到分片）。`--no-log` 关闭，
`--log-dir <path>` 可把根目录指到移动硬盘，`--log-keep <n>` 调整保留次数。

| 文件 | 内容 |
|---|---|
| `meta.json` | 启动信息：版本、Electron/Node、平台、完整配置、build-info |
| `client.jsonl` | 运行事件：链路状态 1Hz、UI 解锁/急停、OTA、算法健康与 stderr、异常 |
| `status.csv` | 船端 STATUS 全量 **50Hz**（不受 UI 20Hz 限速影响），含 boat_ms 与全部标志位 |
| `cmd.csv` | 实际下发 CMD 全量 50Hz（含最终油门/舵角与 ARM/ESTOP 位） |
| `ui.csv` | 渲染进程原始指令 ~31Hz（归一化 −1..1，未过安全阀，用于区分「没操作」与「被归零」） |
| `scan.csv` | 每圈点云摘要：点数、编码、质量上限、最小/最大距离、圈号与圈率 |
| `pose.csv` | SLAM 位姿 ~10Hz（x/y/yaw、status、rmse、inlier） |
| `rx.NNN.bin` | 收到的**原始 TCP 字节流**（连解码失败的帧也原样保留） |
| `tx.NNN.bin` | 发出的原始帧（HELLO / PING / CMD / TIME_SYNC） |
| `summary.json` | 正常退出时的统计；`README.txt` 为随包携带的格式说明 |

要点：

- 原始流记录格式（小端）：`u32 length | f64 epoch_ms | 原始字节`。
  按此切分后直接喂给 `src/shared/protocol.ts` 的 `FrameParser` 即可还原帧；
  有了时间戳，还能分析抖动、丢帧和延迟：

  ```js
  const fs = require('node:fs');
  const { FrameParser } = require('./dist/shared/protocol.js'); // npm run build 之后
  const buf = fs.readFileSync('rx.000.bin');
  const parser = new FrameParser();
  for (let off = 0; off + 12 <= buf.length; ) {
    const len = buf.readUInt32LE(off);
    const recvMs = buf.readDoubleLE(off + 4);
    for (const frame of parser.feed(buf.subarray(off + 12, off + 12 + len))) {
      // frame.type: 0x81 STATUS / 0x82 SCAN / 0x85 SCAN2 ...
      // frame.payload 交给 unpackStatus / unpackScan / unpackScan2
    }
    off += 12 + len;
  }
  ```
- 全部用**同步写盘**：进程崩溃/断电前已写内容不丢；导出 ZIP 与日志写入在
  同一事件循环里串行，因此导出的包天然是一致快照（`snapshot.json` 记录导出时状态）。
  因此日志目录应放在**本地盘**，不要指到 OneDrive/网络盘（同步客户端锁文件会拖慢控制环）。
- 日志导出用流式 **store ZIP**（不压缩，避免把上百 MB 原始帧读进内存），按 1 MiB
  分块异步读写，块之间把事件循环让出去——90 MB 实测只占 189 ms、最长卡顿 21 ms，
  50Hz 控制环不受影响。每个文件按导出开始时的长度截断，所以边录边导也是一致前缀。
  先写 `.part` 再改名，失败不留半截文件；船端已解锁/急停时拒绝导出。
- 保存/导出对话框打开期间与 SLAM 保存相同：摇杆被忽略、油门舵角归零。
- 日志模块不依赖 Electron，`npm test` 直接覆盖格式与 ZIP；`npm run smoke`
  额外验证真实链路 ⇄ 日志落盘；`npm run log:50hz` 用真 50Hz 突发证明
  「收帧 = CSV 行 = 原始流帧」，一帧不丢。
- 50Hz 数据由**主进程**逐帧落盘，与渲染进程刷新率、窗口是否最小化无关；
  `status.csv` 还会做船钟连续性自检，出现缺口会在面板上变成警示色并写入
  `client.jsonl` 的 `status-gap` 事件。

拿这批数据怎么用：

- 直接看：`status.csv` / `cmd.csv` / `ui.csv` / `scan.csv` / `pose.csv` 用 Excel 打开即可；
- 离线回放建图：`python tools/replay-session.py --session <会话目录>`
  （自动转换 `rx.*.bin` → `scans.jsonl` → `algo/run_slam.py`，详见
  [docs/slam-integration.md](docs/slam-integration.md)）。

## 打包发布

```
npm run release
```

产出：

```
release/USV Terminal-win32-x64/           可直接双击运行
release/USV-Terminal-<ver>-win32-x64.zip  分发用（约 151 MB）
```

- 用 `@electron/packager`，**不开 asar**：Python 侧车（`tools/algo-sidecar.py`）与
  `algo/cocommand2d` 必须是真实文件，Python 读不了 asar。
- 主进程只用 `electron` + node 内置模块，所以 `node_modules` 里除 `electron` 全部排除，
  包内 `node_modules` 是空的。
- 运行前提：Windows 10/11 x64 + Python 3.10+ 且装好 `numpy`、`scipy`。
  算法包使用了 PEP 604 注解（`X | None`），Python 3.9 会在导入阶段直接失败，
  侧车会把原因写进「算法进程」状态，而不是静默重启。
  缺 Python 依赖时界面「算法进程」会显示异常，控制链路不受影响。
- 压缩用系统自带的 `Compress-Archive`；路径经环境变量传给临时 `.ps1`，
  因为源码目录名里带单引号（`刘鸣艺's files`），拼进 `-Command` 会截断命令。

## 雷达视图：角度桶暂留

雷达一圈约 10 Hz，而界面 60 fps 刷新。若每帧只画最新一圈，漏一圈就会整屏闪烁。
因此改用**角度桶暂留**（`src/renderer/radar.ts`）：

- 360° 分成 **720 个 0.5° 桶**（C1 角分辨率 0.72°，基本一桶一点）
- 每个桶保存「最近一次落在该角度的点」，**只有新数据覆盖同角度时才替换**
- 某圈漏点或雷达短暂抖动时，画面上旧点仍然保留，不会出现空洞或闪烁
- 超过 1.5 s 未更新的桶开始变暗，6 s 后降到最低亮度（提示数据陈旧）
- 雷达掉线（STATUS 的 `LIDAR_OK` 位清零）时**清空所有桶**，避免把历史数据当成现场画面

量程下拉默认 **3 m**，另有 2/4/6/12 m 与自动。信息栏显示
`点数/圈 · 有效桶数/720 · 圈率 · 量程 · 数据延迟`，便于判断链路是否健康。

## 船端断链 / 未自启的恢复流程（客户端已内置）

界面右侧「链路恢复」卡片在两个地方帮你：

1. **立即重连**按钮：跳过 2 s 退避，立刻重试一次（船端刚重启完、自动退避还在等待时最有用）。
2. **断链超过 3 s 自动展开排查步骤**，显示最近的 socket 错误（如 `ECONNREFUSED`），
   每条命令点一下即复制：

| 步骤 | 命令 |
|---|---|
| 服务是否在跑 | `systemctl is-active usv-edge` |
| 拉起服务 | `systemctl start usv-edge` |
| 看失败原因 | `journalctl -u usv-edge -b -n 30 --no-pager` |
| 开机自启是否还在 | `systemctl is-enabled usv-edge` |
| 端口是否被旧服务占用 | `ss -lntp \| grep 9527` |
| 整机重启 | `systemctl reboot` |

恢复后 SOP 自动收起，链路胶囊转绿。

## 联调注意

- **自动发现会跟随真实船只**：局域网内有实船时，程序会自动连接它（而不是本地假船端）。
  只连本地假船端请加 `--host 127.0.0.1`。
- 实船 `192.168.3.9` 实测：TCP 50Hz STATUS 正常，但 `flags=0x10`（仅「需解锁」），
  `points_last=0`、`scans_total=0` → **船端雷达未上线或未出点**，需在船端查 USB/供电。
