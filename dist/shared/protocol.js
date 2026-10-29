"use strict";
/*
 * USV Edge 协议 v1（TCP 二进制帧）
 *
 *   帧: AA 55 | ver(u8) | type(u8) | seq(u16) | len(u16) | payload | crc16(u16)
 *   CRC16-CCITT-FALSE (poly=0x1021, init=0xFFFF)，覆盖 ver..payload，小端
 *
 * 与船端 usv/protocol.py 一致；黄金帧见 test/protocol.test.ts。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrameParser = exports.OTA_BEGIN_LEN = exports.TIME_SYNC_RESULT_LEN = exports.PONG_LEN = exports.PING_LEN = exports.STATUS_LEN = exports.CMD_LEN = exports.MAX_PAYLOAD = exports.ST_TIME_BAD = exports.ST_ARM_REQUIRED = exports.ST_LIDAR_OK = exports.ST_FAILSAFE = exports.ST_ESTOP = exports.ST_ARMED = exports.CMD_FLAG_ESTOP = exports.CMD_FLAG_ARM = exports.CAP_WATCHDOG = exports.CAP_SELFTEST = exports.CAP_OTA = exports.CAP_SCAN2 = exports.T_OTA_RESULT = exports.T_OTA_PROGRESS = exports.T_OTA_ACK = exports.T_OTA_ABORT = exports.T_OTA_COMMIT = exports.T_OTA_DATA = exports.T_OTA_BEGIN = exports.T_TIME_SYNC_RESULT = exports.T_SCAN2 = exports.T_PONG = exports.T_HELLO_ACK = exports.T_SCAN = exports.T_STATUS = exports.T_TIME_SYNC = exports.T_PING = exports.T_HELLO = exports.T_CMD = exports.PROTO_VER = exports.FRAME_HEADER = void 0;
exports.crc16 = crc16;
exports.buildFrame = buildFrame;
exports.packCmd = packCmd;
exports.unpackStatus = unpackStatus;
exports.unpackScan = unpackScan;
exports.packHello = packHello;
exports.unpackHelloAck = unpackHelloAck;
exports.packHelloAck = packHelloAck;
exports.unpackScan2 = unpackScan2;
exports.packPing = packPing;
exports.unpackPong = unpackPong;
exports.unpackTimeSyncResult = unpackTimeSyncResult;
exports.computeRtt = computeRtt;
exports.packOtaBegin = packOtaBegin;
exports.packOtaData = packOtaData;
exports.unpackOtaAck = unpackOtaAck;
exports.unpackOtaProgress = unpackOtaProgress;
exports.unpackOtaResult = unpackOtaResult;
const node_zlib_1 = __importDefault(require("node:zlib"));
exports.FRAME_HEADER = Buffer.from([0xaa, 0x55]);
exports.PROTO_VER = 0x01;
exports.T_CMD = 0x01;
exports.T_HELLO = 0x03;
exports.T_PING = 0x04;
exports.T_TIME_SYNC = 0x05;
exports.T_STATUS = 0x81;
exports.T_SCAN = 0x82;
exports.T_HELLO_ACK = 0x83;
exports.T_PONG = 0x84;
exports.T_SCAN2 = 0x85;
exports.T_TIME_SYNC_RESULT = 0x86;
exports.T_OTA_BEGIN = 0x11;
exports.T_OTA_DATA = 0x12;
exports.T_OTA_COMMIT = 0x13;
exports.T_OTA_ABORT = 0x14;
exports.T_OTA_ACK = 0x91;
exports.T_OTA_PROGRESS = 0x92;
exports.T_OTA_RESULT = 0x93;
exports.CAP_SCAN2 = 1 << 0;
exports.CAP_OTA = 1 << 1;
exports.CAP_SELFTEST = 1 << 4;
/** 船端 systemd 启动失败回滚看门狗已装（OnFailure + rollback.sh） */
exports.CAP_WATCHDOG = 1 << 5;
exports.CMD_FLAG_ARM = 0x01;
exports.CMD_FLAG_ESTOP = 0x02;
exports.ST_ARMED = 1 << 0;
exports.ST_ESTOP = 1 << 1;
exports.ST_FAILSAFE = 1 << 2;
exports.ST_LIDAR_OK = 1 << 3;
exports.ST_ARM_REQUIRED = 1 << 4;
/** 船端系统时间与 NTP 偏差超过阈值 → 应引导用户校时 */
exports.ST_TIME_BAD = 1 << 5;
exports.MAX_PAYLOAD = 8192;
exports.CMD_LEN = 12;
exports.STATUS_LEN = 26;
function crc16(data, crc = 0xffff) {
    let c = crc;
    for (let i = 0; i < data.length; i++) {
        c ^= (data[i] ?? 0) << 8;
        for (let bit = 0; bit < 8; bit++) {
            c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
        }
    }
    return c;
}
function buildFrame(type, seq, payload) {
    if (payload.length > exports.MAX_PAYLOAD) {
        throw new Error(`载荷过大: ${payload.length} > ${exports.MAX_PAYLOAD}`);
    }
    const body = Buffer.alloc(6 + payload.length);
    body.writeUInt8(exports.PROTO_VER, 0);
    body.writeUInt8(type & 0xff, 1);
    body.writeUInt16LE(seq & 0xffff, 2);
    body.writeUInt16LE(payload.length, 4);
    payload.copy(body, 6);
    const frame = Buffer.alloc(2 + body.length + 2);
    exports.FRAME_HEADER.copy(frame, 0);
    body.copy(frame, 2);
    frame.writeUInt16LE(crc16(body), 2 + body.length);
    return frame;
}
/* ---------------- CMD ---------------- */
/** CMD 载荷：throttle i16(0.1%) + 4×servo i16(0.1°) + flags u8 + rsv u8 */
function packCmd(throttleX10, servosX10, flags) {
    const p = Buffer.alloc(exports.CMD_LEN);
    p.writeInt16LE(clampI16(throttleX10), 0);
    for (let i = 0; i < 4; i++)
        p.writeInt16LE(clampI16(servosX10[i] ?? 0), 2 + i * 2);
    p.writeUInt8(flags & 0xff, 10);
    p.writeUInt8(0, 11);
    return p;
}
function clampI16(v) {
    const n = Math.round(Number.isFinite(v) ? v : 0);
    return Math.max(-32768, Math.min(32767, n));
}
function unpackStatus(payload) {
    if (payload.length !== exports.STATUS_LEN) {
        throw new Error(`STATUS 长度错误: ${payload.length}`);
    }
    return {
        timeMs: payload.readUInt32LE(0),
        throttleX10: payload.readInt16LE(4),
        direction: payload.readUInt8(6),
        servosX10: [
            payload.readInt16LE(7),
            payload.readInt16LE(9),
            payload.readInt16LE(11),
            payload.readInt16LE(13),
        ],
        flags: payload.readUInt8(15),
        rxSeq: payload.readUInt16LE(16),
        rxErrors: payload.readUInt16LE(18),
        pointsLast: payload.readUInt16LE(20),
        scansTotal: payload.readUInt16LE(22),
        loopHzX10: payload.readUInt16LE(24),
    };
}
function unpackScan(payload) {
    if (payload.length < 8)
        throw new Error('SCAN 过短');
    const timeMs = payload.readUInt32LE(0);
    const count = payload.readUInt16LE(4);
    const encoding = payload.readUInt8(6);
    let data = payload.subarray(8);
    if (encoding === 1)
        data = node_zlib_1.default.inflateSync(data);
    else if (encoding !== 0)
        throw new Error(`未知 SCAN 编码 ${encoding}`);
    if (data.length < count * 5) {
        throw new Error(`SCAN 点数据不足: ${data.length} < ${count * 5}`);
    }
    const anglesRad = new Float32Array(count);
    const rangesM = new Float32Array(count);
    const qualities = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const o = i * 5;
        anglesRad[i] = ((data.readUInt16LE(o) / 100) * Math.PI) / 180;
        rangesM[i] = data.readUInt16LE(o + 2) / 1000;
        qualities[i] = data.readUInt8(o + 4);
    }
    return { timeMs, encoding, count, anglesRad, rangesM, qualities, qualityMax: 255 };
}
function packHello(protoMax = 2, protoMin = 1, clientVer = 1, caps = exports.CAP_SCAN2 | exports.CAP_OTA) {
    const p = Buffer.alloc(10);
    p.writeUInt16LE(protoMax, 0);
    p.writeUInt16LE(protoMin, 2);
    p.writeUInt16LE(clientVer, 4);
    p.writeUInt32LE(caps, 6);
    return p;
}
function unpackHelloAck(payload) {
    if (payload.length !== 26)
        throw new Error(`HELLO_ACK 长度错误: ${payload.length}`);
    const hw = payload.subarray(16, 24).toString('utf8').replace(/\0+$/, '');
    return {
        proto: payload.readUInt16LE(0),
        fw: [payload.readUInt16LE(2), payload.readUInt16LE(4), payload.readUInt16LE(6)],
        caps: payload.readUInt32LE(8),
        uptimeS: payload.readUInt32LE(12),
        hwId: hw,
    };
}
/** 船端/仿真器侧构造 HELLO_ACK（hwId 最长 8 字节，不足补 0） */
function packHelloAck(ack) {
    const p = Buffer.alloc(26);
    p.writeUInt16LE(ack.proto, 0);
    p.writeUInt16LE(ack.fw[0], 2);
    p.writeUInt16LE(ack.fw[1], 4);
    p.writeUInt16LE(ack.fw[2], 6);
    p.writeUInt32LE(ack.caps >>> 0, 8);
    p.writeUInt32LE(ack.uptimeS >>> 0, 12);
    Buffer.from(ack.hwId, 'utf8').copy(p, 16, 0, 8);
    return p;
}
/** SCAN2 载荷：24 字节头 + 点数据（可 zlib） */
function unpackScan2(payload) {
    if (payload.length < 24)
        throw new Error('SCAN2 过短');
    const count = payload.readUInt16LE(12);
    const encoding = payload.readUInt8(16);
    const flags = payload.readUInt8(17);
    let data = payload.subarray(24);
    if (encoding === 1)
        data = node_zlib_1.default.inflateSync(data);
    else if (encoding !== 0)
        throw new Error(`未知 SCAN2 编码 ${encoding}`);
    if (data.length < count * 5)
        throw new Error('SCAN2 点数据不足');
    const anglesRad = new Float32Array(count);
    const rangesM = new Float32Array(count);
    const qualities = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const o = i * 5;
        anglesRad[i] = ((data.readUInt16LE(o) / 100) * Math.PI) / 180;
        rangesM[i] = data.readUInt16LE(o + 2) / 1000;
        qualities[i] = data.readUInt8(o + 4);
    }
    const qualityMax = payload.readUInt8(20) || 63;
    return {
        timeMs: payload.readUInt32LE(4),
        encoding,
        count,
        anglesRad,
        rangesM,
        qualities,
        qualityMax,
        tStartMs: payload.readUInt32LE(0),
        scanSeq: payload.readUInt32LE(8),
        originalCount: payload.readUInt16LE(14),
        rateHz: (payload.readUInt16LE(18) || 0) / 100,
        decimated: (flags & 0x02) !== 0,
        lidarOk: (flags & 0x01) !== 0,
        tStartEstimated: (flags & 0x04) !== 0,
    };
}
/* ---------------- 时钟同步（NTP 四时间戳法） ---------------- */
exports.PING_LEN = 8;
exports.PONG_LEN = 16;
exports.TIME_SYNC_RESULT_LEN = 8;
function packPing(t1Ms) {
    const p = Buffer.alloc(exports.PING_LEN);
    p.writeBigUInt64LE(BigInt(Math.max(0, Math.round(t1Ms))), 0);
    return p;
}
function unpackPong(payload) {
    if (payload.length < exports.PONG_LEN)
        throw new Error(`PONG 过短: ${payload.length}`);
    return {
        t1Ms: Number(payload.readBigUInt64LE(0)),
        t2Ms: payload.readUInt32LE(8),
        t3Ms: payload.readUInt32LE(12),
    };
}
function unpackTimeSyncResult(payload) {
    if (payload.length < exports.TIME_SYNC_RESULT_LEN) {
        throw new Error(`TIME_SYNC_RESULT 过短: ${payload.length}`);
    }
    return {
        status: payload.readUInt8(0),
        offsetSec: payload.readInt32LE(2),
        rttMs: payload.readUInt16LE(6),
    };
}
/**
 * 由一次收发算出延迟与时钟偏差。
 *
 * 注意两处容易踩的坑：
 *
 * 1. `t1/t4` 是**客户端 epoch 毫秒**，`t2/t3` 是**船端单调时钟**，两者基准不同。
 *    所以 `offsetMs` 是一个巨大的负数（约 -1.7e12），这是正常的——它就是
 *    「船钟 − 客户钟」的差值，可用来把船端时间戳换算到本地时间轴：
 *        localMs = shipMs - offsetMs
 *
 * 2. **单程延迟无法从一次往返中分离**（分布式系统的固有约束，NTP 也一样）。
 *    在「上下行对称」假设下只能各取 `delayMs / 2`；不对称带来的误差会体现在
 *    `offsetMs` 里，无法进一步分解。要真正分离需要硬件时间戳（PTP）。
 */
