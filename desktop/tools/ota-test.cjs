/*
 * tools/ota-test.cjs —— 无界面验证 OTA 闭环
 *
 *   node tools/ota-test.cjs <host> <pkg> [controlPort] [otaPort]
 *
 * 1) 升级前 HELLO 读版本
 * 2) 上传包（9530）
 * 3) 轮询 HELLO，确认重启后版本变化
 */

const path = require('node:path');
const { runOta, probeFirmware, versionFromFilename } = require('../dist/main/firmware/ota.js');

const host = process.argv[2] || '192.168.3.9';
const pkg = process.argv[3];
const controlPort = Number(process.argv[4] || 19527);
const otaPort = Number(process.argv[5] || 19530);

if (!pkg) {
  console.error('用法: node tools/ota-test.cjs <host> <pkg.tar.gz> [controlPort] [otaPort]');
  process.exit(2);
}

const fmt = (v) => (Array.isArray(v) ? v.join('.') : v);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function readVersion(label) {
  try {
    const ack = await probeFirmware(host, controlPort, 1500);
    console.log(`[${label}] 固件 ${fmt(ack.fw)} · proto=${ack.proto} caps=0x${ack.caps.toString(16)} hw=${ack.hwId}`);
    return ack.fw;
  } catch (e) {
    console.log(`[${label}] 读取版本失败: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`[ota] 目标 ${host}  ctrl=${controlPort}  ota=${otaPort}`);
  console.log(`[ota] 包 ${path.basename(pkg)}  目标版本 ${fmt(versionFromFilename(pkg))}`);

  const before = await readVersion('before');

  const started = Date.now();
  let lastPct = -1;
  const result = await runOta({
    host,
    port: otaPort,
    file: pkg,
    onEvent: (e) => {
      const pct = e.total ? Math.floor((e.received * 100) / e.total) : 0;
      if (pct !== lastPct || e.phase !== 'sending') {
        lastPct = pct;
        console.log(`  [${e.phase}] ${pct}% (${e.received}/${e.total})${e.message ? ' · ' + e.message : ''}`);
      }
    },
  });

  console.log(
    `[ota] 结果 ok=${result.ok} status=${result.status} msg="${result.message}" ` +
      `用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (!result.ok) process.exit(1);

  // 设备会重启；轮询 HELLO 直到版本变化或超时
  for (let i = 0; i < 20; i++) {
    await wait(1000);
    const now = await readVersion(`after+${i + 1}s`);
    if (now && fmt(now) !== fmt(before)) {
      console.log(`[ota] ✅ 版本已切换: ${fmt(before)} → ${fmt(now)}`);
      process.exit(0);
    }
  }
  console.log('[ota] ⚠ 未观察到版本变化（检查 supervisor 是否从 current 启动）');
  process.exit(1);
}

main().catch((e) => {
  console.error('[ota] 异常:', e);
  process.exit(1);
});
