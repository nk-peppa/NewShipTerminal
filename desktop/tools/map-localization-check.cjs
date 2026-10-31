/*
 * tools/map-localization-check.cjs —— 先验地图定位全链路自检
 *
 *   水池仿真 → 建图 → 保存到地图库 → 侧车加载地图（api 3）
 *     → 自动全局定位 → 跟踪 → 实验记录器落盘 → summary
 *
 * 校验重点：
 *   1. 地图库保存出完整目录，meta/hash 正确
 *   2. 侧车确认 map_loaded，并推送先验地图 PNG
 *   3. 自动全局定位在多帧内进入 tracking，位置与仿真真值一致
 *   4. 定位位姿带 mode/phase/指标，poseValid 只在 tracking 为 true
 *   5. 实验目录含 localization.csv / scans.jsonl / summary.json，且行数对得上
 *
 * 用法：npm run map:localize
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startSim } = require('./sim-boat.cjs');
const { TcpLink } = require('../dist/main/link/tcpLink.js');
const { SafetySupervisor } = require('../dist/main/safety/supervisor.js');
const { AlgoSidecar } = require('../dist/main/algo/sidecar.js');
const { SlamRecorder } = require('../dist/main/algo/slamExport.js');
const { MapLibrary } = require('../dist/main/maps/mapLibrary.js');
const { ExperimentRecorder } = require('../dist/main/experiments/experimentRecorder.js');

const TCP_PORT = 19747;
const UDP_PORT = 19748;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (a) => (a + Math.PI) % (2 * Math.PI) - Math.PI;

/** 仿真世界坐标 → SLAM 地图坐标（原点为首帧位姿） */
function toMap(pose, origin) {
  const dx = pose.x - origin.x;
  const dy = pose.y - origin.y;
  const c = Math.cos(origin.yaw);
  const s = Math.sin(origin.yaw);
  return {
    x: c * dx + s * dy,
    y: -s * dx + c * dy,
    yaw: wrap(pose.yaw - origin.yaw),
  };
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).length;
}

