"""Tests for the prior-map localizer.

Synthetic 12 m room with asymmetric obstacles, rasterised into the same
``map.yaml`` + P5 PGM layout the mapping exporter writes. Scans are ray-cast
from known poses, so the expected answer is exact.
"""
from __future__ import annotations

import math
import threading

import numpy as np
import pytest

from cocommand2d.scan import Scan
from localization import (
    PHASE_AMBIGUOUS,
    PHASE_TRACKING,
    LocalizerConfig,
    MapError,
    MapLocalizer,
    PriorMap,
)

RES = 0.08
ROOM = 12.0
ORIGIN = (-ROOM / 2, -ROOM / 2)

WALLS = [
    ((-6.0, -6.0), (6.0, -6.0)),
    ((6.0, -6.0), (6.0, 6.0)),
    ((6.0, 6.0), (-6.0, 6.0)),
    ((-6.0, 6.0), (-6.0, -6.0)),
    # asymmetric interior obstacles: breaks the 4-fold symmetry of the room
    ((1.0, 0.5), (2.4, 0.5)),
    ((2.4, 0.5), (2.4, 1.8)),
    ((-3.4, -2.2), (-2.0, -2.2)),
    ((-3.4, -2.2), (-3.4, -0.6)),
    ((-3.4, 2.4), (-1.4, 2.4)),
]


def _world_to_cells(points: np.ndarray) -> np.ndarray:
    cells = (points - np.asarray(ORIGIN)) / RES
    return np.floor(cells).astype(int)


