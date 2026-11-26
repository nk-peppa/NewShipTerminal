"""Recovery and unobservable motion regressions; synthetic, not sea trials."""
import numpy as np
import pytest
from test_robust_slam import initialized_slam, room_scan, empty_scan
from cocommand2d.scan import Scan
from cocommand2d.slam import SlamConfig


def test_recovery_finds_motion_beyond_old_point_eight_metre_gate():
    slam = initialized_slam()
    truth = np.array([1.2, .2, .08])
    for i in range(3):
        slam.update(room_scan(truth, 10+.1*i))
    assert slam.diagnostics[-1]['recovered'], slam.status
    assert np.linalg.norm(slam.pose[:2]-truth[:2]) < .08


def test_unobservable_parallel_walls_do_not_mean_stationary():
    slam = initialized_slam()
    before = slam.grid.log_odds.copy()
    x = np.linspace(-8, 8, 240)
    points = np.vstack([np.column_stack((x, np.full_like(x, y))) for y in (-3., 9.)])
    angles = np.arctan2(points[:, 1], points[:, 0])
    ranges = np.linalg.norm(points, axis=1)
    for i in range(8):
        slam.update(Scan(1+i*.1, angles, ranges, np.ones(len(x)*2), ranges<=12))
        assert not slam.diagnostics[-1]['pose_valid'], slam.status
        assert not slam.diagnostics[-1]['motion_observable']
        np.testing.assert_array_equal(slam.grid.log_odds, before)


def test_periodic_attempts_remain_recoverable_and_confirmations_are_not_throttled():
    slam = initialized_slam()
    # Too few points cannot permanently disable later recovery.
    for t in (40., 41., 42.):
        slam.update(empty_scan(t))
    for i in range(3):
        slam.update(room_scan(np.array([.2, 0, 0]), 43+i*.1))
    assert slam.diagnostics[-1]['recovered'], slam.status


@pytest.mark.parametrize('options', [dict(recovery_retry_interval=0),
    dict(recovery_search_radius=float('nan')), dict(recovery_search_radius=-1)])
def test_invalid_search_configuration(options):
    with pytest.raises(ValueError):
        SlamConfig(**options)


def test_discarded_direct_match_cannot_publish_good_quality(monkeypatch):
    slam = initialized_slam()
    monkeypatch.setattr(slam, '_match', lambda *a, **kw:
        (np.zeros(3), 'TRACKING', dict(rmse=.001, inlier_ratio=.99, confidence=.99, overlap_ratio=.99)))
    monkeypatch.setattr(slam, '_local_search', lambda *a, **kw: None)
    pose, status, stats = slam._confirm_recovery(np.zeros((60, 2)), np.ones(60), 10., 9.3)
    assert pose is None and status.startswith('LOST')
    assert stats == dict(rmse=None, inlier_ratio=0., confidence=0.)
