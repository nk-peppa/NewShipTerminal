"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShipDiscovery = void 0;
const node_dgram_1 = __importDefault(require("node:dgram"));
const node_os_1 = __importDefault(require("node:os"));
const node_events_1 = require("node:events");
const MAGIC = 'USVDISC1';
const KIND_BEACON = 'beac';
const KIND_PROBE = 'prob';
/** 监听船端 UDP 配对广播（USVDISC1），维护在场船只列表。 */
class ShipDiscovery extends node_events_1.EventEmitter {
    opts;
    socket = null;
    ships = new Map();
    probeTimer = null;
    sweepTimer = null;
    lastJson = '';
    constructor(opts) {
        super();
        this.opts = opts;
    }
    start() {
        if (this.socket)
            return;
        const socket = node_dgram_1.default.createSocket({ type: 'udp4', reuseAddr: true });
        this.socket = socket;
        socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));
        socket.on('error', (err) => this.emit('error', err));
        socket.bind(this.opts.udpPort);
        this.probeTimer = setInterval(() => this.probe(), this.opts.probeIntervalMs);
        this.sweepTimer = setInterval(() => this.sweep(), 1000);
    }
    stop() {
        if (this.probeTimer)
            clearInterval(this.probeTimer);
        if (this.sweepTimer)
            clearInterval(this.sweepTimer);
        this.probeTimer = this.sweepTimer = null;
        try {
            this.socket?.close();
        }
        catch {
            /* ignore */
        }
        this.socket = null;
    }
    list() {
        return [...this.ships.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    }
    onMessage(msg, from) {
        if (msg.length < 12)
            return;
        if (msg.subarray(0, 8).toString('ascii') !== MAGIC)
            return;
        const kind = msg.subarray(8, 12).toString('ascii');
        if (kind !== KIND_BEACON)
            return;
        let info;
        try {
            info = JSON.parse(msg.subarray(12).toString('utf8'));
        }
        catch {
            return;
        }
        if (!info || typeof info !== 'object')
            return;
        const key = info.sn || from;
        this.ships.set(key, {
            name: info.name || 'USV',
            sn: info.sn || '',
            host: from,
            tcpPort: info.tcp_port || 9527,
            state: info.state || 'unknown',
            lidar: !!info.lidar,
            armed: !!info.armed,
            estop: !!info.estop,
            failsafe: !!info.failsafe,
            hz: typeof info.hz === 'number' ? info.hz : 0,
            lastSeenMs: Date.now(),
        });
        this.emitChanged();
    }
    sweep() {
        const cutoff = Date.now() - this.opts.ttlMs;
        let changed = false;
        for (const [key, ship] of this.ships) {
            if (ship.lastSeenMs < cutoff) {
                this.ships.delete(key);
                changed = true;
            }
        }
        if (changed)
            this.emitChanged();
    }
    probe() {
        const socket = this.socket;
        if (!socket)
            return;
        const payload = Buffer.concat([
            Buffer.from(MAGIC, 'ascii'),
            Buffer.from(KIND_PROBE, 'ascii'),
            Buffer.from('{}', 'utf8'),
        ]);
        for (const target of this.probeTargets()) {
            socket.send(payload, this.opts.udpPort, target, () => {
                /* 网络不可达时忽略 */
            });
        }
    }
    probeTargets() {
        const out = ['255.255.255.255'];
        for (const list of Object.values(node_os_1.default.networkInterfaces())) {
            for (const ni of list ?? []) {
                if (ni.family !== 'IPv4' || ni.internal)
                    continue;
                const p = ni.address.split('.');
                if (p.length === 4)
                    out.push(`${p[0]}.${p[1]}.${p[2]}.255`);
            }
        }
        return [...new Set(out)];
    }
    emitChanged() {
        const list = this.list();
        const json = JSON.stringify(list);
        if (json === this.lastJson)
            return;
        this.lastJson = json;
        this.emit('ships', list);
    }
}
exports.ShipDiscovery = ShipDiscovery;
//# sourceMappingURL=discovery.js.map