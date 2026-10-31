"""Condition lidar observations without estimating attitude or inventing timing.

Optional roll/pitch are synchronized sensor-attitude observations in radians:
right-handed roll about x and pitch about y, with the same x-forward/y-left/z-up
axes as Scan. The horizontal projection is R_y(pitch) @ R_x(roll). This cannot
recover surfaces missed by a tilted 2D scan, or infer vertical translation.
"""
import numpy as np
from scipy.spatial import cKDTree


def prepare_scan(scan, velocity, *, max_tilt=.21, max_height=.35, deskew=True):
    """Return points, ray origins, weights, diagnostics in scan-end coordinates.

    ``velocity`` is a constant body twist [vx, vy, yaw_rate], in m/s and rad/s,
    estimated from previously accepted scans. Acquisition offsets must have
    been supplied by the caller; angle order is never treated as time order.
    Ray origins follow the same SE(2) motion as endpoints for grid updates.
    """
    velocity = np.asarray(velocity, dtype=float)
    if velocity.shape != (3,) or not np.isfinite(velocity).all():
        raise ValueError("Deskew velocity must be a finite body twist [vx, vy, yaw_rate]")
    if not np.isfinite(max_tilt) or not 0 < max_tilt <= np.pi / 2:
        raise ValueError("max_tilt must be radians in (0, pi/2]")
    if not np.isfinite(max_height) or max_height <= 0:
        raise ValueError("max_height must be positive metres")

    valid = scan.valid.copy()
    # SDK quality is not calibrated intensity. Only its invalid-zero convention
    # is used; returns from other sources may legitimately have quality == 0.
    if str(scan.source).lower().startswith("c1"):
        valid &= scan.quality > 0
    ids = np.flatnonzero(valid)
    ranges = scan.ranges[ids]
    angles = scan.angles[ids]
    points = np.column_stack((ranges*np.cos(angles), ranges*np.sin(angles)))
    weights = 1 / (1 + (ranges / 10)**2)
    metadata = {
        "input_points": int(len(ids)), "retained_points": 0,
        "deskew": "disabled" if not deskew else (
            "missing_timing" if scan.time_offsets is None else "constant_twist"),
        "tilt": "unavailable" if scan.roll is None else "projected",
        "tilt_rejected": 0, "isolated_rejected": 0,
    }

    if scan.roll is not None:
        roll, pitch = scan.roll[ids], scan.pitch[ids]
        cr, sr, cp, sp = np.cos(roll), np.sin(roll), np.cos(pitch), np.sin(pitch)
        x, y = points[:, 0].copy(), points[:, 1].copy()
        height = -sp*x + cp*sr*y
        tilt = np.arccos(np.clip(cp*cr, -1, 1))
        keep = (tilt <= max_tilt) & (np.abs(height) <= max_height)
        metadata["tilt_rejected"] = int(np.count_nonzero(~keep))
        points = np.column_stack((cp*x + sp*sr*y, cr*y))[keep]
        weights = (weights*np.cos(tilt)**2)[keep]
        ids, ranges = ids[keep], ranges[keep]

    origins = np.zeros_like(points)
    if deskew and scan.time_offsets is not None:
        offsets = scan.time_offsets[ids]
        angle = velocity[2]*offsets
        c, s = np.cos(angle), np.sin(angle)
        # SE(2) exponential, stable at zero angular rate. np.sinc uses pi*x.
        a = offsets*np.sinc(angle/np.pi)
        b = offsets*np.sinc(angle/(2*np.pi))*np.sin(angle/2)
        origins = np.column_stack((a*velocity[0]-b*velocity[1],
                                   b*velocity[0]+a*velocity[1]))
        x, y = points[:, 0].copy(), points[:, 1].copy()
        points = np.column_stack((c*x-s*y, s*x+c*y)) + origins

    # Require two independent neighboring samples. Radius grows with range so
    # nominal 0.72-degree C1 sampling at 12 m is not rejected as isolated noise.
    if len(points) >= 3:
        distance = cKDTree(points).query(points, k=3)[0][:, 2]
        keep = distance <= np.clip(.10 + .025*ranges, .10, .45)
    else:
        keep = np.zeros(len(points), dtype=bool)
    metadata["isolated_rejected"] = int(np.count_nonzero(~keep))
    points, origins, weights = points[keep], origins[keep], weights[keep]
    if len(points):
        _, selected = np.unique(np.floor(points/.06).astype(np.int64),
                                axis=0, return_index=True)
        selected = np.sort(selected)
        points, origins, weights = points[selected], origins[selected], weights[selected]
    metadata["retained_points"] = int(len(points))
    return points, origins, weights, metadata
