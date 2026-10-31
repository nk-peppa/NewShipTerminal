"""Condition lidar observations without estimating attitude or inventing timing.

Optional roll/pitch are synchronized sensor-attitude observations in radians:
right-handed roll about x and pitch about y, with the same x-forward/y-left/z-up
axes as Scan. The horizontal projection is R_y(pitch) @ R_x(roll). This cannot
recover surfaces missed by a tilted 2D scan, or infer vertical translation.
"""
import numpy as np
from scipy.spatial import cKDTree
from collections import deque


def line_support(points):
    """Connected, extended line segments for the straight-edged pool preset.

    Split at range/angle gaps and at geometric corners. Short curved clusters
    must not become pose anchors just because their nearest eight points look
    planar. This is a pool prior, not a classifier of water or real objects.
    The returned mask retains the original point/ray correspondence.
    """
    supported = np.zeros(len(points), dtype=bool)
    if len(points) < 6:
        return supported
    angle = np.mod(np.arctan2(points[:, 1], points[:, 0]), 2*np.pi)
    order = np.argsort(angle, kind="stable")
    gaps = np.diff(np.r_[angle[order], angle[order[0]]+2*np.pi])
    order = np.roll(order, -(np.argmax(gaps)+1))
    theta = np.unwrap(angle[order])
    ordered = points[order]
    ranges = np.linalg.norm(ordered, axis=1)
    gap_limit = np.clip(.18+.04*np.minimum(ranges[1:], ranges[:-1]), .18, .7)
    breaks = (np.diff(theta) > .08) | (np.linalg.norm(np.diff(ordered, axis=0), axis=1) > gap_limit)
    pending = list(np.split(order, np.flatnonzero(breaks)+1))
    segments = []
    while pending:
        ids = pending.pop()
        if len(ids) < 3:
            continue
        centered = points[ids]-np.mean(points[ids], axis=0)
        eigen, vectors = np.linalg.eigh(centered.T@centered/len(ids))
        residual = np.abs(centered@vectors[:, 0])
        if residual.max() <= .06 and np.sqrt(max(0., eigen[0])) <= .025:
            along = centered@vectors[:, 1]
            segments.append((ids, np.mean(points[ids], axis=0), vectors[:, 0], vectors[:, 1]))
            if len(ids) >= 6 and np.ptp(along) >= .8:
                supported[ids] = True
            continue
        # Split against the endpoint chord (TLS residuals can be maximal at a
        # perfectly valid wall endpoint). Share the corner sample between
        # sides, keeping ray coverage without making either recursion grow.
        chord = points[ids[-1]]-points[ids[0]]
        relative = points[ids]-points[ids[0]]
        deviation = np.abs(relative[:, 0]*chord[1]-relative[:, 1]*chord[0])
        cut = int(np.argmax(deviation))
        if cut == 0 or cut == len(ids)-1:
            cut = len(ids)//2
        pending.extend((ids[:cut+1], ids[cut:]))
    # A split at the angular wrap or a corner can leave short pieces of a
    # genuine wall. Rejoin only pieces connected to an already extended wall,
    # either collinear with it or forming a clear right-angle corner. Do not
    # promote isolated short segments or chains of gently turning arc pieces.
    extended = [segment for segment in segments if supported[segment[0]].all()]
    for ids, centre, normal, direction in extended:
        along = (points-centre)@direction
        lower, upper = along[ids].min(), along[ids].max()
        supported |= ((np.abs((points-centre)@normal) < .025) &
                      (along >= lower-.25) & (along <= upper+.25))
    for ids, centre, normal, direction in segments:
        if supported[ids].all() or np.ptp((points[ids]-centre)@direction) < .25:
            continue
        for wall_ids, wall_centre, wall_normal, _ in extended:
            separation = cKDTree(points[wall_ids]).query(points[ids])[0].min()
            alignment = abs(float(normal@wall_normal))
            same_line = alignment > .995 and np.max(np.abs((points[ids]-wall_centre)@wall_normal)) < .04
            corner = alignment < .12
            if separation < .3 and (same_line or corner):
                supported[ids] = True
                break
    return supported


