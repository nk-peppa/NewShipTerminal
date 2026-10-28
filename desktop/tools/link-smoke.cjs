/*
 * tools/link-smoke.cjs —— 无界面端到端自检
 *
 *   假船端 ⇄ TcpLink + SafetySupervisor
 *   覆盖：连接 / 50Hz 下发 / STATUS / SCAN / 未解锁不输出 / 解锁 / 急停 / UI 超时归零
 *
 * 用法：npm run smoke
 */

const { startSim } = require('./sim-boat.cjs');
const { TcpLink } = require('../dist/main/link/tcpLink.js');
const { SafetySupervisor } = require('../dist/main/safety/supervisor.js');

const TCP_PORT = 19527;
const UDP_PORT = 19528;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function drive(safety, ms, throttle, rudder) {
  const timer = setInterval(() => safety.onUiCmd(throttle, rudder), 33);
  await wait(ms);
  clearInterval(timer);
}

async function main() {
  const sim = startSim({ tcpPort: TCP_PORT, udpPort: UDP_PORT, udp: false, name: 'SIM-SMOKE' });
  const safety = new SafetySupervisor({ maxThrottlePct: 60, rudderMaxDeg: 30, uiTimeoutMs: 500 });
  const link = new TcpLink({
    host: '127.0.0.1',
    port: TCP_PORT,
    rateHz: 50,
    reconnectMs: 500,
    getCommand: () => safety.tick(),
  });

  let statuses = 0;
  let scans = 0;
  let lastScanCount = 0;
  let crcErr = 0;
  link.on('status', () => statuses++);
  link.on('scan', ({ scan }) => {
    scans++;
    lastScanCount = scan.count;
    crcErr = link.state().crcErrors;
  });

  console.log('[smoke] 启动链路…');
  link.start();
  await wait(800);

  check('TCP 已连接', sim.stats.connections >= 1, `connections=${sim.stats.connections}`);
  check('已发出 50Hz 量级 CMD', sim.stats.cmds > 20, `cmds=${sim.stats.cmds}`);

  sim.stats.maxThrottleX10 = 0;
  sim.stats.minThrottleX10 = 0;
  await drive(safety, 600, 0.5, 0.5);
  check('未解锁时不输出油门', sim.stats.maxThrottleX10 === 0, `max=${sim.stats.maxThrottleX10}`);

  safety.setArm(true);
  await drive(safety, 600, 0.5, 0.5);
  check('解锁后油门 30%', Math.abs(sim.stats.maxThrottleX10 - 300) <= 10, `max=${sim.stats.maxThrottleX10}`);
  const lastCmd = sim.stats.lastCmd;
  check('舵角 15°', lastCmd && Math.abs((lastCmd.servosX10[0] ?? 0) - 150) <= 5, `servo=${lastCmd?.servosX10[0]}`);
  check('STATUS 50Hz 量级', statuses > 20, `statuses=${statuses}`);
  check('SCAN 10Hz 量级', scans >= 5, `scans=${scans}`);
  check('SCAN 点数正确', lastScanCount === 450, `count=${lastScanCount}`);
  check('SCAN 解码无 CRC 错', crcErr === 0, `crc=${crcErr}`);

  // 先落急停，再等在途的 30% 帧排空，最后重置计数断言
  safety.setEstop(true);
  await wait(200);
  sim.stats.maxThrottleX10 = 0;
  await drive(safety, 400, 0.5, 0.5);
  check('急停时油门归零', sim.stats.maxThrottleX10 === 0, `max=${sim.stats.maxThrottleX10}`);
  check('急停标志已下发', sim.stats.estopFrames > 0, `frames=${sim.stats.estopFrames}`);

  safety.setEstop(false);
  await wait(800); // 停止心跳，等 UI 超时（500ms）生效并把在途帧排空
  sim.stats.maxThrottleX10 = 0;
  await wait(400);
  check('UI 失联后输出归零', sim.stats.maxThrottleX10 === 0, `max=${sim.stats.maxThrottleX10}`);

  safety.setArm(false);
  link.stop();
  sim.stop();

  console.log(`\n[smoke] 结果: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] 异常:', err);
  process.exit(1);
});
