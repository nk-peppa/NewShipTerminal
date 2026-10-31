"""Observation-contract and motion-compensation checks, with analytic geometry."""
import json
import numpy as np
import pytest
from scipy.spatial import cKDTree

from cocommand2d.scan import Scan
from cocommand2d.slam.preprocessing import prepare_scan, water_ring_mask


def scan_points(points, **kwargs):
    points = np.asarray(points)
    n = len(points)
    return Scan(1., np.arctan2(points[:, 1], points[:, 0]),
                np.linalg.norm(points, axis=1), np.ones(n), np.ones(n, bool), **kwargs)


def test_optional_observations_roundtrip_copied_and_order_preserved():
    # Nonmonotonic offsets are valid when a driver sorted beams by angle.
    offsets = np.array([-.02, -.1, 0.])
    scan = scan_points([[2, 0], [2, .1], [2, .2]], time_offsets=offsets,
                       roll=[0, .01, .02], pitch=[.02, .01, 0])
    offsets[0] = -.2
    restored = Scan.from_dict(json.loads(json.dumps(scan.to_dict(), allow_nan=False)))
    np.testing.assert_equal(restored.time_offsets, [-.02, -.1, 0.])
    for field in ("time_offsets", "roll", "pitch"):
        np.testing.assert_equal(getattr(scan, field), getattr(restored, field))
        assert not getattr(restored, field).flags.writeable
    assert not {"roll", "pitch", "time_offsets"} & scan_points([[1, 0]]).to_dict().keys()


@pytest.mark.parametrize("extra", [
    {"time_offsets": [.001]}, {"time_offsets": [-.251]},
    {"time_offsets": [np.nan]}, {"time_offsets": [0, 0]},
    {"roll": [0]}, {"roll": [0], "pitch": [2]},
    {"roll": [np.inf], "pitch": [0]},
])
def test_bad_optional_observations_rejected(extra):
    with pytest.raises(ValueError):
        scan_points([[1, 0]], **extra)


def test_degree_angles_and_string_validity_rejected_at_boundary():
    with pytest.raises(ValueError, match="radians"):
        Scan(0, [90], [1], [1], [True])
    with pytest.raises(ValueError, match="booleans"):
        Scan(0, [0], [1], [1], ["false"])
    # Invalid placeholder angles do not participate in estimation.
    assert not Scan(0, np.arange(500), np.zeros(500), np.zeros(500),
                    np.zeros(500, bool)).valid.any()


def test_constant_twist_deskew_recovers_wall_and_each_ray_origin():
    n = 81
    target = np.column_stack((np.full(n, 4.), np.linspace(-1., 1., n)))
    offsets = np.linspace(-.1, 0., n)[np.random.default_rng(15).permutation(n)]
    vx, vy, w = velocity = np.array([1.2, .3, .8])
    phi = offsets*w
    origins = np.column_stack((vx*np.sin(phi)/w-vy*(1-np.cos(phi))/w,
                               vx*(1-np.cos(phi))/w+vy*np.sin(phi)/w))
    shifted = target-origins
    measured = np.column_stack((np.cos(phi)*shifted[:, 0]+np.sin(phi)*shifted[:, 1],
                                -np.sin(phi)*shifted[:, 0]+np.cos(phi)*shifted[:, 1]))
    scan = scan_points(measured, time_offsets=offsets)
    corrected, ray_origins, _, meta = prepare_scan(scan, velocity)
    distance, ids = cKDTree(target).query(corrected)
    assert max(distance) < 1e-12
    np.testing.assert_allclose(ray_origins, origins[ids], atol=1e-12)
    assert meta["deskew"] == "constant_twist"
    uncorrected, _, _, meta = prepare_scan(scan_points(measured), velocity)
    assert np.std(uncorrected[:, 0]) > .02
    assert meta["deskew"] == "missing_timing"


