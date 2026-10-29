/*
 * firmware/tools/ship-fw.mjs — 把固件 OTA 包发布到 release-fw 分支
 *
 * 与客户端的 `npm run ship` 是同一套思路：单独一条 orphan 分支，只放产物。
 * 目标机（或客户端自身）后续可以直接从这条分支取包做 OTA，不必人工传文件。
 *
 * 分支内容（只保留最新一版；历史版本靠 git history 回溯）：
 *   build-info.json                    版本 / 来源 commit / sha256 / 大小 / minClient
 *   usv-edge-<ver>-aarch64.tar.gz      OTA 包（内含 usv-edge 0755 + manifest.json）
 *   usv-edge-<ver>-aarch64.tar.gz.sha256
 *   README.txt
 *
 * 用法（仓库根目录）：
 *   node firmware\tools\ship-fw.mjs            构建 → 校验 → 提交 → 推送
 *   node firmware\tools\ship-fw.mjs --dry      只构建 + 暂存，不碰 git
 *   node firmware\tools\ship-fw.mjs --skip-build  复用现有包重新发布
 */

import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fwDir = path.dirname(here); // firmware/
const repo = path.dirname(fwDir); // 仓库根

const BRANCH = 'release-fw';
const WORKTREE = process.env.USV_FW_WORKTREE || 'C:\\usv-release-fw';
const DRY = process.argv.includes('--dry');
const SKIP_BUILD = process.argv.includes('--skip-build');

const TARGET = 'aarch64-unknown-linux-gnu';

function die(msg) {
  console.error(`\n[ship-fw] x ${msg}\n`);
  process.exit(1);
}
function log(msg) {
  console.log(`[ship-fw] ${msg}`);
}
function run(exe, args, opts = {}) {
  try {
    const out = execFileSync(exe, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return out == null ? '' : String(out).trim();
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`${path.basename(exe)} ${args.join(' ')} 失败：${detail}`);
  }
}
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
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}
function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) copyTree(path.join(src, e), path.join(dst, e));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

const git = resolveGit();
if (!git) die('找不到 git（装一个：winget install -e --id Git.Git）');

// ---------- 1. 前置：工作区必须干净（--dry / --skip-build 也要求，避免发布到一半的树） ----------
const dirty = run(git, ['-C', repo, 'status', '--porcelain']);
if (dirty) {
  die(`工作区不干净，先提交或 stash：\n${dirty.split('\n').map((l) => `    ${l}`).join('\n')}`);
}

// 固件版本唯一来源是 Cargo.toml
const cargoToml = fs.readFileSync(path.join(fwDir, 'Cargo.toml'), 'utf8');
const verMatch = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml);
if (!verMatch) die('读不到 Cargo.toml 里的 version');
const version = verMatch[1];
log(`固件版本 ${version}（Cargo.toml）`);

// ---------- 2. 构建 ----------
const pkgDir = path.join(repo, 'desktop', 'dist', 'firmware');
const pkgName = `usv-edge-${version}-aarch64.tar.gz`;
const pkgPath = path.join(pkgDir, pkgName);

if (SKIP_BUILD) {
  if (!fs.existsSync(pkgPath)) die(`--skip-build 但找不到 ${pkgPath}`);
  log('跳过构建，复用现有包');
} else {
  log('交叉编译 aarch64 ...');
  const ps1 = path.join(fwDir, 'build-local.ps1');
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { cwd: fwDir, stdio: 'inherit' },
  );
  if (!fs.existsSync(pkgPath)) die(`构建完成但找不到 ${pkgPath}`);
}

// ---------- 3. 校验包内容 ----------
// 包里的 manifest.json 是固件自报的身份，必须与 Cargo.toml 一致；
// 二进制执行位丢了会导致 systemd 203/EXEC，所以也在这里查。
const pkgBytes = fs.readFileSync(pkgPath);
const pkgSha = crypto.createHash('sha256').update(pkgBytes).digest('hex');
const pkgSize = fs.statSync(pkgPath).size;

