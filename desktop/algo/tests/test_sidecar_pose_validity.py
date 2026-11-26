"""Bridge contract tests isolate emitted validity from algorithm status wording."""
import importlib.util
from pathlib import Path
import numpy as np
import pytest


@pytest.mark.parametrize('status,accepted', [
    ('INITIALIZING: 1/3 consistent scans', False),
    ('RECOVERING: confirming 1/3', False),
    ('LOST: too few reliable returns', False),
    ('DEGENERATE: weak geometry', False),
    ('TRACKING', True),
])
def test_sidecar_uses_current_acceptance_and_emits_nothing_for_skipped_scan(monkeypatch, status, accepted):
    path = Path(__file__).resolve().parents[2]/'tools/algo-sidecar.py'
    spec = importlib.util.spec_from_file_location('sidecar_contract', path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    events = []
    monkeypatch.setattr(bridge, 'emit', events.append)
    slam = bridge.STATE.slam
    def update(scan):
        slam.status = status
        slam.diagnostics.append(dict(accepted=accepted))
        return np.zeros(3)
    monkeypatch.setattr(slam, 'update', update)
    bridge.handle_scan(dict(t=100, angles=np.linspace(0, 6, 20).tolist(), ranges=[1.]*20, qualities=[63]*20))
    poses = [e for e in events if e['type']=='pose']
    assert len(poses)==1 and poses[0]['poseValid'] is accepted
    assert poses[0]['status']==status
    previous = list(events)
    bridge.handle_scan(dict(t=200, angles=[], ranges=[], qualities=[]))
    assert events==previous  # Never emit a stale diagnostic entry after skipping.
