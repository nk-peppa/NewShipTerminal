"""Small analytic scenes: regression evidence, not vessel or sensor validation."""
from dataclasses import replace

import numpy as np
import pytest

from cocommand2d.scan import Scan, wrap
from cocommand2d.slam import LidarSlam, OccupancyGrid, SlamConfig


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


def scattered_arcs(scan, index, moving=True):
    """Short, disconnected, nonconcentric artifacts; never a complete ring."""
    ranges = scan.ranges.copy()
    rng = np.random.default_rng(6000+index)
    shift = .08*np.sin(index*.7) if moving else 0.
    for j, centre in enumerate((-2.4, -.9, .7, 2.1)):
        delta = wrap(scan.angles-centre-shift)
        selected = np.abs(delta) < .17
        radius = 1.1+.18*j + (.15*np.sin(index*.9+j) if moving else 0.)
        ranges[selected] = radius+.12*np.sin(6*delta[selected])+rng.normal(0, .008, selected.sum())
    return replace(scan, ranges=ranges)


@pytest.mark.parametrize("changing,motion", [(False, False), (True, True), (False, True)])
def test_scattered_arcs_from_startup_cannot_seed_pose_reference_or_map(changing, motion):
    from test_preprocessing import rectangular_pool_scan
    slam = LidarSlam()
    for i in range(40):
        truth = np.array([i*.012, i*.004, i*.001]) if motion else np.zeros(3)
        scan = scattered_arcs(rectangular_pool_scan(truth, i*.1, seed=i+400), i, changing)
        slam.update(scan)
        assert slam.diagnostics[-1]["ring_rejected"] == 0  # exercises short-arc path
    assert slam.accepted >= 35, slam.status
    assert np.linalg.norm(slam.pose[:2]-truth[:2]) < .06
    assert abs(wrap(slam.pose[2]-truth[2])) < .02
    assert np.min(np.linalg.norm(slam.reference, axis=1)) > 2.5
    yy, xx = np.indices(slam.grid.log_odds.shape)
    x = slam.grid.origin[0]+(xx+.5)*slam.grid.resolution
    y = slam.grid.origin[1]+(yy+.5)*slam.grid.resolution
    assert not np.any((slam.grid.log_odds > .7) & (x*x+y*y < 2.2**2))
    assert sum(d["temporal_withheld"] for d in slam.diagnostics) > 500
    assert np.count_nonzero(slam.grid.log_odds > .7) > 120


def test_only_short_fragments_cannot_start_a_map():
    slam = LidarSlam()
    for i in range(5):
        scan = scattered_arcs(room_scan(np.zeros(3), i*.1), i)
        valid = scan.ranges < 2.
        slam.update(replace(scan, valid=valid))
    assert slam.accepted == 0
    assert not slam.grid.observed.any()


def test_real_small_curved_object_can_enter_map_after_viewpoint_confirmation():
    slam = LidarSlam()
    centre, radius = np.array([2., 1.]), .35
    for i in range(40):
        pose = np.array([i*.03, 0, i*.001])
        scan = room_scan(pose, i*.1, seed=700+i)
        directions = np.column_stack((np.cos(scan.angles+pose[2]), np.sin(scan.angles+pose[2])))
        delta = centre-pose[:2]
        projection = directions@delta
        discriminant = projection**2 - (delta@delta-radius**2)
        distance = projection-np.sqrt(np.maximum(0., discriminant))
        hit = (discriminant >= 0) & (distance > 0) & (distance < scan.ranges)
        r = scan.ranges.copy()
        r[hit] = distance[hit]
        slam.update(replace(scan, ranges=r))
    assert slam.accepted >= 35
    assert np.linalg.norm(slam.pose[:2]-pose[:2]) < .06
    yy, xx = np.indices(slam.grid.log_odds.shape)
    x = slam.grid.origin[0]+(xx+.5)*slam.grid.resolution
    y = slam.grid.origin[1]+(yy+.5)*slam.grid.resolution
    near_surface = np.abs(np.hypot(x-centre[0], y-centre[1])-radius) < .12
    assert np.count_nonzero(near_surface & (slam.grid.log_odds > .7)) >= 3


