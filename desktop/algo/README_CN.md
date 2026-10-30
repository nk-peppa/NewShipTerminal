# 二维激光 SLAM 算法

按时间输入二维雷达扫描，持续估计 `(x, y, yaw)` 并更新占据栅格。可在现有采集程序中逐帧调用，也可从 JSONL 文件离线建图。算法是自有的局部扫描匹配实现，不是完整 Hector SLAM、Cartographer 或 KISS-ICP。

## 安装、运行

使用已有的 Python 3.11 环境。在解压后的 `Lidar-SLAM` 目录执行：

```powershell
python -m pip install -r requirements.txt
python run_slam.py --input your_scans.jsonl --output output/measurement
```

每次指定一个尚不存在的输出目录。压缩包不包含示例数据、解释器、依赖库副本、驱动、仿真平台或历史输出。

默认地图边长 40 米、栅格 0.08 米；可加 `--extent 60 --resolution 0.08`。边长/分辨率不超过 2000；地图越大，内存和计算开销越大。超出地图边界的区域不会被保存。

包内保留了两份小型算法回归测试，包含射线漏格、噪点清除、启动失败、畸变隔离、时间/姿态补偿。需要复核时运行 `python -m pip install pytest`，然后 `python -m pytest -q`；正常建图只依赖 NumPy 和 SciPy。

## 接入现有程序

```python
from cocommand2d.scan import Scan
from cocommand2d.slam import LidarSlam
from cocommand2d.recording import save_result

slam = LidarSlam()
# 每收到完整一圈扫描就调用；不要把不同圈的数据混在一起。
scan = Scan.from_dict(one_scan_dictionary)
pose = slam.update(scan)
status = slam.status
quality = slam.diagnostics[-1]
current_grid = slam.grid.log_odds.copy()  # 可交给现有显示程序
# 结束或需要保存时：
save_result(slam, "output/measurement")
```

应顺序调用同一个 `slam` 实例。开始新的独立采集时创建新实例。`INITIALIZING` 阶段尚未发布地图；`LOST` / `DEGENERATE` 时保留上次可信位姿和地图，这个保持值不能当作当前定位结果。连续超过 1 秒没有可信匹配后停止接续，应检查输入并另起地图，不自动把新场景拼上去。`TRACKING` 也应检查 `quarantined_points`，它表示部分方向被隔离，未写入地图。

## 输入格式与单位

UTF-8 JSONL，每行一个完整扫描对象。下面只示意字段，两个点不足以做 SLAM；实际一圈通常有数百个点。

```json
{"version":1,"frame":"x_forward_y_left_ccw","timestamp":1.0,"angles":[0.0,0.1],"ranges":[2.5,2.6],"quality":[15,15],"valid":[true,true],"range_min":0.05,"range_max":12.0}
```

- `timestamp`：非负秒数，逐帧严格递增。所有时间必须来自同一时基。
- `angles`：弧度，x 向前、y 向左、逆时针为正；不等角间隔也可。
- `ranges`：米；无效、超出声明范围的距离不参加匹配，也不会被当作自由空间清图。
- `quality`：原样保留，不能当成经过标定的反射率。没有此信息时由采集适配层填 1；`source` 以 `c1` 开头时，零质量会被滤除。
- `valid`：布尔数组。角度、距离、质量、有效标记必须等长且保持同一点的对应关系。

这是算法内部接口，不是 C1 的串口报文格式。C1 原始坐标顺时针增加，距离单位是毫米；已经由 SDK 解码成度/毫米时，可以调用：

```python
scan = Scan.from_c1(timestamp, angles_cw_deg, distances_mm, quality)
```

若接到的是 SDK 原始 `angle_z_q14` / `dist_mm_q2`，必须先按官方定义解码，不能把定点整数直接传给上述方法。禁止重复进行顺/逆时针转换。严格检查单位和一圈扫描的起止标记；只改地图权重解决不了角度、距离或帧组装错误。

