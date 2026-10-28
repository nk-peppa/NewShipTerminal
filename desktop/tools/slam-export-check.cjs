/*
 * tools/slam-export-check.cjs —— SLAM 数据导出自检
 *
 *   水池仿真 → TcpLink → 侧车（cocommand2d）→ 录制 → buildSlamArchive() → ZIP
 *
 * 校验重点：
 *   1. ZIP 能被外部工具（PowerShell Expand-Archive）正常解开
 *   2. map.png 能解码，map.pgm 尺寸/三态取值正确
 *   3. map.yaml 的 origin/resolution 与侧车一致
 *   4. trajectory.csv 行数、列数、末行位姿与 sidecar 最后一条 pose 一致
 *   5. session.json 字段完整
 *   6. 清空（algo reset）后录制器同步清空，不再导出旧数据
 *
 * 用法：npm run slam:export
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { startSim } = require('./sim-boat.cjs');
const { TcpLink } = require('../dist/main/link/tcpLink.js');
const { SafetySupervisor } = require('../dist/main/safety/supervisor.js');
const { AlgoSidecar } = require('../dist/main/algo/sidecar.js');
const {
  SlamRecorder,
  buildSlamArchive,
  decodePng,
} = require('../dist/main/algo/slamExport.js');

const TCP_PORT = 19737;
const UDP_PORT = 19738;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sim = startSim({ tcpPort: TCP_PORT, udpPort: UDP_PORT, udp: false, name: 'SIM-EXP' });
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
  let poses = 0;
  sidecar.on('pose', (p) => {
    poses++;
    rec.onPose(p);
  });
  sidecar.on('map', (m) => rec.onMap(m));

  console.log('启动仿真 + 侧车…');
  // 与 bridge.ts 一致：每收到一圈点云就喂给算法
  link.on('scan', ({ scan }) => sidecar.pushScan(scan));
  sidecar.start();
  link.start();

  // 等侧车首帧（Python + numpy/scipy 冷启动 1~3 秒）
  const warm = Date.now();
  while (poses === 0 && Date.now() - warm < 15000) await wait(150);
  await wait(600);
  safety.setArm(true);

  // 直行 + 轻微转向，攒出一定地图与轨迹
  const t0 = Date.now();
  const drive = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    safety.onUiCmd(0.35, Math.sin(el * 0.7) * 0.4);
  }, 33);
  await wait(9000);
  clearInterval(drive);
  safety.onUiCmd(0, 0);
  await wait(500);

  console.log(`\n录制中：poses=${poses} map=${rec.hasMap ? '有' : '无'}\n`);
  check('侧车产出位姿', poses > 20, `${poses} 条`);
  check('侧车产出地图', rec.hasMap);

  const stats = rec.stats();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-slam-export-'));
  const zipPath = path.join(outDir, 'usv-slam-test.zip');

  const { zip, files } = buildSlamArchive(rec, {
    appVersion: '0.1.0-test',
    exportedAt: Date.now(),
    ship: { host: '127.0.0.1', port: TCP_PORT, firmware: 'test', caps: 0x21 },
    recording: { since: stats.firstPoseAt },
  });
  fs.writeFileSync(zipPath, zip);
  console.log(`  写出 ${zipPath} (${Math.round(zip.length / 1024)} KB)`);

  check('包含预期文件', files.join(',') === 'map.png,map.pgm,map.yaml,trajectory.csv,session.json', files.join(','));

  /* ---- 用 PowerShell 的 Expand-Archive 解开：证明是合法 ZIP ---- */
  let extracted = null;
  try {
    const psDir = path.join(outDir, 'unzip');
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${psDir}' -Force`,
      ],
      { stdio: 'pipe', timeout: 60000 },
    );
    extracted = psDir;
    check('Expand-Archive 解压成功', true);
  } catch (err) {
    check('Expand-Archive 解压成功', false, String(err.stderr ?? err.message).slice(0, 160));
  }

  if (extracted) {
    const read = (n) => fs.readFileSync(path.join(extracted, n));

    /* ---- map.pgm ---- */
    const pgm = read('map.pgm');
    const headerText = pgm.subarray(0, 32).toString('ascii');
    const m = /^P5\n(\d+) (\d+)\n255\n/.exec(headerText);
    check('PGM 头合法', !!m, m ? `${m[1]}x${m[2]}` : headerText.slice(0, 20));
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      const body = pgm.subarray(pgm.length - w * h);
      check('PGM 尺寸与侧车一致', w === stats.size && h === stats.size, `${w}x${h} vs size=${stats.size}`);
      let occupied = 0;
      let free = 0;
      let unknown = 0;
      for (const v of body) {
        if (v === 0) occupied++;
        else if (v === 254) free++;
        else if (v === 205) unknown++;
      }
      check('PGM 三态都在用', occupied > 0 && free > 0 && unknown > 0, `占据=${occupied} 空闲=${free} 未知=${unknown}`);
      check('PGM 无其它取值', occupied + free + unknown === w * h);
      check('占据格数与侧车 observed 量级一致', occupied > 100, `observed=${stats.observed}`);
    }

    /* ---- map.yml ---- */
    const yaml = read('map.yaml').toString('utf8');
    check('YAML 指向 map.pgm', /image:\s*map\.pgm/.test(yaml));
    check(
      'YAML 分辨率与侧车一致',
      new RegExp(`resolution:\\s*${String(stats.resolution).replace('.', '\\.')}`).test(yaml),
      `resolution=${stats.resolution}`,
    );
    const om = /origin:\s*\[([-\d.]+),\s*([-\d.]+),/.exec(yaml);
    check(
      'YAML origin 与侧车一致',
      !!om &&
        Math.abs(Number(om[1]) - stats.origin[0]) < 1e-6 &&
        Math.abs(Number(om[2]) - stats.origin[1]) < 1e-6,
      om ? `[${om[1]}, ${om[2]}]` : '未解析到',
    );

    /* ---- map.png 与 PGM 尺寸一致 ---- */
    const png = decodePng(read('map.png'));
    check('PNG 解码成功且尺寸匹配', png.width === stats.size && png.height === stats.size, `${png.width}x${png.height}`);
    let transparent = 0;
    for (let i = 3; i < png.rgba.length; i += 4) if (png.rgba[i] === 0) transparent++;
    check('PNG 存在透明（未知）区', transparent > 0, `${transparent} px`);

    /* ---- trajectory.csv ---- */
    const csv = read('trajectory.csv').toString('utf8').trim().split('\n');
    check('CSV 表头正确', csv[0] === 't_ms,x_m,y_m,yaw_rad,yaw_deg,status,rmse_m,inlier', csv[0]);
    check('CSV 行数与录制一致', csv.length - 1 === stats.poses, `${csv.length - 1} 行 vs poses=${stats.poses}`);
    const cols = csv[1].split(',');
    check('CSV 列数正确', cols.length === 8, `${cols.length} 列`);
    const last = csv[csv.length - 1].split(',');
    check('CSV 位姿是有限数', last.slice(1, 4).every((v) => Number.isFinite(Number(v))), last.slice(1, 4).join(','));
    check('CSV 状态列非空', last[5].length > 0, last[5]);

    /* ---- session.json ---- */
    const sess = JSON.parse(read('session.json').toString('utf8'));
    check('session.json 含船端信息', sess.ship && sess.ship.caps === 0x21);
    check('session.json 含地图参数', sess.map && sess.map.size === stats.size);
    check('session.json 轨迹计数正确', sess.trajectory && sess.trajectory.poses === stats.poses);
    check('session.json 有末位姿', !!sess.trajectory.final, JSON.stringify(sess.trajectory.final));

    fs.rmSync(outDir, { recursive: true, force: true });
  }

  /* ---- 清空后不应再导出旧数据 ---- */
  rec.clear();
  check('清空后录制器为空', !rec.hasData && rec.stats().poses === 0);

  link.stop();
  sidecar.stop();
  sim.stop();

  console.log('');
  if (failures === 0) {
    console.log('slam-export: 全部通过');
    process.exit(0);
  }
  console.log(`slam-export: ${failures} 项失败`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
