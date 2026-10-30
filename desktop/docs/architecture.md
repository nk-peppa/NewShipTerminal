# 新程序架构 v1（定稿）

- 状态：**已定稿**（2026-10-27）
- 形态：Windows 桌面程序，Electron + TypeScript；体积不敏感
- 原则：**本机 = 主机 / 运算中心，船上 = 薄执行端**（不变）

## 1. 决策记录

| # | 决策 | 理由 | 代价 / 约束 |
|---|---|---|---|
| AD-1 | 外壳用 **Electron**，语言以 **TypeScript** 为主 | v1 原型的协议实现、Canvas PPI、手柄逻辑可直接迁移；主/渲染天然分进程；ffmpeg、`child_process` 生态成熟 | 安装体积 150–250MB（已确认不敏感） |
| AD-2 | 算法（SLAM / 视觉 / 规划）用 **Python 独立进程**，stdio + JSONL 通信 | 算法迭代快、生态在 Python；进程隔离保证算法崩溃不影响控制链路 | 多一次序列化；后续可升级为共享内存 / ZeroMQ |
| AD-3 | 安全阀在**三处**：UI 心跳、应用内 Supervisor、船端看门狗 | 任一层失效仍有兜底 | 每层都要有超时与归零逻辑 |
| AD-4 | 点云跨进程用 **TypedArray / 二进制**，不用 JSON | 10Hz × 450–1000 点，JSON 会放大 5–10 倍并产生 GC 抖动 | 渲染进程与 Python 侧都要按二进制契约实现 |
| AD-5 | **录制 / 回放是一等能力** | SLAM 与避障必须能离线复现，不能靠现网碰运气 | 需要稳定的帧日志格式 |
| AD-6 | 船端走**固件化 / OTA**，终端需版本协商与升级态显示 | 便于批量更新与回滚 | 协议需加能力位与版本字段；升级期间必须禁止控制 |

## 2. 进程与线程模型

```
┌──────────────────── Renderer (Chromium) ────────────────────┐
│  UI：PPI 雷达 / 仪表 / 地图 / 设置                            │
│  · 30Hz 下发归一化指令（兼心跳）                              │
│  · 60fps 绘制，只读订阅，绝不直接持有 socket                   │
└───────────────▲──────────────────────────┬──────────────────┘
                │ contextBridge（白名单）   │ 二进制 TypedArray
┌───────────────┴──────────────────────────▼──────────────────┐
│  Main (Node.js)                                             │
│  Link       TCP 9527，50Hz 自校正节拍，STATUS/SCAN 解析        │
│  Safety     ARM / ESTOP / UI 500ms 心跳 / 退出补发安全帧       │
│  Discovery  UDP 9528 广播与探测，多船切换                      │
│  Log        会话日志：原始帧 + CSV + 事件落盘（回放待补）        │
└───────────────┬─────────────────────────────────────────────┘
                │ stdio JSONL（v0）
┌───────────────▼─────────────────────────────────────────────┐
│  Python 算法进程（可多个）：SLAM / 视觉 / 规划                  │
│  崩溃自动重启（2s 退避），只影响算法输出                        │
└─────────────────────────────────────────────────────────────┘
                │ TCP 9527（协议 v1 → 固件 v2 兼容）
┌───────────────▼─────────────────────────────────────────────┐
│  船端固件：CMD 执行 + 300ms 看门狗 + OTA 升级（独立通道）        │
└─────────────────────────────────────────────────────────────┘
```

硬规则：

1. **50Hz 控制节拍只在 Main 的单调时钟调度器里**，不允许 UI 或算法驱动。
2. **UI 卡死 = 500ms 后应用内归零**，不依赖渲染进程存活。
3. **算法队列满 = 丢旧保新**，永不反压控制链路。
4. **任何解码异常只丢弃该帧并计数**，不抛出到事件循环顶层。

## 3. 数据契约

### 3.1 船端线协议（v1，保持不变）

```
AA 55 | ver=1 | type | seq(u16) | len(u16) | payload | crc16
CRC16-CCITT-FALSE，覆盖 ver..payload，小端
CMD 0x01 (12B, 50Hz) · STATUS 0x81 (26B, 50Hz) · SCAN 0x82 (8B 头 + 5B/点, ~10Hz, 可 zlib)
```

权威字段表：`spec/protocol-v1.md`；黄金帧测试：`desktop/test/protocol.test.ts`。

### 3.2 内部 `Scan2D`

