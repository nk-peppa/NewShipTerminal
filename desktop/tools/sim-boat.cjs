/*
 * tools/sim-boat.cjs —— 本地假船端（协议 v1/v2）
 *
 *   TCP :9527  收 CMD(50Hz)，回 STATUS(50Hz) + SCAN2(10Hz)
 *   UDP :9528  每 1s 广播 USVDISC1 beac，并应答 prob
 *
 * 仿真的世界：一个 12m 正方形水池 + 若干障碍物，理想激光雷达
 *   - 射线投射，无噪声、无漏点、无强度衰减
 *   - 单圈 450 束均匀分布，超过 12m 视为无回波（该点被丢弃）
 *   - 船简化为半径 5cm 的圆；撞到池壁或障碍物立即停住（速度归零，位置不前进）
 *   - 动力只做一阶惯性近似，重点是「操控语义」与协议一致，不追求物理真实
 *
 * 用于没有实船时联调 UI / 链路 / SLAM 适配层。
 * 用法：
 *   node tools/sim-boat.cjs
 *   node tools/sim-boat.cjs --tcp-port 9527 --no-udp
 *   node tools/sim-boat.cjs --start 6,2.6,90      # x,y,航向(度,逆时针为正)
 */

const net = require('node:net');
const dgram = require('node:dgram');
const zlib = require('node:zlib');
const os = require('node:os');
const fs = require('node:fs');

