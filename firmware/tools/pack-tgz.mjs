/*
 * firmware/tools/pack-tgz.mjs —— 打 OTA 固件包（tar.gz）
 *
 * 为什么要自己写 tar：Windows 自带的 bsdtar 不支持 --mode，打出来的二进制是
 * 0666（没有执行位）。固件解包时 `tar` crate 会按包头里的 mode 落盘，于是新版
 * 切过去之后 systemd 直接 203/EXEC（Permission denied），回滚看门狗被触发。
 * 2026-10-28 真机上踩过一次：客户端显示「升级完成」，版本却仍是旧的。
 *
 * Pi 上的 scripts/make-package.sh 用 GNU tar 且有 chmod 755，所以那边没问题；
 * 这个脚本是给 Windows 本地交叉编译用的等价实现。
 *
 * 用法：node tools/pack-tgz.mjs <stageDir> <outFile.tar.gz>
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [, , stageDir, outFile] = process.argv;
if (!stageDir || !outFile) {
  console.error('用法：node tools/pack-tgz.mjs <stageDir> <outFile.tar.gz>');
  process.exit(2);
}

/** 各文件应有的权限（与 make-package.sh 一致） */
const MODES = {
  'usv-edge': 0o755,
  'manifest.json': 0o644,
};

const BLOCK = 512;

function octal(n, width) {
  // tar 的数值字段是「前导 0 的八进制 + NUL」
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function writeHeader({ name, mode, size, typeflag = '0' }) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii'); // mtime（0 = 1970，包可重现）
  h.write('        ', 148, 8, 'ascii'); // chksum 先占位为空格
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function padTo(data) {
  const rest = data.length % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest, 0);
}

const names = fs.readdirSync(stageDir).filter((n) => MODES[n] !== undefined).sort();
if (!names.includes('usv-edge')) {
  console.error(`缺少 ${stageDir}/usv-edge`);
  process.exit(1);
}

const parts = [];
// 与 `tar -C stage .` 对齐：先放一个 ./ 目录项
parts.push(writeHeader({ name: './', mode: 0o755, size: 0, typeflag: '5' }));

for (const n of names) {
  const data = fs.readFileSync(path.join(stageDir, n));
  parts.push(writeHeader({ name: `./${n}`, mode: MODES[n], size: data.length }));
  parts.push(data, padTo(data));
}

// 归档结束：两个全零块
parts.push(Buffer.alloc(BLOCK * 2, 0));
const tar = Buffer.concat(parts);

fs.writeFileSync(outFile, zlib.gzipSync(tar, { level: 9 }));
const st = fs.statSync(outFile);
console.log(
  `[pack] ${outFile}  ${st.size} B  ` +
    names.map((n) => `${n}=${MODES[n].toString(8)}`).join(' '),
);
