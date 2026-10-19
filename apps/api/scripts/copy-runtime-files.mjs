/**
 * 构建后把运行期 JS（worker.mjs）复制进 dist。
 * worker 是纯 JS（不参与 tsc），但必须和编译后的 pool 放在相对位置：
 *   dist/services/covers.js  ←  new URL('../covers/worker.mjs', import.meta.url)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', 'src', 'covers', 'worker.mjs');
const target = path.join(here, '..', 'dist', 'covers', 'worker.mjs');

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`copied ${path.relative(process.cwd(), source)} -> ${path.relative(process.cwd(), target)}`);
