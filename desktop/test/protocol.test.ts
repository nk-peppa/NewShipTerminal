import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  buildFrame,
  crc16,
  FrameParser,
  packCmd,
  T_CMD,
  T_SCAN,
  T_STATUS,
  T_SYS,
  SYS_TEMP_UNKNOWN,
  unpackScan,
  unpackStatus,
  unpackSys,
} from '../src/shared/protocol.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('CRC16-CCITT-FALSE 标准向量', () => {
  assert.equal(crc16(Buffer.from('123456789', 'ascii')), 0x29b1);
});

test('CMD 黄金帧与协议文档一致', () => {
  // protocol.md §6：油门 +15.0%、舵 10.0°、解锁、seq=1
  const expected = hex('aa55010101000c009600640000000000000001004e58');
  const frame = buildFrame(T_CMD, 1, packCmd(150, [100, 0, 0, 0], 0x01));
  assert.deepEqual(frame, expected);
});

test('STATUS 黄金帧解码', () => {
  const frame = hex(
    'aa55018100001a00e803000096000164000000000000000901000000e001030 0f401476d',
  );
  const parsed = new FrameParser().feed(frame);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.type, T_STATUS);

  const st = unpackStatus(parsed[0]!.payload);
  assert.equal(st.timeMs, 1000);
  assert.equal(st.throttleX10, 150);
  assert.equal(st.direction, 1);
  assert.deepEqual(st.servosX10, [100, 0, 0, 0]);
  assert.equal(st.flags, 0x09);
  assert.equal(st.rxSeq, 1);
  assert.equal(st.rxErrors, 0);
  assert.equal(st.pointsLast, 480);
  assert.equal(st.scansTotal, 3);
  assert.equal(st.loopHzX10, 500);
});

test('SYS 黄金帧解码（MCU 温度 48.5 °C）', () => {
  const payload = Buffer.alloc(4);
  payload.writeInt16LE(485, 0);
  const parsed = new FrameParser().feed(buildFrame(T_SYS, 9, payload));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.type, T_SYS);
  assert.deepEqual(unpackSys(parsed[0]!.payload), { tempC: 48.5 });
});

test('SYS 哨兵值表示船端读不到温度', () => {
  const payload = Buffer.alloc(4);
  payload.writeInt16LE(SYS_TEMP_UNKNOWN, 0);
  assert.deepEqual(unpackSys(payload), { tempC: null });
  assert.throws(() => unpackSys(Buffer.alloc(2)), /SYS 长度错误/);
});

test('SCAN 黄金帧解码（未压缩，3 点）', () => {
  const frame = hex(
    'aa55018200001700e803000003000000' + '0000e80350e02ed0075ac05db80b64edb0',
  );
  const parsed = new FrameParser().feed(frame);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.type, T_SCAN);

  const scan = unpackScan(parsed[0]!.payload);
  assert.equal(scan.timeMs, 1000);
  assert.equal(scan.count, 3);
  assert.equal(scan.encoding, 0);
  assert.ok(Math.abs(scan.anglesRad[1]! - (120 * Math.PI) / 180) < 1e-6);
  assert.equal(scan.rangesM[0], 1);
  assert.equal(scan.rangesM[1], 2);
  assert.equal(scan.rangesM[2], 3);
  assert.equal(scan.qualities[0], 80);
});

test('解析器：任意分片与噪声后重新同步', () => {
  const a = buildFrame(T_STATUS, 7, Buffer.alloc(26, 0x11));
  const b = buildFrame(T_SCAN, 8, Buffer.alloc(8, 0x22));
  const stream = Buffer.concat([Buffer.from([0x00, 0xaa, 0x99]), a, b]);

  const parser = new FrameParser();
  const got = [];
  for (const byte of stream) got.push(...parser.feed(Buffer.from([byte])));

  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((f) => f.type),
    [T_STATUS, T_SCAN],
  );
});

test('CRC 错误被丢弃并计数', () => {
  const frame = buildFrame(T_STATUS, 1, Buffer.alloc(26, 0));
  frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0xff;

  const parser = new FrameParser();
  assert.equal(parser.feed(frame).length, 0);
  assert.equal(parser.crcErrors, 1);

  const ok = buildFrame(T_STATUS, 2, Buffer.alloc(26, 0));
  assert.equal(parser.feed(ok).length, 1);
});

test('SCAN zlib 编码可解压', () => {
  const points = Buffer.alloc(5 * 2);
  points.writeUInt16LE(0, 0);
  points.writeUInt16LE(1500, 2);
  points.writeUInt8(60, 4);
  points.writeUInt16LE(9000, 5);
  points.writeUInt16LE(2500, 7);
  points.writeUInt8(30, 9);

  const body = Buffer.alloc(8);
  body.writeUInt32LE(1234, 0);
  body.writeUInt16LE(2, 4);
  body.writeUInt8(1, 6);
  const payload = Buffer.concat([body, zlib.deflateSync(points)]);

  const scan = unpackScan(payload);
  assert.equal(scan.count, 2);
  assert.equal(scan.rangesM[0], 1.5);
  assert.equal(scan.rangesM[1], 2.5);
  assert.ok(Math.abs(scan.anglesRad[1]! - (90 * Math.PI) / 180) < 1e-6);
});
