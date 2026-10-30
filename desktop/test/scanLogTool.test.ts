import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildFrame, T_SCAN, T_SCAN2 } from '../src/shared/protocol.js';

/**
 * tools/scan-log-to-jsonl.py：会话日志原始 TCP 流 → Scan v1 JSONL。
 * 覆盖点：跨记录重分帧、CRC 坏帧丢弃、SCAN 与 SCAN2 两种载荷、顺时针角度取反。
 */

const desktopRoot = path.resolve(__dirname, '..', '..');
const python = process.env.PYTHON ?? 'python';
const pythonReady = spawnSync(python, ['-c', 'import numpy'], { stdio: 'ignore' }).status === 0;

interface ScanLine {
  version: number;
  frame: string;
  timestamp: number;
  angles: number[];
  ranges: number[];
  quality: number[];
  valid: boolean[];
}

/** 3 个点：顺时针 0°/10°/20°，距离 1/2/3 m，质量 60。 */
function pointBlock(): Buffer {
  const block = Buffer.alloc(15);
  const write = (i: number, angleDegX100: number, distMm: number) => {
    block.writeUInt16LE(angleDegX100, i * 5);
    block.writeUInt16LE(distMm, i * 5 + 2);
    block.writeUInt8(60, i * 5 + 4);
  };
  write(0, 0, 1000);
  write(1, 1000, 2000);
  write(2, 2000, 3000);
  return block;
}

function scanPayload(timeMs: number): Buffer {
  const points = pointBlock();
  const payload = Buffer.alloc(8 + points.length);
  payload.writeUInt32LE(timeMs, 0);
  payload.writeUInt16LE(3, 4);
  payload.writeUInt8(0, 6); // 原始点数据，不压缩
  points.copy(payload, 8);
  return payload;
}

function scan2Payload(tStartMs: number, timeMs: number): Buffer {
  const points = pointBlock();
  const payload = Buffer.alloc(24 + points.length);
  payload.writeUInt32LE(tStartMs, 0);
  payload.writeUInt32LE(timeMs, 4);
  payload.writeUInt32LE(1, 8);
  payload.writeUInt16LE(3, 12);
  payload.writeUInt16LE(3, 14);
  payload.writeUInt8(0, 16);
  payload.writeUInt8(0x01, 17); // lidarOk
  payload.writeUInt16LE(1000, 18); // 10.00 Hz
  payload.writeUInt8(63, 20);
  points.copy(payload, 24);
  return payload;
}

/** 会话日志的记录格式：u32 长度 | f64 epoch 毫秒 | 字节。 */
function record(atMs: number, data: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(data.length, 0);
  head.writeDoubleLE(atMs, 4);
  return Buffer.concat([head, data]);
}

const near = (actual: number[], expected: number[]) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - (expected[i] ?? NaN)) < 1e-6, `${i}: ${value}`));
};

test('扫描日志转 JSONL：跨记录重分帧、坏 CRC 丢弃、SCAN2 兼容', { skip: !pythonReady && 'python + numpy 不可用' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-scanlog-'));
  const scan = buildFrame(T_SCAN, 1, scanPayload(1000));
  const broken = Buffer.from(buildFrame(T_SCAN, 2, scanPayload(1100)));
  const lastIndex = broken.length - 1;
  broken.writeUInt8(broken.readUInt8(lastIndex) ^ 0xff, lastIndex); // 破坏 CRC
  const scan2 = buildFrame(T_SCAN2, 3, scan2Payload(1150, 1200));
  const stream = Buffer.concat([scan, broken, scan2]);

  // 故意在帧中间切开，验证按记录拼流后仍能重新分帧
  const cutA = 7;
  const cutB = Math.floor(stream.length / 2);
  const chunks = [stream.subarray(0, cutA), stream.subarray(cutA, cutB), stream.subarray(cutB)];
  const rx = Buffer.concat(chunks.map((chunk, i) => record(500 + i, chunk)));
  fs.writeFileSync(path.join(dir, 'rx.000.bin'), rx);

  const out = path.join(dir, 'scans.jsonl');
  const run = spawnSync(
    python,
    [path.join(desktopRoot, 'tools', 'scan-log-to-jsonl.py'), '--session', dir, '--output', out],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);

  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, '坏 CRC 的帧必须被丢弃');
  const parsed = lines.map((line) => JSON.parse(line) as ScanLine);

  const first = parsed[0];
  assert.ok(first);
  assert.equal(first.version, 1);
  assert.equal(first.frame, 'x_forward_y_left_ccw');
  assert.equal(first.timestamp, 1);
  near(first.angles, [0, -Math.PI / 18, -Math.PI / 9]); // 顺时针 0/10/20° → 逆时针取反
  near(first.ranges, [1, 2, 3]);
  near(first.quality, [60, 60, 60]);
  assert.deepEqual(first.valid, [true, true, true]);

  const last = parsed[1];
  assert.ok(last);
  assert.equal(last.timestamp, 1.2, 'SCAN2 用头部的圈完成时刻');
  near(last.ranges, [1, 2, 3]);

  fs.rmSync(dir, { recursive: true, force: true });
});