def test_attitude_projection_recovers_vertical_wall_horizontal_position():
    angles = np.linspace(-.5, .5, 121)
    roll, pitch = .05, .08
    direction_x = np.cos(pitch)*np.cos(angles) + np.sin(pitch)*np.sin(roll)*np.sin(angles)
    ranges = 4 / direction_x  # intersection with the vertical plane x == 4
    scan = Scan(1, angles, ranges, np.ones(121), np.ones(121, bool),
                roll=np.full(121, roll), pitch=np.full(121, pitch))
    corrected, origins, weights, meta = prepare_scan(scan, np.zeros(3), max_height=1.)
    np.testing.assert_allclose(corrected[:, 0], 4., atol=1e-12)
    np.testing.assert_equal(origins, np.zeros_like(origins))
    assert np.all((weights > 0) & (weights <= 1))
    assert meta["tilt"] == "projected"


@pytest.mark.parametrize("pitch,height", [(.25, 3.), (.2, .35)])
def test_tilt_or_off_plane_returns_are_rejected(pitch, height):
    points = np.column_stack((np.full(21, 4.), np.linspace(-.5, .5, 21)))
    scan = scan_points(points, roll=np.zeros(21), pitch=np.full(21, pitch))
    retained, origins, weights, meta = prepare_scan(scan, np.zeros(3), max_height=height)
    assert retained.shape == origins.shape == (0, 2)
    assert weights.shape == (0,)
    assert meta["tilt_rejected"] == 21


def test_isolated_return_removed_but_far_c1_spacing_retained():
    wall = np.column_stack((np.full(31, 2.), np.linspace(-.6, .6, 31)))
    scan = scan_points(np.vstack((wall, [-5, 0])))
    points, _, _, meta = prepare_scan(scan, np.zeros(3))
    assert meta["isolated_rejected"] == 1
    assert np.all(points[:, 0] == pytest.approx(2.))
    angles = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    far = Scan(0, angles, np.full(500, 12.), np.ones(500), np.ones(500, bool))
    assert len(prepare_scan(far, np.zeros(3))[0]) == 500


def test_quality_magnitude_is_not_interpreted_as_calibrated_intensity():
    points = np.column_stack((np.full(31, 2.), np.linspace(-.6, .6, 31)))
    a = scan_points(points).to_dict()
    a["quality"] = [0.] * 31
    unspecified = Scan.from_dict(a)
    assert len(prepare_scan(unspecified, np.zeros(3))[0]) > 0
    a["source"] = "c1-sdk"
    assert len(prepare_scan(Scan.from_dict(a), np.zeros(3))[0]) == 0


@pytest.mark.parametrize("radius", [.7, 1.5, 3., 5., 10.])
def test_pool_mode_rejects_broad_sensor_centred_rings(radius):
    a = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    r = radius+np.random.default_rng(77).normal(0, .01, 500)
    rejected, count = water_ring_mask(a, r)
    assert rejected.sum() >= 495
    assert count > 0
    scan = Scan(0, a, r, np.ones(500), np.ones(500, bool))
    points, origins, weights, meta = prepare_scan(scan, np.zeros(3), water_ring_filter=True)
    assert len(points) < 5
    assert len(points) == len(origins) == len(weights)
    assert meta["ring_rejected"] == int(rejected.sum())
    assert meta["input_points"] == 500


def rectangular_pool_scan(pose, timestamp=0, seed=81):
    """Analytic 8 m by 6 m pool; truth is only used to generate observations."""
    a = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    dx, dy = np.cos(a+pose[2]), np.sin(a+pose[2])
    with np.errstate(divide="ignore"):
        xhit = (np.where(dx >= 0, 4., -4.)-pose[0])/dx
        yhit = (np.where(dy >= 0, 3., -3.)-pose[1])/dy
    r = np.minimum(xhit, yhit)+np.random.default_rng(seed).normal(0, .006, len(a))
    return Scan(timestamp, a, r, np.ones(500), np.ones(500, bool))