## 可选的运动与晃动补偿

旧输入不需要新增字段也能运行。以下是可选的外部观测，不是算法从雷达中估计出的姿态：

- `time_offsets`：每束相对 `timestamp` 的采样时间，单位秒、范围 `[-0.25, 0]`，此时 `timestamp` 明确代表该圈末端参考时刻。算法用此前匹配得到的平面速度，按恒定 SE(2) 运动补偿到该时刻。没有逐点时刻就不做这一步，不能按角度排序后凭空补时间。角度排序时，时间数组必须同步重排。
- `roll`、`pitch`：必须同时提供、与各束同步、等长的弧度数组。在已经统一的右手激光坐标系中，依次按 `R_y(pitch) R_x(roll)` 投影到水平面。提供方应完成 IMU 与雷达外参、坐标轴、时间同步处理；本包没有 IMU 驱动或姿态滤波器。

默认拒绝总倾角超过 0.21 rad（约 12°）或端点相对雷达水平面高度偏移超过 0.35 m 的束。这是保守的处理阈值，不是 C1 硬件容许晃动范围。可在 API 中用 `SlamConfig(max_tilt=..., max_height=...)` 调整；较高的竖直墙和水面不能使用相同的几何假设。不要只为了提高接受帧数而放宽门限。

初始化的第一段没有可信速度，不能完整补偿；恒速模型也不能消除一圈内快速变化的角速度。单线雷达加时间戳不能恢复任意横滚、俯仰或升沉，姿态投影不能补回没有扫到的表面。没有这些可选数据时，诊断会明确标为 `missing_timing` / `unavailable`。

## 输出与诊断

- `map.pgm`：灰度占据图，深色表示较强占据、浅色表示自由、127 为未知。
- `map.npz`：`log_odds`、`observed`、左下原点 `origin`、分辨率 `resolution`。占据概率可用 `1/(1+exp(-log_odds))` 转换。
- `map.json`：坐标说明及 `origin_timestamp`。原点属于成功启动的候选首帧，启动失败换候选时可能不再是输入第一帧。
- `trajectory.csv`：`timestamp,x,y,yaw,status`，单位秒、米、弧度。
- `diagnostics.csv`：每帧是否被接受、匹配残差/重叠比例、过滤点数、运动补偿状态、隔离点数、地图是否更新。
- `summary.json`：批处理帧数、接受/拒绝数量、隔离帧数和耗时等摘要。

PGM 图像首行对应地图上方，NPZ 数组第 0 行对应最小 y。显示程序不能把未排序的点连成折线；显示扫描点应使用散点，显示地图应使用栅格。

退出码 2 表示输入有误，或只生成了质量不足/大量隔离的局部地图，应阅读终端信息和诊断文件。生成了文件不等于定位成功。没有现场原始记录的情况下，本版本尚未验证能修复此次采样失败。

## 硬件依据与边界

核对了提供的 C1M1 数据手册 v1.2 第 6、9—11、13—14 页：典型 10 Hz、5 kHz 采样、0.72° 角间隔、白色目标 0.05—12 m、低反射黑色目标约至 6 m、规定测试条件下测距精度 ±30 mm、460800 baud。约 0.1 秒一圈不能视为瞬时曝光。手册的扫描平面平整度 0—1.5° 不是船体姿态测量值。官方入口：[C1 参数](https://www.slamtec.com/cn/c1/spec)、[资料下载](https://www.slamtec.com/en/support)、[SDK 数据字段](https://github.com/Slamtec/rplidar_sdk#grab-scan-data)。

水面/斜射和低反射回波、快速晃动、升沉、遮挡、移动目标、单边岸线、长直走廊和对称环境都可能降低可用约束；供电或组帧异常也需要从采集端排查。本算法没有全局回环和重定位，长期漂移仍可能累积。大范围已确认结构突然变化时会保守隔离，这也会延迟真实环境变化的写入，不能保证自动区分水面干扰和真正移动的物体。
