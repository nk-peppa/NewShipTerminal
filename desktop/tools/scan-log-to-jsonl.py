#!/usr/bin/env python3
"""把会话日志的雷达原始流（rx.NNN.bin）转成 SLAM 可回放的 Scan v1 JSONL。

主进程 SessionLogger 写出的 ``rx.NNN.bin`` 每条记录是
``u32 小端长度 | f64 小端 epoch 毫秒 | 原始 TCP 字节``。记录里的字节只是 TCP
流的一段：一帧可能被切成几段，也可能跨记录。所以这里先按记录顺序拼回字节流，
再按 ``AA 55`` 帧头重新分帧、校验 CRC，最后逐帧解码 SCAN / SCAN2。

输出的每行都是 Scan v1（x 前 / y 左 / 逆时针，弧度与米），可直接喂给离线建图：

    python tools/scan-log-to-jsonl.py --session recordings/session-20261030-101500
    python algo/run_slam.py --input recordings/session-20261030-101500/scans.jsonl --output out/run1

录制里没有逐束采样时刻、横滚与俯仰，回放时不做去畸变与姿态补偿，
SLAM 的诊断会相应标为 missing_timing / unavailable。
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algo"))

from cocommand2d.scan import Scan  # noqa: E402

MAGIC = b"\xaa\x55"
T_SCAN = 0x82
T_SCAN2 = 0x85
FRAME_HEADER = 8  # AA 55 | ver u8 | type u8 | seq u16 | len u16
RECORD_HEADER = 12  # u32 长度 | f64 epoch 毫秒


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    """CRC16-CCITT-FALSE，与船端协议一致。"""
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def read_records(paths):
    """按文件顺序读出 (到达时刻毫秒, 原始字节)；末尾截断的记录直接忽略。"""
    for path in paths:
        blob = path.read_bytes()
        offset = 0
        while offset + RECORD_HEADER <= len(blob):
            size = struct.unpack_from("<I", blob, offset)[0]
            at_ms = struct.unpack_from("<d", blob, offset + 4)[0]
            start = offset + RECORD_HEADER
            if size == 0 or start + size > len(blob):
                break
            yield at_ms, blob[start:start + size]
            offset = start + size


def parse_frames(records, stats):
    """把 TCP 字节流重新分帧；返回 (类型, 载荷, 该帧完成时的到达毫秒)。"""
    buf = bytearray()
    arrival = 0.0
    for at_ms, chunk in records:
        arrival = at_ms
        buf += chunk
        while True:
            index = buf.find(MAGIC)
            if index < 0:
                keep = min(1, len(buf))
                stats["dropped_bytes"] += len(buf) - keep
                del buf[: len(buf) - keep]
                break
            if index:
                stats["dropped_bytes"] += index
                del buf[:index]
            if len(buf) < FRAME_HEADER:
                break
            length = buf[6] | (buf[7] << 8)
            end = FRAME_HEADER + length
            if len(buf) < end + 2:
                break
            if crc16(bytes(buf[2:end])) != (buf[end] | (buf[end + 1] << 8)):
                stats["crc_errors"] += 1
                del buf[:1]
                continue
            stats["frames"] += 1
            payload = bytes(buf[FRAME_HEADER:end])
            frame_type = buf[3]
            del buf[: end + 2]
            yield frame_type, payload, arrival


def decode_points(header: bytes, count: int, encoding: int, data: bytes):
    if encoding == 1:
        data = zlib.decompress(data)
    elif encoding != 0:
        raise ValueError(f"未知点数据编码 {encoding}")
    if len(data) < count * 5:
        raise ValueError(f"点数据不足: {len(data)} < {count * 5}")
    words = np.frombuffer(data[: count * 5], dtype=np.uint8).reshape(count, 5).astype(np.uint16)
    angles_cw_deg = (words[:, 0] | (words[:, 1] << 8)).astype(float) / 100.0
    distances_mm = (words[:, 2] | (words[:, 3] << 8)).astype(float)
    quality = words[:, 4].astype(float)
    return angles_cw_deg, distances_mm, quality


def decode_scan(payload: bytes):
    if len(payload) < 8:
        raise ValueError("SCAN 过短")
    time_ms = struct.unpack_from("<I", payload, 0)[0]
    count = struct.unpack_from("<H", payload, 4)[0]
    encoding = payload[6]
    angles, distances, quality = decode_points(payload[:8], count, encoding, payload[8:])
    return time_ms, angles, distances, quality


def decode_scan2(payload: bytes):
    if len(payload) < 24:
        raise ValueError("SCAN2 过短")
    time_ms = struct.unpack_from("<I", payload, 4)[0]
    count = struct.unpack_from("<H", payload, 12)[0]
    encoding = payload[16]
    angles, distances, quality = decode_points(payload[:24], count, encoding, payload[24:])
    return time_ms, angles, distances, quality


class Clock:
    """船端时钟可能回退或归零；发现回退就整体加偏移，保持严格递增。"""

    def __init__(self) -> None:
        self.last = None
        self.offset = 0.0

    def seconds(self, time_ms: int, arrival_ms: float) -> float:
        base = (time_ms if time_ms > 0 else arrival_ms) / 1000.0
        value = base + self.offset
        if self.last is not None and value <= self.last:
            self.offset += (self.last - value) + 0.001
            value = base + self.offset
        self.last = value
        return value


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--session", help="会话日志目录，自动读取其中所有 rx.NNN.bin")
    parser.add_argument("--rx", action="append", help="直接指定 rx 分片，可重复")
    parser.add_argument("--output", help="输出 JSONL；默认写到第一个 rx 分片同目录的 scans.jsonl")
    args = parser.parse_args(argv)

    if args.session:
        paths = sorted(Path(args.session).glob("rx.*.bin"))
    elif args.rx:
        paths = [Path(item) for item in args.rx]
    else:
        parser.error("必须给 --session 或 --rx")
    if not paths:
        print("没有找到 rx.*.bin", file=sys.stderr)
        return 2

    output = Path(args.output) if args.output else paths[0].parent / "scans.jsonl"
    stats = {"frames": 0, "crc_errors": 0, "dropped_bytes": 0, "bad_scans": 0, "rejected": 0}
    clock = Clock()
    scans = scan2 = written = 0

    with output.open("w", encoding="utf-8", newline="\n") as handle:
        for frame_type, payload, arrival in parse_frames(read_records(paths), stats):
            if frame_type not in (T_SCAN, T_SCAN2):
                continue
            try:
                if frame_type == T_SCAN2:
                    scan2 += 1
                    time_ms, angles, distances, quality = decode_scan2(payload)
                else:
                    scans += 1
                    time_ms, angles, distances, quality = decode_scan(payload)
            except (ValueError, zlib.error):
                stats["bad_scans"] += 1
                continue
            if not len(angles):
                continue
            try:
                scan = Scan.from_c1(clock.seconds(time_ms, arrival), angles, distances, quality)
            except ValueError:
                stats["rejected"] += 1
                continue
            handle.write(json.dumps(scan.to_dict(), separators=(",", ":")) + "\n")
            written += 1

    print(
        f"rx 分片 {len(paths)} 个；帧 {stats['frames']}（SCAN {scans} / SCAN2 {scan2}）；"
        f"CRC 错误 {stats['crc_errors']}；丢弃字节 {stats['dropped_bytes']}；"
        f"坏扫描 {stats['bad_scans']}；越界拒绝 {stats['rejected']}",
        file=sys.stderr,
    )
    print(f"写出 {written} 帧 → {output}", file=sys.stderr)
    return 0 if written else 2


if __name__ == "__main__":
    raise SystemExit(main())
