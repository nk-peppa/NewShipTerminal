#!/usr/bin/env python3
"""把一次会话录制转成 Scan v1 并用 SLAM 离线建图，输出目录保证唯一。

上游 ``batch_slam.py`` 的 "--output 必须是新目录" 只是先检查后创建，两个并发回放
使用同一个 ``--output`` 时仍可能互相覆盖。这里先用 ``O_CREAT | O_EXCL`` 的锁文件
原子地占住目录名，再交给 ``run_slam.py``，从流程上消除该竞态。

    python tools/replay-session.py --session recordings/session-20261030-101500
    python tools/replay-session.py --session <dir> --out-root out --label pool-test

退出码沿用 ``run_slam.py``：2 表示输入有误或只生成了质量不足的局部地图。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ALGO = HERE.parent / "algo"


def convert(session: Path, scans: Path) -> int:
    return subprocess.run(
        [
            sys.executable,
            str(HERE / "scan-log-to-jsonl.py"),
            "--session",
            str(session),
            "--output",
            str(scans),
        ]
    ).returncode


def reserve_output(root: Path, label: str) -> tuple[Path, Path]:
    """原子地占住一个尚未存在的输出目录名。

    ``run_slam.py`` 要求 ``--output`` 不存在，所以不能先建目录；这里用
    ``O_CREAT | O_EXCL`` 创建同名 ``.lock`` 文件来占位，并发调用只会有一个
    成功拿到该名字。返回 (待创建的输出目录, 需要清理的锁文件)。
    """
    root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    for attempt in range(1, 100):
        name = f"{label}-{stamp}" if attempt == 1 else f"{label}-{stamp}-{attempt}"
        candidate = root / name
        lock = root / f"{name}.lock"
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            continue
        if candidate.exists():
            lock.unlink(missing_ok=True)
            continue
        return candidate, lock
    raise SystemExit(f"无法在 {root} 下占住唯一输出目录")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--session", required=True, help="会话日志目录（含 rx.NNN.bin）")
    parser.add_argument("--out-root", default="out", help="输出根目录，默认 out/")
    parser.add_argument("--label", help="输出目录前缀，默认用会话目录名")
    parser.add_argument("--skip-convert", action="store_true", help="复用已存在的 scans.jsonl")
    args = parser.parse_args(argv)

    session = Path(args.session)
    if not session.is_dir():
        print(f"会话目录不存在: {session}", file=sys.stderr)
        return 2

    scans = session / "scans.jsonl"
    if not args.skip_convert and convert(session, scans) != 0:
        return 2
    if not scans.is_file():
        print(f"缺少扫描文件: {scans}", file=sys.stderr)
        return 2

    output, lock = reserve_output(Path(args.out_root), args.label or session.name)
    print(f"回放输出目录: {output}", file=sys.stderr)
    try:
        return subprocess.run(
            [
                sys.executable,
                str(ALGO / "run_slam.py"),
                "--input",
                str(scans),
                "--output",
                str(output),
            ]
        ).returncode
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