def joined_pool_scan(pose, timestamp=0, seed=81, scale=1.):
    """Example union of 20x9 m and 12x6 m rectangles, not a surveyed real pool."""
    vertices = scale*np.array([[0, 0], [20, 0], [20, 9], [12, 9], [12, 15], [0, 15]])
    edges = np.roll(vertices, -1, axis=0)-vertices
    angles = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    d = np.column_stack((np.cos(angles+pose[2]), np.sin(angles+pose[2])))
    delta = vertices-np.asarray(pose[:2])
    cross = lambda a, b: a[..., 0]*b[..., 1]-a[..., 1]*b[..., 0]
    divisor = cross(d[:, None], edges)
    with np.errstate(divide="ignore", invalid="ignore"):
        distance = cross(delta, edges)/divisor
        fraction = cross(delta, d[:, None])/divisor
    hits = (np.abs(divisor) > 1e-10) & (distance > 0) & (fraction >= 0) & (fraction <= 1)
    r = np.min(np.where(hits, distance, np.inf), axis=1)
    valid = np.isfinite(r) & (r <= 12)
    r[valid] += np.random.default_rng(seed).normal(0, .006, valid.sum())
    return Scan(timestamp, angles, r, np.ones(500), valid)


@pytest.mark.parametrize("pose", [[5, 5, 0], [10, 5, .5], [10, 9, -.5],
                                  [10, 12, .1], [3, 12, .8], [18, 6, -.2]])
def test_large_joined_pool_walls_and_concave_corner_are_not_rings(pose):
    for scale in (1., 1.5, 2.):  # 20x15, 30x22.5 and 40x30 m example envelopes
        scaled_pose = np.array(pose)*[scale, scale, 1.]
        scan = joined_pool_scan(scaled_pose, scale=scale)
        assert scan.valid.sum() >= 30
        rejected, _ = water_ring_mask(scan.angles[scan.valid], scan.ranges[scan.valid])
        assert not rejected.any()


def test_scan_matching_uses_real_features_beyond_four_metres_in_large_pool():
    from cocommand2d.slam import LidarSlam
    slam = LidarSlam()
    initial = np.array([5., 5., 0.])
    for i in range(20):
        pose = initial + [i*.01, i*.005, i*.001]
        scan = joined_pool_scan(pose, i*.1, seed=1400+i)
        assert np.min(scan.ranges[scan.valid]) > 4
        slam.update(scan)
        assert slam.diagnostics[-1]["ring_rejected"] == 0
    assert slam.accepted >= 17
    assert np.linalg.norm(slam.pose[:2]-(pose[:2]-initial[:2])) < .04


@pytest.mark.parametrize("pose", [[0, 0, 0], [3.7, 0, .3], [3.5, 2.5, -.4], [-1, .5, 1.]])
def test_pool_filter_preserves_straight_walls_and_corners(pose):
    scan = rectangular_pool_scan(pose)
    rejected, _ = water_ring_mask(scan.angles, scan.ranges)
    assert not rejected.any()


def test_mixed_arc_and_wall_preserves_beam_association_after_angle_sorting():
    scan = rectangular_pool_scan([0, 0, 0])
    a, r = scan.angles, scan.ranges.copy()
    arc = np.abs(a) > 2.0  # crosses the -pi/pi cut
    r[arc] = 1.5+np.random.default_rng(91).normal(0, .006, arc.sum())
    order = np.random.default_rng(92).permutation(len(a))
    rejected, _ = water_ring_mask(a[order], r[order])
    np.testing.assert_array_equal(rejected, arc[order])
    offsets = np.linspace(-.1, 0, len(a))[order]
    mixed = Scan(1, a[order], r[order], np.ones(500), np.ones(500, bool), time_offsets=offsets)
    filtered = Scan(1, a[order][~rejected], r[order][~rejected], np.ones((~rejected).sum()),
                    np.ones((~rejected).sum(), bool), time_offsets=offsets[~rejected])
    p, o, w, _ = prepare_scan(mixed, [1, .2, .3], water_ring_filter=True)
    expected_p, expected_o, expected_w, _ = prepare_scan(filtered, [1, .2, .3])
    np.testing.assert_allclose(p, expected_p)
    np.testing.assert_allclose(o, expected_o)
    np.testing.assert_allclose(w, expected_w)