// console.log 在被重定向到管道/文件时可能阻塞事件循环；诊断时改用同步写文件
const LOG_FILE = process.env.USV_SIM_LOG || '';
function logLine(text) {
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString().slice(11, 23)} ${text}\n`);
    } catch {
      /* ignore */
    }
  } else {
    console.log(text);
  }
}

const {
  buildFrame,
  FrameParser,
  packHelloAck,
  T_CMD,
  T_HELLO,
  T_HELLO_ACK,
  T_PING,
  T_PONG,
  T_STATUS,
  T_SCAN2,
  CAP_SCAN2,
} = require('../dist/shared/protocol.js');

/* ---------------- 世界 ---------------- */

const POOL = 12.0; // 正方形水池边长（米），内部为 [0,POOL]²
const LIDAR_MAX_M = 12.0; // C1 量程上限
const SCAN_POINTS = 450; // 单圈束数（0.8°，与实测 443 同量级）
const SCAN_HZ = 10;

/** 轴对齐矩形障碍物（池内假想浮标、立柱、浮台） */
const OBSTACLES = [
  { x0: 5.2, y0: 5.2, x1: 6.8, y1: 6.8, label: '中央方块' },
  { x0: 2.8, y0: 8.2, x1: 3.6, y1: 9.0, label: '立柱A' },
  { x0: 8.4, y0: 3.0, x1: 9.2, y1: 3.8, label: '立柱B' },
  { x0: 7.6, y0: 8.0, x1: 10.0, y1: 8.6, label: '浮台' },
];

/** 池壁 + 障碍物边，展开成线段表供射线投射 */
function buildSegments() {
  const segs = [
    [0, 0, POOL, 0],
    [POOL, 0, POOL, POOL],
    [POOL, POOL, 0, POOL],
    [0, POOL, 0, 0],
  ];
  for (const o of OBSTACLES) {
    segs.push(
      [o.x0, o.y0, o.x1, o.y0],
      [o.x1, o.y0, o.x1, o.y1],
      [o.x1, o.y1, o.x0, o.y1],
      [o.x0, o.y1, o.x0, o.y0],
    );
  }
  return segs;
}

const SEGMENTS = buildSegments();

/** 射线与线段求交，返回沿射线的最小正距离；无交返回 -1 */
function raySegment(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return -1;
  const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
  if (t <= 0) return -1;
  const u = ((ax - ox) * dy - (ay - oy) * dx) / den;
  if (u < 0 || u > 1) return -1;
  return t;
}

/** 从位姿打一圈射线，返回 [{angleCdeg, distMm}]，无回波的点被丢弃 */
function castScan(x, y, yawRad) {
  const out = [];
  for (let i = 0; i < SCAN_POINTS; i++) {
    const angleCdeg = Math.round((i * 36000) / SCAN_POINTS) % 36000;
    // 协议角度是「0=正前、顺时针增大」；世界航向用逆时针，故相减
    const a = (angleCdeg / 100) * (Math.PI / 180);
    const dir = yawRad - a;
    const dx = Math.cos(dir);
    const dy = Math.sin(dir);
    let best = Infinity;
    for (const s of SEGMENTS) {
      const t = raySegment(x, y, dx, dy, s[0], s[1], s[2], s[3]);
      if (t > 0 && t < best) best = t;
    }
    if (!Number.isFinite(best) || best > LIDAR_MAX_M) continue;
    const distMm = Math.round(best * 1000);
    if (distMm <= 0) continue;
    out.push({ angleCdeg, distMm });
  }
  return out;
}

/** 质点等效半径：避免贴边抖动，也让擦角更真实 */
const BODY_R = 0.05;

/** 船体（半径 BODY_R 的圆）是否与池壁或障碍物相撞 */
function collides(x, y) {
  if (x < BODY_R || x > POOL - BODY_R || y < BODY_R || y > POOL - BODY_R) return true;
  for (const o of OBSTACLES) {
    if (x > o.x0 - BODY_R && x < o.x1 + BODY_R && y > o.y0 - BODY_R && y < o.y1 + BODY_R) return true;
  }
  return false;
}

/* ---------------- 动力模型 ---------------- */

const V_MAX_FWD = 2.5; // 100% 油门 ≈ 2.5 m/s（客户端 60% 限幅 ≈ 1.5 m/s）
const V_MAX_REV = 1.0;
const TAU_S = 0.6; // 速度一阶惯性时间常数
const YAW_MAX = (45 * Math.PI) / 180; // 满舵最大角速度
const YAW_SPEED_REF = 0.8; // 低于此速度舵效线性下降，静止不能转向
const WATCHDOG_MS = 300;
const PHYS_DT = 0.01;

/* ---------------- 协议辅助 ---------------- */

function unpackCmd(payload) {
  if (payload.length < 12) return null;
  return {
    throttleX10: payload.readInt16LE(0),
    servosX10: [
      payload.readInt16LE(2),
      payload.readInt16LE(4),
      payload.readInt16LE(6),
      payload.readInt16LE(8),
    ],
    flags: payload.readUInt8(10),
  };
}

/** SCAN2 载荷：24 字节头 + 点数据（zlib） */
function packScan2(scan) {
  const count = scan.points.length;
  const raw = Buffer.alloc(count * 5);
  for (let i = 0; i < count; i++) {
    const p = scan.points[i];
    const o = i * 5;
    raw.writeUInt16LE(p.angleCdeg % 36000, o);
    raw.writeUInt16LE(Math.min(65535, p.distMm), o + 2);
    raw.writeUInt8(p.quality ?? 60, o + 4);
  }
  const body = count ? zlib.deflateSync(raw) : raw;
  const h = Buffer.alloc(24);
  h.writeUInt32LE(scan.tStartMs >>> 0, 0);
  h.writeUInt32LE(scan.tEndMs >>> 0, 4);
  h.writeUInt32LE(scan.scanSeq >>> 0, 8);
  h.writeUInt16LE(count, 12);
  h.writeUInt16LE(scan.originalCount, 14);
  h.writeUInt8(count ? 1 : 0, 16); // encoding: 1=zlib
  h.writeUInt8(scan.lidarOk ? 0x01 : 0, 17);
  h.writeUInt16LE(Math.round(SCAN_HZ * 100), 18);
  h.writeUInt8(63, 20); // qualityMax（C1 原始量程 0..63）
  h.writeUInt8(0, 21);
  h.writeUInt16LE(0, 22);
  return Buffer.concat([h, body]);
}

/* ---------------- 主循环 ---------------- */

function startSim(opts = {}) {
  const tcpPort = opts.tcpPort ?? 9527;
  const udpPort = opts.udpPort ?? 9528;
  const useUdp = opts.udp !== false;
  const name = opts.name ?? 'SIM-USV';
  const start = opts.start ?? { x: 6.0, y: 2.6, yaw: Math.PI / 2 };

  const stats = {
    connections: 0,
    cmds: 0,
    lastCmd: null,
    lastCmdAt: 0,
    maxThrottleX10: 0,
    minThrottleX10: 0,
    armedFrames: 0,
    estopFrames: 0,
    loopHzX10: 0,
    statusTx: 0,
    scanTx: 0,
    bytesTx: 0,
    collisions: 0,
    pose: { x: start.x, y: start.y, yaw: start.yaw, v: 0 },
  };

  let client = null;
  let scanSeq = 0;
  let scansTotal = 0;
  let lastCmd = { throttleX10: 0, servosX10: [0, 0, 0, 0], flags: 0 };
  let lastCmdSeq = 0;
  let cmdWindow = 0;
  let pointsLast = 0;
  let armed = false; // 掉线即清解锁，与固件一致
  let stuck = false; // 当前是否顶在障碍物上（用于碰撞计数去抖）
  let hitX = 0;
  let hitY = 0;
  const t0 = process.hrtime.bigint();
  const monoMs = () => Number((process.hrtime.bigint() - t0) / 1000000n);

  const parser = new FrameParser();

  const server = net.createServer((socket) => {
    stats.connections++;
    if (client) client.destroy();
    client = socket;
    socket.setNoDelay(true);
    parser.crcErrors = 0;

    socket.on('data', (chunk) => {
      for (const frame of parser.feed(chunk)) {
        if (frame.type === T_HELLO) {
          const p = packHelloAck({
            proto: 2,
            fw: [9, 9, 9],
            caps: CAP_SCAN2,
            uptimeS: Math.floor(monoMs() / 1000),
            hwId: 'SIM0001',
          });
          const f = buildFrame(T_HELLO_ACK, 0, p);
          socket.write(f);
          stats.bytesTx += f.length;
          continue;
        }
        if (frame.type === T_PING) {
          // 时钟同步：T2/T3 用同一个时刻（仿真器无处理延迟）
          if (frame.payload.length >= 8) {
            const t1 = frame.payload.readBigUInt64LE(0);
            const now = monoMs() >>> 0;
            const p = Buffer.alloc(16);
            p.writeBigUInt64LE(t1, 0);
            p.writeUInt32LE(now, 8);
            p.writeUInt32LE(now, 12);
            const f = buildFrame(T_PONG, 0, p);
            socket.write(f);
            stats.bytesTx += f.length;
          }
          continue;
        }
        if (frame.type !== T_CMD) continue;
        const cmd = unpackCmd(frame.payload);
        if (!cmd) continue;
        lastCmd = cmd;
        lastCmdSeq = frame.seq;
        cmdWindow++;
        armed = !!(cmd.flags & 0x01);
        stats.cmds++;
        stats.lastCmd = cmd;
        stats.lastCmdAt = Date.now();
        stats.maxThrottleX10 = Math.max(stats.maxThrottleX10, cmd.throttleX10);
        stats.minThrottleX10 = Math.min(stats.minThrottleX10, cmd.throttleX10);
        if (cmd.flags & 0x01) stats.armedFrames++;
        if (cmd.flags & 0x02) stats.estopFrames++;
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      if (client === socket) client = null;
      armed = false;
    });
  });

  server.listen(tcpPort, '0.0.0.0');

  /* --- 物理推进 100Hz --- */
  const physTimer = setInterval(() => {
    const p = stats.pose;
    const estop = !!(lastCmd.flags & 0x02);
    const stale = stats.lastCmdAt === 0 || Date.now() - stats.lastCmdAt > WATCHDOG_MS;
    const enabled = armed && !estop && !stale;

    const throttleNorm = enabled ? Math.max(-1, Math.min(1, lastCmd.throttleX10 / 1000)) : 0;
    const rudderNorm = enabled ? Math.max(-1, Math.min(1, (lastCmd.servosX10[0] ?? 0) / 300)) : 0;

    const vTarget = throttleNorm >= 0 ? throttleNorm * V_MAX_FWD : throttleNorm * V_MAX_REV;
    p.v += (vTarget - p.v) * Math.min(1, PHYS_DT / TAU_S);

    const authority = Math.min(1, Math.abs(p.v) / YAW_SPEED_REF);
    // 右舵（正）在逆时针为正的世界里使航向减小
    const yawRate = -rudderNorm * YAW_MAX * authority;

    const nx = p.x + p.v * Math.cos(p.yaw) * PHYS_DT;
    const ny = p.y + p.v * Math.sin(p.yaw) * PHYS_DT;
    if (collides(nx, ny)) {
      // 只有「从自由状态撞上」才计数；离开撞击点 10cm 后才允许再次计数
      if (!stuck) {
        stats.collisions++;
        stuck = true;
        hitX = p.x;
        hitY = p.y;
      }
      p.v = 0; // 撞到就停
    } else {
      p.x = nx;
      p.y = ny;
      p.yaw += yawRate * PHYS_DT;
      // 保持 ±π 有界，避免长时间运行后角度无限增长（日志里会看到 -395° 这种）
      if (p.yaw > Math.PI) p.yaw -= 2 * Math.PI;
      else if (p.yaw < -Math.PI) p.yaw += 2 * Math.PI;
      if (stuck && Math.hypot(p.x - hitX, p.y - hitY) > 0.1) stuck = false;
    }
  }, PHYS_DT * 1000);

  /* --- STATUS 50Hz --- */
  const statusTimer = setInterval(() => {
    try {
      stats.loopHzX10 = cmdWindow * 10;
      cmdWindow = 0;
      if (!client || client.destroyed) return;

      const p = stats.pose;
      const estop = !!(lastCmd.flags & 0x02);
      const stale = stats.lastCmdAt === 0 || Date.now() - stats.lastCmdAt > WATCHDOG_MS;
      const enabled = armed && !estop && !stale;
      const thr = enabled ? lastCmd.throttleX10 : 0;
      const dir = estop ? 3 : p.v > 0.02 ? 1 : p.v < -0.02 ? 2 : 0;

      const buf = Buffer.alloc(26);
      buf.writeUInt32LE(monoMs() >>> 0, 0);
      buf.writeInt16LE(thr, 4);
      buf.writeUInt8(dir, 6);
      for (let i = 0; i < 4; i++) buf.writeInt16LE(lastCmd.servosX10[i] ?? 0, 7 + i * 2);
      let flags = 0x08 | 0x10; // ST_LIDAR_OK | ST_ARM_REQUIRED
      if (armed) flags |= 0x01;
      if (estop) flags |= 0x02;
      if (stale) flags |= 0x04;
      buf.writeUInt8(flags, 15);
      buf.writeUInt16LE(lastCmdSeq, 16);
      buf.writeUInt16LE(parser.crcErrors, 18);
      buf.writeUInt16LE(pointsLast, 20);
      buf.writeUInt16LE(scansTotal & 0xffff, 22);
      buf.writeUInt16LE(500, 24);

      const frame = buildFrame(T_STATUS, scansTotal & 0xffff, buf);
      client.write(frame);
      stats.statusTx++;
      stats.bytesTx += frame.length;
    } catch (err) {
      logLine(`[sim] status 发送异常 ${err.message}`);
    }
  }, 20);

  /* --- SCAN2 10Hz --- */
  let lastScanEnd = monoMs();
  const scanTimer = setInterval(() => {
    scanSeq = (scanSeq + 1) & 0xffff;
    scansTotal++;
    const p = stats.pose;
    const points = castScan(p.x, p.y, p.yaw);
    pointsLast = points.length;
    if (!client || client.destroyed) {
      lastScanEnd = monoMs();
      return;
    }
    try {
      const tEnd = monoMs();
      const payload = packScan2({
        tStartMs: lastScanEnd,
        tEndMs: tEnd,
        scanSeq,
        originalCount: SCAN_POINTS,
        points,
        lidarOk: true,
      });
      lastScanEnd = tEnd;
      const frame = buildFrame(T_SCAN2, scanSeq, payload);
      client.write(frame);
      stats.scanTx++;
      stats.bytesTx += frame.length;
    } catch (err) {
      logLine(`[sim] scan 发送异常 ${err.message}`);
    }
  }, 1000 / SCAN_HZ);

  /* --- UDP 广播 --- */
  let udp = null;
  let udpTimer = null;
  if (useUdp) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
      }
    }
    const beacon = () =>
      Buffer.concat([
        Buffer.from('USVDISC1', 'ascii'),
        Buffer.from('beac', 'ascii'),
        Buffer.from(
          JSON.stringify({
            kind: 'usv',
            ver: 1,
            name,
            sn: 'SIM00001',
            tcp_port: tcpPort,
            ips,
            state: stuck ? 'collision' : armed ? 'armed' : 'idle',
            lidar: true,
            armed,
            estop: !!(lastCmd.flags & 0x02),
            failsafe: stats.lastCmdAt === 0 || Date.now() - stats.lastCmdAt > WATCHDOG_MS,
            hz: stats.loopHzX10 / 10,
            uptime_s: monoMs() / 1000,
            t: Math.floor(Date.now() / 1000),
            reply_to_probe: true,
          }),
          'utf8',
        ),
      ]);

    udp.on('message', (msg, rinfo) => {
      if (msg.length >= 12 && msg.subarray(0, 8).toString('ascii') === 'USVDISC1') {
        if (msg.subarray(8, 12).toString('ascii') === 'prob') {
          udp.send(beacon(), rinfo.port, rinfo.address, () => {});
        }
      }
    });
    udp.bind(udpPort);
    udpTimer = setInterval(() => {
      udp.send(beacon(), udpPort, '255.255.255.255', () => {});
    }, 1000);
  }

  function stop() {
    clearInterval(physTimer);
    clearInterval(statusTimer);
    clearInterval(scanTimer);
    if (udpTimer) clearInterval(udpTimer);
    client?.destroy();
    server.close();
    udp?.close();
  }

  return { stats, tcpPort, udpPort, stop, world: { pool: POOL, obstacles: OBSTACLES } };
}

module.exports = { startSim, castScan, collides, POOL, OBSTACLES, SEGMENTS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const num = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : dflt;
  };
  const str = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : dflt;
  };

  let start = { x: 6.0, y: 2.6, yaw: Math.PI / 2 };
  const raw = str('--start', '');
  if (raw) {
    const [sx, sy, sdeg] = raw.split(',').map(Number);
    if ([sx, sy, sdeg].every((n) => Number.isFinite(n))) {
      start = { x: sx, y: sy, yaw: (sdeg * Math.PI) / 180 };
    }
  }

  const sim = startSim({
    tcpPort: num('--tcp-port', 9527),
    udpPort: num('--udp-port', 9528),
    udp: !argv.includes('--no-udp'),
    start,
  });

  const pointsNow = () =>
    castScan(sim.stats.pose.x, sim.stats.pose.y, sim.stats.pose.yaw).length;

  logLine(`[sim] 水池 ${POOL}m×${POOL}m · 障碍物 ${OBSTACLES.length} 个 · 理想雷达 ${SCAN_POINTS} 束 @ ${SCAN_HZ}Hz`);
  logLine(
    `[sim] 起点 (${start.x.toFixed(1)}, ${start.y.toFixed(1)}) 航向 ${((start.yaw * 180) / Math.PI).toFixed(0)}°`,
  );
  logLine(`[sim] TCP ${sim.tcpPort} · UDP ${sim.udpPort} · 等待上位机连接…`);

  let prevCmds = 0;
  let prevAt = Date.now();
  setInterval(() => {
    const c = sim.stats.lastCmd;
    const p = sim.stats.pose;
    const now = Date.now();
    const hz = ((sim.stats.cmds - prevCmds) * 1000) / (now - prevAt);
    prevCmds = sim.stats.cmds;
    prevAt = now;
    logLine(
      `[sim] cmd=${sim.stats.cmds} (${hz.toFixed(1)}Hz) 连接=${sim.stats.connections} ` +
        `pos=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}) 航向=${((p.yaw * 180) / Math.PI).toFixed(0)}° ` +
        `v=${p.v.toFixed(2)}m/s 点=${pointsNow()} 撞=${sim.stats.collisions} ` +
        (c
          ? `油门=${(c.throttleX10 / 10).toFixed(1)}% 舵=${(c.servosX10[0] / 10).toFixed(1)}°`
          : '尚无指令'),
    );
  }, 2000);

  process.on('SIGINT', () => {
    sim.stop();
    process.exit(0);
  });
}
