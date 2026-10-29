/*
 * tools/build-info.mjs — 生成 build-info.json
 *
 * 回答一个 package.json 回答不了的问题：**这份产物是哪个 commit 编出来的**。
 * release 分支只放产物，靠这个字段反查 main 上的源码；界面也用它显示版本。
 *
 * 在 npm run build 的最后一步执行，产物落在 desktop/build-info.json（已 gitignore）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here); // desktop/

/** git 不一定在 PATH 里（本机就是如此），按已知安装位置兜底 */
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

const git = resolveGit();

function gitOut(args) {
  if (!git) return null;
  try {
    return execFileSync(git, ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const commit = gitOut(['rev-parse', 'HEAD']);
const ref = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
const porcelain = gitOut(['status', '--porcelain']);

const info = {
  version: pkg.version,
  sourceCommit: commit,
  sourceRef: ref,
  /** null = 没有 git，无法判断 */
  sourceDirty: porcelain === null ? null : porcelain.length > 0,
  builtAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
};

const out = path.join(root, 'build-info.json');
fs.writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`, 'utf8');

const short = commit ? commit.slice(0, 7) : 'no-git';
const dirty = info.sourceDirty ? ' (dirty)' : '';
console.log(`[info] ${info.version} @ ${short}${dirty} → build-info.json`);
