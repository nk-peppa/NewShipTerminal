import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ST_ARMED, ST_ESTOP, ST_LIDAR_OK, type Status } from '../src/shared/protocol.js';
import { crc32Of, zipDirectoryToFile } from '../src/main/log/logArchive.js';
import {
  pruneLogSessions,
  SessionLogger,
  WIRE_RECORD_HEADER,
  type ScanLogFrame,
} from '../src/main/log/sessionLog.js';

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usv-log-test-'));
}

function readJsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readWire(file: string): { at: number; data: Buffer }[] {
  const buf = fs.readFileSync(file);
  const out: { at: number; data: Buffer }[] = [];
  let off = 0;
  while (off + WIRE_RECORD_HEADER <= buf.length) {
    const len = buf.readUInt32LE(off);
    const at = buf.readDoubleLE(off + 4);
    out.push({ at, data: buf.subarray(off + WIRE_RECORD_HEADER, off + WIRE_RECORD_HEADER + len) });
    off += WIRE_RECORD_HEADER + len;
  }
  assert.equal(off, buf.length, '原始流记录必须刚好铺满文件');
  return out;
}

const STATUS: Status = {
  timeMs: 1234,
  throttleX10: 153,
  direction: 1,
  servosX10: [105, 0, 0, 0],
  flags: ST_ARMED | ST_ESTOP | ST_LIDAR_OK,
  rxSeq: 42,
  rxErrors: 3,
  pointsLast: 450,
  scansTotal: 77,
  loopHzX10: 500,
};

const SCAN: ScanLogFrame = {
  timeMs: 1234,
  encoding: 0,
  count: 3,
  anglesRad: new Float32Array([0, 1, 2]),
  rangesM: new Float32Array([0, 1.5, 2.25]),
  qualities: new Uint8Array([0, 80, 60]),
  qualityMax: 255,
  tStartMs: 1200,
  scanSeq: 9,
  rateHz: 9.5,
};

