#!/usr/bin/env python3
"""Python 算法侧车 —— 2D 激光 SLAM（cocommand2d）+ 先验地图定位。

契约（stdin/stdout 逐行 JSON，``api: 3``）::

    <- {"type":"scan","t":<ms>,"tStart":<ms>,"angles":[rad 顺时针],"ranges":[m],"qualities":[u8]}
    -> {"type":"pose","t":<ms>,"x":m,"y":m,"yaw":rad,"status":"...","rmse":m,"inlier":0..1}
    -> {"type":"map","png":"<base64>","size":n,"resolution":m/cell,"origin":[x,y],"observed":n}
    -> {"type":"error","message":"..."}
    <- {"type":"load_map","path":"<map.yaml>"}      // 进入定位模式
    <- {"type":"set_initial_pose","x":..,"y":..,"yaw":..}
    <- {"type":"clear_pose"}                        // 重新全局定位
    <- {"type":"unload_map"}                        // 回到建图模式
    -> {"type":"map_loaded","ok":true,...}
    -> {"type":"localization","phase":"waiting|searching|tracking|lost|ambiguous",...}
    <- {"type":"ping"}  ->  {"type":"pong"}
    <- {"type":"shutdown"}

坐标链：客户端 SCAN2 的角度是「0=正前、顺时针、rad」，`Scan.from_c1()` 会把它转成
「x 前 / y 左 / 逆时针」的 Scan v1 契约，因此这里不需要再做符号处理。

地图限频推送：SLAM 每帧都更新栅格，但 500×500 栅格转成 PNG 只有 ~10KB，
2Hz 足够看，不必每帧都推。定位模式只在加载地图时推一次先验地图。

定位算法在 ``algo/localization/``，不在 vendor 的 ``cocommand2d`` 里；
这里只做进程内接缝。
"""

import base64
import hashlib
import json
import math
import struct
import sys
import time
import zlib
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np

# vendor 包在类级注解里用了 PEP 604（X | None），需要 Python 3.10+。
if sys.version_info < (3, 10):
    sys.stdout.write(
        json.dumps(
            {"type": "error", "message": f"SLAM 需要 Python 3.10+，当前 {sys.version.split()[0]}"},
            separators=(",", ":"),
        )
        + "\n"
    )
    sys.stdout.flush()
    raise SystemExit(1)

# 侧车同级的 algo/ 就是 vendor 进来的 cocommand2d
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "algo"))

try:
    from cocommand2d.scan import Scan
    from cocommand2d.slam import LidarSlam
    from localization import LocalizerConfig, MapError, MapLocalizer, PriorMap
except Exception as exc:  # noqa: BLE001 - 依赖缺失时要能明确告诉界面
    sys.stdout.write(
        json.dumps({"type": "error", "message": f"导入 SLAM 失败: {exc}"}, separators=(",", ":")) + "\n"
    )
    sys.stdout.flush()
    raise SystemExit(1)

MAP_PERIOD_S = 0.5  # 地图推送限频
EXTENT_M = 40.0
RESOLUTION_M = 0.08
LOC_STATUS_PERIOD_S = 0.5


def emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def finite(v: float) -> Optional[float]:
    """JSON 里不能出现 Infinity/NaN，统一转成 null。"""
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None


def png_rgba(rgba: np.ndarray) -> bytes:
    """8bit RGBA PNG（只用 stdlib，避免引入 Pillow）。"""
    h, w, _ = rgba.shape

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + rgba[r].tobytes() for r in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 6))
        + chunk(b"IEND", b"")
    )


def grid_rgba(grid: Any) -> np.ndarray:
    """占据栅格 → RGBA。

    未知区域留全透明（让界面的深色背景透出来），空闲区淡蓝、占据区亮白，
    这样在深色 UI 上比传统「白空闲/黑占据」的 PGM 好看得多。
    """
    p = 1.0 / (1.0 + np.exp(-grid.log_odds))
    observed = grid.observed
    occupied = observed & (p > 0.6)
    free = observed & ~occupied
    h, w = grid.log_odds.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[free] = (70, 120, 170, 70)
    rgba[occupied] = (226, 236, 248, 235)
    return np.flipud(rgba)  # image() 是 [y][x]，PNG 行 0 在最上


class State:
    def __init__(self) -> None:
        self.slam = LidarSlam(extent=EXTENT_M, resolution=RESOLUTION_M)
        self.scans = 0
        self.skipped = 0
        self.last_t = -1.0
        self.t_offset = 0.0
        self.last_map_at = 0.0
        self.last_map_digest = None
        # 定位模式
        self.mode = "mapping"
        self.localizer: Optional[MapLocalizer] = None
        self.map_name: Optional[str] = None
        self.map_yaml: Optional[str] = None
        self.map_info: Optional[dict] = None
        self.last_phase: Optional[str] = None
        self.last_loc_emit = 0.0
        self.loc_frames = 0

    def reset_mapping(self) -> None:
        self.slam = LidarSlam(extent=EXTENT_M, resolution=RESOLUTION_M)
        self.last_map_at = 0.0
        self.last_map_digest = None