| 字段 | 类型 | 说明 |
|---|---|---|
| `timeMs` | number | 船端单调时钟，圈完成时刻 |
| `count` | number | 点数 |
| `anglesRad` | Float32Array | C1 约定：0 = 正前，顺时针 |
| `rangesM` | Float32Array | 米；0 表示无效 |
| `qualities` | Uint8Array | 0..255 |
| `qualityMax` | number | 源量化上限（C1 为 63） |
| `encoding` | number | 0=raw，1=zlib |

> v2 拟增加 `tStartMs / scanSeq / originalCount / scanRateX100 / qualityMax`，见 §7.3。

### 3.3 应用内 IPC（preload 白名单）

| 通道 | 方向 | 频率 | 内容 |
|---|---|---|---|
| `ui:cmd` | 渲染 → 主 | 30Hz | `{throttle, rudder}` 归一化 −1..1 |
| `ui:arm` / `ui:estop` | 渲染 → 主 | 事件 | 布尔 |
| `evt:status` | 主 → 渲染 | 20Hz | `StatusView` |
| `evt:scan` | 主 → 渲染 | ~10Hz | `ScanView`（TypedArray） |
| `evt:link` / `evt:ships` | 主 → 渲染 | 1Hz / 变更 | 链路与在场船只 |
| `evt:pose` / `evt:algo` | 主 → 渲染 | 10Hz / 1Hz | SLAM 位姿与算法健康 |
| `log:info` | 渲染 → 主 | 2s 轮询 | 会话日志大小 / 行数 / 失败原因 |
| `log:open` / `log:save` | 渲染 → 主 | 事件 | 打开日志目录 / 导出 ZIP |

### 3.4 Python 侧车协议（v0）

```
→ {"type":"scan","t":<ms>,"angles":[rad],"ranges":[m],"qualities":[u8]}
← {"type":"pose","t":<ms>,"x":0,"y":0,"yaw":0,"status":"TRACKING","covariance":[9]}
→ {"type":"ping"}          ← {"type":"pong"}
```

- 逐行 JSON，UTF-8；单行可能较大（500 点约 15KB），本地管道可接受。
- v1 升级方向：长度前缀 + `Float32` 二进制，或共享内存环。契约不变，只换编码层。
- 启动时算法应输出 `{"type":"ready","api":1}`；主进程据此判定版本兼容。

## 4. 安全设计

| 层 | 机制 | 参数 |
|---|---|---|
| UI | 摇杆回中才允许解锁；切后台/关闭前补发归零 | 阈值 0.15 |
| Main | Supervisor：未解锁 / 急停 / UI 超时 → 归零且不带 ARM 位 | `uiTimeoutMs = 500` |
| Main | 退出前保持连接 600ms，连续发安全帧 | 0.6s |
| 链路 | 断线自动重连；断线期间不写 socket | 2s 退避 |
| 船端 | 300ms 看门狗 → 油门 0 + 舵回中 | 固件参数 |

急停优先级最高：即使未解锁也会下发 `ESTOP` 位。

## 5. 目录结构

```
desktop/
├─ src/
│  ├─ shared/       protocol.ts（协议编解码 + Scan2D）、api.ts（IPC 契约类型）
│  ├─ main/         index.ts / config.ts / link / safety / ipc / algo / log
│  ├─ preload/      contextBridge 白名单
│  └─ renderer/     index.html / main.ts / radar.ts / style.css
├─ test/            黄金帧与解析器单测（node:test）
├─ tools/           sim-boat.cjs（假船端）/ link-smoke.cjs / algo-sidecar.py / copy-assets.mjs
└─ docs/            本文档
```

构建：

| 命令 | 作用 |
|---|---|
| `npm run build` | tsc（主进程/预加载）+ esbuild（渲染）+ 复制静态资源 |
| `npm test` | 协议黄金帧 + 分片 + CRC + zlib + 会话日志格式 |
| `npm run smoke` | 假船端 ⇄ 真实链路：50Hz、未解锁不输出、解锁、急停、UI 超时、日志落盘 |
| `npm start` | 启动应用（需先 `npm run sim` 或接实船） |
| `npm run sim` | 只启动假船端 |

## 6. Python 算法进程

- **打包**：随应用内嵌 `python-build-standalone`（体积不敏感），避免依赖用户环境；venv 固定在 `resources/algo/`。
- **生命周期**：主进程启动时拉起，退出时 `shutdown`；崩溃 2s 退避重启，重启次数上报 UI。
- **健康**：`evt:algo` 每秒上报 `running / restarts / lastPoseAgoMs / scansSent`。
- **SLAM 输出建议**（供 UI / 决策）：`pose(x,y,yaw)`、`covariance`、`status(INIT/TRACKING/LOST/RELOC)`、`quality(inliers/residual)`、`map`、`path`。
- **坐标**：`map` 用本地 ENU 或首帧位姿为原点；点云角度需按 C1 约定（顺时针）转 SLAM 约定（逆时针），转换在适配层完成，不进 `Scan2D`。

