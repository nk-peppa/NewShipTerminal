"use strict";
/*
 * OTA 客户端（TCP 9530）。
 *
 * 流程：读取包 → sha256 → OTA_BEGIN → 分块 OTA_DATA → OTA_COMMIT → 等 OTA_RESULT。
 * 服务端在偏移不一致时会回 ACK(offset)，这里据此续传。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.versionFromFilename = versionFromFilename;
exports.probeFirmware = probeFirmware;
exports.runOta = runOta;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_net_1 = __importDefault(require("node:net"));
const protocol_js_1 = require("../../shared/protocol.js");
const STAGE_TEXT = {
    1: 'verifying',
    2: 'installing',
    4: 'installing',
    5: 'done',
};
/** 从文件名解析版本：usv-edge-0.2.0-aarch64.tar.gz */
function versionFromFilename(file) {
    const m = /usv-edge-(\d+)\.(\d+)\.(\d+)/.exec(file);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
class Inbox {
    acks = [];
    results = [];
    progresses = [];
    ackWaiters = [];
    resultWaiters = [];
    pushAck(p) {
        const parsed = (0, protocol_js_1.unpackOtaAck)(p);
        const w = this.ackWaiters.shift();
        if (w)
            w(parsed);
        else
            this.acks.push(p);
    }
    pushResult(p) {
        const parsed = (0, protocol_js_1.unpackOtaResult)(p);
        const w = this.resultWaiters.shift();
        if (w)
            w(parsed);
        else
            this.results.push(p);
    }
    pushProgress(p) {
        this.progresses.push(p);
    }
    takeProgress() {
        const p = this.progresses.shift();
        return p ? (0, protocol_js_1.unpackOtaProgress)(p) : null;
    }
    nextAck(timeoutMs = 10_000) {
        const ready = this.acks.shift();
        if (ready)
            return Promise.resolve((0, protocol_js_1.unpackOtaAck)(ready));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('等待 OTA_ACK 超时')), timeoutMs);
            this.ackWaiters.push((v) => {
                clearTimeout(timer);
                resolve(v);
            });
        });
    }
    nextResult(timeoutMs = 180_000) {
        const ready = this.results.shift();
        if (ready)
            return Promise.resolve((0, protocol_js_1.unpackOtaResult)(ready));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('等待 OTA_RESULT 超时')), timeoutMs);
            this.resultWaiters.push((v) => {
                clearTimeout(timer);
                resolve(v);
            });
        });
    }
}
/** 连接控制端口发 HELLO，读回固件版本（用于「升级前后」对比） */
function probeFirmware(host, port, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const socket = node_net_1.default.createConnection({ host, port });
        const parser = new protocol_js_1.FrameParser();
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('HELLO 超时'));
        }, timeoutMs);
        socket.setNoDelay(true);
        socket.on('connect', () => {
            socket.write((0, protocol_js_1.buildFrame)(0x03, 0, (0, protocol_js_1.packHello)()));
        });
        socket.on('data', (chunk) => {
            for (const f of parser.feed(chunk)) {
                if (f.type === protocol_js_1.T_HELLO_ACK) {
                    clearTimeout(timer);
                    socket.destroy();
                    try {
                        resolve((0, protocol_js_1.unpackHelloAck)(f.payload));
                    }
                    catch (e) {
                        reject(e);
                    }
                }
            }
        });
        socket.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}
async function runOta(opts) {
    const emit = (e) => opts.onEvent?.(e);
    // 帧 payload 是 u16，且设备侧上限 8192；减去 4 字节 offset 后取 4KB 更稳
    const chunkSize = Math.min(opts.chunkSize ?? 4096, 8188);
    const version = versionFromFilename(opts.file);
    if (!version) {
        const message = '文件名需包含版本号，例如 usv-edge-0.2.1-aarch64.tar.gz';
        emit({ phase: 'error', received: 0, total: 0, message });
        return { ok: false, status: -1, message, version: [0, 0, 0] };
    }
    const buf = await node_fs_1.default.promises.readFile(opts.file);
    const total = buf.length;
    emit({ phase: 'hashing', received: 0, total });
    const sha256 = node_crypto_1.default.createHash('sha256').update(buf).digest();
    emit({ phase: 'connecting', received: 0, total });
    const socket = node_net_1.default.createConnection({ host: opts.host, port: opts.port });
    socket.setNoDelay(true);
    const inbox = new Inbox();
    const parser = new protocol_js_1.FrameParser();
    let closed = false;
    socket.on('data', (chunk) => {
        for (const f of parser.feed(chunk)) {
            if (f.type === protocol_js_1.T_OTA_ACK)
                inbox.pushAck(f.payload);
            else if (f.type === protocol_js_1.T_OTA_RESULT)
                inbox.pushResult(f.payload);
            else if (f.type === protocol_js_1.T_OTA_PROGRESS)
                inbox.pushProgress(f.payload);
            else if (f.type === protocol_js_1.T_CMD) {
                /* OTA 端口不应出现控制帧，忽略 */
            }
        }
    });
    socket.on('close', () => {
        closed = true;
    });
    socket.on('error', () => {
        closed = true;
    });
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    let seq = 0;
    const send = (type, payload) => {
        if (closed)
            throw new Error('连接已断开');
        socket.write((0, protocol_js_1.buildFrame)(type, seq++, payload));
    };
    try {
        // BEGIN：签名位留空（内网 allow_unsigned）
        emit({ phase: 'begin', received: 0, total });
        send(protocol_js_1.T_OTA_BEGIN, (0, protocol_js_1.packOtaBegin)(version, total, sha256, Buffer.alloc(64), 0));
        const ack0 = await inbox.nextAck();
        if (ack0.status !== 0) {
            const message = `设备拒绝升级: status=${ack0.status}`;
            emit({ phase: 'error', received: 0, total, message });
            return { ok: false, status: ack0.status, message, version };
        }
        let offset = Math.min(ack0.offset, total);
        while (offset < total) {
            const end = Math.min(offset + chunkSize, total);
            send(protocol_js_1.T_OTA_DATA, (0, protocol_js_1.packOtaData)(offset, buf.subarray(offset, end)));
            offset = end;
            for (let p = inbox.takeProgress(); p; p = inbox.takeProgress()) {
                emit({
                    phase: STAGE_TEXT[p.stage] ?? 'sending',
                    received: p.received,
                    total: p.total || total,
                    stage: p.stage,
                });
            }
            emit({ phase: 'sending', received: offset, total });
            if (offset % (chunkSize * 8) === 0) {
                await new Promise((r) => setImmediate(r));
            }
        }
        emit({ phase: 'verifying', received: total, total });
        send(protocol_js_1.T_OTA_COMMIT, Buffer.alloc(0));
        const result = await inbox.nextResult();
        const phase = result.status === 0 ? 'done' : 'error';
        emit({ phase, received: total, total, message: result.message });
        socket.destroy();
        return {
            ok: result.status === 0,
            status: result.status,
            message: result.message,
            version: result.fw,
        };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        emit({ phase: 'error', received: 0, total, message });
        socket.destroy();
        return { ok: false, status: -1, message, version };
    }
}
//# sourceMappingURL=ota.js.map