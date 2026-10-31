"""Tunables for prior-map localization.

Everything here is recorded in the experiment ``config.json`` so an offline
review can reproduce the exact behaviour. Defaults were validated on synthetic
pool data only; field recordings may need different thresholds.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class LocalizerConfig:
    # --- matching ---------------------------------------------------------
    max_match_distance: float = 0.80  # m; distance-field truncation
    robust_scale: float = 0.10  # m; Cauchy weight scale
    inlier_distance: float = 0.15  # m; metric threshold
    good_inlier: float = 0.70  # accept a tracked pose
    min_inlier: float = 0.45  # accept a global candidate
    max_rmse: float = 0.10  # m
    gn_iterations: int = 24
    gn_step_xy: float = 0.25  # m per iteration
    gn_step_yaw: float = 0.08  # rad per iteration
    # --- local refinement -------------------------------------------------
    refine_span_xy: float = 0.16  # m
    refine_step_xy: float = 0.04  # m
    refine_span_yaw: float = math.radians(1.2)
    refine_step_yaw: float = math.radians(0.4)
    polish_span_xy: float = 0.05  # m
    polish_step_xy: float = 0.02  # m
    polish_span_yaw: float = math.radians(0.36)
    polish_step_yaw: float = math.radians(0.12)
    # --- global search ----------------------------------------------------
    global_step_xy: float = 0.60  # m
    global_step_yaw: float = math.radians(10.0)
    global_coarse_points: int = 120
    global_candidates: int = 16
    global_refine_points: int = 400
    global_min_clearance: float = 0.30  # m from occupied cells
    ambiguity_margin: float = 0.10  # best - runner-up score on one frame
    bootstrap_margin: float = 0.05  # relative cumulative lead after multi-frame vote
    ambiguity_distance: float = 0.60  # m; candidates closer than this are "same"
    # --- tracking ---------------------------------------------------------
    max_speed: float = 2.0  # m/s, gate on pose delta
    max_yaw_rate: float = 1.5  # rad/s
    tracking_gap: float = 2.0  # s; longer gap -> lost
    relocalize_after: float = 4.0  # s lost before auto global search
    velocity_decay: float = 0.85
    bootstrap_frames: int = 4  # frames used to disambiguate a global guess
    # --- scan conditioning ------------------------------------------------
    min_points: int = 60
    max_tilt: float = 0.21  # rad, same gate as the mapping side
    max_height: float = 0.35  # m
    deskew: bool = True

    def to_dict(self) -> dict:
        out = asdict(self)
        # radians are unreadable in a report; keep both
        for key in (
            "refine_span_yaw",
            "refine_step_yaw",
            "polish_span_yaw",
            "polish_step_yaw",
            "global_step_yaw",
        ):
            out[f"{key}_deg"] = math.degrees(float(getattr(self, key)))
        return out

    def validate(self) -> None:
        positive = (
            self.max_match_distance,
            self.robust_scale,
            self.inlier_distance,
            self.max_speed,
            self.max_yaw_rate,
            self.tracking_gap,
            self.refine_span_xy,
            self.refine_step_xy,
            self.polish_span_xy,
            self.polish_step_xy,
            self.global_step_xy,
            self.global_min_clearance,
        )
        if not all(math.isfinite(v) and v > 0 for v in positive):
            raise ValueError("定位参数必须为有限正数")
        if not 0 < self.min_inlier <= 1 or not 0 < self.good_inlier <= 1:
            raise ValueError("inlier 阈值必须在 (0, 1]")
        if self.min_points < 20:
            raise ValueError("min_points 至少 20")
        if self.global_candidates < 1:
            raise ValueError("global_candidates 至少 1")
        if self.bootstrap_frames < 1:
            raise ValueError("bootstrap_frames 至少 1")


DEFAULT_CONFIG = LocalizerConfig()
DEFAULT_CONFIG.validate()