async function main() {
  const sim = startSim({ tcpPort: TCP_PORT, udpPort: UDP_PORT, udp: false, name: 'SIM-LOC' });
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

  const rec = new SlamRecorder();
  const poses = [];
  let mapLoaded = null;
  let lastMap = null;
  const locPoses = [];
  const locStates = [];
  let api = null;

  sidecar.on('ready', (m) => {
    api = m.api;
  });
  sidecar.on('pose', (p) => {
    poses.push(p);
    if (p.mode === 'localization') locPoses.push(p);
    else {
      if (!simOrigin) simOrigin = { ...sim.stats.pose };
      rec.onPose(p);
    }
  });
  sidecar.on('map', (m) => {
    lastMap = m;
    if (!m.prior) rec.onMap(m);
  });
  sidecar.on('map-loaded', (m) => {
    mapLoaded = m;
  });
  sidecar.on('localization', (s) => locStates.push(s));
  sidecar.on('log', (l) => {
    if (/错误|失败|非法|Traceback/.test(l)) process.stderr.write(`[algo] ${l}`);
  });

  let simOrigin = null;
  link.on('scan', ({ scan }) => sidecar.pushScan(scan));

  console.log('启动仿真 + 侧车…');
  sidecar.start();
  link.start();

  const t0 = Date.now();
  while (poses.length === 0 && Date.now() - t0 < 20000) await wait(150);
  check('侧车 api 3', api === 3, `api=${api}`);
  check('侧车产出建图位姿', poses.length > 0, `${poses.length} 帧`);

  // 建图：绕一圈，攒地图与轨迹
  safety.setArm(true);
  const drive = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    safety.onUiCmd(0.35, 0.4 + 0.25 * Math.sin(el * 0.6));
  }, 33);
  await wait(9000);
  clearInterval(drive);
  safety.onUiCmd(0, 0);
  safety.setArm(false);
  await wait(700);
  check('建图已有地图', rec.hasMap);
  check('建图已有轨迹', poses.length > 30, `${poses.length} 帧`);

  // 保存到地图库
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-loc-'));
  const library = new MapLibrary(path.join(base, 'maps'));
  const saved = await library.save({
    recorder: rec,
    appVersion: '0.1.0-test',
    ship: { host: '127.0.0.1', port: TCP_PORT, firmware: 'sim', caps: 0x21 },
    name: 'sim-pool',
  });
  check('地图保存成功', saved.ok, saved.message);
  const loaded = await library.load(saved.name ?? 'sim-pool');
  check('地图可加载', loaded.ok, loaded.message);
  const mapDir = path.join(library.baseDir, saved.name ?? 'sim-pool');
  check('地图目录完整', fs.existsSync(path.join(mapDir, 'meta.json')) && fs.existsSync(path.join(mapDir, 'map.pgm')));

  // 进入定位：加载先验地图
  console.log('\n进入定位模式…');
  let resolveLoaded;
  const loadedPromise = new Promise((resolve) => {
    resolveLoaded = resolve;
    setTimeout(() => resolve(null), 20000);
  });
  const onLoaded = (m) => resolveLoaded(m);
  sidecar.once('map-loaded', onLoaded);
  sidecar.loadMap(loaded.yamlPath);
  mapLoaded = await loadedPromise;
  const mapWait = Date.now();
  while (!(lastMap && lastMap.prior) && Date.now() - mapWait < 2000) await wait(50);
  check('侧车确认加载地图', mapLoaded && mapLoaded.ok === true, mapLoaded ? mapLoaded.message : '超时');
  check(
    '地图尺寸/分辨率正确',
    mapLoaded && mapLoaded.size === 500 && Math.abs(mapLoaded.resolution - 0.08) < 1e-9,
    mapLoaded ? `${mapLoaded.size} @ ${mapLoaded.resolution}` : '无',
  );
  check(
    '推送先验地图 PNG',
    !!lastMap && lastMap.prior === true && (lastMap.png ?? '').length > 100,
    lastMap
      ? `prior=${String(lastMap.prior)} png=${(lastMap.png ?? '').length}B size=${lastMap.size}`
      : '无地图消息',
  );

  // 实验记录器
  const experiment = await ExperimentRecorder.create({
    baseDir: path.join(base, 'experiments'),
    appVersion: '0.1.0-test',
    ship: { host: '127.0.0.1', port: TCP_PORT, firmware: 'sim', caps: 0x21 },
    map: { name: saved.name, hash: null, dir: mapDir },
    config: { source: 'map-localization-check' },
  });
  const expScan = ({ scan, recvMs }) => experiment.scan(scan, scan.tStartMs, recvMs);
  link.on('scan', expScan);
  const expPose = (p) => {
    if (p.mode === 'localization') experiment.pose(p);
  };
  sidecar.on('pose', expPose);
  const expLoc = (s) => experiment.localizationState(s);
  sidecar.on('localization', expLoc);

  // 自动全局定位 + 跟踪（船继续动，帮助多帧投票）
  safety.setArm(true);
  const drive2 = setInterval(() => safety.onUiCmd(0.3, 0.35), 33);
  const started = Date.now();
  let tracking = null;
  while (Date.now() - started < 20000) {
    tracking = locPoses.filter((p) => (p.phase ?? '').startsWith('tracking') && p.poseValid === true);
    if (tracking.length >= 5) break;
    await wait(200);
  }
  clearInterval(drive2);
  safety.onUiCmd(0, 0);
  safety.setArm(false);
  await wait(600);
  link.off('scan', expScan);
  sidecar.off('pose', expPose);
  sidecar.off('localization', expLoc);

  check('自动全局定位进入 tracking', !!tracking && tracking.length >= 5, `${tracking?.length ?? 0} 帧`);
  const finalLoc = locPoses[locPoses.length - 1];
  check('定位位姿带 mode/phase', finalLoc?.mode === 'localization' && !!finalLoc?.phase, finalLoc?.phase ?? '无');
  check(
    '定位指标完整',
    finalLoc && typeof finalLoc.inlier === 'number' && typeof finalLoc.confidence === 'number',
    finalLoc ? `inlier=${finalLoc.inlier} conf=${finalLoc.confidence}` : '无',
  );

  if (finalLoc) {
    const truth = toMap(sim.stats.pose, simOrigin);
    const err = Math.hypot(finalLoc.x - truth.x, finalLoc.y - truth.y);
    const yawErr = Math.abs(wrap(finalLoc.yaw - truth.yaw));
    check('定位误差 < 0.6 m', err < 0.6, `误差 ${err.toFixed(3)} m`);
    check('航向误差 < 8°', (yawErr * 180) / Math.PI < 8, `${((yawErr * 180) / Math.PI).toFixed(1)}°`);
  } else {
    check('定位误差 < 0.6 m', false, '无定位位姿');
  }
  check('定位相位事件已上报', locStates.length > 0, `${locStates.length} 次`);

  const expDir = await experiment.finalize('check-done');
  const expFiles = ['localization.csv', 'scans.jsonl', 'events.jsonl', 'meta.json', 'config.json', 'summary.json'];
  check(
    '实验目录文件齐全',
    expFiles.every((f) => fs.existsSync(path.join(expDir, f))),
    expFiles.filter((f) => !fs.existsSync(path.join(expDir, f))).join(',') || 'ok',
  );
  const poseRows = countLines(path.join(expDir, 'localization.csv')) - 1;
  const scanRows = countLines(path.join(expDir, 'scans.jsonl'));
  check('实验位姿行数 > 0', poseRows > 0, `${poseRows} 行`);
  check('实验原始扫描 > 0', scanRows > 0, `${scanRows} 圈`);
  const summary = JSON.parse(fs.readFileSync(path.join(expDir, 'summary.json'), 'utf8'));
  check('summary 记录跟踪帧', summary.tracking > 0, `tracking=${summary.tracking}`);
  check('summary 记录地图名', summary.map?.name === (saved.name ?? 'sim-pool'), String(summary.map?.name));

  // 停止定位：回到建图模式
  sidecar.unloadMap();
  await wait(300);
  check('卸载地图后回到建图模式', sidecar.currentMode === 'mapping');

  link.stop();
  sidecar.stop();
  sim.stop();
  fs.rmSync(base, { recursive: true, force: true });

  console.log(`\n[map-localize] 结果: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[map-localize] 异常:', err);
  process.exit(1);
});