class TemporalSupport:
    """Bounded evidence for non-anchor map points, fed by accepted poses only.

    At least three scans and a 0.25 m change of viewpoint are needed. Stationary
    repetition alone cannot prove that a sensor-attached arc is a real object.
    Held rays neither mark occupied cells nor clear free space.
    """
    def __init__(self):
        self.frames = deque(maxlen=12)

    def clear(self):
        self.frames.clear()

    def update(self, world, pose, timestamp):
        while self.frames and timestamp-self.frames[0][0] > 2.0:
            self.frames.popleft()
        votes = np.ones(len(world), dtype=int)
        viewpoint = np.zeros(len(world), dtype=bool)
        for _, previous_pose, tree in self.frames:
            if tree is None:
                continue
            supported = tree.query(world)[0] <= .10
            votes += supported
            if np.linalg.norm(pose[:2]-previous_pose[:2]) >= .25:
                viewpoint |= supported
        self.frames.append((timestamp, pose.copy(), cKDTree(world) if len(world) else None))
        return (votes >= 3) & viewpoint


def water_ring_mask(angles, ranges):
    """Identify broad, nearly sensor-centred arcs for the straight-edged pool preset.

    A geometric prior, NOT a water classifier: real circular structures can
    satisfy it. Keep short arcs, sparse returns and line-like candidates.
    Input is valid decoded polar data; output preserves its original order.
    """
    rejected = np.zeros(len(ranges), dtype=bool)
    remaining = np.ones(len(ranges), dtype=bool)
    tolerance = .06  # +/- metres, provisional C1-scale noise band
    minimum_span = np.deg2rad(90)
    maximum_gap = np.deg2rad(4)
    min_points = 45
    rings = 0
    # Bound work for cluttered scans. Multiple concentric arcs can occur in a
    # single scan; every candidate must independently pass geometric checks.
    for _ in range(8):
        ids = np.flatnonzero(remaining & (ranges >= .5))
        if len(ids) < min_points:
            break
        radius_values = np.sort(ranges[ids])
        counts = (np.searchsorted(radius_values, radius_values+tolerance, side="right") -
                  np.searchsorted(radius_values, radius_values-tolerance, side="left"))
        index = np.argmax(counts)
        if counts[index] < min_points:
            break
        centre = radius_values[index]
        near = ids[np.abs(ranges[ids]-centre) <= tolerance]
        centre = np.median(ranges[near])
        near = ids[np.abs(ranges[ids]-centre) <= tolerance]
        remaining[near] = False
        if len(near) < min_points:
            continue
        theta = np.mod(angles[near], 2*np.pi)
        order = np.argsort(theta, kind="stable")
        near, theta = near[order], theta[order]
        # Cut at the largest empty angle so arcs crossing -pi/pi remain whole.
        gaps = np.diff(np.r_[theta, theta[0]+2*np.pi])
        start = (np.argmax(gaps)+1) % len(near)
        near = np.roll(near, -start)
        theta = np.r_[theta[start:], theta[:start]+2*np.pi]
        groups = np.split(np.arange(len(near)), np.flatnonzero(np.diff(theta) > maximum_gap)+1)
        broad_arc = False
        for group in groups:
            if len(group) < min_points or theta[group[-1]]-theta[group[0]] < minimum_span:
                continue
            # Repeated samples in a few directions cannot imitate a wide arc.
            if len(np.unique(np.floor(theta[group]/np.deg2rad(2)))) < 35:
                continue
            selected = near[group]
            r = ranges[selected]
            radial_rmse = np.sqrt(np.mean((r-np.median(r))**2))
            points = np.column_stack((r*np.cos(angles[selected]), r*np.sin(angles[selected])))
            centered = points-np.mean(points, axis=0)
            line_rmse = np.sqrt(max(0., np.linalg.eigvalsh(centered.T@centered/len(points))[0]))
            if line_rmse <= max(.025, 2*radial_rmse):
                continue
            broad_arc = True
            rings += 1
        if broad_arc:
            # Once a broad arc establishes this radius, also quarantine its
            # disconnected fragments. Real wall intersections in the same
            # radial band may be withheld; they are never marked as free.
            rejected[near] = True
    return rejected, rings


def prepare_scan(scan, velocity, *, max_tilt=.21, max_height=.35, deskew=True,
                 water_ring_filter=False):
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
    input_count = len(ids)
    ring_rejected, rings = 0, 0
    if water_ring_filter:
        rejected, rings = water_ring_mask(scan.angles[ids], scan.ranges[ids])
        ring_rejected = int(np.count_nonzero(rejected))
        ids = ids[~rejected]
    ranges = scan.ranges[ids]
    angles = scan.angles[ids]
    points = np.column_stack((ranges*np.cos(angles), ranges*np.sin(angles)))
    weights = 1 / (1 + (ranges / 10)**2)
    metadata = {
        "input_points": int(input_count), "retained_points": 0,
        "water_ring_filter": bool(water_ring_filter),
        "ring_rejected": ring_rejected, "ring_candidates": rings,
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
