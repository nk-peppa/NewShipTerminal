"""Prior map loading for scan-to-map localization.

Reads the ROS ``map_server`` pair produced by the mapping exporter
(``map.yaml`` + 8-bit ``P5`` PGM, 0/254/205 three-state). The PGM's first row is
the top of the map; this module flips it so row 0 is the minimum world y, which
matches the SLAM grid and the renderer.

Only observation utilities live here: the vendor ``cocommand2d`` package is not
modified, the localizer imports it read-only.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates


class MapError(ValueError):
    """Raised when a prior map cannot be loaded or is inconsistent."""


@dataclass(frozen=True)
class MapInfo:
    path: Path
    width: int
    height: int
    resolution: float
    origin: tuple[float, float]
    occupied: int
    free: int
    unknown: int

    def to_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "size": self.width,
            "resolution": self.resolution,
            "origin": [self.origin[0], self.origin[1]],
            "occupied": self.occupied,
            "free": self.free,
            "unknown": self.unknown,
            "observed": self.occupied + self.free,
        }


def _parse_yaml(text: str) -> dict:
    values: dict = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    try:
        origin = [float(v) for v in values["origin"].strip("[]").split(",")[:2]]
        resolution = float(values["resolution"])
    except (KeyError, ValueError) as exc:
        raise MapError(f"map.yaml 缺少 origin/resolution: {exc}") from exc
    if len(origin) < 2:
        raise MapError("map.yaml 的 origin 至少需要 x,y")
    if not np.isfinite(resolution) or resolution <= 0:
        raise MapError(f"map.yaml 的 resolution 无效: {resolution}")
    if not all(np.isfinite(v) for v in origin):
        raise MapError("map.yaml 的 origin 含非有限值")
    image = values.get("image", "map.pgm").strip()
    return {"origin": (origin[0], origin[1]), "resolution": resolution, "image": image}


def _read_pgm(path: Path) -> np.ndarray:
    data = path.read_bytes()
    offset = 0
    tokens: list[bytes] = []
    while len(tokens) < 4:
        # skip whitespace and comments
        while offset < len(data):
            c = data[offset]
            if c == 0x23:  # '#'
                while offset < len(data) and data[offset] != 0x0A:
                    offset += 1
            elif c in (0x20, 0x0A, 0x0D, 0x09):
                offset += 1
            else:
                break
        start = offset
        while offset < len(data) and data[offset] not in (0x20, 0x0A, 0x0D, 0x09):
            offset += 1
        tokens.append(data[start:offset])
    magic, width, height, maxval = tokens
    if magic != b"P5":
        raise MapError(f"只支持 P5 PGM，实际 {magic!r}")
    w, h, mv = int(width), int(height), int(maxval)
    if w <= 0 or h <= 0 or mv != 255:
        raise MapError(f"PGM 头无效: {w}x{h} maxval={mv}")
    offset += 1  # single whitespace after maxval
    body = data[offset : offset + w * h]
    if len(body) < w * h:
        raise MapError(f"PGM 数据不完整: {len(body)} < {w * h}")
    return np.frombuffer(body, dtype=np.uint8).reshape(h, w)


class PriorMap:
    """Occupancy map with a precomputed distance field for scan matching."""

    def __init__(self, yaml_path: Path, sigma: float = 0.8):
        yaml_path = Path(yaml_path).resolve()
        if not yaml_path.is_file():
            raise MapError(f"地图不存在: {yaml_path}")
        meta = _parse_yaml(yaml_path.read_text(encoding="utf-8"))
        image_path = (yaml_path.parent / meta["image"]).resolve()
        if image_path.parent != yaml_path.parent:
            raise MapError("map.yaml 的 image 不得指向目录外")
        if not image_path.is_file():
            raise MapError(f"缺少栅格文件: {image_path}")

        raw = _read_pgm(image_path)
        # PGM row 0 = top of the map; grid row 0 = minimum y.
        self.raw = np.flipud(raw)
        self.width = int(raw.shape[1])
        self.height = int(raw.shape[0])
        self.resolution = float(meta["resolution"])
        self.origin = np.asarray(meta["origin"], dtype=float)

        self.occupied = self.raw <= 1
        self.free = self.raw >= 250
        self.unknown = ~(self.occupied | self.free)
        if not np.any(self.occupied):
            raise MapError("地图没有占据栅格，无法定位")

        dist = distance_transform_edt(~self.occupied).astype(np.float32) * self.resolution
        if sigma > 0:
            dist = gaussian_filter(dist, sigma=sigma, mode="nearest").astype(np.float32)
        self.dist = dist
        gy, gx = np.gradient(dist)
        self.gx = (gx / self.resolution).astype(np.float32)
        self.gy = (gy / self.resolution).astype(np.float32)

        self.info = MapInfo(
            path=yaml_path,
            width=self.width,
            height=self.height,
            resolution=self.resolution,
            origin=(float(self.origin[0]), float(self.origin[1])),
            occupied=int(np.count_nonzero(self.occupied)),
            free=int(np.count_nonzero(self.free)),
            unknown=int(np.count_nonzero(self.unknown)),
        )

    # ---- coordinate helpers -------------------------------------------------

    def to_cells(self, xy: np.ndarray) -> np.ndarray:
        return (np.asarray(xy, dtype=float) - self.origin) / self.resolution

    def to_world(self, cells: np.ndarray) -> np.ndarray:
        return np.asarray(cells, dtype=float) * self.resolution + self.origin

    def sample(self, xy: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Bilinear distance / gradient sampling plus an "inside known" mask.

        ``xy`` is (N, 2) world coordinates. Unknown cells count as unusable so a
        scan cannot "match" a wall that was never observed.
        """
        xy = np.asarray(xy, dtype=float)
        if xy.size == 0:
            empty = np.empty(0, dtype=np.float32)
            return empty, empty, empty, np.empty(0, dtype=bool)
        cells = self.to_cells(xy)
        col = cells[:, 0]
        row = cells[:, 1]
        coords = np.array([row, col])
        inside = (
            (col >= 0)
            & (col <= self.width - 1)
            & (row >= 0)
            & (row <= self.height - 1)
        )
        dist = map_coordinates(self.dist, coords, order=1, mode="nearest")
        gx = map_coordinates(self.gx, coords, order=1, mode="nearest")
        gy = map_coordinates(self.gy, coords, order=1, mode="nearest")
        # Walls themselves are "known" (a beam that lands on a wall is a hit);
        # only never-observed cells are excluded.
        unknown = map_coordinates(
            self.unknown.astype(np.float32), coords, order=0, mode="nearest"
        ) > 0.5
        return dist, gx, gy, inside & ~unknown

    def clearance(self) -> np.ndarray:
        return distance_transform_edt(~self.occupied) * self.resolution

    # ---- preview ------------------------------------------------------------

    def preview_png(self) -> bytes:
        """Render the prior map with the same palette as the live map."""
        rgba = np.zeros((self.height, self.width, 4), dtype=np.uint8)
        rgba[self.free] = (70, 120, 170, 70)
        rgba[self.occupied] = (226, 236, 248, 235)
        return _png_rgba(np.flipud(rgba))


def _png_rgba(rgba: np.ndarray) -> bytes:
    import struct
    import zlib

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
