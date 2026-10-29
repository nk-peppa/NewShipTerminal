/*
 * tools/ship.mjs — 把构建产物发布到 release 分支
 *
 * release 是只读部署快照（约 0.4 MB），只有本脚本能写：
 *   dist/ + tools/algo-sidecar.py + algo/cocommand2d + package.json + package-lock.json
 *   + 启动器 + build-info.json
 *
 * 目标机 clone 该分支后，双击 run-usv-terminal.cmd 即可：启动器会自检 Node/Git、
 * 自动拉取更新、安装 Electron，然后启动。源码不落到目标机上。
 *
 * 用法：
 *   npm run ship              构建 → 测试 → 提交 → 推送
 *   npm run ship -- --dry     只要构建 + 暂存目录，不碰 git
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.dirname(here);

const BRANCH = 'release';
const WORKTREE = process.env.USV_RELEASE_WORKTREE || 'C:\\usv-release';
const DRY = process.argv.includes('--dry');

function die(msg) {
  console.error(`\n[ship] x ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  console.log(`[ship] ${msg}`);
}

function run(exe, args, opts = {}) {
  try {
    return execFileSync(exe, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`${path.basename(exe)} ${args.join(' ')} 失败：${detail}`);
  }
}

/** git 不一定在 PATH 里，按已知安装位置兜底 */
function resolveGit() {
  const candidates = [
    'git',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
  ];
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['--version'], { stdio: 'ignore' });
      return exe;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function copyTree(src, dst, skip = () => false) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (skip(entry)) continue;
      copyTree(path.join(src, entry), path.join(dst, entry), skip);
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

const git = resolveGit();
if (!git) die('找不到 git（装一个：winget install -e --id Git.Git）');