def test_multiple_rings_are_filtered_without_interpreting_quality_as_reflectivity():
    a = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    r = np.where(np.arange(500) % 2, 1.2, 2.3)
    scan = Scan(0, a, r, np.full(500, 60.), np.ones(500, bool))
    p, _, _, meta = prepare_scan(scan, np.zeros(3), water_ring_filter=True)
    assert len(p) == 0
    assert meta["ring_rejected"] == 500
    assert meta["ring_candidates"] == 2


def test_short_arcs_and_duplicate_bearings_are_not_sufficient_for_ring_rejection():
    a = np.linspace(-.35, .35, 100)
    assert not water_ring_mask(a, np.full(100, 1.5))[0].any()
    a = np.repeat(np.array([0., 1., 2., 3.]), 100)
    assert not water_ring_mask(a, np.full(400, 1.5))[0].any()


def test_genuine_circular_structure_can_be_preserved_by_disabling_pool_prior():
    a = np.linspace(-np.pi, np.pi, 500, endpoint=False)
    scan = Scan(0, a, np.full(500, 4.), np.ones(500), np.ones(500, bool))
    p, _, _, meta = prepare_scan(scan, np.zeros(3), water_ring_filter=False)
    assert len(p) > 300
    assert meta["ring_rejected"] == 0


@pytest.mark.parametrize("pose", [[0, 0, 0], [3.5, 2.5, -.4], [-1, .5, 1.]])
def test_extended_line_anchors_keep_pool_walls_without_fixed_orientation(pose):
    from cocommand2d.slam.preprocessing import line_support
    points = prepare_scan(rectangular_pool_scan(pose), np.zeros(3))[0]
    assert line_support(points).mean() > .85


def test_short_nonconstant_radius_fragments_are_not_pose_anchors():
    from cocommand2d.slam.preprocessing import line_support
    angle = np.linspace(-.17, .17, 28)
    pieces = []
    for direction in (-2.4, -.9, .7, 2.1):
        r = 1.3+.12*np.sin(6*angle)+.015*np.cos(30*angle)
        pieces.append(np.column_stack((r*np.cos(angle+direction), r*np.sin(angle+direction))))
    noise = np.concatenate(pieces)
    wall = np.column_stack((np.full(40, 5.), np.linspace(-2, 2, 40)))
    points = np.concatenate((noise, wall))
    order = np.random.default_rng(52).permutation(len(points))
    supported = line_support(points[order])
    assert not supported[order < len(noise)].any()
    assert supported[order >= len(noise)].all()


def test_nonanchor_evidence_requires_distinct_scans_and_changed_viewpoint():
    from cocommand2d.slam.preprocessing import TemporalSupport
    gate = TemporalSupport()
    point = np.array([[2., 1.]])
    # Even a long stationary sequence does not validate sensor-fixed clutter.
    for i in range(20):
        assert not gate.update(np.repeat(point, 20, axis=0), np.zeros(3), i*.1).any()
    assert gate.update(point, np.array([.3, 0, 0]), 2.).all()
    gate.clear()
    assert not gate.update(point, np.array([.6, 0, 0]), 2.1).any()
    assert not gate.update(point, np.array([.9, 0, 0]), 2.2).any()
    assert gate.update(point, np.array([1.2, 0, 0]), 2.3).all()
    # Old observations cannot accumulate across an acquisition gap.
    assert not gate.update(point, np.array([1.5, 0, 0]), 5.).any()


def test_temporal_evidence_is_checked_in_world_coordinates():
    from cocommand2d.slam.preprocessing import TemporalSupport
    from cocommand2d.scan import transform
    stable, moving = TemporalSupport(), TemporalSupport()
    fixed_world = np.array([[2., 1.], [2.05, 1.02]])
    fixed_sensor = fixed_world.copy()
    for i in range(4):
        pose = np.array([i*.15, 0, 0])
        actual = stable.update(fixed_world, pose, i*.1)
        artifact = moving.update(transform(fixed_sensor, pose), pose, i*.1)
    assert actual.all()
    assert not artifact.any()
