# NewShipTerminal — 无人船操作终端

| 目录 | 内容 |
|---|---|
| [desktop/](desktop/) | 上位机终端（Electron + TypeScript），开发中 |
| [firmware/](firmware/) | 船端固件（Rust），协议 v1/v2 + OTA |
| [spec/](spec/) | 协议与契约的唯一真相源 |
| [docs/](docs/) | 架构与规格文档、器件手册 |

## 定位（不变）

- **本机 PC = 主机 / 运算中心**：手柄解析、指令生成、界面渲染，以及视频、SLAM、避障、航迹规划、数据记录全部在本机完成。
- **船上 = 薄执行端**：只做「收指令 → 驱动电机 / 舵机」，外加最小本地安全兜底（看门狗、失联停车）。
- **船端协议 v1**：TCP 9527，`AA 55` 帧 + CRC16-CCITT-FALSE，CMD/STATUS 50Hz，SCAN 每圈一帧（点云，可 zlib）。

## 入口

- 上位机程序：双击 `run-usv-terminal.cmd`（首次会自动装依赖并构建）
- 架构说明：[desktop/docs/architecture.md](desktop/docs/architecture.md)
- 固件说明：[firmware/README.md](firmware/README.md)
- 船端协议：[spec/protocol-v1.md](spec/protocol-v1.md)
- 船端交接资料：[spec/handover-v1.md](spec/handover-v1.md)
- 雷达数据手册：[docs/datasheets/SLAMTEC_rplidar_C1_v1.2_en.pdf](docs/datasheets/SLAMTEC_rplidar_C1_v1.2_en.pdf)

## 分支与分发

| 分支 | 内容 | 谁写 |
|---|---|---|
| `main` | 源码、测试、文档（唯一开发分支） | 所有人，经 PR 合并 |
| `release` | 客户端产物（约 0.4 MB），orphan 分支 | 只有 `npm run ship` |
| `release-fw` | 固件 OTA 包（约 355 KB），orphan 分支 | 只有 `node firmware/tools/ship-fw.mjs` |

两条 release 分支都是**只读产物快照**，目标机不需要源码和构建工具。

### 客户端

```powershell
git clone -b release --single-branch https://github.com/nk-peppa/NewShipTerminal.git USV-Terminal
# 之后双击 run-usv-terminal.cmd
```

启动器会依次：检测/安装 Node.js 与 Git → 自检 Electron 依赖（含 npm 拦截
postinstall 的兜底）→ 自动拉取 `release` 最新产物 → 启动。

发布（在 `main` 上）：

```powershell
cd desktop
npm run ship          # 要求工作区干净、测试全绿
```

### 固件

```powershell
node firmware\tools\ship-fw.mjs              # 交叉编译 → 校验 → 提交 → 推送
node firmware\tools\ship-fw.mjs --dry        # 只构建 + 暂存
node firmware\tools\ship-fw.mjs --skip-build # 复用现有包重新发布
```

分支上只有 4 个文件：`build-info.json`、`usv-edge-<ver>-aarch64.tar.gz`、
同名 `.sha256`、`README.txt`。只保留最新版，旧版靠 git history 取回：

```sh
git show <commit>:usv-edge-0.4.0-aarch64.tar.gz > usv-edge-0.4.0-aarch64.tar.gz
```

`build-info.json` 里的 `sha256` 用于校验传输完整性。注意固件目前**未签名**
（设备配置 `allow_unsigned=true`），`sha256` 不能替代签名校验。

两条分支的产物都通过 `build-info.json` 的 `sourceCommit` 记录来源，可据此在
`main` 上反查源码。


