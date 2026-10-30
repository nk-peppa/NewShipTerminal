/*
 * tools/log-50hz-check.cjs —— 50Hz 记录完整性自检
 *
 *   假船端每 200ms 突发 10 帧 STATUS（船钟 20ms 步进，共 50 帧/秒）
 *   ⇄ 真实 TcpLink + SessionLogger
 *
 * 校验重点（实船 STATUS 就是 50Hz，这里要证明「一帧都不丢」）：
 *   1. 发出的 STATUS 帧数 == 链路解出的帧数（TcpLink 没漏解）
 *   2. 解出的帧数 == status.csv 行数（日志没漏写）
 *   3. 解出的帧数 == rx.*.bin 里的 STATUS 帧数（原始流完整）
 *   4. 船钟连续性自检 0 缺口，最大间隔 ≤ 25ms
 *   5. 一次 write 里塞 10 帧（多帧同分片）也照样全收
 *
 * 用法：npm run log:50hz
 */

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protocol = require('../dist/shared/protocol.js');
const { TcpLink } = require('../dist/main/link/tcpLink.js');
const { SafetySupervisor } = require('../dist/main/safety/supervisor.js');
const { SessionLogger } = require('../dist/main/log/sessionLog.js');

const PORT = 19947;
const RUNTIME_MS = 10_000;
const BURST_EVERY_MS = 200;
const PER_BURST = 10;
const BURST = PER_BURST * 1000 / BURST_EVERY_MS; // 50 帧/秒

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function statusFrame(boatMs) {
  const p = Buffer.alloc(26);
  p.writeUInt32LE(boatMs >>> 0, 0);
  p.writeInt16LE(0, 4);
  p.writeUInt8(0, 6);
  for (let i = 0; i < 4; i++) p.writeInt16LE(0, 7 + i * 2);
  p.writeUInt8(0x08, 15); // ST_LIDAR_OK
  p.writeUInt16LE(0, 16);
  p.writeUInt16LE(0, 18);
  p.writeUInt16LE(450, 20);
  p.writeUInt16LE(0, 22);
  p.writeUInt16LE(500, 24);
  return protocol.buildFrame(protocol.T_STATUS, 0, p);
}

/** 从 rx.*.bin 里重新分帧，数 STATUS 帧 */
function countRxStatus(dir) {
  const parser = new protocol.FrameParser();
  let count = 0;
  for (const name of fs.readdirSync(dir).filter((n) => /^rx\.\d{3}\.bin$/.test(n))) {
    const buf = fs.readFileSync(path.join(dir, name));
    let off = 0;
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32LE(off);
      for (const f of parser.feed(buf.subarray(off + 12, off + 12 + len))) {
        if (f.type === protocol.T_STATUS) count++;
      }
      off += 12 + len;
    }
  }
  if (parser.crcErrors) console.log(`  ! 原始流 CRC 错误 ${parser.crcErrors}`);
  return count;
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-50hz-'));
  const log = new SessionLogger({ baseDir: base });
  const safety = new SafetySupervisor({ maxThrottlePct: 60, rudderMaxDeg: 30, uiTimeoutMs: 5000 });
  const link = new TcpLink({
    host: '127.0.0.1',
    port: PORT,
    rateHz: 50,
    reconnectMs: 200,
    getCommand: () => safety.tick(),
  });

  let sent = 0;
  let boatMs = 0;
  const parser = new protocol.FrameParser();

  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      for (const f of parser.feed(chunk)) {
        if (f.type === protocol.T_HELLO) {
          socket.write(
            protocol.buildFrame(
              protocol.T_HELLO_ACK,
              0,
              protocol.packHelloAck({
                proto: 2,
                fw: [9, 9, 9],
                caps: 0x03,
                uptimeS: 1,
                hwId: 'SIM50',
              }),
            ),
          );
        }
      }
    });
    const timer = setInterval(() => {
      if (socket.destroyed) return;
      const frames = [];
      for (let i = 0; i < PER_BURST; i++) {
        boatMs += 20;
        frames.push(statusFrame(boatMs));
        sent++;
      }
      // 一次写入 10 帧：制造真实的「多帧落在同一个 TCP 分片」
      socket.write(Buffer.concat(frames));
    }, BURST_EVERY_MS);
    socket.on('close', () => clearInterval(timer));
  });

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  let statuses = 0;
  link.setWireTap((dir, data, at) => log.wire(dir, data, at));
  link.on('status', (st) => {
    statuses++;
    log.status(st);
  });

  console.log('[50hz] 启动链路…');
  link.start();
  await new Promise((r) => setTimeout(r, RUNTIME_MS));
  link.stop();
  const stats = log.close('50hz-check');
  server.close();

  const rows =
    fs.readFileSync(path.join(log.dir, 'status.csv'), 'utf8').trim().split('\n').length - 1;
  const rxStatus = countRxStatus(log.dir);
  const rate = rows / (RUNTIME_MS / 1000);

  check('发出 50Hz STATUS', sent >= 400, `sent=${sent} (${BURST}/s)`);
  check('链路解出全部 STATUS', statuses === sent, `received=${statuses}/${sent}`);
  check('status.csv 行数与收帧一致', rows === statuses, `rows=${rows}/${statuses}`);
  check('原始流里的 STATUS 帧数一致', rxStatus === statuses, `rx=${rxStatus}/${statuses}`);
  check('实测记录速率 ≈50Hz', rate >= 45 && rate <= 55, `${rate.toFixed(1)} 行/s`);
  check('无船钟缺口', stats.statusGaps === 0, `gaps=${stats.statusGaps}`);
  check('最大帧间隔 ≤25ms', stats.maxStatusGapMs <= 25, `max=${stats.maxStatusGapMs}ms`);

  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\n[50hz] 结果: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[50hz] 异常:', err);
  process.exit(1);
});
