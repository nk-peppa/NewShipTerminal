"""Observation-contract and motion-compensation checks, with analytic geometry."""
import json
import numpy as np
import pytest
from scipy.spatial import cKDTree

from cocommand2d.scan import Scan
from cocommand2d.slam.preprocessing import prepare_scan


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