def test_loss_clears_nonanchor_confirmation_without_erasing_map():
    slam = initialized_slam()
    world = np.array([[1., 1.]])
    slam.temporal_support.update(world, slam.pose, .7)
    before = slam.grid.log_odds.copy()
    scan = room_scan(np.zeros(3), .8)
    slam.update(replace(scan, valid=np.zeros(500, bool)))
    assert not slam.temporal_support.frames
    np.testing.assert_array_equal(before, slam.grid.log_odds)


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


def initialized_slam(config=None):
    slam = LidarSlam(config=config)
    for index in range(8):
        slam.update(room_scan(np.zeros(3), index*.1, seed=index))
    assert slam.status == "TRACKING"
    return slam


def empty_scan(timestamp):
    return Scan(timestamp, np.zeros(1), np.zeros(1), np.zeros(1), np.zeros(1, bool))


@pytest.mark.parametrize("explicit_bad_frames", [False, True])
def test_short_outage_requires_three_matches_before_publishing_pose_or_map(explicit_bad_frames):
    slam = initialized_slam()
    before_pose, before_map = slam.pose.copy(), slam.grid.log_odds.copy()
    before_observed, before_reference = slam.grid.observed.copy(), slam.reference.copy()
    origin, accepted = slam.origin_timestamp, slam.accepted
    if explicit_bad_frames:
        for t in (.8, 1.2, 1.7):
            slam.update(empty_scan(t))
    for i in range(3):
        truth = np.array([.45+.012*i, .10, .06+.002*i])
        estimate = slam.update(room_scan(truth, 2.2+.1*i, seed=610+i))
        if i < 2:
            assert slam.status.startswith("RECOVERING"), slam.status
            assert slam.confidence == 0
            assert slam.diagnostics[-1]["confidence"] == 0
            assert not slam.diagnostics[-1]["map_updated"]
            assert slam.last_accepted_timestamp == pytest.approx(.7)
            assert slam.accepted == accepted
            np.testing.assert_array_equal(estimate, before_pose)
            np.testing.assert_array_equal(slam.grid.log_odds, before_map)
            np.testing.assert_array_equal(slam.grid.observed, before_observed)
            np.testing.assert_array_equal(slam.reference, before_reference)
    assert slam.status == "TRACKING"
    assert slam.diagnostics[-1]["recovered"]
    assert slam.diagnostics[-1]["recovery_confirmations"] == 3
    assert slam.accepted == accepted+1  # Candidate scans are never backfilled.
    assert slam.origin_timestamp == origin
    assert np.linalg.norm(estimate[:2]-truth[:2]) < .03
    assert abs(wrap(estimate[2]-truth[2])) < .015
    np.testing.assert_array_equal(slam.velocity, np.zeros(3))


def test_bad_frame_breaks_recovery_confirmations():
    slam = initialized_slam()
    before = slam.grid.log_odds.copy()
    slam.update(empty_scan(.8))
    slam.update(room_scan(np.zeros(3), .9))
    assert slam.diagnostics[-1]["recovery_confirmations"] == 1
    slam.update(empty_scan(1.0))
    for t in (1.1, 1.2):
        slam.update(room_scan(np.zeros(3), t))
        assert not slam.diagnostics[-1]["accepted"]
        np.testing.assert_array_equal(slam.grid.log_odds, before)
    slam.update(room_scan(np.zeros(3), 1.3))
    assert slam.status == "TRACKING"


def test_provisional_matches_cannot_extend_recovery_deadline():
    slam = initialized_slam(SlamConfig(max_tracking_gap=1.0))
    before_map, before_pose = slam.grid.log_odds.copy(), slam.pose.copy()
    for t in (1.5, 1.6, 1.8, 1.9, 2.0):
        slam.update(room_scan(np.zeros(3), t))
        assert not slam.diagnostics[-1]["accepted"]
        np.testing.assert_array_equal(slam.grid.log_odds, before_map)
        np.testing.assert_array_equal(slam.pose, before_pose)
        assert slam.last_accepted_timestamp == pytest.approx(.7)
    assert "recovery timeout" in slam.status


def test_confirmation_frames_must_be_close_in_time():
    slam = initialized_slam()
    for t in (1.4, 1.8, 2.2):
        slam.update(room_scan(np.zeros(3), t))
        assert slam.diagnostics[-1]["recovery_confirmations"] == 1
        assert not slam.diagnostics[-1]["map_updated"]
    for t in (2.3, 2.4):
        slam.update(room_scan(np.zeros(3), t))
    assert slam.diagnostics[-1]["recovered"]


