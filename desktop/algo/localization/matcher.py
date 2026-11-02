"""Distance-field scan-to-map localization against a prior occupancy map.

Two stages, mirroring how the mapping side works:

* a Gauss-Newton refinement on the map's Euclidean distance field, with a
  Cauchy robust weight so moving boats / water clutter cannot drag the pose;
* a small exhaustive refinement around the GN result. The distance field is
  smooth and slightly biased on 8 cm cells, so GN alone lands ~0.1–0.2 m off;
  a 4 cm / 0.4° grid pass followed by a 2 cm / 0.12° polish brings synthetic
  tests to a few centimetres.

Global localization is coarse-to-fine: free cells on a 0.6 m grid × 10° yaw,
ranked by inlier fraction (more discriminative than mean distance), then
non-maximum suppression and the same local refinement. Ambiguous best/second
pairs are reported instead of silently picking one.

Nothing here writes to the prior map, and the vendor ``cocommand2d`` package is
only imported, never modified.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from cocommand2d.scan import transform, wrap
from cocommand2d.slam.preprocessing import prepare_scan

from .config import LocalizerConfig
from .map import PriorMap

PHASE_WAITING = "waiting"
PHASE_SEARCHING = "searching"
PHASE_TRACKING = "tracking"
PHASE_LOST = "lost"
PHASE_AMBIGUOUS = "ambiguous"


@dataclass
class Metrics:
    rmse: float | None = None
    inlier: float = 0.0
    coverage: float = 0.0
    matched: int = 0
    points: int = 0
    confidence: float = 0.0
    dt_ms: float = 0.0
    candidates: int = 0
    margin: float | None = None
    condition: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rmse": None if self.rmse is None else round(float(self.rmse), 5),
            "inlier": round(float(self.inlier), 4),
            "coverage": round(float(self.coverage), 4),
            "matched": int(self.matched),
            "points": int(self.points),
            "confidence": round(float(self.confidence), 4),
            "dtMs": round(float(self.dt_ms), 2),
            "candidates": int(self.candidates),
            "margin": None if self.margin is None else round(float(self.margin), 4),
            "condition": None if self.condition is None else round(float(self.condition), 2),
        }


@dataclass
class Result:
    pose: np.ndarray
    phase: str
    message: str
    metrics: Metrics
    valid: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "x": round(float(self.pose[0]), 4),
            "y": round(float(self.pose[1]), 4),
            "yaw": round(float(self.pose[2]), 5),
            "phase": self.phase,
            "message": self.message,
            "poseValid": bool(self.valid),
            **self.metrics.to_dict(),
        }


@dataclass
class Candidate:
    pose: np.ndarray
    inlier: float
    score: float
    rmse: float
    matched: int = 0
    coverage: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "x": round(float(self.pose[0]), 3),
            "y": round(float(self.pose[1]), 3),
            "yaw": round(float(self.pose[2]), 4),
            "inlier": round(float(self.inlier), 3),
            "score": round(float(self.score), 3),
            "matched": int(self.matched),
            "coverage": round(float(self.coverage), 3),
        }


def scan_points(scan, config: LocalizerConfig, velocity=None):
    """Scan v1 → conditioned points/weights, using the mapping-side pipeline."""
    if velocity is None:
        velocity = np.zeros(3)
    points, _origins, weights, meta = prepare_scan(
        scan,
        velocity,
        max_tilt=config.max_tilt,
        max_height=config.max_height,
        deskew=config.deskew,
    )
    return points, weights, meta


class MapLocalizer:
    def __init__(self, prior: PriorMap, config: LocalizerConfig = LocalizerConfig()):
        config.validate()
        self.map = prior
        self.config = config
        self.pose: np.ndarray | None = None
        self.velocity = np.zeros(3)
        self.last_timestamp: float | None = None
        self.last_accepted: float | None = None
        self.phase = PHASE_WAITING
        self.message = "已加载地图，等待首帧扫描"
        self.metrics = Metrics()
        self.candidates: list[Candidate] = []
        self.frames = 0
        self.tracking_frames = 0
        self.lost_since: float | None = None
        self.manual_seed = False
        self._clearance_cache: np.ndarray | None = None
        # Multi-hypothesis bootstrap: a single 2D scan is sometimes ambiguous
        # (square pool, symmetric obstacle layout). Keep the best few poses and
        # let the next scans vote before declaring a winner.
        self.hypotheses: list[Candidate] = []
        self.search_frames = 0
        self.last_global_at: float | None = None
        self._hyp_scores: list[float] = []
        self.tracking = False
        self.awaiting_manual = False
        self.last_alternatives: list[Candidate] = []

    # ---- control ------------------------------------------------------------

    def set_initial_pose(self, x: float, y: float, yaw: float) -> None:
        self.pose = np.array([float(x), float(y), wrap(float(yaw))], dtype=float)
        self.velocity[:] = 0
        self.phase = PHASE_TRACKING
        self.message = "已设置初始位姿，等待匹配"
        self.manual_seed = True
        self.lost_since = None
        self.hypotheses = []
        self._hyp_scores = []
        self.search_frames = 0
        self.tracking = True
        self.awaiting_manual = False

    def clear_pose(self) -> None:
        self.pose = None
        self.velocity[:] = 0
        self.phase = PHASE_WAITING
        self.message = "位姿已清空，下一帧重新全局定位"
        self.manual_seed = False
        self.lost_since = None
        self.candidates = []
        self.hypotheses = []
        self._hyp_scores = []
        self.search_frames = 0
        self.last_global_at = None
        self.tracking = False
        self.awaiting_manual = False

    def request_global_search(self) -> None:
        """UI「重新全局定位」：清位姿并允许新一轮搜索。"""
        self.clear_pose()

    # ---- scoring ------------------------------------------------------------

    def _measure(self, points: np.ndarray, weights: np.ndarray, pose: np.ndarray) -> Metrics:
        del weights
        world = transform(points, pose)
        dist, _gx, _gy, valid = self.map.sample(world)
        dist = np.minimum(dist, self.config.max_match_distance)
        n = len(points)
        valid_n = int(np.count_nonzero(valid))
        if not n or not valid_n:
            return Metrics(points=n)
        inside = dist[valid] < self.config.inlier_distance
        matched = int(np.count_nonzero(inside))
        inlier = matched / max(valid_n, 1)
        coverage = valid_n / n
        rmse = float(np.sqrt(np.mean(dist[valid][inside] ** 2))) if matched else None
        confidence = inlier * math.sqrt(coverage)
        if matched < self.config.min_points:
            confidence *= 0.4
        return Metrics(
            rmse=rmse,
            inlier=inlier,
            coverage=coverage,
            matched=matched,
            points=n,
            confidence=min(1.0, confidence),
        )

    # ---- Gauss-Newton -------------------------------------------------------

    def _gn(self, points: np.ndarray, weights: np.ndarray, seed: np.ndarray) -> np.ndarray:
        cfg = self.config
        pose = np.asarray(seed, dtype=float).copy()
        for _ in range(cfg.gn_iterations):
            c, s = math.cos(pose[2]), math.sin(pose[2])
            rel = points @ np.array([[c, s], [-s, c]])
            world = rel + pose[:2]
            dist, gx, gy, valid = self.map.sample(world)
            dist = np.minimum(dist, cfg.max_match_distance)
            robust = 1.0 / (1.0 + (dist / cfg.robust_scale) ** 2)
            w = weights * robust * valid
            if float(np.sum(w)) < 1e-6:
                break
            rel_yaw = gx * (-rel[:, 1]) + gy * rel[:, 0]
            jac = np.column_stack((gx, gy, rel_yaw))
            a = jac.T @ (jac * w[:, None]) + np.eye(3) * 1e-3
            b = -(jac.T @ (dist * w))
            try:
                step = np.linalg.solve(a, b)
            except np.linalg.LinAlgError:
                break
            if not np.all(np.isfinite(step)):
                break
            step[:2] = np.clip(step[:2], -cfg.gn_step_xy, cfg.gn_step_xy)
            step[2] = np.clip(step[2], -cfg.gn_step_yaw, cfg.gn_step_yaw)
            pose += step
            pose[2] = wrap(pose[2])
            if float(np.abs(step).max()) < 1e-5:
                break
        return pose

    # ---- exhaustive local refinement ---------------------------------------

    def _grid_refine(
        self,
        points: np.ndarray,
        seed: np.ndarray,
        span_xy: float,
        step_xy: float,
        span_yaw: float,
        step_yaw: float,
    ) -> tuple[np.ndarray, Metrics]:
        cfg = self.config
        xs = seed[0] + np.arange(-span_xy, span_xy + 1e-9, step_xy)
        ys = seed[1] + np.arange(-span_xy, span_xy + 1e-9, step_xy)
        yaws = seed[2] + np.arange(-span_yaw, span_yaw + 1e-9, step_yaw)
        if len(xs) * len(ys) * len(yaws) * len(points) > 4_000_000:
            raise ValueError("局部细化搜索空间过大，请调大步长")

        best_pose = np.asarray(seed, dtype=float).copy()
        best_metrics = self._measure(points, np.ones(len(points)), best_pose)
        best_key = (best_metrics.confidence, best_metrics.inlier, -(best_metrics.rmse or 0.0))
        ny = len(ys)
        base_y = np.repeat(ys, len(points))
        npts = len(points)
        for yaw in yaws:
            c, s = math.cos(yaw), math.sin(yaw)
            rel = points @ np.array([[c, s], [-s, c]])
            tiled = np.tile(rel, (ny, 1))
            for x in xs:
                world = np.column_stack((np.full(ny * npts, x), base_y)) + tiled
                dist, _gx, _gy, valid = self.map.sample(world)
                dist = np.minimum(dist, cfg.max_match_distance)
                valid = valid.reshape(ny, npts)
                dist = dist.reshape(ny, npts)
                valid_n = valid.sum(axis=1)
                inside = valid & (dist < cfg.inlier_distance)
                matched = inside.sum(axis=1)
                with np.errstate(invalid="ignore", divide="ignore"):
                    inlier = matched / np.maximum(valid_n, 1)
                sq = np.where(inside, dist * dist, 0.0).sum(axis=1)
                with np.errstate(invalid="ignore", divide="ignore"):
                    rmse = np.sqrt(sq / np.maximum(matched, 1))
                coverage = valid_n / npts
                score = inlier * np.sqrt(coverage)
                score = np.where(matched >= cfg.min_points, score, score * 0.4)
                key = score - 0.05 * np.nan_to_num(rmse, nan=0.0)
                i = int(np.argmax(key))
                candidate_key = (
                    float(score[i]),
                    float(inlier[i]),
                    -float(rmse[i]) if np.isfinite(rmse[i]) else -math.inf,
                )
                if candidate_key > best_key:
                    best_key = candidate_key
                    best_pose = np.array([x, ys[i], wrap(float(yaw))], dtype=float)
                    best_metrics = Metrics(
                        rmse=None if not np.isfinite(rmse[i]) else float(rmse[i]),
                        inlier=float(inlier[i]),
                        coverage=float(coverage[i]),
                        matched=int(matched[i]),
                        points=npts,
                        confidence=float(score[i]),
                    )
        return best_pose, best_metrics

    def refine(self, points: np.ndarray, weights: np.ndarray, seed: np.ndarray) -> Result:
        cfg = self.config
        t0 = time.perf_counter()
        pose = self._gn(points, weights, seed)
        pose, metrics = self._grid_refine(
            points, pose, cfg.refine_span_xy, cfg.refine_step_xy,
            cfg.refine_span_yaw, cfg.refine_step_yaw,
        )
        pose, metrics = self._grid_refine(
            points, pose, cfg.polish_span_xy, cfg.polish_step_xy,
            cfg.polish_span_yaw, cfg.polish_step_yaw,
        )
        metrics.dt_ms = (time.perf_counter() - t0) * 1000
        metrics.condition = self._condition(points, pose)
        return Result(pose=pose, phase=self.phase, message=self.message, metrics=metrics, valid=False)

    def _condition(self, points: np.ndarray, pose: np.ndarray) -> float | None:
        """Translation observability: eigenvalue ratio of the wall normals."""
        c, s = math.cos(pose[2]), math.sin(pose[2])
        rel = points @ np.array([[c, s], [-s, c]])
        world = rel + pose[:2]
        _d, gx, gy, valid = self.map.sample(world)
        if np.count_nonzero(valid) < 10:
            return None
        n = np.column_stack((gx[valid], gy[valid]))
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        values = np.linalg.eigvalsh(n.T @ n)
        if values[-1] <= 0:
            return None
        return float(values[0] / values[-1])

    # ---- global search ------------------------------------------------------

    def _candidate_positions(self) -> np.ndarray:
        if self._clearance_cache is None:
            self._clearance_cache = self.map.clearance()
        clearance = self._clearance_cache
        free = self.map.free & (clearance >= self.config.global_min_clearance)
        rows, cols = np.nonzero(free)
        if not len(rows):
            return np.empty((0, 2))
        xs = self.map.origin[0] + (cols + 0.5) * self.map.resolution
        ys = self.map.origin[1] + (rows + 0.5) * self.map.resolution
        step = self.config.global_step_xy
        key = np.floor(xs / step).astype(np.int64) * 100_000 + np.floor(ys / step).astype(np.int64)
        _, keep = np.unique(key, return_index=True)
        return np.column_stack((xs[keep], ys[keep]))

    def global_search(self, points: np.ndarray, weights: np.ndarray) -> list[Candidate]:
        cfg = self.config
        positions = self._candidate_positions()
        if not len(positions):
            return []
        stride = max(1, len(points) // cfg.global_coarse_points)
        coarse = points[::stride]
        yaw_count = max(1, int(round(2 * math.pi / cfg.global_step_yaw)))

        scored: list[tuple[float, float, float, float, float]] = []
        for yaw in np.linspace(-math.pi, math.pi - cfg.global_step_yaw, yaw_count):
            c, s = math.cos(yaw), math.sin(yaw)
            rel = coarse @ np.array([[c, s], [-s, c]])
            world = positions[:, None, :] + rel[None, :, :]
            dist, _gx, _gy, valid = self.map.sample(world.reshape(-1, 2))
            dist = np.minimum(dist, cfg.max_match_distance)
            valid = valid.reshape(len(positions), -1)
            dist = dist.reshape(len(positions), -1)
            valid_n = valid.sum(axis=1)
            inside = valid & (dist < cfg.inlier_distance)
            matched = inside.sum(axis=1)
            with np.errstate(invalid="ignore", divide="ignore"):
                inlier = matched / np.maximum(valid_n, 1)
            coverage = valid_n / len(coarse)
            score = np.where(matched >= 12, inlier * np.sqrt(coverage), 0.0)
            top = min(cfg.global_candidates, len(score))
            idx = np.argpartition(-score, top - 1)[:top]
            for i in idx:
                if score[i] <= 0:
                    continue
                scored.append(
                    (
                        float(score[i]),
                        float(inlier[i]),
                        float(yaw),
                        float(positions[i, 0]),
                        float(positions[i, 1]),
                    )
                )
        scored.sort(reverse=True)

        kept: list[tuple[float, float, float, float, float]] = []
        for item in scored:
            _score, _inlier, yaw, x, y = item
            if all(
                math.hypot(x - k[3], y - k[4]) > 1.0 or abs(wrap(yaw - k[2])) > math.radians(25)
                for k in kept
            ):
                kept.append(item)
            if len(kept) >= cfg.global_candidates:
                break

        out: list[Candidate] = []
        stride = max(1, len(points) // cfg.global_refine_points)
        refine_points = points[::stride]
        refine_weights = weights[::stride]
        refined: list[tuple[Candidate, np.ndarray]] = []
        for _score, _inlier, yaw, x, y in kept:
            coarse_pose = np.array([x, y, yaw])
            result = self.refine(refine_points, refine_weights, coarse_pose)
            candidate = Candidate(
                pose=result.pose,
                inlier=result.metrics.inlier,
                score=result.metrics.confidence,
                rmse=result.metrics.rmse if result.metrics.rmse is not None else float("inf"),
                matched=result.metrics.matched,
                coverage=result.metrics.coverage,
            )
            refined.append((candidate, coarse_pose))
            out.append(candidate)
        out.sort(key=lambda c: (c.score, c.inlier, -c.rmse), reverse=True)

        # Symmetric layouts (a square pool, four identical corners) make several
        # poses score identically. GN from a coarse pose slides everything into
        # one basin, so re-check the *coarse* poses with a bounded polish: that
        # keeps the alternatives alive and reports them as ambiguities.
        alternatives: list[Candidate] = []
        if out:
            best = out[0]
            for candidate, coarse in refined:
                if (
                    math.hypot(coarse[0] - best.pose[0], coarse[1] - best.pose[1])
                    <= cfg.ambiguity_distance
                    and abs(wrap(coarse[2] - best.pose[2])) <= math.radians(20)
                ):
                    continue
                pose, metrics = self._grid_refine(
                    points,
                    coarse,
                    cfg.polish_span_xy * 4,
                    cfg.polish_step_xy * 4,
                    cfg.polish_span_yaw * 4,
                    cfg.polish_step_yaw * 4,
                )
                if metrics.matched < cfg.min_points or metrics.inlier < cfg.min_inlier:
                    continue
                if metrics.confidence >= 0.85 * best.score:
                    alternatives.append(
                        Candidate(
                            pose=pose,
                            inlier=metrics.inlier,
                            score=metrics.confidence,
                            rmse=metrics.rmse if metrics.rmse is not None else float("inf"),
                            matched=metrics.matched,
                            coverage=metrics.coverage,
                        )
                    )
        alternatives.sort(key=lambda c: (c.score, c.inlier), reverse=True)
        self.last_alternatives = alternatives[:3]
        return out

    # ---- per-scan entry -----------------------------------------------------

    def update_scan(self, scan) -> Result:
        t0 = time.perf_counter()
        self.frames += 1
        now = float(scan.timestamp)
        dt = 0.0 if self.last_timestamp is None else max(0.0, now - self.last_timestamp)
        self.last_timestamp = now

        points, weights, _meta = scan_points(scan, self.config, self._body_velocity())
        if len(points) < self.config.min_points:
            result = self._fail(PHASE_LOST, f"LOST: 有效点太少 ({len(points)})", Metrics(points=len(points)))
            result.metrics.dt_ms = (time.perf_counter() - t0) * 1000
            return result

        if self.awaiting_manual:
            metrics = self._measure(points, weights, self.pose) if self.pose is not None else Metrics(points=len(points))
            metrics.dt_ms = (time.perf_counter() - t0) * 1000
            return Result(
                pose=self.pose if self.pose is not None else np.zeros(3),
                phase=PHASE_AMBIGUOUS,
                message=self.message,
                metrics=metrics,
                valid=False,
            )

        if not self.tracking or self.pose is None:
            self.tracking = False
            if self.hypotheses and self.search_frames < self.config.bootstrap_frames:
                return self._advance_hypotheses(points, weights, t0)
            if (
                self.last_global_at is not None
                and now - self.last_global_at < 2.0
            ):
                metrics = Metrics(points=len(points))
                metrics.dt_ms = (time.perf_counter() - t0) * 1000
                return Result(
                    pose=self.pose if self.pose is not None else np.zeros(3),
                    phase=PHASE_SEARCHING,
                    message="等待下一轮全局定位…",
                    metrics=metrics,
                    valid=False,
                )
            return self._global(points, weights, t0)

        gap = 0.0 if self.last_accepted is None else max(0.0, now - self.last_accepted)
        if gap > self.config.tracking_gap:
            return self._lost(points, weights, t0, f"LOST: 跟踪中断 {gap:.1f}s")

        seed = self.pose + self.velocity * min(dt, 0.3)
        refined = self.refine(points, weights, seed)
        if self._acceptable(refined) and self._within_motion(seed, refined.pose, dt):
            return self._accept(refined, t0, dt)

        # Recover with a bounded search from the last accepted pose.
        recovered = self.refine(points, weights, self.pose)
        if self._acceptable(recovered):
            return self._accept(recovered, t0, dt)

        return self._lost(points, weights, t0, "LOST: 与先验地图不匹配")

    def _acceptable(self, result: Result) -> bool:
        return (
            result.metrics.inlier >= self.config.good_inlier
            and result.metrics.coverage >= self.config.min_coverage
            and result.metrics.confidence >= self.config.min_confidence
            and result.metrics.matched >= self.config.min_points
            and (result.metrics.rmse is None or result.metrics.rmse <= self.config.max_rmse)
        )

    def _within_motion(self, seed: np.ndarray, pose: np.ndarray, dt: float) -> bool:
        if dt <= 0:
            return True
        delta = pose - seed
        delta[2] = wrap(delta[2])
        allowed_xy = max(0.35, self.config.max_speed * dt)
        allowed_yaw = max(0.20, self.config.max_yaw_rate * dt)
        return bool(np.hypot(delta[0], delta[1]) <= allowed_xy and abs(delta[2]) <= allowed_yaw)

    def _body_velocity(self) -> np.ndarray:
        yaw = self.pose[2] if self.pose is not None else 0.0
        c, s = math.cos(yaw), math.sin(yaw)
        return np.array(
            [
                c * self.velocity[0] + s * self.velocity[1],
                -s * self.velocity[0] + c * self.velocity[1],
                self.velocity[2],
            ]
        )

    def _accept(self, result: Result, t0: float, dt: float) -> Result:
        pose = result.pose
        if self.pose is not None and dt > 0:
            delta = pose - self.pose
            delta[2] = wrap(delta[2])
            measured = delta / dt
            self.velocity = (
                self.velocity * self.config.velocity_decay + measured * (1 - self.config.velocity_decay)
            )
            self.velocity[:2] = np.clip(self.velocity[:2], -self.config.max_speed, self.config.max_speed)
            self.velocity[2] = float(
                np.clip(self.velocity[2], -self.config.max_yaw_rate, self.config.max_yaw_rate)
            )
        self.pose = pose
        self.phase = PHASE_TRACKING
        self.message = "定位跟踪中"
        self.tracking_frames += 1
        self.last_accepted = self.last_timestamp
        self.lost_since = None
        self.manual_seed = False
        result.metrics.dt_ms = (time.perf_counter() - t0) * 1000
        self.metrics = result.metrics
        return Result(pose=pose, phase=self.phase, message=self.message, metrics=result.metrics, valid=True)

    def _lost(self, points: np.ndarray, weights: np.ndarray, t0: float, message: str) -> Result:
        if self.lost_since is None:
            self.lost_since = self.last_timestamp
        lost_for = (
            0.0
            if self.lost_since is None or self.last_timestamp is None
            else max(0.0, self.last_timestamp - self.lost_since)
        )
        if lost_for >= self.config.relocalize_after and (
            self.last_global_at is None
            or (self.last_timestamp or 0.0) - self.last_global_at >= self.config.global_retry_interval
        ):
            return self._global(points, weights, t0, prefix=message)
        metrics = self._measure(points, weights, self.pose) if self.pose is not None else Metrics()
        result = self._fail(PHASE_LOST, message, metrics)
        result.metrics.dt_ms = (time.perf_counter() - t0) * 1000
        return result

    def _global(self, points: np.ndarray, weights: np.ndarray, t0: float, prefix: str = "") -> Result:
        self.phase = PHASE_SEARCHING
        self.message = "正在全局定位…"
        self.tracking = False
        candidates = self.global_search(points, weights)
        self.candidates = candidates
        self.search_frames = 1
        self.last_global_at = self.last_timestamp
        if not candidates:
            self.hypotheses = []
            self._hyp_scores = []
            return self._fail(
                PHASE_LOST,
                (prefix + "；" if prefix else "") + "LOST: 地图内没有可行位置",
                Metrics(points=len(points), dt_ms=(time.perf_counter() - t0) * 1000),
            )

        # Keep the best few *plausible* poses: a pose matching only a handful of
        # rays is not an ambiguity, it is a degenerate sliver of the scan.
        min_cov = 0.25
        plausible = [
            c
            for c in candidates
            if c.matched >= self.config.min_points and c.coverage >= min_cov
        ]
        for alt in self.last_alternatives:
            if all(
                math.hypot(alt.pose[0] - p.pose[0], alt.pose[1] - p.pose[1])
                > self.config.ambiguity_distance
                or abs(wrap(alt.pose[2] - p.pose[2])) > math.radians(20)
                for p in plausible
            ):
                plausible.append(alt)

        plausible.sort(key=lambda c: (c.score, c.inlier, -c.rmse), reverse=True)
        self.hypotheses = plausible[:4]
        self._hyp_scores = [c.score for c in self.hypotheses]

        best = plausible[0] if plausible else candidates[0]
        runner = next(
            (
                c
                for c in plausible[1:]
                if math.hypot(c.pose[0] - best.pose[0], c.pose[1] - best.pose[1])
                > self.config.ambiguity_distance
                or abs(wrap(c.pose[2] - best.pose[2])) > math.radians(20)
            ),
            None,
        )
        margin = best.score - (runner.score if runner else 0.0)
        metrics = self._measure(points, weights, best.pose)
        metrics.candidates = len(candidates)
        metrics.margin = margin
        metrics.dt_ms = (time.perf_counter() - t0) * 1000
        metrics.condition = self._condition(points, best.pose)

        if (
            best.inlier < self.config.min_inlier
            or best.matched < self.config.min_points
            or best.coverage < self.config.min_coverage
            or best.score < self.config.min_confidence
        ):
            self.phase = PHASE_LOST
            self.message = (prefix + "；" if prefix else "") + "LOST: 全局定位未找到可信位置"
            self.pose = best.pose
            self.metrics = metrics
            return Result(pose=best.pose, phase=self.phase, message=self.message, metrics=metrics, valid=False)

        if runner is not None and margin < self.config.ambiguity_margin:
            if len(self.hypotheses) > 1:
                # Ambiguous on one frame: let the next scans vote.
                self.phase = PHASE_SEARCHING
                self.message = "全局定位有多个候选，正在用后续帧确认…"
                self.pose = None
                self.metrics = metrics
                return Result(
                    pose=best.pose, phase=self.phase, message=self.message, metrics=metrics, valid=False
                )
            self.phase = PHASE_AMBIGUOUS
            self.message = "AMBIGUOUS: 多个候选得分接近，请点选初始位姿"
            self.pose = best.pose
            self.metrics = metrics
            self.awaiting_manual = True
            return Result(pose=best.pose, phase=self.phase, message=self.message, metrics=metrics, valid=False)

        return self._commit_global(best, metrics)

    def _advance_hypotheses(self, points: np.ndarray, weights: np.ndarray, t0: float) -> Result:
        """Vote between bootstrap hypotheses using a new scan."""
        self.phase = PHASE_SEARCHING
        self.message = "正在用后续帧确认初始位姿…"
        self.search_frames += 1
        scored: list[Candidate] = []
        totals: list[float] = []
        for index, hypothesis in enumerate(self.hypotheses):
            result = self.refine(points, weights, hypothesis.pose)
            candidate = Candidate(
                pose=result.pose,
                inlier=result.metrics.inlier,
                score=result.metrics.confidence,
                rmse=result.metrics.rmse if result.metrics.rmse is not None else float("inf"),
                matched=result.metrics.matched,
                coverage=result.metrics.coverage,
            )
            scored.append(candidate)
            previous = self._hyp_scores[index] if index < len(self._hyp_scores) else 0.0
            usable = (
                candidate.matched >= self.config.min_points
                and candidate.inlier >= self.config.min_inlier
                and candidate.coverage >= self.config.min_coverage
            )
            totals.append(previous + candidate.score if usable else previous * 0.5)

        order = sorted(range(len(scored)), key=lambda i: totals[i], reverse=True)
        scored = [scored[i] for i in order]
        totals = [totals[i] for i in order]
        best, best_total = scored[0], totals[0]
        runner_index = next(
            (
                i
                for i in range(1, len(scored))
                if math.hypot(scored[i].pose[0] - best.pose[0], scored[i].pose[1] - best.pose[1])
                > self.config.ambiguity_distance
                or abs(wrap(scored[i].pose[2] - best.pose[2])) > math.radians(20)
            ),
            None,
        )
        runner_total = totals[runner_index] if runner_index is not None else 0.0
        relative = (best_total - runner_total) / max(best_total, 1e-6)
        metrics = self._measure(points, weights, best.pose)
        metrics.candidates = len(scored)
        metrics.margin = relative
        metrics.dt_ms = (time.perf_counter() - t0) * 1000
        metrics.condition = self._condition(points, best.pose)

        acceptable = (
            best.inlier >= self.config.min_inlier
            and best.coverage >= self.config.min_coverage
            and best.score >= self.config.min_confidence
            and best.matched >= self.config.min_points
            and (not math.isfinite(best.rmse) or best.rmse <= self.config.max_rmse)
        )
        if acceptable and relative >= self.config.bootstrap_margin:
            self.hypotheses = []
            self._hyp_scores = []
            return self._commit_global(best, metrics)

        if self.search_frames >= self.config.bootstrap_frames:
            self.phase = PHASE_AMBIGUOUS
            self.message = "AMBIGUOUS: 多帧仍无法区分候选，请点选初始位姿"
            self.pose = best.pose
            self.metrics = metrics
            self.hypotheses = []
            self._hyp_scores = []
            self.awaiting_manual = True
            self.tracking = False
            return Result(pose=best.pose, phase=self.phase, message=self.message, metrics=metrics, valid=False)

        self.hypotheses = scored[:4]
        self._hyp_scores = totals[:4]
        self.pose = None
        self.metrics = metrics
        return Result(pose=best.pose, phase=self.phase, message=self.message, metrics=metrics, valid=False)

    def _commit_global(self, best: Candidate, metrics: Metrics) -> Result:
        self.pose = best.pose
        self.velocity[:] = 0
        self.phase = PHASE_TRACKING
        self.message = "全局定位成功"
        self.last_accepted = self.last_timestamp
        self.lost_since = None
        self.tracking_frames += 1
        self.hypotheses = []
        self._hyp_scores = []
        self.tracking = True
        self.awaiting_manual = False
        self.metrics = metrics
        return Result(pose=best.pose, phase=self.phase, message=self.message, metrics=metrics, valid=True)

    def _fail(self, phase: str, message: str, metrics: Metrics) -> Result:
        self.phase = phase
        self.message = message
        self.metrics = metrics
        pose = self.pose if self.pose is not None else np.zeros(3)
        return Result(pose=pose, phase=phase, message=message, metrics=metrics, valid=False)