function computeRtt(pong, t4Ms) {
    const delayMs = Math.max(0, t4Ms - pong.t1Ms - (pong.t3Ms - pong.t2Ms));
    const offsetMs = (pong.t2Ms - pong.t1Ms + (pong.t3Ms - t4Ms)) / 2;
    const half = delayMs / 2;
    return { delayMs, offsetMs, upMs: half, downMs: half };
}
/* ---------------- OTA ---------------- */
exports.OTA_BEGIN_LEN = 110;
function packOtaBegin(version, totalSize, sha256, sig, resumeOffset = 0) {
    const p = Buffer.alloc(exports.OTA_BEGIN_LEN);
    p.writeUInt16LE(version[0], 0);
    p.writeUInt16LE(version[1], 2);
    p.writeUInt16LE(version[2], 4);
    p.writeUInt32LE(totalSize, 6);
    sha256.copy(p, 10, 0, 32);
    sig.copy(p, 42, 0, Math.min(64, sig.length));
    p.writeUInt32LE(resumeOffset, 106);
    return p;
}
function packOtaData(offset, chunk) {
    const p = Buffer.alloc(4 + chunk.length);
    p.writeUInt32LE(offset, 0);
    chunk.copy(p, 4);
    return p;
}
function unpackOtaAck(p) {
    if (p.length < 5)
        throw new Error('OTA_ACK 过短');
    return { status: p.readUInt8(0), offset: p.readUInt32LE(1) };
}
function unpackOtaProgress(p) {
    if (p.length < 9)
        throw new Error('OTA_PROGRESS 过短');
    return {
        received: p.readUInt32LE(0),
        total: p.readUInt32LE(4),
        stage: p.readUInt8(8),
    };
}
function unpackOtaResult(p) {
    if (p.length < 70)
        throw new Error('OTA_RESULT 过短');
    return {
        status: p.readUInt8(0),
        fw: [p.readUInt16LE(1), p.readUInt16LE(3), p.readUInt16LE(5)],
        message: p.subarray(7, 71).toString('utf8').replace(/\0+$/, ''),
    };
}
class FrameParser {
    buf = Buffer.alloc(0);
    crcErrors = 0;
    feed(data) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : Buffer.from(data);
        const out = [];
        for (;;) {
            const idx = this.buf.indexOf(exports.FRAME_HEADER);
            if (idx < 0) {
                const keep = this.buf.length > 0 && this.buf[this.buf.length - 1] === 0xaa ? 1 : 0;
                this.buf = this.buf.subarray(this.buf.length - keep);
                break;
            }
            if (idx > 0)
                this.buf = this.buf.subarray(idx);
            if (this.buf.length < 8)
                break;
            const ver = this.buf.readUInt8(2);
            const type = this.buf.readUInt8(3);
            const seq = this.buf.readUInt16LE(4);
            const plen = this.buf.readUInt16LE(6);
            if (plen > exports.MAX_PAYLOAD) {
                this.buf = this.buf.subarray(2);
                continue;
            }
            const total = 8 + plen + 2;
            if (this.buf.length < total)
                break;
            const bodyEnd = 8 + plen;
            const crcRx = this.buf.readUInt16LE(bodyEnd);
            if (crcRx !== crc16(this.buf.subarray(2, bodyEnd))) {
                this.crcErrors++;
                this.buf = this.buf.subarray(2);
                continue;
            }
            out.push({ ver, type, seq, payload: Buffer.from(this.buf.subarray(8, bodyEnd)) });
            this.buf = this.buf.subarray(total);
        }
        return out;
    }
}
exports.FrameParser = FrameParser;
//# sourceMappingURL=protocol.js.map