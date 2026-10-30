"""Conservative local scan-to-submap SLAM; accepts observations only.

Revisable occupancy is separate from the registration reference. No global loop
closure, hidden pose, attitude estimator, controller or device driver is used.
"""
from collections import deque
from dataclasses import dataclass
import numpy as np
from scipy.spatial import cKDTree
from ..scan import transform, wrap
from .grid import OccupancyGrid
from .preprocessing import prepare_scan


@dataclass(frozen=True)
class SlamConfig:
    min_points: int = 60
    min_inlier_ratio: float = .62
    max_rmse: float = .075
    max_speed: float = 2.0  # m/s rejection bound, not odometry
    max_yaw_rate: float = 1.5  # rad/s
    max_tracking_gap: float = 1.0  # seconds since last accepted scan
    max_tilt: float = .21  # requires supplied attitude, radians
    max_height: float = .35  # m from instantaneous sensor-level plane
    deskew: bool = True

    def __post_init__(self):
        values = (self.max_rmse, self.max_speed, self.max_yaw_rate,
                  self.max_tracking_gap, self.max_tilt, self.max_height)
        if (not all(np.isfinite(v) and v > 0 for v in values) or self.max_tilt > np.pi/2 or
                not 0 < self.min_inlier_ratio <= 1 or
                not isinstance(self.min_points, (int, np.integer)) or self.min_points < 20):
            raise ValueError("Invalid SLAM configuration")


def voxel(points, resolution=.06):
    _, indices = np.unique(np.floor(points / resolution).astype(int), axis=0, return_index=True)
    return points[np.sort(indices)]


