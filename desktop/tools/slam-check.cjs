/*
 * tools/slam-check.cjs —— SLAM 全链路自检
 *
 *   水池仿真 → TcpLink → Python 侧车（cocommand2d）→ 位姿 + 地图
 *
 * 用法：npm run slam:check
 */

const path = require('node:path');
const { startSim } = require('./sim-boat.cjs');
const { TcpLink } = require('../dist/main/link/tcpLink.js');
const { SafetySupervisor } = require('../dist/main/safety/supervisor.js');
const { AlgoSidecar } = require('../dist/main/algo/sidecar.js');

const TCP_PORT = 19727;
const UDP_PORT = 19728;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sim = startSim({ tcpPort: TCP_PORT, udpPort: UDP_PORT, udp: false, name: 'SIM-SLAM' });
  const safety = new SafetySupervisor({ maxThrottlePct: 60, rudderMaxDeg: 30, uiTimeoutMs: 500 });

  const sidecar = new AlgoSidecar({
    python: 'python',
    script: path.join(__dirname, 'algo-sidecar.py'),
    cwd: __dirname,
  });

  const link = new TcpLink({
    host: '127.0.0.1',
    port: TCP_PORT,
    rateHz: 50,
    reconnectMs: 500,
    getCommand: () => safety.tick(),
  });

  const poses = [];
  const maps = [];
  const logs = [];

  sidecar.on('pose', (p) => poses.push(p));
  sidecar.on('map', (m) => maps.push(m));
  sidecar.on('log', (l) => logs.push(l));

  // 与 bridge.ts 一致：每收到一圈点云就喂给算法
  link.on('scan', ({ scan }) => sidecar.pushScan(scan));

  sidecar.start();
  link.start();

  // 等侧车启动：Python + numpy/scipy 首次导入通常 1~3 秒
  const t0 = Date.now();
  while (poses.length === 0 && Date.now() - t0 < 15000) await wait(150);
  const startupMs = Date.now() - t0;

  check('侧车启动并产出位姿', poses.length > 0, `${startupMs}ms 出首帧`);
  check(
    '首帧状态为 INITIALIZING（3 帧确认）',
    (poses[0]?.status ?? '').startsWith('INITIALIZING'),
    poses[0]?.status ?? '无',
  );

  // 沿 2m 半径绕圈：油门 35%、右舵 50%，不碰壁
  safety.setArm(true);
  const drive = setInterval(() => safety.onUiCmd(0.35, 0.5), 33);
  await wait(9000);
  clearInterval(drive);
  safety.setArm(false);
  await wait(600);

  const last = poses[poses.length - 1];
  const truePose = sim.stats.pose;
  const trueDisp = Math.hypot(truePose.x - 6.0, truePose.y - 2.6);
  const slamDisp = last ? Math.hypot(last.x, last.y) : 0;

  check('持续产出位姿（≈10Hz）', poses.length > 70, `${poses.length} 帧 / 10.8s`);
  check('最终状态 TRACKING', (last?.status ?? '').startsWith('TRACKING'), last?.status ?? '无');
  check('内点率 > 0.5', (last?.inlier ?? 0) > 0.5, `${((last?.inlier ?? 0) * 100).toFixed(0)}%`);
  check('匹配残差 < 5cm', (last?.rmse ?? 1) < 0.05, `${(((last?.rmse ?? 1) / 100) * 100).toFixed(2)}cm`);
  check(
    'SLAM 位移与真值一致（±15%）',
    trueDisp > 0.5 && Math.abs(slamDisp - trueDisp) / trueDisp < 0.15,
    `SLAM ${slamDisp.toFixed(2)}m vs 真值 ${trueDisp.toFixed(2)}m`,
  );

  check('收到地图快照', maps.length >= 2, `${maps.length} 次`);
  const m = maps[maps.length - 1];
  if (m) {
    const buf = Buffer.from(m.png, 'base64');
    const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    check('地图是合法 PNG', isPng, `${(buf.length / 1024).toFixed(1)} KB`);
    check('地图尺寸与分辨率正确', m.size === 500 && m.resolution === 0.08, `${m.size} cells @ ${m.resolution}m`);
    check('已观测格子 > 2000', m.observed > 2000, `${m.observed} cells`);
  } else {
    check('地图是合法 PNG', false, '无地图');
  }

  const errLog = logs.filter((l) => l.includes('错误') || l.includes('失败') || l.includes('非法'));
  check('侧车无错误日志', errLog.length === 0, errLog.join(' | ').slice(0, 120));

  link.stop();
  sidecar.stop();
  sim.stop();

  console.log(`\n[slam-check] 结果: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[slam-check] 异常:', err);
  process.exit(1);
});
