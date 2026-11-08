"""State-transition regressions; synthetic observations, not field validation."""
from dataclasses import replace
import numpy as np
import pytest
from localization import MapLocalizer, PriorMap
from localization.matcher import Metrics, Result
from test_localization import write_map, make_scan


@pytest.fixture
def tracked(tmp_path):
    loc = MapLocalizer(PriorMap(write_map(tmp_path)))
    loc.set_initial_pose(.5, -.8, .2)
    assert loc.update_scan(make_scan(.5, -.8, .2, timestamp=1.)).valid
    return loc


def good(pose):
    return Result(np.array(pose), 'tracking', '',
                  Metrics(rmse=.03, inlier=.95, coverage=1., matched=200,
                          points=210, confidence=.95), False)


def test_fallback_cannot_bypass_motion_bound(tracked, monkeypatch):
    before = tracked.pose.copy()
    monkeypatch.setattr(tracked, 'refine', lambda *args: good(before+[3., 0, 0]))
    result = tracked.update_scan(make_scan(.5, -.8, .2, timestamp=1.1))
    assert not result.valid
    np.testing.assert_array_equal(tracked.pose, before)


def test_prediction_cannot_move_the_motion_gate(tracked, monkeypatch):
    before = tracked.pose.copy()
    tracked.velocity[:] = [2., 0, 0]
    monkeypatch.setattr(tracked, 'refine', lambda *args: good(before+[.5, 0, 0]))
    assert not tracked.update_scan(make_scan(.5, -.8, .2, timestamp=1.1)).valid


def test_lost_frame_clears_velocity_and_recovery_uses_accepted_interval(tracked, monkeypatch):
    before = tracked.pose.copy()
    tracked.velocity[:] = [1., 0, .2]
    scan = make_scan(.5, -.8, .2, timestamp=1.1)
    assert not tracked.update_scan(replace(scan, valid=np.zeros(len(scan.valid), bool))).valid
    np.testing.assert_array_equal(tracked.velocity, np.zeros(3))
    monkeypatch.setattr(tracked, 'refine', lambda *args: good(before+[.2, 0, 0]))
    assert tracked.update_scan(replace(scan, timestamp=1.2)).valid
    assert tracked.velocity[0] == pytest.approx(1.*(1-tracked.config.velocity_decay))


@pytest.mark.parametrize('timestamp', [1., .9])
def test_reordered_scan_does_not_change_tracking_state(tracked, timestamp):
    before = tracked.pose.copy()
    frames = tracked.frames
    with pytest.raises(ValueError, match='timestamp'):
        tracked.update_scan(make_scan(.5, -.8, .2, timestamp=timestamp))
    np.testing.assert_array_equal(tracked.pose, before)
    assert tracked.frames == frames and tracked.last_timestamp == 1.


def test_manual_reseed_does_not_inherit_tracking_timeout(tracked):
    tracked.set_initial_pose(1., -1., .3)
    result = tracked.update_scan(make_scan(1., -1., .3, timestamp=100.))
    assert result.valid
    np.testing.assert_array_equal(tracked.velocity, np.zeros(3))


@pytest.mark.parametrize('rmse', [None, float('nan'), float('inf')])
def test_nonfinite_match_is_never_accepted(tracked, rmse):
    result = good(tracked.pose)
    result.metrics.rmse = rmse
    assert not tracked._acceptable(result)


def test_invalid_manual_seed_does_not_destroy_last_pose(tracked):
    before = tracked.pose.copy()
    with pytest.raises(ValueError):
        tracked.set_initial_pose(float('nan'), 0., 0.)
    np.testing.assert_array_equal(tracked.pose, before)


@pytest.mark.parametrize('rmse', [.2, float('inf')])
def test_global_candidate_must_pass_residual_gate(tracked, monkeypatch, rmse):
    from localization.matcher import Candidate
    candidate = Candidate(tracked.pose.copy(), .95, .95, rmse, 200, 1.)
    tracked.clear_pose()
    monkeypatch.setattr(tracked, 'global_search', lambda *args: [candidate])
    assert not tracked.update_scan(make_scan(.5, -.8, .2, timestamp=2.)).valid


def test_noisy_motion_and_dropouts_preserve_prior_and_recover(tracked):
    original_map = tracked.map.dist.copy()
    rng = np.random.default_rng(812)
    accepted, errors = 0, []
    for i in range(1, 21):
        truth = np.array([.5+i*.015, -.8+i*.005, .2+i*.002])
        scan = make_scan(*truth, timestamp=1.+i*.1)
        ranges = scan.ranges + rng.normal(0, .012, len(scan.ranges))
        scan = replace(scan, ranges=ranges)
        if i in (6, 7):
            before = tracked.pose.copy()
            result = tracked.update_scan(replace(scan, valid=np.zeros(len(scan.valid), bool)))
            assert not result.valid
            np.testing.assert_array_equal(result.pose, before)
        else:
            result = tracked.update_scan(scan)
            accepted += result.valid
            if result.valid:
                errors.append(np.linalg.norm(result.pose[:2]-truth[:2]))
    assert accepted >= 17
    assert max(errors) < .25
    assert result.valid
    np.testing.assert_array_equal(tracked.map.dist, original_map)