// ---------- 1. 前置：工作区必须干净 ----------
const repo = run(git, ['-C', desktop, 'rev-parse', '--show-toplevel']).replace(/\//g, '\\');
const dirty = run(git, ['-C', repo, 'status', '--porcelain']);
if (dirty) {
  die(`工作区不干净，先提交或 stash：\n${dirty.split('\n').map((l) => `    ${l}`).join('\n')}`);
}
log(`仓库 ${repo}`);

// ---------- 2. 构建 ----------
log('构建 ...');
execSync('npm run build', { cwd: desktop, stdio: 'inherit' });

// ---------- 3. 测试必须全绿 ----------
log('测试 ...');
execSync('npm test', { cwd: desktop, stdio: 'inherit' });

// ---------- 4. 读取产物元信息 ----------
const infoPath = path.join(desktop, 'build-info.json');
if (!fs.existsSync(infoPath)) die('缺少 build-info.json（npm run build 应该生成它）');
const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
if (info.sourceDirty) die('产物标记为 dirty，拒绝发布');
if (!info.sourceCommit) die('产物没有 sourceCommit，无法溯源');
log(`${info.version} @ ${info.sourceCommit.slice(0, 7)} (${info.sourceRef})`);

// ---------- 5. 组装暂存目录 ----------
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-release-'));
const skipPyc = (name) => name === '__pycache__' || name.endsWith('.pyc');

// dist/firmware 是固件 OTA 包（不属于客户端），但 dist/main/firmware 是编译后的
// OTA 模块必须保留 —— 所以只跳过 dist 顶层的 firmware，不能用全局目录名匹配。
const distSrc = path.join(desktop, 'dist');
const distDst = path.join(stage, 'dist');
fs.mkdirSync(distDst, { recursive: true });
for (const entry of fs.readdirSync(distSrc)) {
  if (entry === 'firmware') continue;
  copyTree(path.join(distSrc, entry), path.join(distDst, entry));
}
copyTree(path.join(desktop, 'tools', 'algo-sidecar.py'), path.join(stage, 'tools', 'algo-sidecar.py'));
copyTree(path.join(desktop, 'algo', 'cocommand2d'), path.join(stage, 'algo', 'cocommand2d'), skipPyc);
copyTree(path.join(desktop, 'run-terminal.ps1'), path.join(stage, 'run-terminal.ps1'));
copyTree(path.join(desktop, 'run-terminal.cmd'), path.join(stage, 'run-usv-terminal.cmd'));
copyTree(path.join(desktop, 'package.json'), path.join(stage, 'package.json'));
copyTree(path.join(desktop, 'package-lock.json'), path.join(stage, 'package-lock.json'));
copyTree(infoPath, path.join(stage, 'build-info.json'));

fs.writeFileSync(
  path.join(stage, '.gitignore'),
  ['node_modules/', '.deps-ok', '*.log', ''].join('\n'),
  'utf8',
);

const shortSha = info.sourceCommit.slice(0, 7);
fs.writeFileSync(
  path.join(stage, 'README.txt'),
  [
    `USV Terminal ${info.version}  (${info.sourceRef}@${shortSha})`,
    '',
    '运行：双击 run-usv-terminal.cmd',
    '      首次会自动安装 Node.js / Git / Electron，并拉取最新产物。',
    '',
    '依赖：',
    '  · Windows 10/11 x64',
    '  · Python 3.9+ 且装有 numpy、scipy（仅 SLAM 侧车需要）',
    '    缺依赖时界面「算法进程」显示异常，控制链路不受影响。',
    '',
    `构建时间：${info.builtAt}`,
    `构建环境：node ${info.node} · ${info.platform}`,
    '',
  ].join('\r\n'),
  'utf8',
);

const stageMb = dirSize(stage) / 1024 / 1024;
log(`暂存 ${stage}  (${stageMb.toFixed(2)} MB)`);

if (DRY) {
  log('--dry：已跳过 git 操作');
  process.exit(0);
}

// ---------- 6. 准备 release worktree ----------
function branchExists(name) {
  try {
    run(git, ['-C', repo, 'rev-parse', '--verify', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

function worktreeRegistered(dir) {
  const out = run(git, ['-C', repo, 'worktree', 'list', '--porcelain']);
  const target = path.resolve(dir).toLowerCase();
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .some((l) => path.resolve(l.slice(9)).toLowerCase() === target);
}

if (!worktreeRegistered(WORKTREE)) {
  if (fs.existsSync(WORKTREE)) die(`${WORKTREE} 已存在但不是本仓库的 worktree，先手动清理`);
  if (branchExists(BRANCH)) {
    run(git, ['-C', repo, 'worktree', 'add', WORKTREE, BRANCH]);
  } else {
    try {
      run(git, ['-C', repo, 'rev-parse', '--verify', `refs/remotes/origin/${BRANCH}`]);
      run(git, ['-C', repo, 'branch', BRANCH, `origin/${BRANCH}`]);
      run(git, ['-C', repo, 'worktree', 'add', WORKTREE, BRANCH]);
    } catch {
      log(`创建 orphan 分支 ${BRANCH}`);
      run(git, ['-C', repo, 'worktree', 'add', '--orphan', '-b', BRANCH, WORKTREE]);
    }
  }
}
log(`worktree ${WORKTREE}`);

// ---------- 7. 用暂存内容替换 worktree（保留 .git） ----------
for (const entry of fs.readdirSync(WORKTREE)) {
  if (entry === '.git') continue;
  fs.rmSync(path.join(WORKTREE, entry), { recursive: true, force: true });
}
copyTree(stage, WORKTREE);
fs.rmSync(stage, { recursive: true, force: true });

// ---------- 8. 提交 ----------
run(git, ['-C', WORKTREE, 'add', '-A']);
const changed = run(git, ['-C', WORKTREE, 'status', '--porcelain']);
if (!changed) {
  log('内容无变化，跳过提交');
} else {
  const msgFile = path.join(os.tmpdir(), `usv-ship-${process.pid}.txt`);
  fs.writeFileSync(
    msgFile,
    [
      `release: ${info.version} from ${shortSha}`,
      '',
      `sourceRef: ${info.sourceRef}`,
      `builtAt:   ${info.builtAt}`,
      '',
    ].join('\n'),
    'utf8',
  );
  run(git, ['-C', WORKTREE, 'commit', '-F', msgFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  fs.rmSync(msgFile, { force: true });
  log(`已提交 ${changed.split('\n').length} 个文件`);
}

// ---------- 9. 推送 ----------
run(git, ['-C', WORKTREE, 'push', '-u', 'origin', BRANCH], { stdio: ['ignore', 'inherit', 'inherit'] });
log(`✓ 已推送 origin/${BRANCH}`);
log('');
log(`目标机首次部署：git clone -b ${BRANCH} --single-branch <url> USV-Terminal`);
log('之后每次：双击 run-usv-terminal.cmd（自动拉取更新）');
