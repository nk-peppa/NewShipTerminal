"""Batch entry point: JSONL scan sequence in, occupancy map and trajectory out."""
import argparse
import json
from pathlib import Path
import time

from .recording import replay, save_result
from .slam import LidarSlam, SlamConfig


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Build a 2D occupancy map from a timestamped JSONL lidar sequence.")
    parser.add_argument("--input", required=True, help="Input JSONL recording in Scan v1 format")
    parser.add_argument("--output", required=True, help="New directory for map and trajectory")
    parser.add_argument("--extent", type=float, default=40.0, help="Square map width in metres")
    parser.add_argument("--resolution", type=float, default=0.08, help="Grid resolution in metres")
    parser.add_argument("--recovery-window", type=float, default=5.0,
                        help="Seconds since last trusted scan allowed to finish recovery")
    parser.add_argument("--recovery-confirmations", type=int, default=3,
                        help="Consecutive matching scans needed to resume mapping (at least 2)")
    parser.add_argument("--water-ring-filter", action=argparse.BooleanOptionalAction, default=True,
                        help="Straight-edged pool arc filter; disable near real circular structures")
    parser.add_argument("--pool-noise-filter", action=argparse.BooleanOptionalAction, default=True,
                        help="Use extended wall anchors and temporal validation of other map points")
    args = parser.parse_args(argv)

    destination = Path(args.output)
    if destination.exists():
        parser.error("--output must be a new directory; existing results are never overwritten")
    try:
        config = SlamConfig(max_tracking_gap=args.recovery_window,
                            recovery_confirmations=args.recovery_confirmations,
                            water_ring_filter=args.water_ring_filter,
                            pool_noise_filter=args.pool_noise_filter)
        slam = LidarSlam(extent=args.extent, resolution=args.resolution, config=config)
    except ValueError as exc:
        parser.error(str(exc))
    started = time.perf_counter()
    frames = 0
    try:
        for scan in replay(args.input):
            slam.update(scan)
            frames += 1
    except (OSError, ValueError, TypeError) as exc:
        parser.error(str(exc))
    if not frames:
        parser.error("Input contains no scans")
    save_result(slam, destination)
    summary = {
        "input": str(Path(args.input)),
        "frames": frames,
        "accepted_frames": slam.accepted,
        "rejected_frames": frames-slam.accepted,
        "initializing_in_rejected_count": sum(row["status"].startswith("INITIALIZING") for row in slam.diagnostics),
        "elapsed_seconds": round(time.perf_counter()-started, 3),
        "status": slam.status,
        "final_pose_x_y_yaw": slam.pose.tolist(),
        "observed_cells": int(slam.grid.observed.sum()),
        "extent_m": args.extent,
        "resolution_m": args.resolution,
        "coordinate_frame": "initial_scan_x_forward_y_left_ccw",
        "origin_timestamp": slam.origin_timestamp,
        "quarantined_frames": sum(row.get("quarantined_points", 0) > 0 for row in slam.diagnostics),
        "deskew_frames": sum(row.get("deskew") == "constant_twist" for row in slam.diagnostics),
        "attitude_frames": sum(row.get("tilt") == "projected" for row in slam.diagnostics),
        "recovery_window_seconds": config.max_tracking_gap,
        "recoveries": sum(row.get("recovered", False) for row in slam.diagnostics),
        "recovery_confirmation_frames": sum(row["status"].startswith("RECOVERING") for row in slam.diagnostics),
        "water_ring_filter": config.water_ring_filter,
        "pool_noise_filter": config.pool_noise_filter,
        "temporal_withheld_points": sum(row.get("temporal_withheld", 0) for row in slam.diagnostics),
        "ring_rejected_points": sum(row.get("ring_rejected", 0) for row in slam.diagnostics),
    }
    (destination / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    # A saved partial/empty map is not proof that localization succeeded.
    if slam.accepted < 3 or (frames-slam.accepted)/frames > .2 or summary["quarantined_frames"]/frames > .2:
        print("WARNING: incomplete or inconsistent mapping; inspect diagnostics.csv. Map is partial.")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
