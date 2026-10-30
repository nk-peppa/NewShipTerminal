/*
 * tools/package-release.mjs —— 打 Windows 便携版发布包
 *
 * 产出：
 *   release/USV Terminal-win32-x64/          可直接双击运行的目录
 *   release/USV-Terminal-<ver>-win32-x64.zip 分发用压缩包
 *
 * 为什么不用 asar：
 *   Python 侧车（tools/algo-sidecar.py）和 vendor 进来的 algo/cocommand2d 必须
 *   以真实文件存在，Python 读不了 asar。所以整包保持散文件布局。
 *
 * 为什么排除这么多 node_modules：
 *   主进程只用 electron + node 内置模块（net/dgram/fs/zlib），没有任何运行时
 *   第三方依赖；node_modules 里除了 electron 本身全是构建期工具。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here); // desktop/
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'release');
const appName = 'USV Terminal';

// 打进包里的东西：运行必需的源码/资源 + 侧车脚本 + SLAM 算法
const keep = ['dist', 'tools', 'algo', 'package.json'];
// 明确不要的：源码、测试产物、构建工具链、发布产物本身
const ignore = [
  '^/src',
  '^/dist-test',
  '^/release',
  '^/node_modules/(?!electron$)',
  '^/tsconfig',
  '^/\\.',
  '^/docs',
  '^/test',
  '^/sim\\.log$',
  '^/.*\\.cmd$',
  '^/README\\.md$',
  '^/package-lock\\.json$',
  '^/tools/[^/]*\\.cjs$', // 自检脚本不进发布包
  '^/tools/[^/]*\\.mjs$',
];

for (const p of keep) {
  if (!fs.existsSync(path.join(root, p))) {
    console.error(`缺少 ${p}，先跑 npm run build`);
    process.exit(1);
  }
}

console.log(`[pkg] ${pkg.name} ${pkg.version} → ${outDir}`);

// 用 API 而不是 CLI，便于精确控制 ignore（CLI 的 --ignore 重复传参会互相覆盖）
const { packager } = await import('@electron/packager');
const appPaths = await packager({
  dir: root,
  name: appName,
  platform: 'win32',
  arch: 'x64',
  out: outDir,
  overwrite: true,
  asar: false,
  prune: true,
  ignore: ignore.map((s) => new RegExp(s)),
  appVersion: pkg.version,
  win32metadata: {
    CompanyName: 'GTI USV',
    FileDescription: 'USV Terminal',
    ProductName: appName,
    InternalName: 'usv-terminal',
    OriginalFilename: `${appName}.exe`,
  },
});

if (!appPaths.length) {
  console.error('[pkg] 打包失败');
  process.exit(1);
}
const appDir = appPaths[0];
console.log(`[pkg] 目录：${appDir}`);

// 说明文件（分发时一眼知道怎么跑、缺什么）
const readme = [
  `${appName} ${pkg.version}`,
  '',
  '运行：双击 "USV Terminal.exe"',
  '',
  '依赖：',
  '  · Windows 10/11 x64',
  '  · Python 3.10+ 且装有 numpy、scipy（SLAM 侧车用；3.9 不兼容）',
  '    缺依赖时界面右下「算法进程」会显示异常，控制链路不受影响。',
  '',
  '用法要点：',
  '  · 手柄：左摇杆油门/舵角，右摇杆地图平移，R3 三态视角，',
  '          LB/RB 旋转，LT/RT 缩放，十字键 ↑解锁 ↓急停，',
  '          View 保存 SLAM 数据，Menu 进入菜单导航（A 确认 / B 退出）',
  '  · 默认自动发现船端（UDP 9528 广播）；也可用 --host <ip> 直连',
  '  · 保存的 SLAM 数据为 ZIP：map.pgm/map.yaml（ROS 格式）、map.png、',
  '    trajectory.csv、session.json',
  '',
].join('\r\n');
fs.writeFileSync(path.join(appDir, 'README.txt'), readme, 'utf8');

// 用 PowerShell 的 Compress-Archive 打包：系统自带、无额外依赖。
//
// 不能直接把路径拼进 -Command：源码目录里带单引号（"刘鸣艺's files"），
// PowerShell 会把命令字符串截断。改成写临时 .ps1 用 -File 执行，
// 路径经环境变量传进去，绕开所有引号问题。
const zipPath = path.join(outDir, `USV-Terminal-${pkg.version}-win32-x64.zip`);
fs.rmSync(zipPath, { force: true });
console.log('[pkg] 压缩…');
const ps1 = path.join(os.tmpdir(), 'usv-pack-release.ps1');
fs.writeFileSync(
  ps1,
  [
    '$ErrorActionPreference = "Stop"',
    // 注意用 -Path（会展开通配符）而不是 -LiteralPath（会把 * 当字面量）
    'Compress-Archive -Path (Join-Path $env:USV_PKG_SRC "*") `',
    '  -DestinationPath $env:USV_PKG_DST -CompressionLevel Optimal -Force',
    '',
  ].join('\r\n'),
  'utf8',
);
try {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    stdio: 'inherit',
    timeout: 600000,
    env: { ...process.env, USV_PKG_SRC: appDir, USV_PKG_DST: zipPath },
  });
} finally {
  fs.rmSync(ps1, { force: true });
}
if (!fs.existsSync(zipPath)) {
  console.error('[pkg] 压缩失败：没有生成 ZIP');
  process.exit(1);
}

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log('');
console.log(`[pkg] ✓ ${appName} ${pkg.version}`);
console.log(`      目录 ${appDir}`);
console.log(`      ZIP  ${zipPath}  (${mb(zipPath)} MB)`);
