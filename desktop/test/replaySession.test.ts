import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildFrame, T_SCAN } from '../src/shared/protocol.js';

/**
 * tools/replay-session.py：转换 + 回放，并保证输出目录唯一。
 * 关键点：连续两次回放同一会话必须落到两个不同目录，不能互相覆盖。
 */

const desktopRoot = path.resolve(__dirname, '..', '..');
const python = process.env.PYTHON ?? 'python';
const pythonReady = spawnSync(python, ['-c', 'import numpy'], { stdio: 'ignore' }).status === 0;

/** 6 m × 4 m 房间、360 束的一圈扫描（角度顺时针、距离米）。 */
function roomScan(count = 360): { anglesCW: number[]; ranges: number[] } {
  const anglesCW: number[] = [];
  const ranges: number[] = [];
  for (let k = 0; k < count; k++) {
    const deg = (k * 360) / count;
    const phi = (deg * Math.PI) / 180;
    const dx = Math.cos(phi);
    const dy = Math.sin(phi);
    let best = Number.POSITIVE_INFINITY;
    const walls: Array<[number, number, boolean]> = [
      [6, dx, false],
      [-6, dx, false],
      [4, dy, true],
      [-4, dy, true],
    ];
    for (const [wall, dir, horizontal] of walls) {
      if (Math.abs(dir) < 1e-9) continue;
      const t = wall / dir;
      if (t <= 0) continue;
      const inside = horizontal ? Math.abs(t * dx) <= 6 + 1e-6 : Math.abs(t * dy) <= 4 + 1e-6;
      if (inside) best = Math.min(best, t);
    }
    anglesCW.push(deg);
    ranges.push(Number.isFinite(best) && best <= 12 ? best : 0);
  }
  return { anglesCW, ranges };
}

function scanFrame(seq: number, timeMs: number, anglesCW: number[], ranges: number[]): Buffer {
  const count = anglesCW.length;
  const points = Buffer.alloc(5 * count);
  for (let i = 0; i < count; i++) {
    points.writeUInt16LE(Math.round((anglesCW[i] ?? 0) * 100), i * 5);
    points.writeUInt16LE(Math.round((ranges[i] ?? 0) * 1000), i * 5 + 2);
    points.writeUInt8(60, i * 5 + 4);
  }
  const payload = Buffer.alloc(8 + points.length);
  payload.writeUInt32LE(timeMs, 0);
  payload.writeUInt16LE(count, 4);
  payload.writeUInt8(0, 6);
  points.copy(payload, 8);
  return buildFrame(T_SCAN, seq, payload);
}

test('回放会话：两次运行落到不同输出目录', { skip: !pythonReady && 'python + numpy 不可用' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-replay-'));
  const session = path.join(dir, 'session-test');
  const outRoot = path.join(dir, 'out');
  fs.mkdirSync(session, { recursive: true });

  const { anglesCW, ranges } = roomScan();
  const frames = Buffer.concat(
    Array.from({ length: 20 }, (_, i) => scanFrame(i + 1, 1000 + i * 100, anglesCW, ranges)),
  );
  const head = Buffer.alloc(12);
  head.writeUInt32LE(frames.length, 0);
  head.writeDoubleLE(1_760_000_000_000, 4);
  fs.writeFileSync(path.join(session, 'rx.000.bin'), Buffer.concat([head, frames]));

  const runOnce = () =>
    spawnSync(
      python,
      [
        path.join(desktopRoot, 'tools', 'replay-session.py'),
        '--session',
        session,
        '--out-root',
        outRoot,
        '--label',
        'sess',
      ],
      { encoding: 'utf8', cwd: desktopRoot, timeout: 180000 },
    );

  const first = runOnce();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const second = runOnce();
  assert.equal(second.status, 0, second.stdout + second.stderr);

  const outputs = fs.readdirSync(outRoot).filter((name) =>
    fs.statSync(path.join(outRoot, name)).isDirectory(),
  );
  assert.equal(outputs.length, 2, `两次回放必须各用一个目录，实际: ${outputs.join(',')}`);
  for (const name of outputs) {
    const out = path.join(outRoot, name);
    for (const file of ['summary.json', 'trajectory.csv', 'map.pgm']) {
      assert.ok(fs.existsSync(path.join(out, file)), `${name} 缺少 ${file}`);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
});