STATE = State()


def to_scan(msg: Dict[str, Any]) -> Optional[Scan]:
    """把客户端 SCAN2 转成 Scan v1；时间戳做单调化处理。

    船端 timeMs 是 u32 毫秒、且重启会归零，而 Scan 要求严格递增，
    所以发现回退时整体加一个偏移，而不是丢弃后续数据。
    """
    angles = np.asarray(msg.get("angles") or [], dtype=float)
    ranges = np.asarray(msg.get("ranges") or [], dtype=float)
    qualities = np.asarray(msg.get("qualities") or [], dtype=float)
    if angles.size < 10 or angles.size != ranges.size or ranges.size != qualities.size:
        return None

    t_ms = float(msg.get("tStart") or msg.get("t") or 0.0)
    t_s = t_ms / 1000.0 + STATE.t_offset
    if t_s <= STATE.last_t:
        STATE.t_offset += (STATE.last_t - t_s) + 0.001
        t_s = t_ms / 1000.0 + STATE.t_offset
    STATE.last_t = t_s

    try:
        return Scan.from_c1(t_s, np.degrees(angles), ranges * 1000.0, qualities, mount_yaw=0.0)
    except ValueError:
        return None


def handle_scan(msg: Dict[str, Any]) -> None:
    scan = to_scan(msg)
    if scan is None:
        STATE.skipped += 1
        return

    STATE.scans += 1
    try:
        pose = STATE.slam.update(scan)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": f"SLAM 更新失败: {exc}"})
        return

    emit(
        {
            "type": "pose",
            "t": msg.get("t", 0),
            "x": round(float(pose[0]), 4),
            "y": round(float(pose[1]), 4),
            "yaw": round(float(pose[2]), 5),
            "status": STATE.slam.status,
            "poseValid": STATE.slam.status.startswith(("TRACKING", "INITIALIZING")),
            "rmse": finite(STATE.slam.rmse),
            "inlier": round(float(STATE.slam.inlier_ratio), 3),
            "scans": STATE.scans,
            "skipped": STATE.skipped,
        }
    )

    now = time.monotonic()
    grid = STATE.slam.grid
    observed = int(grid.observed.sum())
    # INITIALIZING（或启动失败）时栅格还是空的：按契约不发布地图，
    # 也不占用限频窗口；reset 的清屏回执走 handle() 里单独的分支。
    if observed and now - STATE.last_map_at >= MAP_PERIOD_S:
        # 内容指纹：比较总量会在"证据在两个已观测格之间转移"时漏掉变化
        # （例如 [3, -3] → [-3, 3]），这里直接对栅格与观测掩码取摘要，
        # 只在 0.5 s 限频通过后才计算，开销约 1 ms。
        digest = hashlib.blake2b(grid.log_odds.tobytes(), digest_size=8).digest()
        digest += hashlib.blake2b(grid.observed.tobytes(), digest_size=8).digest()
        if digest != STATE.last_map_digest:
            STATE.last_map_at = now
            STATE.last_map_digest = digest
            data = base64.b64encode(png_rgba(grid_rgba(grid))).decode("ascii")
            emit(
                {
                    "type": "map",
                    "png": data,
                    "size": int(grid.size),
                    "resolution": float(grid.resolution),
                    "origin": [float(grid.origin[0]), float(grid.origin[1])],
                    "observed": observed,
                }
            )


def emit_localization(force: bool = False) -> None:
    loc = STATE.localizer
    if loc is None:
        return
    now = time.monotonic()
    if (
        not force
        and loc.phase == STATE.last_phase
        and now - STATE.last_loc_emit < LOC_STATUS_PERIOD_S
    ):
        return
    STATE.last_phase = loc.phase
    STATE.last_loc_emit = now
    emit(
        {
            "type": "localization",
            "phase": loc.phase,
            "message": loc.message,
            "map": STATE.map_name,
            "frames": STATE.loc_frames,
            "trackingFrames": loc.tracking_frames,
            "candidates": [c.to_dict() for c in loc.candidates[:3]],
            "metrics": loc.metrics.to_dict(),
        }
    )


def handle_localization_scan(msg: Dict[str, Any]) -> None:
    loc = STATE.localizer
    if loc is None:
        return
    scan = to_scan(msg)
    if scan is None:
        STATE.skipped += 1
        return
    STATE.scans += 1
    STATE.loc_frames += 1
    try:
        result = loc.update_scan(scan)
    except Exception as exc:  # noqa: BLE001 - 单帧失败不应杀掉侧车
        emit({"type": "error", "message": f"定位更新失败: {exc}"})
        return
    payload: Dict[str, Any] = {
        "type": "pose",
        "mode": "localization",
        "t": msg.get("t", 0),
        "status": result.phase.upper(),
        "statusText": result.message,
        "scans": STATE.scans,
        "skipped": STATE.skipped,
        **result.to_dict(),
    }
    if result.valid:
        payload["poseValid"] = True
    emit(payload)
    emit_localization()