test('会话日志：目录、meta 与 README', () => {
  const base = tempBase();
  try {
    const log = new SessionLogger({ baseDir: base, meta: { app: { version: '1.2.3' } } });
    try {
      assert.match(path.basename(log.dir), /^session-\d{8}-\d{6}$/);
      assert.ok(fs.existsSync(log.dir));

      const meta = JSON.parse(fs.readFileSync(path.join(log.dir, 'meta.json'), 'utf8'));
      assert.equal(meta.schema, 1);
      assert.equal(meta.kind, 'usv-terminal-session-log');
      assert.equal(meta.app.version, '1.2.3');
      assert.equal(meta.dir, log.dir);

      const readme = fs.readFileSync(path.join(log.dir, 'README.txt'), 'utf8');
      assert.match(readme, /rx\.NNN\.bin/);
      assert.match(readme, /u32 length \| f64 epoch_ms/);
    } finally {
      log.close('test');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('会话日志：STATUS / CMD / SCAN / POSE CSV 与事件 JSONL', () => {
  const base = tempBase();
  const t = 1_790_000_000_000;
  const log = new SessionLogger({ baseDir: base, now: () => t });
  try {
    log.event('info', 'ui-arm', { on: true });
    log.warn('decode-error', { message: 'bad frame' });
    log.status(STATUS);
    log.command({ throttleX10: 150, servosX10: [100, 0, 0, 0], flags: 0x03 });
    log.uiCommand(0.25, -0.5);
    log.scan(SCAN);
    log.pose({
      t: 1234,
      x: 1.25,
      y: -2.5,
      yaw: 0.5,
      status: 'TRACKING',
      rmse: 0.02,
      inlier: 0.9,
      scans: 9,
      skipped: 1,
    });

    const statusLines = fs.readFileSync(path.join(log.dir, 'status.csv'), 'utf8').trim().split('\n');
    assert.equal(statusLines.length, 2);
    assert.equal(
      statusLines[0],
      'recv_ms,boat_ms,throttle_pct,direction,servo1_deg,armed,estop,failsafe,lidar_ok,' +
        'arm_required,rx_seq,rx_errors,points_last,scans_total,loop_hz',
    );
    assert.equal(statusLines[1], '1790000000000,1234,15.3,1,10.5,1,1,0,1,0,42,3,450,77,50.0');

    const cmdLines = fs.readFileSync(path.join(log.dir, 'cmd.csv'), 'utf8').trim().split('\n');
    assert.equal(cmdLines[1], '1790000000000,15.0,10.0,3,1,1');

    const uiLines = fs.readFileSync(path.join(log.dir, 'ui.csv'), 'utf8').trim().split('\n');
    assert.equal(uiLines[0], 'recv_ms,throttle_norm,rudder_norm');
    assert.equal(uiLines[1], '1790000000000,0.250,-0.500');

    const scanLines = fs.readFileSync(path.join(log.dir, 'scan.csv'), 'utf8').trim().split('\n');
    assert.equal(scanLines[1], '1790000000000,1234,3,0,255,1.500,2.250,1200,9,9.50');

    const poseLines = fs.readFileSync(path.join(log.dir, 'pose.csv'), 'utf8').trim().split('\n');
    assert.equal(poseLines[1], '1790000000000,1234,1.25,-2.5,0.5,TRACKING,0.02,0.9,9,1');

    const events = readJsonl(path.join(log.dir, 'client.jsonl'));
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'ui-arm');
    assert.equal(events[0]?.on, true);
    assert.equal(events[0]?.level, 'info');
    assert.equal(events[1]?.level, 'warn');

    const stats = log.stats();
    assert.equal(stats.statusRows, 1);
    assert.equal(stats.cmdRows, 1);
    assert.equal(stats.uiRows, 1);
    assert.equal(stats.scanRows, 1);
    assert.equal(stats.poseRows, 1);
    assert.equal(stats.events, 2);
    assert.equal(stats.errorEvents, 0);
  } finally {
    log.close('test');
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('会话日志：STATUS 船钟缺口与船端重启识别', () => {
  const base = tempBase();
  const t = 1_790_000_000_000;
  const log = new SessionLogger({ baseDir: base, now: () => t, statusGapMs: 100 });
  try {
    // 50Hz 连续 5 帧：不应记缺口，最大间隔就是 20ms
    for (let i = 0; i < 5; i++) log.status({ ...STATUS, timeMs: 1000 + i * 20 });
    assert.equal(log.stats().statusGaps, 0);
    assert.equal(log.stats().maxStatusGapMs, 20);

    // 1080 → 1220：跳了 140ms（50Hz 下丢了 6 帧）
    log.status({ ...STATUS, timeMs: 1220 });
    assert.equal(log.stats().statusGaps, 1);
    assert.equal(log.stats().maxStatusGapMs, 140);

    // 再跳 500ms
    log.status({ ...STATUS, timeMs: 1720 });
    assert.equal(log.stats().statusGaps, 2);
    assert.equal(log.stats().maxStatusGapMs, 500);

    // 船端重启：timeMs 归零不算缺口，但要留事件
    log.status({ ...STATUS, timeMs: 0 });
    log.status({ ...STATUS, timeMs: 20 });
    assert.equal(log.stats().statusGaps, 2);

    const events = readJsonl(path.join(log.dir, 'client.jsonl'));
    const gaps = events.filter((e) => e.type === 'status-gap');
    assert.equal(gaps.length, 2);
    assert.deepEqual(
      gaps.map((e) => [e.gapMs, e.boatMs]),
      [
        [140, 1220],
        [500, 1720],
      ],
    );
    assert.equal(events.filter((e) => e.type === 'status-time-reset').length, 1);
  } finally {
    log.close('test');
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('会话日志：原始流记录格式与分片', () => {
  const base = tempBase();
  const t = 1_790_000_000_000;
  // 每条记录 12B 头 + 20B 数据 = 32B，上限 40B 时每条都放不进同一分片
  const log = new SessionLogger({ baseDir: base, rawPartBytes: 40, now: () => t });
  try {
    log.wire('rx', Buffer.from('AAAAAAAAAAAAAAAAAAAA')); // 20 B
    log.wire('rx', Buffer.from('BBBBBBBBBBBBBBBBBBBB'));
    log.wire('rx', Buffer.from('CCCCCCCCCCCCCCCCCCCC'));
    log.wire('tx', Buffer.from('TX'));

    const rx000 = readWire(path.join(log.dir, 'rx.000.bin'));
    const rx001 = readWire(path.join(log.dir, 'rx.001.bin'));
    const rx002 = readWire(path.join(log.dir, 'rx.002.bin'));
    assert.equal(rx000.length, 1);
    assert.equal(rx001.length, 1);
    assert.equal(rx002.length, 1);
    assert.equal(rx000[0]?.data.toString(), 'AAAAAAAAAAAAAAAAAAAA');
    assert.equal(rx001[0]?.data.toString(), 'BBBBBBBBBBBBBBBBBBBB');
    assert.equal(rx002[0]?.data.toString(), 'CCCCCCCCCCCCCCCCCCCC');
    assert.equal(rx000[0]?.at, t);

    const tx = readWire(path.join(log.dir, 'tx.000.bin'));
    assert.equal(tx.length, 1);
    assert.equal(tx[0]?.data.toString(), 'TX');
    assert.equal(log.stats().rxBytes, 3 * (WIRE_RECORD_HEADER + 20));
    assert.equal(log.stats().txBytes, WIRE_RECORD_HEADER + 2);
  } finally {
    log.close('test');
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('会话日志：按数量清理旧会话，不碰无关目录', () => {
  const base = tempBase();
  try {
    for (const name of [
      'session-20260101-000000',
      'session-20260102-000000',
      'session-20260103-000000',
      'not-a-session',
    ]) {
      fs.mkdirSync(path.join(base, name));
    }

    const removed = pruneLogSessions(base, 2);
    assert.deepEqual(removed, ['session-20260101-000000']);
    assert.ok(fs.existsSync(path.join(base, 'session-20260102-000000')));
    assert.ok(fs.existsSync(path.join(base, 'session-20260103-000000')));
    assert.ok(fs.existsSync(path.join(base, 'not-a-session')));

    const log = new SessionLogger({ baseDir: base, keepSessions: 1 });
    log.close('test');
    const sessions = fs
      .readdirSync(base)
      .filter((n) => n.startsWith('session-'))
      .sort();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0], path.basename(log.dir));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('日志导出：store ZIP 结构、CRC 与附加 snapshot', () => {
  const base = tempBase();
  try {
    const log = new SessionLogger({ baseDir: base });
    log.event('info', 'hello', { n: 1 });
    log.status(STATUS);
    log.close('test');

    const dest = path.join(base, 'export.zip');
    const extra = Buffer.from('{"exported":true}\n', 'utf8');
    const outcome = zipDirectoryToFile(log.dir, dest, [{ name: 'snapshot.json', data: extra }]);
    assert.equal(fs.statSync(dest).size, outcome.bytes);
    assert.ok(outcome.files.includes('snapshot.json'));
    assert.ok(outcome.files.includes('status.csv'));

    const buf = fs.readFileSync(dest);
    const entries = readZip(buf);
    assert.deepEqual(entries.get('snapshot.json'), extra);
    assert.match(entries.get('client.jsonl')?.toString('utf8') ?? '', /"type":"hello"/);
    assert.match(entries.get('meta.json')?.toString('utf8') ?? '', /usv-terminal-session-log/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** 最小只读 ZIP 解析：只支持 store，用于反向校验导出的包 */
function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, '找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    assert.equal(buf.readUInt32LE(localOff), 0x04034b50);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const data = Buffer.from(buf.subarray(dataOff, dataOff + size));
    assert.equal(crc32Of(data), crc, `${name} CRC 不一致`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
