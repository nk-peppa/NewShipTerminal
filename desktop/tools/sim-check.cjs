/*
 * tools/sim-check.cjs —— 水池仿真的自检
 *
 *   1) 几何：从已知位姿向四个方向打射线，距离必须与解析值一致
 *   2) 碰撞：质点判定
 *   3) 链路：HELLO_ACK / STATUS / SCAN2 正常
 *   4) 运动：解锁+油门 → 向北前进
 *   5) 撞击：撞上中央方块后停住且不再前进
 *
 * 用法：npm run sim:check
 */

const { startSim, castScan, collides } = require('./sim-boat.cjs');
const { TcpLink } = require('../dist/main/link/tcpLink.js');
const { SafetySupervisor } = require('../dist/main/safety/supervisor.js');

const TCP_PORT = 19627;
const UDP_PORT = 19628;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取某一束的角度对应的距离（米），找不到返回 -1 */
function rangeAt(points, angleDeg) {
  const want = Math.round((((angleDeg % 360) + 360) % 360) * 100);
  let best = null;
  let bestDelta = Infinity;
  for (const p of points) {
    const d = Math.abs(p.angleCdeg - want);
    if (d < bestDelta) {
      bestDelta = d;
      best = p;
    }
  }
  return best && bestDelta <= 60 ? best.distMm / 1000 : -1;
}

