# SLAM 接入与回放

## 先验地图定位稳定性修订（2026-11-08）

延续 `5c532a9` 的距离场定位算法，未调整匹配阈值或全局搜索策略。
正常匹配和备用匹配现在都相对最后可信位置检查运动幅度，预测位置不能移动验收边界。
丢帧后的速度按两次可信结果之间的时间计算；拒绝帧清除旧速度，采集间隔超过
0.3 秒时暂停旧速度预测和逐点去畸变。该时间对应现有预测时域，不代表设备性能保证。

重复、倒退或非有限时间戳在修改定位状态前抛出 `ValueError`；新采集时调用
`clear_pose()`。人工重新设置位置会清除旧计时、速度和候选状态，第一帧的修正量
不作为船速。无效人工位置不改变原状态；本地和全局匹配均须有有限且合格的残差。
拒绝匹配时 `poseValid=false`，保留的坐标不能当作当前位置。输入单位和侧车 api 3 不变。

验证包含异常跳位、乱序、重新设位、带测距噪声的移动与短时丢帧，以及现有终端的
建图—保存—加载—定位—实验导出流程。均为软件/合成测试，尚无新增实船验证；
对称水池的多解、长期无特征及大幅晃动仍可能导致定位失败。

SLAM 引擎（`desktop/algo/cocommand2d`）与终端之间只有两个接缝：**进程内 sidecar**
和 **离线回放文件**。引擎可以整包替换，这两处的约定不变。定位器在
`desktop/algo/localization`，只读引用 vendor 的 `Scan` / `prepare_scan`。

```
船端 SCAN/SCAN2 ──► TcpLink ──► AlgoSidecar(stdin JSONL) ──► SLAM / 定位 ──► pose / map
                                  ▲                              ▲
                                  │                     map.yaml + PGM（先验地图）
录制 rx.NNN.bin ──► scan-log-to-jsonl.py ──► scans.jsonl ──► run_slam.py（离线）
```

## 1. 位姿事件（stdin/stdout 逐行 JSON）

`api: 3`。建图模式每收到一圈就回一条 `pose`：

| 字段 | 含义 |
|---|---|
| `t` | 船端毫秒时间戳（原样回传） |
| `x` / `y` / `yaw` | 米 / 弧度，原点为首帧可信位姿 |
| `status` | 见下表，**用前缀匹配，不要枚举比较** |
| `poseValid` | `false` 表示坐标是上次可信位姿或占位原点，**不可当作当前定位结果** |
| `rmse` / `inlier` | 匹配残差（米）与内点率；无匹配时为 `null` / `0` |
| `scans` / `skipped` | 已处理圈数 / 被丢弃的异常圈数 |

| `status` 前缀 | 含义 | UI |
|---|---|---|
| `WAITING` | 还没收到扫描 | 红（占位） |
| `INITIALIZING` | 正在用 3 帧确认首帧参考，**不发布地图** | 黄 |
| `TRACKING` | 正常跟踪 | 绿 |
| `LOST` | 连续无可信匹配或超时（>1 s） | 红，`poseValid=false` |
| `DEGENERATE` | 几何退化，匹配无约束 | 红，`poseValid=false` |

`poseValid=false` 时渲染端只画虚线轮廓，表示"最后已知位置"；显示方不得据此
判断船在移动或静止。

### 1.1 先验地图定位（api 3）

加载地图库里的 `map.yaml`（同目录有 `map.pgm`、可选 `map.png`）：

| 方向 | 消息 | 说明 |
|---|---|---|
| → | `{"type":"load_map","path":"<abs map.yaml>"}` | 进入定位模式；清空位姿，首帧自动全局搜索 |
| ← | `{"type":"map_loaded","ok":true,"name":...,"size":500,"resolution":0.08,"origin":[x,y],"occupied":...,"config":{...}}` | 确认加载；`config` 是定位器参数，实验 `config.json` 直接记录 |
| ← | `{"type":"map","prior":true,"png":"<base64>","size":500,"resolution":0.08,"origin":[x,y]}` | 先验地图预览 |
| ← | `{"type":"localization","phase":"waiting\|searching\|tracking\|lost\|ambiguous","message":...,"candidates":[...],"metrics":{...}}` | 相位与指标（≤2Hz 或变化时） |
| → | `{"type":"set_initial_pose","x":..,"y":..,"yaw":..}` | 手动初始位姿；跳过全局搜索 |
| → | `{"type":"clear_pose"}` | 清空位姿，下一帧重新全局定位 |
| → | `{"type":"unload_map"}` | 回到建图模式 |
| ← | `{"type":"pose","mode":"localization","phase":"tracking","poseValid":true,...}` | 定位位姿；额外带 `rmse/inlier/coverage/confidence/matched/dtMs/candidates/margin/condition` |

- 坐标与建图一致：`x` 前 / `y` 左 / 逆时针，原点为建图首帧位姿；**地图不参与建图更新**。
- 自动全局定位：0.6 m / 10° 粗搜索 → 候选细化 → 多帧投票；仍不确定时输出
  `ambiguous`，不静默采用错误位姿。
- 侧车崩溃重启后主进程会重发 `load_map` 与初始位姿，实验继续记录。

## 2. 录制回放

会话目录中的 `rx.NNN.bin` 是原始 TCP 流（`u32 长度 | f64 epoch 毫秒 | 字节`），
点云本体只存在这里（`scan.csv` 只是摘要）。终端侧录制器是
`src/main/log/sessionLog.ts`，随记录功能**单独合入**；本模块只依赖上面的文件格式，
用其它录制器按同一格式写出的数据也能转换。

```powershell
cd desktop
python tools/replay-session.py --session recordings\session-20261030-101500
```

`replay-session.py` 会转换录制、用排他锁文件原子地占住一个唯一输出目录
（`out\<会话名>-<时间戳>`），再交给 `algo/run_slam.py`。转换结果写到**每次独立的
临时目录**并在结束后删除，所以同一会话并发回放也不会互相截断；需要复用一个已转换
好的文件时用 `--scans <file>`。

上游 `batch_slam.py` 的"输出目录必须不存在"只是先检查后创建，直接调用
`run_slam.py` 时仍需自己保证目录唯一。

需要分步执行时：

```powershell
python tools/scan-log-to-jsonl.py --session recordings\session-20261030-101500
python algo\run_slam.py --input recordings\session-20261030-101500\scans.jsonl --output out\run1
```

适配器会重分帧、校验 CRC、把 SCAN（0x82）与 SCAN2（0x85）两种载荷都解出来，
并用 `Scan.from_c1()` 完成度/毫米 → 弧度/米的转换，输出 Scan v1 JSONL。
船端时钟回退或归零时会自动加偏移，保证时间戳严格递增。

需要留意：

- 录制里**没有**逐束采样时刻、横滚、俯仰，所以回放不做去畸变和姿态补偿，
  诊断会标 `missing_timing` / `unavailable`。这是数据缺口，不是算法缺陷。
- `run_slam.py` 要求输出目录尚不存在；一次回放一个新目录，便于对比。
- 有大量隔离帧或只生成局部地图时退出码为 2，**生成了文件不等于定位成功**。
