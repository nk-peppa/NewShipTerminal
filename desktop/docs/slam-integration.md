# SLAM 接入与回放

SLAM 引擎（`desktop/algo/cocommand2d`）与终端之间只有两个接缝：**进程内 sidecar**
和 **离线回放文件**。引擎可以整包替换，这两处的约定不变。

```
船端 SCAN/SCAN2 ──► TcpLink ──► AlgoSidecar(stdin JSONL) ──► SLAM ──► pose / map
                                  ▲
录制 rx.NNN.bin ──► scan-log-to-jsonl.py ──► scans.jsonl ──► run_slam.py（离线）
```

## 1. 位姿事件（stdin/stdout 逐行 JSON）

`api: 2`。每收到一圈就回一条 `pose`：

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

## 2. 录制回放

会话目录中的 `rx.NNN.bin` 是原始 TCP 流（`u32 长度 | f64 epoch 毫秒 | 字节`），
点云本体只存在这里（`scan.csv` 只是摘要）。

```powershell
cd desktop
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
