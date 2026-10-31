import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExperimentRecorder } from '../src/main/experiments/experimentRecorder.js';
import type { PoseView } from '../src/shared/api.js';
import type { ScanFrame } from '../src/shared/protocol.js';

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usv-exp-test-'));
}

function fakeMap(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'map.pgm'), Buffer.from('P5\n2 2\n255\n\x00\xfe\xcd\xfe'));
  fs.writeFileSync(path.join(dir, 'map.yaml'), 'image: map.pgm\nresolution: 0.08\norigin: [0, 0, 0]\n');
  return dir;
}

function pose(x: number, phase: string, valid = true): PoseView {
  return {
    t: 1234,
    x,
    y: -x,
    yaw: 0.5,
    status: phase.toUpperCase(),
    phase,
    mode: 'localization',
    poseValid: valid,
    rmse: 0.02,
    inlier: 0.8,
    confidence: 0.7,
    matched: 200,
    dtMs: 40,
  };
}

function scan(count = 4): ScanFrame {
  return {
    timeMs: 1000,
    encoding: 0,
    count,
    // C1 frame: clockwise, 0 = forward
    anglesRad: new Float32Array([0, Math.PI / 2, Math.PI, -Math.PI / 2]),
    rangesM: new Float32Array([1, 2, 3, 0]),
    qualities: new Uint8Array([30, 30, 30, 30]),
    qualityMax: 63,
  };
}

function readJsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const OPTS = (baseDir: string, mapDir: string) => ({
  baseDir,
  appVersion: '0.1.0-test',
  ship: { host: '127.0.0.1', port: 9527, firmware: '0.4.0', caps: 33 },
  map: { name: 'pool', hash: 'sha256:abc', dir: mapDir },
  config: { robust_scale: 0.1 },
  sessionLogDir: 'C:/logs/session-x',
});

test('experiment writes CSV, Scan v1 JSONL, events, map copy and summary', async () => {
  const base = tempBase();
  const mapDir = fakeMap(path.join(base, 'map-src'));
  const rec = await ExperimentRecorder.create(OPTS(path.join(base, 'experiments'), mapDir));
  assert.ok(fs.existsSync(rec.directory));

  rec.pose(pose(1.0, 'tracking'));
  rec.pose(pose(1.1, 'lost', false));
  rec.scan(scan(), undefined, 1_700_000_000_000);
  rec.event('manual-pose', { x: 0.5 });
  rec.localizationState({
    phase: 'searching',
    message: 'searching',
    map: 'pool',
    frames: 1,
    trackingFrames: 0,
    candidates: [{ x: 1, y: 2, yaw: 0, inlier: 0.9, score: 0.8 }],
    metrics: {
      rmse: 0.02,
      inlier: 0.9,
      coverage: 0.6,
      matched: 200,
      points: 300,
      confidence: 0.7,
      dtMs: 40,
      candidates: 1,
      margin: 0.2,
    },
  });

  assert.equal(rec.stats().frames, 2);
  assert.equal(rec.stats().tracking, 1);
  assert.equal(rec.stats().lost, 1);
  assert.equal(rec.stats().scans, 1);
  assert.equal(rec.stats().map, 'pool');
  const dir = await rec.finalize('test');
  assert.equal(dir, rec.directory);

  const csv = fs.readFileSync(path.join(rec.directory, 'localization.csv'), 'utf8').trim().split('\n');
  assert.equal(
    csv[0],
    'recv_ms,boat_t_ms,x_m,y_m,yaw_rad,yaw_deg,status,pose_valid,rmse_m,inlier,confidence,matched_points,dt_ms',
  );
  assert.equal(csv.length, 3);
  assert.match(csv[1]!, /,1,-1,0\.5,28\.648,/);
  assert.match(csv[2]!, /,lost,0,/);

  const scans = readJsonl(path.join(rec.directory, 'scans.jsonl'));
  assert.equal(scans.length, 1);
  const s = scans[0] as {
    version: number;
    frame: string;
    angles: number[];
    ranges: number[];
    valid: boolean[];
    source: string;
  };
  assert.equal(s.version, 1);
  assert.equal(s.frame, 'x_forward_y_left_ccw');
  // C1 clockwise 90° must become -90° in the x-forward/y-left frame.
  assert.ok(Math.abs(s.angles[1]! + Math.PI / 2) < 1e-3);
  assert.deepEqual(s.ranges, [1, 2, 3, 0]);
  assert.deepEqual(s.valid, [true, true, true, false]);
  assert.equal(s.source, 'c1-sdk');

  const events = readJsonl(path.join(rec.directory, 'events.jsonl'));
  assert.ok(events.some((e) => e.type === 'experiment-start'));
  assert.ok(events.some((e) => e.type === 'manual-pose'));
  assert.ok(events.some((e) => e.type === 'localization-state'));
  assert.ok(events.some((e) => e.type === 'experiment-stop'));

  const meta = JSON.parse(fs.readFileSync(path.join(rec.directory, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'done');
  assert.equal(meta.map.name, 'pool');
  assert.equal(meta.sessionLogDir, 'C:/logs/session-x');

  const summary = JSON.parse(fs.readFileSync(path.join(rec.directory, 'summary.json'), 'utf8'));
  assert.equal(summary.frames, 2);
  assert.equal(summary.tracking, 1);
  assert.equal(summary.lost, 1);
  assert.equal(summary.scans, 1);
  assert.equal(summary.map.hash, 'sha256:abc');
  assert.equal(summary.sessionLogDir, 'C:/logs/session-x');
  assert.equal(summary.finalPose.valid, false);
  assert.equal(summary.trackingRatio, 0.5);

  assert.ok(fs.existsSync(path.join(rec.directory, 'map.pgm')));
  assert.ok(fs.existsSync(path.join(rec.directory, 'map.yaml')));
  assert.ok(fs.existsSync(path.join(rec.directory, 'config.json')));
  assert.ok(fs.readFileSync(path.join(rec.directory, 'README.txt'), 'utf8').includes('x 向前'));
});

test('experiment directory names never collide', async () => {
  const base = tempBase();
  const mapDir = fakeMap(path.join(base, 'map-src'));
  const at = new Date(2026, 9, 31, 12, 0, 0);
  const a = await ExperimentRecorder.create(OPTS(path.join(base, 'experiments'), mapDir), at);
  await a.finalize('test');
  const b = await ExperimentRecorder.create(OPTS(path.join(base, 'experiments'), mapDir), at);
  await b.finalize('test');
  assert.notEqual(a.directory, b.directory);
  assert.ok(fs.existsSync(a.directory));
  assert.ok(fs.existsSync(b.directory));
});

test('finalize is idempotent and scans are ignored afterwards', async () => {
  const base = tempBase();
  const mapDir = fakeMap(path.join(base, 'map-src'));
  const rec = await ExperimentRecorder.create(OPTS(path.join(base, 'experiments'), mapDir));
  rec.scan(scan());
  await rec.finalize('test');
  rec.scan(scan());
  rec.pose(pose(2.0, 'tracking'));
  assert.equal(rec.stats().scans, 1);
  assert.equal(rec.stats().frames, 0);
  assert.equal(await rec.finalize('again'), rec.directory);

  const summaryPath = path.join(rec.directory, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.frames, 0);
  assert.equal(summary.scans, 1);
});