async function main() {
  console.log('=== 1. 射线几何（位姿 6.0, 2.6, 航向 90°）===');
  const pts = castScan(6.0, 2.6, Math.PI / 2);
  // 船在 (6,2.6) 朝北：正前撞中央方块下沿 y=5.2 → 2.6m
  check('正前 0° → 中央方块 2.6m', Math.abs(rangeAt(pts, 0) - 2.6) < 0.05, `${rangeAt(pts, 0).toFixed(2)}m`);
  // 正后 180° → 池壁 y=0 → 2.6m
  check('正后 180° → 后壁 2.6m', Math.abs(rangeAt(pts, 180) - 2.6) < 0.05, `${rangeAt(pts, 180).toFixed(2)}m`);
  // 右舷 90° → 池壁 x=12 → 6.0m（右舷=顺时针90°）
  check('右舷 90° → 右壁 6.0m', Math.abs(rangeAt(pts, 90) - 6.0) < 0.05, `${rangeAt(pts, 90).toFixed(2)}m`);
  check('左舷 270° → 左壁 6.0m', Math.abs(rangeAt(pts, 270) - 6.0) < 0.05, `${rangeAt(pts, 270).toFixed(2)}m`);
  check('总点数 > 400', pts.length > 400, `${pts.length} 点`);
  // 左右不对称的障碍物：立柱A 在左舷、立柱B 在右舷，用来锁死顺/逆时针方向
  const starboard = rangeAt(pts, 74); // 顺时针 74° → 立柱B，约 2.5m
  const port = rangeAt(pts, 335); // 顺时针 335°（=左舷 25°）→ 立柱A，约 6.2m
  check('右舷 74° 命中近处立柱B', starboard > 2.0 && starboard < 3.2, `${starboard.toFixed(2)}m`);
  check('左舷 335° 命中远处立柱A', port > 5.5 && port < 7.0, `${port.toFixed(2)}m`);
  check('两侧距离明显不同（非对称场景）', port - starboard > 2.0, `差 ${(port - starboard).toFixed(2)}m`);

  console.log('\n=== 2. 碰撞判定 ===');
  check('池外判碰撞', collides(12.5, 6) === true);
  check('障碍物内判碰撞', collides(6.0, 6.0) === true);
  check('空地不判碰撞', collides(2.0, 2.0) === false);

  console.log('\n=== 3. 链路 ===');
  const sim = startSim({ tcpPort: TCP_PORT, udpPort: UDP_PORT, udp: false, name: 'SIM-CHECK' });
  const safety = new SafetySupervisor({ maxThrottlePct: 100, rudderMaxDeg: 30, uiTimeoutMs: 500 });
  const link = new TcpLink({
    host: '127.0.0.1',
    port: TCP_PORT,
    rateHz: 50,
    reconnectMs: 500,
    getCommand: () => safety.tick(),
  });

  let statuses = 0;
  let scans = 0;
  let lastCount = 0;
  let hello = null;
  link.on('status', () => statuses++);
  link.on('scan', ({ scan }) => {
    scans++;
    lastCount = scan.count;
  });
  link.on('hello', (h) => {
    hello = h;
  });

  link.start();
  await wait(700);
  check('握手成功 · 固件 9.9.9', hello?.fw.join('.') === '9.9.9', hello ? `caps=0x${hello.caps.toString(16)}` : '无 ACK');
  check('STATUS 收包', statuses > 20, `${statuses} 帧`);
  check('SCAN2 收包', scans >= 4, `${scans} 帧`);
  check('SCAN2 点数 > 400', lastCount > 400, `${lastCount} 点`);

  // 时钟同步：至少等到两次 PING 往返（1Hz + 5 次采样取中位数）
  await wait(2600);
  const st = link.state();
  check(
    '测得往返延迟',
    st.rttMs != null && st.rttMs >= 0,
    st.rttMs != null ? `往返 ${st.rttMs}ms（上行 ${st.upMs} / 下行 ${st.downMs}）` : '无采样',
  );
  check(
    '本地链路延迟合理 (< 30ms)',
    st.rttMs != null && st.rttMs < 30,
    `${st.rttMs}ms`,
  );
  check(
    '钟差是跨基准的巨大值（船钟为单调上电计时）',
    st.clockOffsetMs != null && st.clockOffsetMs < -1e9,
    `${st.clockOffsetMs}ms`,
  );

  console.log('\n=== 4. 前进 ===');
  const y0 = sim.stats.pose.y;
  safety.setArm(true);
  const timer = setInterval(() => safety.onUiCmd(1.0, 0), 33);
  await wait(1200);
  const movedNorth = sim.stats.pose.y - y0;
  check('解锁+全油门 → 向北移动', movedNorth > 0.5, `Δy=${movedNorth.toFixed(2)}m`);

  console.log('\n=== 5. 撞击后停住 ===');
  await wait(2500); // 继续全速前进直到撞上中央方块（y≈5.2）
  const yHit = sim.stats.pose.y;
  const vHit = sim.stats.pose.v;
  check('发生碰撞', sim.stats.collisions > 0, `碰撞 ${sim.stats.collisions} 次`);
  check('未穿过障碍物', yHit < 5.25, `y=${yHit.toFixed(2)}m`);
  check('撞后速度归零', Math.abs(vHit) < 0.05, `v=${vHit.toFixed(2)}`);
  await wait(500);
  check('撞后不再前进', Math.abs(sim.stats.pose.y - yHit) < 0.02, `y=${sim.stats.pose.y.toFixed(2)}m`);
  clearInterval(timer);

  console.log('\n=== 6. 转向 ===');
  const yaw0 = sim.stats.pose.yaw;
  safety.setEstop(true);
  await wait(200);
  safety.setEstop(false);
  // 先倒车离开障碍物，再前进打舵
  const t2 = setInterval(() => safety.onUiCmd(-0.5, 0), 33);
  await wait(1200);
  clearInterval(t2);
  const t3 = setInterval(() => safety.onUiCmd(0.6, 1.0), 33);
  await wait(1200);
  const yawDelta = Math.abs(sim.stats.pose.yaw - yaw0);
  check('右舵使航向变化', yawDelta > 0.05, `Δyaw=${((yawDelta * 180) / Math.PI).toFixed(1)}°`);
  clearInterval(t3);

  safety.setArm(false);
  link.stop();
  sim.stop();

  console.log(`\n[check] 结果: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[check] 异常:', err);
  process.exit(1);
});
