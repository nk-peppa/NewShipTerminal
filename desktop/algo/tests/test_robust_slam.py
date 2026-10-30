"""Small analytic scenes: regression evidence, not vessel or sensor validation."""
from dataclasses import replace

import numpy as np
import pytest

from cocommand2d.scan import Scan, wrap
from cocommand2d.slam import LidarSlam, OccupancyGrid


def room_scan(pose, timestamp, seed=31):
    """Independent ray/segment fixture; pose is never passed to SLAM."""
    polygons = [np.array(p) for p in (
        [(-3., -3.), (10., -3.), (10., 9.), (-3., 9.)],
        [(4., 1.5), (6., 1.5), (6., 3.5), (4., 3.5)],
        [(0., 5.), (1.5, 5.), (1.5, 6.), (0., 6.)],
    )]
    a = np.concatenate(polygons)
    b = np.concatenate([np.roll(p, -1, axis=0) for p in polygons])
    angles = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    direction = np.column_stack((np.cos(angles+pose[2]), np.sin(angles+pose[2])))
    vector = b - a
    offset = a - pose[:2]
    cross = lambda x, y: x[..., 0] * y[..., 1] - x[..., 1] * y[..., 0]
    denominator = cross(direction[:, None], vector)
    with np.errstate(divide="ignore", invalid="ignore"):
        distance = cross(offset, vector) / denominator
        fraction = cross(offset, direction[:, None]) / denominator
    hits = (np.abs(denominator) > 1e-9) & (distance > 0) & (fraction >= 0) & (fraction <= 1)
    ranges = np.min(np.where(hits, distance, np.inf), axis=1)
    valid = np.isfinite(ranges) & (ranges <= 12)
    ranges[~valid] = 0
    ranges[valid] += np.random.default_rng(seed).normal(0, .006, valid.sum())
    return Scan(timestamp, angles, ranges, np.ones(500), valid, "analytic-test")


def cell_value(grid, point):
    x, y = grid.cells(np.asarray([point]))[0]
    return grid.log_odds[y, x]


def test_single_hit_does_not_commit_obstacle_but_repeated_hits_do():
    grid = OccupancyGrid(extent=10, resolution=.1)
    point = np.array([[2.05, .05]])
    # Many returns in one frame are not independent temporal confirmations.
    grid.update(np.repeat(point, 100, axis=0), [0, 0, 0])
    assert cell_value(grid, point[0]) <= 0
    for _ in range(6):
        grid.update(point, [0, 0, 0])
    assert cell_value(grid, point[0]) > 2


def test_revisited_free_rays_remove_saturated_temporary_obstacle():
    grid = OccupancyGrid(extent=10, resolution=.1)
    for _ in range(20):
        grid.update(np.array([[2.05, .05]]), [0, 0, 0])
    assert cell_value(grid, [2.05, .05]) > 2
    for _ in range(12):
        grid.update(np.array([[4.05, .05]]), [0, 0, 0])
    assert cell_value(grid, [2.05, .05]) < -1
    assert cell_value(grid, [4.05, .05]) > 2


def test_unobserved_cells_do_not_decay_during_unrelated_updates():
    grid = OccupancyGrid(extent=10, resolution=.1)
    for _ in range(10):
        grid.update(np.array([[-2.05, 1.05]]), [0, 0, 0])
    before = cell_value(grid, [-2.05, 1.05])
    for _ in range(80):
        grid.update(np.array([[3.05, -1.05]]), [0, 0, 0])
    assert cell_value(grid, [-2.05, 1.05]) == before


def test_diagonal_ray_clears_every_crossed_cell_not_only_sample_locations():
    grid = OccupancyGrid(extent=20, resolution=.08)
    ghost = np.array([[1.48, -.52]])
    for _ in range(20):
        grid.update(ghost, [0, 0, 0])
    assert cell_value(grid, ghost[0]) > 2
    # This ray crosses the lower-left corner of the ghost's cell. Sampling at
    # one grid-resolution intervals skips that cell even though the ray enters.
    for _ in range(12):
        grid.update(np.array([[7.86, -3.]]), [0, 0, 0])
    assert cell_value(grid, ghost[0]) < -1


@pytest.mark.parametrize("spikes", [False, True])
def test_small_motion_remains_tracked_with_isolated_gross_returns(spikes):
    slam = LidarSlam()
    rng = np.random.default_rng(824)
    errors = []
    accepted = 0
    for index in range(70):
        truth = np.array([index*.016, .2*np.sin(index*.02), index*.004])
        scan = room_scan(truth, index*.1, seed=index+20)
        if spikes:
            ranges = scan.ranges.copy()
            ids = rng.choice(500, 30, replace=False)
            ranges[ids] = rng.uniform(.3, 10, len(ids))
            scan = replace(scan, ranges=ranges)
        estimate = slam.update(scan)
        accepted += slam.status in ("INITIALIZED", "TRACKING")
        errors.append(np.linalg.norm(estimate[:2]-truth[:2]))
    assert accepted >= 65, slam.status  # Freezing must not count as accuracy.
    assert max(errors) < .16
    assert abs(wrap(estimate[2]-truth[2])) < .03
    assert np.count_nonzero(slam.grid.log_odds > .7) > 150


