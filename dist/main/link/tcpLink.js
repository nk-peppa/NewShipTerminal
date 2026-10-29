"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TcpLink = void 0;
const node_net_1 = __importDefault(require("node:net"));
const node_events_1 = require("node:events");
const protocol_js_1 = require("../../shared/protocol.js");
/**
 * TCP 控制链路：50Hz 下发 CMD、解析 STATUS/SCAN、断线自动重连。
 * 发送节拍用单调时钟自校正，不允许 setTimeout 漂移累积。
 */
class TcpLink extends node_events_1.EventEmitter {
    opts;
    socket = null;
    parser = new protocol_js_1.FrameParser();
    connected = false;
    stopped = false;
    seq = 0;
    lastError = null;
    decodeErrors = 0;
    timer = null;
    reconnectTimer = null;
    rateTimer = null;
    txCount = 0;
    statusCount = 0;
    scanCount = 0;
    txHz = 0;
    rxStatusHz = 0;
    rxScanHz = 0;
    rxBytes = 0;
    rxBytesPerSec = 0;
    hello = null;
    /* ---- 时钟同步（NTP 四时间戳法） ---- */
    pingTimer = null;
    /** 发出但未回的 PING：t1 → 本地发出时刻 */
    pendingPing = null;
    /** 最近若干次采样（取中位数，抗热点抖动） */
    samples = [];
    rtt = null;
    constructor(opts) {
        super();
        this.opts = opts;
    }
    /** 切换目标船端（自动发现选船时使用） */
    setTarget(host, port) {
        if (this.opts.host === host && this.opts.port === port)
            return;
        this.opts.host = host;
        this.opts.port = port;
        this.lastError = null;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const old = this.socket;
        this.socket = null;
        this.connected = false;
        if (old) {
            old.removeAllListeners();
            old.destroy();
        }
        this.emitState();
        if (!this.stopped)
            this.connect();
    }
    /** 立即重连：跳过退避等待，用于船端刚重启/服务刚拉起时的一键恢复 */
    reconnectNow() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const old = this.socket;
        this.socket = null;
        this.connected = false;
        if (old) {
            old.removeAllListeners();
            old.destroy();
        }
        this.emitState();
        if (!this.stopped)
            this.connect();
    }
    start() {
        this.stopped = false;
        this.connect();
        this.startScheduler();
        this.rateTimer = setInterval(() => {
            this.txHz = this.txCount;
            this.rxStatusHz = this.statusCount;
            this.rxScanHz = this.scanCount;
            this.rxBytesPerSec = this.rxBytes;
            this.txCount = this.statusCount = this.scanCount = this.rxBytes = 0;
            this.emitState();
        }, 1000);
        // 1Hz 时钟同步探针：只发一帧 PING，不影响 50Hz 控制环
        this.pingTimer = setInterval(() => this.sendPing(), 1000);
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.rateTimer)
            clearInterval(this.rateTimer);
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.timer = this.reconnectTimer = this.rateTimer = this.pingTimer = null;
        this.pendingPing = null;
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;
    }
    /** 立即测量一次（校时按钮/手动刷新用） */
    sendPing() {
        const s = this.socket;
        if (!this.connected || !s || s.destroyed)
            return;
        const t1 = Date.now();
        this.pendingPing = { t1 };
        try {
            s.write((0, protocol_js_1.buildFrame)(protocol_js_1.T_PING, this.nextSeq(), (0, protocol_js_1.packPing)(t1)));
        }
        catch {
            this.pendingPing = null;
        }
    }
    /** 请求船端做一次网络校时；结果通过 'timesync' 事件返回 */
    requestTimeSync() {
        const s = this.socket;
        if (!this.connected || !s || s.destroyed)
            return false;
        try {
            s.write((0, protocol_js_1.buildFrame)(protocol_js_1.T_TIME_SYNC, this.nextSeq(), Buffer.alloc(0)));
            return true;
        }
        catch {
            return false;
        }
    }
    nextSeq() {
        this.seq = (this.seq + 1) & 0xffff;
        return this.seq;
    }
    /** 取最近 5 次采样的中位数：手机热点抖动大，均值不可靠 */
    pushSample(sample) {
        this.samples.push(sample);
        if (this.samples.length > 5)
            this.samples.shift();
        const med = (pick) => {
            const v = this.samples.map(pick).sort((a, b) => a - b);
            return v[Math.floor(v.length / 2)] ?? 0;
        };
        this.rtt = {
            delayMs: med((s) => s.delayMs),
            offsetMs: med((s) => s.offsetMs),
            upMs: med((s) => s.upMs),
            downMs: med((s) => s.downMs),
        };
    }
    state() {
        return {
            connected: this.connected,
            host: this.opts.host,
            port: this.opts.port,
            lastError: this.lastError,
            txHz: this.txHz,
            rxStatusHz: this.rxStatusHz,
            rxScanHz: this.rxScanHz,
            rxBytesPerSec: this.rxBytesPerSec,
            decodeErrors: this.decodeErrors,
            crcErrors: this.parser.crcErrors,
            fwVersion: this.hello ? this.hello.fw.join('.') : null,
            caps: this.hello?.caps ?? 0,
            watchdogArmed: (((this.hello?.caps ?? 0) & protocol_js_1.CAP_WATCHDOG) !== 0),
            upMs: this.rtt ? Math.round(this.rtt.upMs * 10) / 10 : null,
            downMs: this.rtt ? Math.round(this.rtt.downMs * 10) / 10 : null,
            rttMs: this.rtt ? Math.round(this.rtt.delayMs * 10) / 10 : null,
            clockOffsetMs: this.rtt ? Math.round(this.rtt.offsetMs) : null,
        };
    }
    emitState() {
        this.emit('state', this.state());
    }
    connect() {
        if (this.stopped)
            return;
        const socket = node_net_1.default.createConnection({ host: this.opts.host, port: this.opts.port });
        this.socket = socket;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 1000);
        socket.on('connect', () => {
            this.connected = true;
            this.lastError = null;
            this.hello = null;
            // 先握手：声明 v2 + SCAN2/OTA 能力；旧固件会忽略未知帧，行为回落到 v1
            try {
                socket.write((0, protocol_js_1.buildFrame)(protocol_js_1.T_HELLO, 0, (0, protocol_js_1.packHello)()));
            }
            catch (e) {
                this.lastError = e instanceof Error ? e.message : String(e);
            }
            this.emit('state', this.state());
        });
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (err) => {
            this.lastError = err.message;
        });
        socket.on('close', () => {
            this.connected = false;
            this.socket = null;
            this.emit('state', this.state());
            if (!this.stopped) {
                this.reconnectTimer = setTimeout(() => this.connect(), this.opts.reconnectMs);
            }
        });
    }
    onData(chunk) {
        this.rxBytes += chunk.length;
        let frames;
        try {
            frames = this.parser.feed(chunk);
        }
        catch (err) {
            this.reportDecodeError(err);
            return;
        }
        for (const frame of frames) {
            if (frame.type === protocol_js_1.T_STATUS) {
                try {
                    const st = (0, protocol_js_1.unpackStatus)(frame.payload);
                    this.statusCount++;
                    this.emit('status', st);
                }
                catch (err) {
                    this.reportDecodeError(err);
                }
            }
            else if (frame.type === protocol_js_1.T_SCAN || frame.type === protocol_js_1.T_SCAN2) {
                try {
                    const scan = frame.type === protocol_js_1.T_SCAN2 ? (0, protocol_js_1.unpackScan2)(frame.payload) : (0, protocol_js_1.unpackScan)(frame.payload);
                    this.scanCount++;
                    const received = { scan, recvMs: Date.now() };
                    this.emit('scan', received);
                }
                catch (err) {
                    this.reportDecodeError(err);
                }
            }
            else if (frame.type === protocol_js_1.T_PONG) {
                try {
                    const pong = (0, protocol_js_1.unpackPong)(frame.payload);
                    // 只认自己最近发出的那一次，避免乱序响应污染统计
                    if (this.pendingPing && pong.t1Ms === this.pendingPing.t1) {
                        this.pendingPing = null;
                        this.pushSample((0, protocol_js_1.computeRtt)(pong, Date.now()));
                        this.emitState();
                    }
                }
                catch (err) {
                    this.reportDecodeError(err);
                }
            }
            else if (frame.type === protocol_js_1.T_TIME_SYNC_RESULT) {
                try {
                    this.emit('timesync', (0, protocol_js_1.unpackTimeSyncResult)(frame.payload));
                }
                catch (err) {
                    this.reportDecodeError(err);
                }
            }
            else if (frame.type === protocol_js_1.T_HELLO_ACK) {
                try {
                    this.hello = (0, protocol_js_1.unpackHelloAck)(frame.payload);
                    this.emit('hello', this.hello);
                    this.emitState();
                }
                catch (err) {
                    this.reportDecodeError(err);
                }
            }
            else if (process.env.USV_DEBUG) {
                console.warn(`[link] 未知帧类型 0x${frame.type.toString(16)} len=${frame.payload.length}`);
            }
        }
    }
    reportDecodeError(err) {
        this.decodeErrors++;
        this.emit('decode-error', err);
        const text = err instanceof Error ? err.message : String(err);
        // 解码失败必须留痕：没有监听者时也要能看到（否则表现为「扫描突然没了」）
        console.warn(`[link] 解码失败 #${this.decodeErrors}: ${text}`);
    }
    startScheduler() {
        const periodMs = 1000 / this.opts.rateHz;
        const periodNs = BigInt(Math.round(1e9 / this.opts.rateHz));
        let nextAt = process.hrtime.bigint() + periodNs;
        const loop = () => {
            if (this.stopped)
                return;
            try {
                this.sendOnce();
            }
            catch (err) {
                this.lastError = err instanceof Error ? err.message : String(err);
                console.error('[link] 发送异常', err);
            }
            // 无论发送成败都要续上下一拍，否则节拍链会永久中断
            const now = process.hrtime.bigint();
            nextAt += periodNs;
            if (nextAt <= now)
                nextAt = now + periodNs;
            const delayMs = Math.max(0, Number(nextAt - now) / 1e6);
            this.timer = setTimeout(loop, Math.min(delayMs, periodMs * 4));
        };
        this.timer = setTimeout(loop, periodMs);
    }
    sendOnce() {
        const socket = this.socket;
        if (!socket || !this.connected || socket.destroyed)
            return;
        const cmd = this.opts.getCommand();
        const frame = (0, protocol_js_1.buildFrame)(protocol_js_1.T_CMD, this.seq++, (0, protocol_js_1.packCmd)(cmd.throttleX10, cmd.servosX10, cmd.flags));
        try {
            socket.write(frame);
            this.txCount++;
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }
}
exports.TcpLink = TcpLink;
//# sourceMappingURL=tcpLink.js.map