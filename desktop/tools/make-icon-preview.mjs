/**
 * 生成 Xbox 图标预览页（开发用，产物在 dist-test，不进仓库）。
 *   npm run icons   →  desktop/dist-test/icons/preview.html
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

const outDir = path.join(process.cwd(), 'dist-test', 'icons');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: ['tools/icon-preview.ts'],
  bundle: true,
  outfile: path.join(outDir, 'preview.js'),
  format: 'iife',
  target: 'chrome120',
  logLevel: 'warning',
});

const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Xbox icons</title></head>
<body><script src="preview.js"></script></body>
</html>
`;
writeFileSync(path.join(outDir, 'preview.html'), html, 'utf8');

console.log(`[icons] 预览已生成：${path.join(outDir, 'preview.html')}`);
