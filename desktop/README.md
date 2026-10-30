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
npm test          # 协议黄金帧 / CRC / 分片 / zlib（7 项）
npm run smoke     # 假船端 ⇄ 真实链路：50Hz、解锁、急停、UI 超时归零（12 项）
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
| 无参数 | **实机模式**：自动发现 + 9527/9530 |

环境变量：`USV_DEBUG=1` 每秒打印链路统计与渲染进程诊断；`USV_SHOT=<png>` 启动 2.5 s 后自截图。

## 目录

```
src/shared/   protocol.ts（协议 v1 + Scan2D）、api.ts（IPC 契约）
src/main/     index.ts / config.ts / link / safety / ipc / algo
src/preload/  contextBridge 白名单
src/renderer/ index.html / main.ts / radar.ts / style.css
test/         协议单测（node:test）
tools/        sim-boat.cjs（假船端）/ link-smoke.cjs（端到端自检）/ algo-sidecar.py / copy-assets.mjs
              slam-export-check.cjs（导出 ZIP 自检）/ package-release.mjs（打发布包）
```

## 已验证（2026-10-27）

| 项 | 结果 |
|---|---|
| 协议单测 | 7/7 通过（含 `protocol.md` 黄金帧） |
| 端到端自检 | 12/12 通过（50Hz、未解锁不输出、解锁 30% / 舵 15°、急停、UI 500ms 超时归零） |
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
