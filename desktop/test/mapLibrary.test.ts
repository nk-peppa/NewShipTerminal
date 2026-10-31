import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { MapLibrary, countPgmStates, resolveMapDir, sanitizeMapName } from '../src/main/maps/mapLibrary.js';
import { SlamRecorder } from '../src/main/algo/slamExport.js';

/* ---------------- helpers ---------------- */

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

function pngChunk(tag: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Minimal 8-bit RGBA PNG for the recorder: unknown = transparent, walls = white. */
function makePng(size: number): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      const wall = y === 0 || y === size - 1 || x === 0 || x === size - 1;
      const free = !wall;
      if (wall) {
        raw[o] = 226;
        raw[o + 1] = 236;
        raw[o + 2] = 248;
        raw[o + 3] = 235;
      } else if (free) {
        raw[o] = 70;
        raw[o + 1] = 120;
        raw[o + 2] = 170;
        raw[o + 3] = 70;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function recorderWithMap(size = 32): SlamRecorder {
  const rec = new SlamRecorder();
  rec.onMap({
    t: Date.now(),
    png: makePng(size).toString('base64'),
    size,
    resolution: 0.08,
    origin: [-1.28, -1.28],
    observed: 100,
  });
  rec.onPose({
    t: 1000,
    x: 0.1,
    y: -0.2,
    yaw: 0.3,
    status: 'TRACKING',
    rmse: 0.02,
    inlier: 0.9,
  });
  return rec;
}

const SHIP = { host: '127.0.0.1', port: 9527, firmware: '0.4.0', caps: 33 };

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usv-map-test-'));
}

/* ---------------- tests ---------------- */

test('sanitizeMapName removes separators and falls back to a stamp', () => {
  assert.equal(sanitizeMapName('pool/2026 10:31'), 'pool-2026-10-31');
  assert.equal(sanitizeMapName('   '), sanitizeMapName(undefined));
  assert.match(sanitizeMapName(undefined, new Date(2026, 9, 31, 12, 34, 56)), /^map-20261031-123456$/);
  assert.equal(
    sanitizeMapName('..', new Date(2026, 9, 31)),
    sanitizeMapName(undefined, new Date(2026, 9, 31)),
  );
  assert.ok(sanitizeMapName('a'.repeat(200)).length <= 48);
});

test('resolveMapDir rejects traversal and absolute names', () => {
  const base = tempBase();
  assert.throws(() => resolveMapDir(base, '..'));
  assert.throws(() => resolveMapDir(base, '../etc'));
  assert.throws(() => resolveMapDir(base, 'a/b'));
  assert.throws(() => resolveMapDir(base, 'a\\b'));
  assert.equal(path.basename(resolveMapDir(base, 'ok')), 'ok');
});

test('countPgmStates parses P5 headers and counts three states', () => {
  const body = Buffer.from([0, 0, 254, 254, 205, 205]);
  const pgm = Buffer.concat([Buffer.from('P5\n3 2\n255\n', 'ascii'), body]);
  const states = countPgmStates(pgm);
  assert.deepEqual(
    { w: states.width, h: states.height, o: states.occupied, f: states.free, u: states.unknown },
    { w: 3, h: 2, o: 2, f: 2, u: 2 },
  );
  assert.throws(() => countPgmStates(Buffer.from('P2\n1 1\n255\n', 'ascii')));
});

test('save writes a complete map folder and rejects duplicate names', async () => {
  const base = tempBase();
  const lib = new MapLibrary(base);
  const first = await lib.save({
    recorder: recorderWithMap(),
    appVersion: '0.1.0-test',
    ship: SHIP,
    name: 'pool',
  });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.name, 'pool');
  for (const file of ['map.pgm', 'map.yaml', 'map.png', 'trajectory.csv', 'session.json', 'meta.json']) {
    assert.ok(fs.existsSync(path.join(base, 'pool', file)), `缺少 ${file}`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(base, 'pool', 'meta.json'), 'utf8'));
  assert.equal(meta.name, 'pool');
  assert.equal(meta.map.size, 32);
  assert.equal(meta.map.resolution, 0.08);
  assert.match(meta.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(meta.trajectory.poses, 1);

  const second = await lib.save({
    recorder: recorderWithMap(),
    appVersion: '0.1.0-test',
    ship: SHIP,
    name: 'pool',
  });
  assert.equal(second.ok, true);
  assert.equal(second.name, 'pool-2');
  assert.ok(fs.existsSync(path.join(base, 'pool-2', 'map.pgm')));
});

test('save refuses a recorder without a map', async () => {
  const lib = new MapLibrary(tempBase());
  const result = await lib.save({ recorder: new SlamRecorder(), appVersion: 'x', ship: SHIP });
  assert.equal(result.ok, false);
  assert.match(result.message, /SLAM/);
});

test('list/load/delete round-trip and hashes match the saved files', async () => {
  const base = tempBase();
  const lib = new MapLibrary(base);
  await lib.save({ recorder: recorderWithMap(), appVersion: '0.1.0-test', ship: SHIP, name: 'dock' });

  const list = await lib.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'dock');
  assert.equal(list[0]!.size, 32);
  assert.equal(list[0]!.poses, 1);
  assert.ok(list[0]!.bytes > 0);

  const loaded = await lib.load('dock');
  assert.equal(loaded.ok, true, loaded.message);
  assert.ok(loaded.yamlPath?.endsWith('map.yaml'));
  assert.equal(loaded.meta?.name, 'dock');

  const removed = await lib.delete('dock');
  assert.equal(removed.ok, true);
  assert.deepEqual(await lib.list(), []);
  assert.equal((await lib.delete('dock')).ok, false);
  assert.equal((await lib.load('../etc')).ok, false);
});

test('list falls back to PGM/YAML for maps without meta.json', async () => {
  const base = tempBase();
  fs.mkdirSync(path.join(base, 'legacy'));
  const pgm = Buffer.concat([
    Buffer.from('P5\n4 3\n255\n', 'ascii'),
    Buffer.from([0, 0, 254, 205, 205, 205, 254, 254, 254, 254, 254, 254]),
  ]);
  fs.writeFileSync(path.join(base, 'legacy', 'map.pgm'), pgm);
  fs.writeFileSync(
    path.join(base, 'legacy', 'map.yaml'),
    'image: map.pgm\nresolution: 0.05\norigin: [-1.0, -2.0, 0.0]\n',
  );
  const lib = new MapLibrary(base);
  const list = await lib.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'legacy');
  assert.equal(list[0]!.size, 4);
  assert.equal(list[0]!.resolution, 0.05);
  assert.deepEqual(list[0]!.origin, [-1, -2]);
  assert.ok(list[0]!.hash?.startsWith('sha256:'));
  assert.ok(list[0]!.warning);

  const loaded = await lib.load('legacy');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.meta?.map.origin[0], -1);
});

test('list ignores unrelated directories and half-written temp dirs', async () => {
  const base = tempBase();
  fs.mkdirSync(path.join(base, 'not-a-map'));
  fs.mkdirSync(path.join(base, '.tmp-pool-123'));
  const lib = new MapLibrary(base);
  assert.deepEqual(await lib.list(), []);
});