## 7. 船端固件化（对接口的影响）

### 7.1 目标

船端从「手工 `nohup python3 main.py`」升级为可版本化、可回滚、可远程更新的固件。

### 7.2 推荐形态（按代价从低到高）

| 方案 | 内容 | 适用 |
|---|---|---|
| A. 版本化 deb + systemd | 打包 `usv_edge` 为 deb，`dpkg -i` 升级，systemd 管理，SIGTERM 安全停车 | 先落地，改动最小 |
| B. A/B rootfs + bootloader 切换 | 双系统分区，升级写备分区，失败回滚 | 需要断电安全与批量运维 |
| C. 容器化（docker/podman） | 应用与系统解耦，镜像回滚 | 资源占用略高，Orange Pi 可行 |

> 建议先 A，接口按 B 的能力设计（版本号、升级状态、回滚），避免以后返工。

### 7.3 协议影响（与船端同步升 v2）

| 新增项 | 作用 |
|---|---|
| `HELLO(0x03)` / `HELLO_ACK(0x83)` | 连接后交换：协议版本、固件版本、能力位、算法接口版本 |
| 能力位 `caps` | 雷达启停、SCAN v2、OTA、IMU、视频流等，终端按位降级 |
| `SCAN` 头扩展 | `t_start_ms / scan_seq(u32) / original_count / scan_rate_x100 / quality_max` |
| `OTA_BEGIN/PROGRESS/RESULT`（独立端口 9530） | 传输与校验不占用 50Hz 控制链路 |
| `STATUS` 扩展（可选） | 固件版本、CPU/温度、升级状态、电池电压 |

### 7.4 升级期间的安全约定

1. 升级前必须 **disarm**，终端置 `ESTOP` 或进入 `SERVICE` 状态；
2. 升级中船端**拒绝一切控制帧**，只回状态；
3. 升级包必须 **签名 + SHA256**，校验失败立即回滚；
4. 升级后自检（雷达/舵机/电机/PWM）通过才允许重新上线；
5. 断电保护：写备分区 + 原子切换，避免刷成砖。

### 7.5 兼容策略

- 终端同时支持 **v1 与 v2**：`HELLO` 缺失按 v1 处理（当前实船）；
- 终端发布新版本时，固件可滞后一个版本（N-1 兼容）；
- 所有新增字段必须有默认值，禁止破坏既有字段偏移。

## 8. 测试与验收

| 层级 | 内容 | 现状 |
|---|---|---|
| 协议 | CRC 标准向量、CMD/STATUS/SCAN 黄金帧、任意分片、CRC 错误恢复、zlib | ✅ `npm test` |
| 链路 | 50Hz 下发、未解锁不输出、解锁、急停、UI 超时归零、SCAN 解码 | ✅ `npm run smoke` |
| 日志 | STATUS/CMD/SCAN 行数、原始流可还原、CRC 0、ZIP 可解压 | ✅ `npm test` / `npm run smoke` |
| 算法 | 崩溃重启、超时无位姿告警、输入输出契约校验 | ⬜ 待补 |
| 回放 | 同一份录制数据离线复跑，结果可复现 | ⬜ 待补 |
| 打包 | 安装包、免安装目录、签名 | ⬜ 待补 |

时延预算（端到端）：一圈 83–125ms（物理）+ 组帧/压缩 <5ms + WiFi 1–10ms + 解码 <1ms。
**最老点数据年龄 ≈ 1 个扫描周期**，SLAM 去畸变必须按角度插值，不能只用圈时间戳。

## 9. 里程碑

| 阶段 | 交付 |
|---|---|
| M1（本次） | 骨架：Electron + 协议包 + 链路 + 安全 + 假船端 + 自检 |
| M2 | 会话日志/原始帧落盘（已完成）；离线回放；STATUS 全字段 UI；配置持久化 |
| M3 | SLAM 接入：Python 侧车实装、位姿/地图显示 |
| M4 | 避障与告警（点云扇区、最近障碍、分级告警） |
| M5 | 打包分发（electron-builder / 免安装目录）、日志与崩溃收集 |
| M6 | 船端固件 v2：HELLO / 能力位 / OTA；终端升级界面 |
