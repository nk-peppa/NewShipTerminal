import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist', 'renderer');

await mkdir(out, { recursive: true });
for (const file of ['index.html', 'style.css']) {
  await copyFile(path.join(src, file), path.join(out, file));
}
console.log(`[assets] 已复制 ${out}`);