def test_inconsistent_candidate_motion_does_not_publish_a_recovery():
    slam = initialized_slam()
    before = slam.grid.log_odds.copy()
    slam.update(empty_scan(.8))
    slam.update(room_scan(np.zeros(3), 1.0))
    slam.update(room_scan(np.array([.55, 0, 0]), 1.1))
    assert not slam.diagnostics[-1]["accepted"]
    assert "inconsistent recovery motion" in slam.status
    np.testing.assert_array_equal(slam.grid.log_odds, before)
    for t in (1.2, 1.3):
        slam.update(room_scan(np.zeros(3), t))
        assert not slam.diagnostics[-1]["accepted"]
    slam.update(room_scan(np.zeros(3), 1.4))
    assert slam.diagnostics[-1]["recovered"]


def test_recovery_does_not_join_a_distant_scene():
    slam = initialized_slam()
    before, pose = slam.grid.log_odds.copy(), slam.pose.copy()
    for t in (1.4, 1.5, 1.6):
        slam.update(room_scan(np.array([2.5, 1.8, .8]), t))
        assert not slam.diagnostics[-1]["accepted"]
        np.testing.assert_array_equal(slam.grid.log_odds, before)
        np.testing.assert_array_equal(slam.pose, pose)


def test_concentric_ring_bursts_do_not_write_map_and_clean_features_can_return():
    slam = initialized_slam()
    before, pose = slam.grid.log_odds.copy(), slam.pose.copy()
    a = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    for i, radius in enumerate((1.2, 1.8, 2.4, 1.2)):
        slam.update(Scan(.8+.1*i, a, np.full(500, radius), np.ones(500), np.ones(500, bool)))
        assert not slam.diagnostics[-1]["accepted"]
        np.testing.assert_array_equal(slam.grid.log_odds, before)
        np.testing.assert_array_equal(slam.pose, pose)
    for t in (1.2, 1.3, 1.4):
        slam.update(room_scan(np.array([.05, .02, .01]), t))
    assert slam.diagnostics[-1]["recovered"]


def test_recovery_does_not_reuse_stale_velocity_for_deskew():
    slam = LidarSlam()
    for i in range(8):
        slam.update(room_scan(np.array([i*.01, 0, 0]), i*.1))
    assert np.linalg.norm(slam.velocity) > .05
    for t in (1.8, 1.9, 2.0):
        scan = room_scan(np.array([.1, 0, 0]), t)
        slam.update(replace(scan, time_offsets=np.linspace(-.1, 0, len(scan.angles))))
        assert slam.diagnostics[-1]["deskew"] == "suspended_recovery"
    assert slam.diagnostics[-1]["recovered"]
    assert np.linalg.norm(slam.pose[:2]-[.1, 0]) < .03


def test_transient_ring_arcs_mixed_with_real_features_do_not_become_obstacles():
    slam = initialized_slam()
    for i, radius in enumerate((1.2, 1.2, 1.8, 1.8, 2.4, 2.4)):
        scan = room_scan(np.zeros(3), .8+.1*i, seed=800+i)
        ranges = scan.ranges.copy()
        ranges[np.abs(scan.angles) < .65] = radius
        slam.update(replace(scan, ranges=ranges))
    for i in range(5):
        slam.update(room_scan(np.zeros(3), 1.4+.1*i, seed=810+i))
    yy, xx = np.indices(slam.grid.log_odds.shape)
    x = slam.grid.origin[0]+(xx+.5)*slam.grid.resolution
    y = slam.grid.origin[1]+(yy+.5)*slam.grid.resolution
    # This analytic room has no obstacle within 2.6 m of its origin.
    assert not np.any((x*x+y*y < 2.6**2) & (slam.grid.log_odds > .7))
    assert slam.status == "TRACKING"
    assert np.linalg.norm(slam.pose[:2]) < .04


def test_outage_discards_pending_hit_support_without_erasing_existing_map():
    slam = initialized_slam()
    point = np.array([[1.05, .05]])
    for _ in range(2):
        slam.grid.update(point, [0, 0, 0])
    x, y = slam.grid.cells(point)[0]
    assert slam.grid.hit_support[y, x] == 2
    before, observed = slam.grid.log_odds.copy(), slam.grid.observed.copy()
    slam.update(empty_scan(.8))
    np.testing.assert_array_equal(slam.grid.log_odds, before)
    np.testing.assert_array_equal(slam.grid.observed, observed)
    assert slam.grid.hit_support[y, x] == 0
    slam.grid.update(point, [0, 0, 0])
    assert slam.grid.hit_support[y, x] == 1
    assert cell_value(slam.grid, point[0]) == before[y, x]