def test_severe_nonrigid_frame_cannot_mutate_map_and_clean_scan_recovers():
    slam = LidarSlam()
    for index in range(8):
        slam.update(room_scan(np.zeros(3), index*.1, seed=index))
    before_map = slam.grid.log_odds.copy()
    before_observed = slam.grid.observed.copy()
    before_pose = slam.pose.copy()
    bad = room_scan(np.zeros(3), .8)
    bad = replace(bad, ranges=bad.ranges * (1+.28*np.sin(3*bad.angles+.7)))
    slam.update(bad)
    assert slam.status.startswith(("LOST", "DEGENERATE", "REJECTED")), slam.status
    np.testing.assert_array_equal(slam.grid.log_odds, before_map)
    np.testing.assert_array_equal(slam.grid.observed, before_observed)
    np.testing.assert_array_equal(slam.pose, before_pose)
    for index in range(9, 14):
        slam.update(room_scan(np.zeros(3), index*.1, seed=index))
    assert slam.status == "TRACKING"
    assert np.linalg.norm(slam.pose[:2]) < .04


def test_corrupted_first_frame_cannot_seed_map_and_clean_startup_recovers():
    slam = LidarSlam()
    first = room_scan(np.zeros(3), 0)
    first = replace(first, ranges=first.ranges * (1+.28*np.sin(3*first.angles+.7)))
    slam.update(first)
    assert not slam.grid.observed.any()
    assert not np.any(slam.grid.log_odds)
    for index in range(1, 16):
        slam.update(room_scan(np.zeros(3), index*.1, seed=index+300))
    assert slam.status == "TRACKING"
    assert np.linalg.norm(slam.pose[:2]) < .05
    assert abs(slam.pose[2]) < .015
    assert np.count_nonzero(slam.grid.log_odds > .7) > 100


def test_coherent_bad_sector_cannot_erase_established_room_walls():
    slam = LidarSlam()
    for index in range(15):
        slam.update(room_scan(np.zeros(3), index*.1, seed=index+400))
    yy, xx = np.indices(slam.grid.log_odds.shape)
    x = slam.grid.origin[0] + (xx+.5)*slam.grid.resolution
    y = slam.grid.origin[1] + (yy+.5)*slam.grid.resolution
    affected = (np.arctan2(y, x) > 2.5) & (slam.grid.log_odds > .7)
    count = affected.sum()
    assert count > 20
    accepted = 0
    for index in range(15, 40):
        scan = room_scan(np.zeros(3), index*.1, seed=index+400)
        ranges = scan.ranges.copy()
        ranges[scan.angles > 2.5] += 2
        slam.update(replace(scan, ranges=ranges))
        accepted += slam.status == "TRACKING"
    # A well-supported 90% of the scene should keep localization usable, but
    # the inconsistent sector must not repeatedly ray-clear established walls.
    assert accepted >= 20
    assert np.count_nonzero((slam.grid.log_odds > .7) & affected) >= .8*count
    assert np.linalg.norm(slam.pose[:2]) < .05


def test_stationary_disappearing_surface_is_removed_from_map():
    slam = LidarSlam()
    accepted = 0
    for index in range(70):
        scan = room_scan(np.zeros(3), index*.1, seed=index+60)
        if index < 5:
            ranges = scan.ranges.copy()
            mask = np.abs(scan.angles) < .5
            ranges[mask] = np.minimum(ranges[mask], 1.5/np.cos(scan.angles[mask]))
            scan = replace(scan, ranges=ranges)
        slam.update(scan)
        accepted += slam.status in ("INITIALIZED", "TRACKING")
    probes = np.column_stack((np.full(15, 1.5), np.linspace(-.5, .5, 15)))
    cells = slam.grid.cells(probes)
    assert accepted >= 60
    assert np.max(slam.grid.log_odds[cells[:, 1], cells[:, 0]]) <= 0
    assert np.linalg.norm(slam.pose[:2]) < .08


def test_missing_frames_do_not_turn_held_pose_into_velocity_estimate():
    slam = LidarSlam()
    accepted = 0
    for index in range(70):
        if index % 15 in (7, 8):
            continue
        truth = np.array([index*.012, .001*index, .002*index])
        estimate = slam.update(room_scan(truth, index*.1, seed=index+90))
        accepted += slam.status in ("INITIALIZED", "TRACKING")
    assert accepted >= 55
    assert np.linalg.norm(estimate[:2]-truth[:2]) < .12
    assert abs(wrap(estimate[2]-truth[2])) < .02