def _map_preview_png(yaml_path: Path) -> bytes:
    """优先用地图目录里的 map.png（界面同款），缺失时现渲染。"""
    png_path = yaml_path.parent / "map.png"
    if png_path.is_file():
        data = png_path.read_bytes()
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return data
    return PriorMap(yaml_path).preview_png()


def handle_load_map(msg: Dict[str, Any]) -> None:
    global STATE
    raw = str(msg.get("path") or "")
    try:
        yaml_path = Path(raw).resolve()
        prior = PriorMap(yaml_path)
        localizer = MapLocalizer(prior, LocalizerConfig())
    except (MapError, OSError, ValueError) as exc:
        emit({"type": "map_loaded", "ok": False, "path": raw, "message": str(exc)})
        return

    STATE.mode = "localization"
    STATE.localizer = localizer
    STATE.map_yaml = str(yaml_path)
    STATE.map_name = yaml_path.parent.name
    STATE.map_info = prior.info.to_dict()
    STATE.last_phase = None
    STATE.last_loc_emit = 0.0
    STATE.loc_frames = 0

    info = prior.info
    emit(
        {
            "type": "map_loaded",
            "ok": True,
            "name": STATE.map_name,
            "path": str(yaml_path),
            "config": LocalizerConfig().to_dict(),
            **info.to_dict(),
        }
    )
    try:
        png = _map_preview_png(yaml_path)
        emit(
            {
                "type": "map",
                "prior": True,
                "name": STATE.map_name,
                "png": base64.b64encode(png).decode("ascii"),
                "size": info.width,
                "resolution": info.resolution,
                "origin": [info.origin[0], info.origin[1]],
                "observed": info.occupied + info.free,
                "occupied": info.occupied,
            }
        )
    except Exception as exc:  # noqa: BLE001 - 预览失败不影响定位
        emit({"type": "error", "message": f"地图预览失败: {exc}"})
    emit_localization(force=True)


def handle_set_initial_pose(msg: Dict[str, Any]) -> None:
    loc = STATE.localizer
    if loc is None:
        emit({"type": "localization", "phase": "waiting", "message": "未加载地图"})
        return
    try:
        loc.set_initial_pose(float(msg.get("x", 0.0)), float(msg.get("y", 0.0)), float(msg.get("yaw", 0.0)))
    except (TypeError, ValueError) as exc:
        emit({"type": "error", "message": f"初始位姿无效: {exc}"})
        return
    emit_localization(force=True)


def handle_clear_pose() -> None:
    loc = STATE.localizer
    if loc is None:
        return
    loc.clear_pose()
    emit_localization(force=True)


def handle_unload_map() -> None:
    global STATE
    STATE.localizer = None
    STATE.mode = "mapping"
    STATE.map_name = None
    STATE.map_yaml = None
    STATE.map_info = None
    STATE.last_phase = None
    STATE.reset_mapping()
    emit({"type": "map_unloaded", "ok": True})


def handle(msg: Dict[str, Any]) -> None:
    global STATE
    kind = msg.get("type")
    if kind == "scan":
        if STATE.mode == "localization":
            handle_localization_scan(msg)
        else:
            handle_scan(msg)
    elif kind == "load_map":
        handle_load_map(msg)
    elif kind == "set_initial_pose":
        handle_set_initial_pose(msg)
    elif kind == "clear_pose":
        handle_clear_pose()
    elif kind == "unload_map":
        handle_unload_map()
    elif kind == "reset":
        if STATE.mode == "localization":
            handle_clear_pose()
            return
        # 建图模式：重建 SLAM 实例，回到「等首帧」状态，并推一张空图让界面立刻清屏
        STATE = State()
        emit(
            {
                "type": "map",
                "png": "",
                "size": STATE.slam.grid.size,
                "resolution": RESOLUTION_M,
                "origin": [-EXTENT_M / 2, -EXTENT_M / 2],
                "observed": 0,
                "cleared": True,
            }
        )
        emit(
            {
                "type": "pose",
                "t": 0,
                "x": 0.0,
                "y": 0.0,
                "yaw": 0.0,
                "status": "WAITING",
                "poseValid": False,
                "rmse": None,
                "inlier": 0.0,
                "scans": 0,
                "skipped": 0,
            }
        )
    elif kind == "ping":
        emit({"type": "pong", "t": time.time()})
    elif kind == "shutdown":
        raise SystemExit(0)


def main() -> None:
    emit(
        {
            "type": "ready",
            "api": 3,
            "slam": "cocommand2d",
            "localization": "distance-field",
            "capabilities": ["slam", "localization"],
            "extent_m": EXTENT_M,
            "resolution_m": RESOLUTION_M,
        }
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(msg, dict):
            handle(msg)


if __name__ == "__main__":
    main()