@pytest.mark.parametrize("values", [
    {"max_tracking_gap": 0}, {"max_tracking_gap": float("nan")},
    {"recovery_frame_gap": -1}, {"recovery_frame_gap": float("inf")},
    {"recovery_confirmations": 1}, {"recovery_confirmations": 2.5},
    {"recovery_confirmations": True},
])
def test_invalid_recovery_configuration_is_rejected(values):
    with pytest.raises(ValueError):
        SlamConfig(**values)


def test_default_five_second_window_can_resume_after_four_second_outage():
    slam = initialized_slam()
    assert slam.config.max_tracking_gap == 5
    before = slam.grid.log_odds.copy()
    for i, t in enumerate((4.7, 4.8, 4.9)):
        slam.update(room_scan(np.array([.2, .05, .03]), t))
        if i < 2:
            assert not slam.diagnostics[-1]["accepted"]
            np.testing.assert_array_equal(slam.grid.log_odds, before)
    assert slam.diagnostics[-1]["recovered"]
    assert np.linalg.norm(slam.pose[:2]-[.2, .05]) < .03


def test_default_recovery_still_expires_after_five_seconds():
    slam = initialized_slam()
    before = slam.grid.log_odds.copy()
    for t in (5.8, 5.9, 6.0):
        slam.update(room_scan(np.zeros(3), t))
        assert "recovery timeout" in slam.status
        assert not slam.diagnostics[-1]["accepted"]
        np.testing.assert_array_equal(slam.grid.log_odds, before)


def test_rings_cannot_seed_the_initial_reference_in_pool_mode():
    slam = LidarSlam()
    a = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    for i in range(4):
        slam.update(Scan(i*.1, a, np.full(500, 1.5), np.ones(500), np.ones(500, bool)))
        assert slam.tree is None
        assert not slam.grid.observed.any()
        assert slam.diagnostics[-1]["ring_rejected"] == 500
    for i in range(4, 10):
        slam.update(room_scan(np.zeros(3), i*.1))
    assert slam.status == "TRACKING"


def test_persistent_mixed_ring_from_startup_is_excluded_from_map_and_reference():
    slam = LidarSlam()
    for i in range(60):
        truth = np.array([.008*i, .08*np.sin(.03*i), .002*i])
        scan = room_scan(truth, i*.1, seed=1200+i)
        r = scan.ranges.copy()
        arc = np.abs(scan.angles) < 1.2
        r[arc] = 1.5+.12*np.sin(.3*i)+np.random.default_rng(1300+i).normal(0, .006, arc.sum())
        slam.update(replace(scan, ranges=r))
        assert slam.diagnostics[-1]["ring_rejected"] == int(np.count_nonzero(arc & scan.valid))
    assert slam.accepted >= 55, slam.status
    assert np.linalg.norm(slam.pose[:2]-truth[:2]) < .08
    yy, xx = np.indices(slam.grid.log_odds.shape)
    x = slam.grid.origin[0]+(xx+.5)*slam.grid.resolution
    y = slam.grid.origin[1]+(yy+.5)*slam.grid.resolution
    assert not np.any((x*x+y*y < 2.6**2) & (slam.grid.log_odds > .7))
    assert np.min(np.linalg.norm(slam.reference, axis=1)) > 2.6


def test_filtered_far_ring_cannot_clear_existing_walls():
    slam = initialized_slam()
    before, observed = slam.grid.log_odds.copy(), slam.grid.observed.copy()
    reference = slam.reference.copy()
    a = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    slam.update(Scan(.8, a, np.full(500, 10.), np.ones(500), np.ones(500, bool)))
    assert slam.diagnostics[-1]["ring_rejected"] == 500
    assert not slam.diagnostics[-1]["map_updated"]
    np.testing.assert_array_equal(slam.grid.log_odds, before)
    np.testing.assert_array_equal(slam.grid.observed, observed)
    np.testing.assert_array_equal(slam.reference, reference)