class LidarSlam:
    def __init__(self, resolution=.08, extent=40.0, config=None):
        self.config = config or SlamConfig()
        self.grid = OccupancyGrid(extent, resolution)
        self.pose = np.zeros(3)
        self.velocity = np.zeros(3)  # world-frame constant-velocity prediction
        self.last_timestamp = self.last_accepted_timestamp = None
        self.last_key_pose = np.zeros(3)
        self.keyframes = deque(maxlen=16)
        self.protected_reference = np.empty((0, 2))
        self.trajectory = []
        self.diagnostics = []
        self.status = "WAITING"
        self.rmse = float("inf")
        self.inlier_ratio = self.confidence = 0.0
        self.tree = None
        self.accepted = 0
        self.bootstrap_count = 0
        self.origin_timestamp = None

    def _start_candidate(self, points, timestamp):
        # A failed provisional origin can be replaced before ANY map is published.
        self.pose[:] = 0
        self.velocity[:] = 0
        self.keyframes.clear()
        self.protected_reference = np.empty((0, 2))
        self.tree = None
        self._reference(points)
        self.bootstrap_count = 1
        self.origin_timestamp = timestamp
        self.last_accepted_timestamp = timestamp

    def _reference(self, points):
        self.keyframes.append(transform(points, self.pose))
        # Prefer recent geometry; require independent-frame spatial support.
        # Refresh periodically even while stationary.
        candidates = voxel(np.concatenate(list(self.keyframes)[::-1]))
        support = np.ones(len(candidates), dtype=int)
        if len(self.keyframes) > 1:
            support = np.zeros(len(candidates), dtype=int)
            for frame in self.keyframes:
                support += cKDTree(frame).query(candidates)[0] < .12
            keep = support >= 2
            candidates, support = candidates[keep], support[keep]
        if len(self.protected_reference):
            candidates = np.concatenate((self.protected_reference, candidates))
            support = np.concatenate((np.full(len(self.protected_reference), 6), support))
            _, selected = np.unique(np.floor(candidates/.06).astype(int), axis=0, return_index=True)
            selected = np.sort(selected)
            candidates, support = candidates[selected], support[selected]
        if len(candidates) < self.config.min_points:
            return
        self.reference = candidates
        self.reference_support = support
        self.tree = cKDTree(candidates)
        distances, neighbors = self.tree.query(candidates, k=8)
        local = candidates[neighbors]
        centered = local - np.mean(local, axis=1, keepdims=True)
        cov = np.einsum("nki,nkj->nij", centered, centered)
        eigen, vectors = np.linalg.eigh(cov)
        self.normals = vectors[:, :, 0]
        self.planar = (eigen[:, 0] / np.maximum(eigen[:, 1], 1e-9) < .15) & (distances[:, -1] < .65)
        self.last_key_pose = self.pose.copy()

    def _match(self, points, seed, point_weights, dt):
        pose = seed.copy()
        stats = {"rmse": None, "inlier_ratio": 0.0, "confidence": 0.0}
        prediction = np.linalg.norm(seed[:2]-self.pose[:2]) + 3*abs(wrap(seed[2]-self.pose[2]))
        gate = np.clip(.28 + prediction, .28, .65)
        sectors = ((np.arctan2(points[:, 1], points[:, 0])+np.pi)*6/np.pi).astype(int) % 12
        sector_count = np.bincount(sectors, minlength=12)
        balance = np.minimum(1.0, 60 / np.maximum(sector_count[sectors], 1))
        for iteration in range(24):
            world = transform(points, pose)
            distance, ids = self.tree.query(world)
            mask = (distance < gate) & self.planar[ids]
            if np.count_nonzero(mask) < 40:
                return None, "LOST: insufficient overlap", stats
            n = self.normals[ids[mask]]
            residual = np.sum(n * (world[mask]-self.reference[ids[mask]]), axis=1)
            rotated = world[mask] - pose[:2]
            jacobian = np.column_stack((n, -n[:, 0]*rotated[:, 1] + n[:, 1]*rotated[:, 0]))
            scale = np.clip(1.4826*np.median(np.abs(residual-np.median(residual))), .03, .08)
            weights = point_weights[mask]*balance[mask] / (1+(residual/(2*scale))**2)
            if iteration >= 3:
                weights[np.abs(residual) > max(.12, 4*scale)] = 0
            scaled = jacobian.copy()
            scaled[:, 2] /= max(1.0, np.sqrt(np.mean(np.sum(rotated**2, axis=1))))
            info = scaled.T @ (scaled * weights[:, None]) / max(np.sum(weights), 1e-9)
            values = np.linalg.eigvalsh(info)
            translation = np.linalg.eigvalsh(n.T @ (n * weights[:, None]))
            if (values[0] / max(values[-1], 1e-9) < .012 or
                    translation[0] / max(translation[-1], 1e-9) < .025):
                return None, "DEGENERATE: weak geometry", stats
            step = np.linalg.lstsq(jacobian * np.sqrt(weights[:, None]),
                                   -residual*np.sqrt(weights), rcond=None)[0]
            step[:2] = np.clip(step[:2], -.18, .18)
            step[2] = np.clip(step[2], -.06, .06)
            pose += step
            pose[2] = wrap(pose[2])
            if np.linalg.norm(step) < 1e-5:
                break
        world = transform(points, pose)
        distance, ids = self.tree.query(world)
        residual = np.sum(self.normals[ids] * (world-self.reference[ids]), axis=1)
        mask = (distance < .22) & self.planar[ids] & (np.abs(residual) < .15)
        ratio = float(np.mean(mask))
        rmse = float(np.sqrt(np.mean(residual[mask]**2))) if np.any(mask) else float("inf")
        stats.update(rmse=rmse if np.isfinite(rmse) else None, inlier_ratio=ratio)
        # Unknown directions must not count as contradictory existing geometry.
        # This matters when attitude/height filtering changes the visible sector.
        c, s = np.cos(pose[2]), np.sin(pose[2])
        ref_local = (self.reference-pose[:2]) @ np.array([[c, -s], [s, c]])
        ref_bins = ((np.arctan2(ref_local[:, 1], ref_local[:, 0])+np.pi)*18/np.pi).astype(int) % 36
        beam_bins = ((np.arctan2(points[:, 1], points[:, 0])+np.pi)*18/np.pi).astype(int) % 36
        known = np.bincount(ref_bins[self.planar], minlength=36)[beam_bins] >= 3
        overlap_ratio = float(np.count_nonzero(mask & known)/max(1, np.count_nonzero(known)))
        supported_sectors = np.count_nonzero(np.bincount(sectors[mask], minlength=12) >= 8)
        stats["overlap_ratio"] = overlap_ratio
        if (ratio < .35 or overlap_ratio < self.config.min_inlier_ratio or
                np.count_nonzero(mask) < 50 or supported_sectors < 3 or rmse > self.config.max_rmse):
            return None, "LOST: inconsistent scan", stats
        # Whole sectors disagreeing indicate deformation, not isolated noise.
        bad_sectors = 0
        for sector in range(12):
            selected = (sectors == sector) & self.planar[ids] & (distance < .65)
            if np.count_nonzero(selected) >= 12 and np.median(np.abs(residual[selected])) > .09:
                bad_sectors += 1
        if bad_sectors >= 2:
            return None, "LOST: sector distortion", stats
        if (np.linalg.norm(pose[:2]-self.pose[:2]) > min(.8, .10+self.config.max_speed*dt) or
                abs(wrap(pose[2]-self.pose[2])) > min(.45, .04+self.config.max_yaw_rate*dt)):
            return None, "LOST: excessive motion", stats
        stats["confidence"] = float(np.clip(ratio * np.exp(-(rmse/.09)**2), .25, 1))
        return pose, "TRACKING", stats

    def _quarantine(self, points, pose, distance, residual, ids):
        """Withhold a newly contradictory sector of an established reference.

        A sustained changed facade and a rocking scan may be indistinguishable
        without attitude. Prefer holding that sector to erasing a mature wall.
        Only reference geometry in those directions is held. Reliable directions
        keep refreshing, so one suspect sector cannot freeze the entire frontend.
        """
        quarantined = np.zeros(len(points), dtype=bool)
        self.protected_reference = np.empty((0, 2))
        if self.accepted < 8:
            return quarantined
        c, s = np.cos(pose[2]), np.sin(pose[2])
        local = (self.reference-pose[:2]) @ np.array([[c, -s], [s, c]])
        ref_sector = ((np.arctan2(local[:, 1], local[:, 0])+np.pi)*6/np.pi).astype(int) % 12
        # Short-lived provisional surfaces must remain removable. Protection
        # requires support from six separate reference frames at that location.
        mature = self.planar & (self.reference_support >= 6)
        expected = np.bincount(ref_sector[mature], minlength=12)
        sectors = ((np.arctan2(points[:, 1], points[:, 0])+np.pi)*6/np.pi).astype(int) % 12
        supported = (distance < .22) & (residual < .12) & self.planar[ids]
        suspect = np.zeros(12, dtype=bool)
        for sector in range(12):
            selected = sectors == sector
            if (expected[sector] >= 12 and np.count_nonzero(selected) >= 12 and
                    np.mean(supported[selected]) < .25):
                suspect[sector] = True
        # Cover the edge of a corrupted sector without discarding its reliable
        # neighbor rays. A bin boundary must not let a large range jump through.
        expanded = suspect | np.roll(suspect, 1) | np.roll(suspect, -1)
        self.protected_reference = self.reference[expanded[ref_sector] & mature].copy()
        return suspect[sectors] | (expanded[sectors] & ~supported)

    def _local_search(self, points, seed, weights, dt):
        """Bounded correlative seed search, not global relocalization."""
        sparse = points[::max(1, len(points)//120)]
        radius = min(.24, .08 + self.config.max_speed*dt)
        yaw = min(.16, .03 + self.config.max_yaw_rate*dt)
        seeds = []
        for angle in np.linspace(-yaw, yaw, 5):
            for dx in (-radius, 0, radius):
                for dy in (-radius, 0, radius):
                    candidate = seed + [dx, dy, angle]
                    distance = self.tree.query(transform(sparse, candidate))[0]
                    score = float(np.mean(np.minimum(distance, .4)**2))
                    seeds.append((score, candidate))
        best = None
        for _, candidate in sorted(seeds, key=lambda item: item[0])[:3]:
            result = self._match(points, candidate, weights, dt)
            if result[0] is not None and (best is None or result[2]["confidence"] > best[2]["confidence"]):
                best = result
        return best

    def _body_velocity(self, yaw):
        c, s = np.cos(yaw), np.sin(yaw)
        return np.array([c*self.velocity[0]+s*self.velocity[1],
                         -s*self.velocity[0]+c*self.velocity[1], self.velocity[2]])

    def update(self, scan):
        if self.last_timestamp is not None and scan.timestamp <= self.last_timestamp:
            raise ValueError("SLAM timestamps must strictly increase")
        self.last_timestamp = scan.timestamp
        dt = 0 if self.last_accepted_timestamp is None else scan.timestamp-self.last_accepted_timestamp
        predicted_yaw = self.pose[2]+self.velocity[2]*min(dt, .2)
        points, origins, weights, meta = prepare_scan(
            scan, self._body_velocity(predicted_yaw), max_tilt=self.config.max_tilt,
            max_height=self.config.max_height, deskew=self.config.deskew)
        if scan.time_offsets is not None and self.config.deskew and self.bootstrap_count < 2:
            meta["deskew"] = "bootstrap_no_velocity"
        stats = {"rmse": None, "inlier_ratio": 0.0, "confidence": 0.0}
        meta["quarantined_points"] = 0
        meta["map_updated"] = False
        accepted = False
        if len(points) < self.config.min_points:
            self.status = "LOST: too few reliable returns"
        elif self.tree is not None and self.bootstrap_count >= 3 and dt > self.config.max_tracking_gap:
            self.status = "LOST: tracking gap; restart a new map"
        elif self.tree is None:
            self.status = "INITIALIZING: 1/3 consistent scans"
            self._start_candidate(points, scan.timestamp)
        else:
            seed = self.pose + self.velocity * min(dt, .2)
            estimate, self.status, stats = self._match(points, seed, weights, dt)
            if estimate is None and not self.status.startswith("DEGENERATE"):
                retry = self._local_search(points, seed, weights, dt)
                if retry is not None:
                    estimate, self.status, stats = retry
            if estimate is not None:
                delta = estimate-self.pose
                delta[2] = wrap(delta[2])
                self.velocity = delta/max(dt, .01)
                self.pose = estimate
                if self.bootstrap_count < 3:
                    self.bootstrap_count += 1
                    self.last_accepted_timestamp = scan.timestamp
                    self._reference(points)
                accepted = self.bootstrap_count >= 3
                if not accepted:
                    self.status = "INITIALIZING: 2/3 consistent scans"
            elif self.bootstrap_count < 3:
                failure = self.status
                self._start_candidate(points, scan.timestamp)
                self.status = failure + "; bootstrap candidate replaced"
        if accepted:
            self.accepted += 1
            self.last_accepted_timestamp = scan.timestamp
            # Omit contradictory near-reference rays from both marking AND clearing.
            world = transform(points, self.pose)
            distance, ids = self.tree.query(world)
            residual = np.abs(np.sum(self.normals[ids] * (world-self.reference[ids]), axis=1))
            quarantine = self._quarantine(points, self.pose, distance, residual, ids)
            meta["quarantined_points"] = int(np.count_nonzero(quarantine))
            reliable = ~quarantine & ~((distance < .65) & self.planar[ids] & (residual > .12))
            weights = weights * reliable * np.where(distance < .22, 1.0, .6)
            self.grid.update(points, self.pose, weights, stats["confidence"], origins)
            meta["map_updated"] = bool(np.any(weights > 0))
            if self.accepted > 1 and (self.accepted <= 3 or self.accepted % 3 == 0 or
                    np.linalg.norm(self.pose[:2]-self.last_key_pose[:2]) > .25 or
                    abs(wrap(self.pose[2]-self.last_key_pose[2])) > .08):
                self._reference(points[reliable])
        elif not self.status.startswith("INITIALIZING"):
            self.velocity[:] = 0
        self.rmse = stats["rmse"] if stats["rmse"] is not None else float("inf")
        self.inlier_ratio = stats["inlier_ratio"]
        self.confidence = stats["confidence"] if accepted else 0.0
        self.trajectory.append((scan.timestamp, *self.pose, self.status))
        self.diagnostics.append(dict(timestamp=scan.timestamp, status=self.status,
            accepted=accepted, **meta, **stats))
        return self.pose.copy()
