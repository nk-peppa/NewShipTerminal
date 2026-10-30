"""Reversible occupancy evidence from accepted, weighted laser scans.

A new endpoint needs three recent scan confirmations before it contributes
occupied evidence. Reliable free-space observations can remove old occupancy;
unseen cells are retained. This map never participates in pose estimation.
"""
import numpy as np

from ..scan import transform


class OccupancyGrid:
    def __init__(self, extent=40.0, resolution=0.08):
        extent, resolution = float(extent), float(resolution)
        if (not np.isfinite(extent) or not np.isfinite(resolution)
                or extent <= 0 or resolution <= 0
                or extent / resolution > 2000):
            raise ValueError("Invalid or excessive grid size")
        self.resolution = resolution
        self.size = int(np.ceil(extent / resolution))
        self.origin = np.array([-extent / 2, -extent / 2])
        self.log_odds = np.zeros((self.size, self.size), dtype=np.float32)
        self.observed = np.zeros_like(self.log_odds, dtype=bool)
        self.hit_support = np.zeros_like(self.log_odds, dtype=np.uint8)
        self.last_hit = np.zeros_like(self.log_odds, dtype=np.uint64)
        self._updates = 0
        self.clipped = False

    @staticmethod
    def _points(value, name):
        value = np.asarray(value, dtype=np.float64)
        if value.size == 0:
            value = value.reshape(0, 2)
        if value.ndim != 2 or value.shape[1] != 2 or not np.all(np.isfinite(value)):
            raise ValueError(f"{name} must be finite N x 2 coordinates")
        return value

    def cells(self, points):
        points = np.asarray(points, dtype=np.float64)
        if points.shape[-1:] != (2,) or not np.all(np.isfinite(points)):
            raise ValueError("Cell coordinates must be finite and end in dimension 2")
        # Saturation is only for coordinates beyond the integer representation;
        # all such coordinates remain outside the map.
        with np.errstate(over="ignore"):
            values = np.floor((points - self.origin) / self.resolution)
        limit = np.iinfo(np.int64).max // 4
        return np.clip(values, -limit, limit).astype(np.int64)

    def inside(self, cells):
        cells = np.asarray(cells)
        return np.all((cells >= 0) & (cells < self.size), axis=-1)

    @staticmethod
    def _max_by_cell(indices, weights):
        if not len(indices):
            return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float64)
        unique, inverse = np.unique(indices, return_inverse=True)
        maximum = np.zeros(len(unique), dtype=np.float64)
        np.maximum.at(maximum, inverse, weights)
        return unique, maximum

    def _free_rays(self, starts, endpoints, weights, endpoint_inside):
        """Traverse crossed cells exactly, clipping rays before allocation."""
        direction = endpoints - starts
        if not np.all(np.isfinite(direction)):
            raise ValueError("Ray coordinates exceed numeric range")
        lower = self.origin
        upper = np.nextafter(self.origin + self.size * self.resolution, lower)
        parallel = np.abs(direction) < 1e-15
        possible = np.all(~parallel | ((starts >= lower) & (starts <= upper)), axis=1)
        with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
            a = np.divide(lower - starts, direction,
                          out=np.full_like(direction, -np.inf), where=~parallel)
            b = np.divide(upper - starts, direction,
                          out=np.full_like(direction, np.inf), where=~parallel)
        enter = np.maximum(0.0, np.max(np.minimum(a, b), axis=1))
        leave = np.minimum(1.0, np.min(np.maximum(a, b), axis=1))
        length = np.max(np.abs(direction), axis=1)
        # A one-cell endpoint guard prevents nearby rays from shaving walls.
        guard = np.zeros_like(length)
        np.divide(self.resolution, length, out=guard, where=length > 0)
        leave = np.where(endpoint_inside, np.minimum(leave, 1.0 - guard), leave)
        possible &= (length > 0) & (enter <= leave)
        all_indices, all_weights = [], []
        for index in np.flatnonzero(possible):
            start = np.clip(starts[index] + enter[index] * direction[index], lower, upper)
            end = np.clip(starts[index] + leave[index] * direction[index], lower, upper)
            cell_start = (start - self.origin) / self.resolution
            cell_end = (end - self.origin) / self.resolution
            cell_direction = cell_end - cell_start
            cuts = [np.array([0.0, 1.0])]
            for axis in range(2):
                if abs(cell_direction[axis]) < 1e-14:
                    continue
                low = min(cell_start[axis], cell_end[axis])
                high = max(cell_start[axis], cell_end[axis])
                boundaries = np.arange(np.floor(low) + 1, np.ceil(high))
                crossing = (boundaries - cell_start[axis]) / cell_direction[axis]
                cuts.append(crossing[(crossing > 0) & (crossing < 1)])
            fractions = np.unique(np.concatenate(cuts))
            # Coincident x/y crossings describe a corner, not two additional
            # cells. Ignore round-off-sized intervals between those crossings.
            widths = np.diff(fractions)
            midpoints = ((fractions[:-1] + fractions[1:]) / 2)[widths > 32*np.finfo(float).eps]
            samples = start + midpoints[:, None] * (end - start)
            cells = self.cells(samples)
            cells = cells[self.inside(cells)]
            all_indices.append(cells[:, 1] * self.size + cells[:, 0])
            all_weights.append(np.full(len(cells), weights[index]))
        if not all_indices:
            return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float64)
        return self._max_by_cell(np.concatenate(all_indices), np.concatenate(all_weights))

    def update(self, points, pose, weights=None, confidence=1.0, origins=None):
        """Integrate one accepted scan; weights/confidence are in [0, 1].

        ``origins`` are per-ray N x 2 origins in the same scan-reference frame as
        ``points``. They keep free-space tracing consistent after deskewing.
        Rejected scans should not call this method, or should use confidence=0.
        """
        points = self._points(points, "Points")
        pose = np.asarray(pose, dtype=np.float64)
        if pose.shape != (3,) or not np.all(np.isfinite(pose)):
            raise ValueError("Pose must contain finite x, y, yaw")
        confidence = float(confidence)
        if not np.isfinite(confidence) or confidence > 1:
            raise ValueError("Confidence must be finite and at most 1")
        if weights is None:
            weights = np.ones(len(points), dtype=np.float64)
        else:
            weights = np.asarray(weights, dtype=np.float64)
        if (weights.shape != (len(points),) or not np.all(np.isfinite(weights))
                or np.any((weights < 0) | (weights > 1))):
            raise ValueError("Weights must be one finite [0, 1] value per point")
        origins = np.zeros_like(points) if origins is None else self._points(origins, "Origins")
        if origins.shape != points.shape:
            raise ValueError("Origins must match the point array shape")
        if confidence <= 0 or not len(points) or not np.any(weights > 0):
            return
        active = weights > 0
        weights = weights[active] * confidence
        with np.errstate(over="ignore", invalid="ignore"):
            endpoints = transform(points[active], pose)
            starts = transform(origins[active], pose)
        if not np.all(np.isfinite(endpoints)) or not np.all(np.isfinite(starts)):
            raise ValueError("Transformed coordinates exceed numeric range")
        end_cells = self.cells(endpoints)
        endpoint_inside = self.inside(end_cells)
        hit_cells = end_cells[endpoint_inside]
        hit, hit_weight = self._max_by_cell(
            hit_cells[:, 1] * self.size + hit_cells[:, 0], weights[endpoint_inside])
        free, free_weight = self._free_rays(starts, endpoints, weights, endpoint_inside)
        # Hits have priority even before their multi-scan confirmation. A cell
        # receives at most one weighted update from this scan, never one per ray.
        keep = ~np.isin(free, hit, assume_unique=True)
        free, free_weight = free[keep], free_weight[keep]

        # All validation and ray construction is complete before state changes.
        self._updates += 1
        self.clipped = not bool(np.all(endpoint_inside) and np.all(self.inside(self.cells(starts))))
        odds = self.log_odds.ravel()
        observed = self.observed.ravel()
        support = self.hit_support.ravel()
        last_hit = self.last_hit.ravel()
        odds[free] = np.maximum(-3.0, odds[free] - 0.55 * free_weight)
        observed[free] = True
        support[free] = 0
        last_hit[free] = 0
        recent = (last_hit[hit] > 0) & (self._updates - last_hit[hit] <= 3)
        support[hit] = np.where(recent, np.minimum(support[hit].astype(int) + 1, 255), 1)
        last_hit[hit] = self._updates
        confirmed = support[hit] >= 3
        occupied = hit[confirmed]
        odds[occupied] = np.minimum(3.0, odds[occupied] + 0.85 * hit_weight[confirmed])
        observed[hit] = True

    def image(self):
        probability = 1.0 / (1.0 + np.exp(-self.log_odds))
        return np.where(self.observed, (1.0 - probability) * 255, 127).astype(np.uint8)
