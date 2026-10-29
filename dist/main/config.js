"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const node_path_1 = __importDefault(require("node:path"));
function argOf(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
}
function loadConfig(argv = process.argv.slice(1)) {
    const host = argOf(argv, '--host');
    const port = Number(argOf(argv, '--port') ?? 0);
    const algoScript = argOf(argv, '--algo-script') ?? node_path_1.default.join(__dirname, '..', '..', 'tools', 'algo-sidecar.py');
    const otaPort = Number(argOf(argv, '--ota-port') ?? 0);
    return {
        ship: { host, port: port > 0 ? port : 9527 },
        ota: { port: otaPort > 0 ? otaPort : 9530 },
        link: { rateHz: 50, reconnectMs: 2000, statusUiHz: 20 },
        control: { maxThrottlePct: 60, rudderMaxDeg: 30, uiTimeoutMs: 500, deadband: 0.08 },
        discovery: {
            enabled: !argv.includes('--no-discovery') && !host,
            udpPort: Number(argOf(argv, '--udp-port') ?? 9528),
            probeIntervalMs: 2500,
            ttlMs: 6000,
        },
        algo: {
            enabled: !argv.includes('--no-algo'),
            python: argOf(argv, '--python') ?? 'python',
            script: algoScript,
        },
        ui: { window: !argv.includes('--no-window') },
    };
}
//# sourceMappingURL=config.js.map