let manifest = null;
{
  const tar = zlib.gunzipSync(pkgBytes);
  // 极简 tar 遍历：只找 manifest.json 的内容，不落盘
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const sizeField = tar.subarray(off + 124, off + 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const modeField = tar.subarray(off + 100, off + 108).toString('ascii').replace(/\0.*$/, '').trim();
    const mode = parseInt(modeField, 8) || 0;
    const body = tar.subarray(off + 512, off + 512 + size);
    const base = name.replace(/^\.\//, '');

    if (base === 'manifest.json') manifest = JSON.parse(body.toString('utf8'));
    if (base === 'usv-edge' && (mode & 0o111) === 0) {
      die(`包内 usv-edge 权限是 0${mode.toString(8)}，缺少执行位（会 203/EXEC）`);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
}
if (!manifest) die('包里没有 manifest.json');
if (manifest.version !== version) {
  die(`包内版本 ${manifest.version} 与 Cargo.toml ${version} 不一致`);
}
if (manifest.arch !== 'aarch64') die(`包内架构 ${manifest.arch} 不是 aarch64`);
log(`包 ${pkgName}  ${(pkgSize / 1024).toFixed(0)} KB  sha256 ${pkgSha.slice(0, 16)}…`);

// ---------- 4. 组装暂存目录 ----------
const shortSha = run(git, ['-C', repo, 'rev-parse', '--short=7', 'HEAD']);
const ref = run(git, ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);

const info = {
  component: 'firmware',
  version,
  sourceCommit: run(git, ['-C', repo, 'rev-parse', 'HEAD']),
  sourceRef: ref,
  target: TARGET,
  file: pkgName,
  sha256: pkgSha,
  size: pkgSize,
  binarySha256: manifest.binary_sha256,
  minClient: manifest.min_client,
  builtAt: new Date().toISOString(),
  buildHost: `${process.platform}-${process.arch} node ${process.version}`,
  /** 固件尚未签名（config: allow_unsigned）；客户端不得据 sha256 代替签名验证 */
  signed: false,
};

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-fw-'));
fs.copyFileSync(pkgPath, path.join(stage, pkgName));
fs.writeFileSync(path.join(stage, `${pkgName}.sha256`), `${pkgSha}  ${pkgName}\n`, 'utf8');
fs.writeFileSync(path.join(stage, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');

fs.writeFileSync(
  path.join(stage, 'README.txt'),
  [
    `USV Edge firmware ${version}  (${ref}@${shortSha})`,
    '',
    `目标架构：${TARGET}`,
    `包大小：  ${(pkgSize / 1024).toFixed(0)} KB`,
    `包 sha256：${pkgSha}`,
    `二进制 sha256：${manifest.binary_sha256}`,
    '',
    '本分支只放固件 OTA 包，由 firmware/tools/ship-fw.mjs 生成，请勿手工修改。',
    '旧版本可通过 git history 取回：',
    `  git show <commit>:${pkgName} > ${pkgName}`,
    '',
    '⚠ 当前固件未签名（设备配置 allow_unsigned=true）。sha256 只能防传输损坏，',
    '  不能防篡改；签名流程落地前，请只从本仓库取包。',
    '',
  ].join('\r\n'),
  'utf8',
);

log(`暂存 ${stage}  (${(dirSize(stage) / 1024).toFixed(0)} KB)`);

if (DRY) {
  log('--dry：已跳过 git 操作');
  process.exit(0);
}

// ---------- 5. 准备 release-fw worktree ----------
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

// ---------- 6. 用暂存内容替换（保留 .git） ----------
for (const entry of fs.readdirSync(WORKTREE)) {
  if (entry === '.git') continue;
  fs.rmSync(path.join(WORKTREE, entry), { recursive: true, force: true });
}
copyTree(stage, WORKTREE);
fs.rmSync(stage, { recursive: true, force: true });

// ---------- 7. 提交 ----------
run(git, ['-C', WORKTREE, 'add', '-A']);
const changed = run(git, ['-C', WORKTREE, 'status', '--porcelain']);
if (!changed) {
  log('内容无变化，跳过提交');
} else {
  const msgFile = path.join(os.tmpdir(), `usv-fw-ship-${process.pid}.txt`);
  fs.writeFileSync(
    msgFile,
    [
      `release-fw: ${version} from ${shortSha}`,
      '',
      `target:    ${TARGET}`,
      `package:   ${pkgName} (${(pkgSize / 1024).toFixed(0)} KB)`,
      `sha256:    ${pkgSha}`,
      `builtAt:   ${info.builtAt}`,
      '',
    ].join('\n'),
    'utf8',
  );
  run(git, ['-C', WORKTREE, 'commit', '-F', msgFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  fs.rmSync(msgFile, { force: true });
  log(`已提交 ${changed.split('\n').length} 个文件`);
}

// ---------- 8. 推送 ----------
run(git, ['-C', WORKTREE, 'push', '-u', 'origin', BRANCH], { stdio: ['ignore', 'inherit', 'inherit'] });
log(`✓ 已推送 origin/${BRANCH}`);
log('');
log(`取用：git show origin/${BRANCH}:${pkgName} > ${pkgName}`);