def write_map(directory, walls=WALLS):
    """Rasterise a room and return the map.yaml path."""
    n = int(math.ceil(ROOM / RES))
    grid = np.full((n, n), 205, dtype=np.uint8)  # unknown
    xs = ORIGIN[0] + (np.arange(n) + 0.5) * RES
    ys = ORIGIN[1] + (np.arange(n) + 0.5) * RES
    xx, yy = np.meshgrid(xs, ys)  # row = y index
    inside = (xx > -6.0) & (xx < 6.0) & (yy > -6.0) & (yy < 6.0)
    grid[inside] = 254  # free

    for (x1, y1), (x2, y2) in walls:
        length = math.hypot(x2 - x1, y2 - y1)
        steps = max(2, int(length / (RES * 0.4)))
        for t in np.linspace(0.0, 1.0, steps):
            x = x1 + (x2 - x1) * t
            y = y1 + (y2 - y1) * t
            # thicken to at least one full cell
            for dx in (-RES * 0.4, 0.0, RES * 0.4):
                for dy in (-RES * 0.4, 0.0, RES * 0.4):
                    col = int((x + dx - ORIGIN[0]) / RES)
                    row = int((y + dy - ORIGIN[1]) / RES)
                    if 0 <= row < n and 0 <= col < n:
                        grid[row, col] = 0

    # PGM row 0 is the top of the map; grid row 0 is min y.
    body = np.flipud(grid).tobytes()
    header = f"P5\n{n} {n}\n255\n".encode("ascii")
    (directory / "map.pgm").write_bytes(header + body)
    (directory / "map.yaml").write_text(
        "\n".join(
            [
                "# test map",
                "image: map.pgm",
                f"resolution: {RES}",
                f"origin: [{ORIGIN[0]}, {ORIGIN[1]}, 0.0]",
                "negate: 0",
                "occupied_thresh: 0.65",
                "free_thresh: 0.196",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return directory / "map.yaml"


def raycast(x, y, yaw, angles, walls=WALLS, max_range=12.0):
    """Distance to the nearest wall for each beam (x-forward / y-left frame)."""
    out = np.full(len(angles), max_range, dtype=float)
    dirs = np.column_stack((np.cos(angles + yaw), np.sin(angles + yaw)))
    for i, (dx, dy) in enumerate(dirs):
        best = max_range
        for (x1, y1), (x2, y2) in walls:
            sx, sy = x2 - x1, y2 - y1
            denom = dx * sy - dy * sx
            if abs(denom) < 1e-12:
                continue
            t = ((x1 - x) * sy - (y1 - y) * sx) / denom
            u = ((x1 - x) * dy - (y1 - y) * dx) / denom
            if 0.05 < t < best and 0.0 <= u <= 1.0:
                best = t
        out[i] = best
    return out


def make_scan(x, y, yaw, timestamp=1.0, beams=480, walls=WALLS):
    angles = np.linspace(-math.pi, math.pi, beams, endpoint=False)
    ranges = raycast(x, y, yaw, angles, walls)
    return Scan(
        timestamp=timestamp,
        angles=angles,
        ranges=ranges,
        quality=np.full(beams, 30.0),
        valid=np.ones(beams, dtype=bool),
        source="test",
    )


@pytest.fixture()
def prior(tmp_path):
    return PriorMap(write_map(tmp_path))


def test_map_loading_and_orientation(tmp_path):
    prior = PriorMap(write_map(tmp_path))
    info = prior.info
    assert info.width == int(math.ceil(ROOM / RES))
    assert info.resolution == pytest.approx(RES)
    assert info.origin == pytest.approx(ORIGIN)
    assert info.occupied > 100
    assert info.free > 1000
    # Row 0 must be minimum y: the bottom wall is at y = -6.
    assert prior.occupied[0, :].sum() > 100
    assert prior.occupied[-1, :].sum() > 100


def test_map_missing_file(tmp_path):
    with pytest.raises(MapError):
        PriorMap(tmp_path / "missing.yaml")


def test_map_rejects_bad_image_reference(tmp_path):
    yaml = write_map(tmp_path)
    yaml.write_text(
        yaml.read_text(encoding="utf-8").replace("map.pgm", "../outside.pgm"),
        encoding="utf-8",
    )
    with pytest.raises(MapError):
        PriorMap(yaml)


def test_localize_from_perturbed_seed(prior):
    cfg = LocalizerConfig()
    loc = MapLocalizer(prior, cfg)
    truth = (1.2, -1.6, 0.7)
    loc.set_initial_pose(truth[0] + 0.6, truth[1] - 0.45, truth[2] + math.radians(15))
    result = loc.update_scan(make_scan(*truth))
    assert result.phase == PHASE_TRACKING
    assert result.valid
    assert math.hypot(result.pose[0] - truth[0], result.pose[1] - truth[1]) < 0.25
    assert abs(math.atan2(math.sin(result.pose[2] - truth[2]), math.cos(result.pose[2] - truth[2]))) < math.radians(3)
    assert result.metrics.inlier > 0.7
    assert result.metrics.matched > 100


def test_global_localization_votes_over_frames(prior):
    cfg = LocalizerConfig(bootstrap_frames=4)
    loc = MapLocalizer(prior, cfg)
    truth = (0.4, -0.9, -0.4)
    outcome = None
    for i in range(4):
        # A little motion between frames so a wrong alias cannot survive.
        pose = (truth[0] + 0.12 * i, truth[1] + 0.05 * i, truth[2])
        outcome = loc.update_scan(make_scan(*pose, timestamp=1.0 + 0.1 * i))
        if outcome.phase == PHASE_TRACKING:
            break
    assert outcome is not None
    assert outcome.phase == PHASE_TRACKING, outcome.message
    assert math.hypot(outcome.pose[0] - pose[0], outcome.pose[1] - pose[1]) < 0.3
    assert outcome.metrics.inlier > 0.7


def test_symmetric_room_surfaces_equivalent_candidates(tmp_path):
    """A square pool is rotationally symmetric: several poses match equally well.

    The localizer may commit to one of them (the scan cannot tell them apart),
    but it must surface the equivalents instead of pretending there is a single
    answer. A manual seed is the way to pick the intended one.
    """
    square = WALLS[:4]  # empty square: 4-fold symmetry
    prior = PriorMap(write_map(tmp_path, square))
    loc = MapLocalizer(prior, LocalizerConfig(bootstrap_frames=3))
    outcome = None
    for i in range(3):
        outcome = loc.update_scan(make_scan(0.0, 0.0, 0.0, timestamp=1.0 + 0.1 * i, walls=square))
    assert outcome is not None
    assert loc.candidates, "global search must report candidates"
    best = loc.candidates[0]
    equivalents = [
        c
        for c in loc.candidates[1:]
        if c.score >= 0.9 * best.score
        and (
            math.hypot(c.pose[0] - best.pose[0], c.pose[1] - best.pose[1]) > 0.6
            or abs(math.atan2(math.sin(c.pose[2] - best.pose[2]), math.cos(c.pose[2] - best.pose[2])))
            > math.radians(20)
        )
    ]
    assert equivalents, "symmetric room should expose alternative poses"
    # A manual seed resolves the choice deterministically.
    loc.set_initial_pose(0.0, 0.0, 0.0)
    seeded = loc.update_scan(make_scan(0.0, 0.0, 0.0, timestamp=2.0, walls=square))
    assert seeded.phase == PHASE_TRACKING
    assert abs(math.atan2(math.sin(seeded.pose[2]), math.cos(seeded.pose[2]))) < math.radians(5)


def test_scan_far_outside_map_is_lost(prior):
    loc = MapLocalizer(prior, LocalizerConfig())
    loc.set_initial_pose(0.0, 0.0, 0.0)
    result = loc.update_scan(make_scan(30.0, 30.0, 0.0))
    assert not result.valid
    assert result.phase == "lost"


def test_manual_pose_clears_ambiguity(prior):
    loc = MapLocalizer(prior, LocalizerConfig())
    loc.set_initial_pose(1.0, -1.0, 0.2)
    result = loc.update_scan(make_scan(1.0, -1.0, 0.2))
    assert result.valid
    loc.clear_pose()
    assert loc.phase == "waiting"
    loc.set_initial_pose(1.0, -1.0, 0.2)
    assert loc.update_scan(make_scan(1.0, -1.0, 0.2)).valid


def test_config_validation():
    with pytest.raises(ValueError):
        LocalizerConfig(min_points=5).validate()
    with pytest.raises(ValueError):
        LocalizerConfig(min_inlier=0.0).validate()
    LocalizerConfig().validate()


def test_metrics_are_bounded(prior):
    loc = MapLocalizer(prior, LocalizerConfig())
    loc.set_initial_pose(0.5, 0.5, 0.0)
    result = loc.update_scan(make_scan(0.5, 0.5, 0.0))
    payload = result.to_dict()
    assert 0.0 <= payload["inlier"] <= 1.0
    assert 0.0 <= payload["coverage"] <= 1.0
    assert payload["matched"] <= payload["points"]
    assert payload["dtMs"] >= 0.0


def test_localization_runs_off_the_ui_thread(prior):
    """Sanity: a full global search is a blocking call, so the sidecar must not
    run it on a thread that also serves control messages. This test only proves
    the call itself is deterministic and finishes, not latency bounds."""
    loc = MapLocalizer(prior, LocalizerConfig(bootstrap_frames=1))
    done = {}

    def run():
        done["result"] = loc.update_scan(make_scan(0.0, -2.0, 1.0))

    thread = threading.Thread(target=run)
    thread.start()
    thread.join(20)
    assert not thread.is_alive()
    assert "result" in done
