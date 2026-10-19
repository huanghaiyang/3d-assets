/**
 * 封面渲染自测：验证后端子线程（worker_threads + headless-gl）能把模型渲染成 PNG。
 *
 *   npm run test:cover -w @h3d/api
 *
 * 不联网；所有测试数据写在项目内 `.tmp-test/`（gitignore），
 * 封面磁盘缓存也指向项目内的临时数据目录，不写系统盘。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const tempRoot = path.join(repoRoot, '.tmp-test', `cover-selftest-${Date.now().toString(36)}`);
await fs.mkdir(tempRoot, { recursive: true });
// 必须先设置数据目录，再加载 covers / paths 模块
process.env.H3D_DATA_DIR = path.join(tempRoot, 'data');

const { getCoverRenderer, shutdownCoverRenderer, animationCover, clearAnimationCoverCache, getCoverCacheDir } =
  await import('../services/covers.js');

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail === undefined ? '' : detail);
  }
}

function pngInfo(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** 解出我们自己的 PNG（RGBA + filter 0），用于检测“画出来是不是空的” */
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1);
    if (raw[start] !== 0) throw new Error('只支持 filter 0');
    raw.copy(rgba, y * width * 4, start + 1, start + 1 + width * 4);
  }
  return { width, height, rgba };
}

function analyze(rgba: Buffer): { coverage: number; colors: number; red: number; blue: number } {
  let opaque = 0;
  let red = 0;
  let blue = 0;
  const colors = new Set<string>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 16) {
      opaque += 1;
      colors.add(`${rgba[i] >> 4},${rgba[i + 1] >> 4},${rgba[i + 2] >> 4}`);
      if (rgba[i] > 120 && rgba[i] > rgba[i + 1] * 1.5 && rgba[i] > rgba[i + 2] * 1.5) red += 1;
      if (rgba[i + 2] > 120 && rgba[i + 2] > rgba[i + 1] * 1.5 && rgba[i + 2] > rgba[i] * 1.5) blue += 1;
    }
  }
  const total = rgba.length / 4;
  return { coverage: opaque / total, colors: colors.size, red: red / total, blue: blue / total };
}

function objCube(): string {
  const lines = ['o cube'];
  const points: [number, number, number][] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  for (const [x, y, z] of points) lines.push(`v ${x} ${y} ${z}`);
  const faces = [
    [1, 2, 3, 4],
    [5, 8, 7, 6],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 8, 4],
    [5, 1, 4, 8],
  ];
  for (const face of faces) lines.push(`f ${face.join(' ')}`);
  return `${lines.join('\n')}\n`;
}

function gltfTriangle(): string {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  const buffer = Buffer.from(positions.buffer);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.9, 0.3, 0.2, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: buffer.length, target: 34962 }],
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
  };
  return JSON.stringify(json);
}

/** 生成一个带 PNG 棋盘格贴图的 GLB，验证 WebGL 真的采样了贴图 */
function texturedGlb(): Buffer {
  const texture = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const index = (y * 64 + x) * 4;
      const isRed = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      texture.data[index] = isRed ? 230 : 30;
      texture.data[index + 1] = 30;
      texture.data[index + 2] = isRed ? 30 : 230;
      texture.data[index + 3] = 255;
    }
  }
  const pngBytes = PNG.sync.write(texture);

  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const chunks = [
    Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
    Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength),
    Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
    pngBytes,
  ];
  const bin = Buffer.concat(chunks);
  const offsets = [];
  let cursor = 0;
  for (const chunk of chunks) {
    offsets.push(cursor);
    cursor += chunk.byteLength;
    while (cursor % 4 !== 0) {
      cursor += 1;
    }
  }
  const paddedBin = Buffer.alloc(cursor);
  bin.copy(paddedBin, 0);

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, TEXCOORD_0: 1 },
            indices: 2,
            material: 0,
          },
        ],
      },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: chunks[0].byteLength },
      { buffer: 0, byteOffset: offsets[1], byteLength: chunks[1].byteLength },
      { buffer: 0, byteOffset: offsets[2], byteLength: chunks[2].byteLength },
      { buffer: 0, byteOffset: offsets[3], byteLength: chunks[3].byteLength },
    ],
    buffers: [{ byteLength: paddedBin.length }],
  };

  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.alloc(Math.ceil(jsonBuffer.length / 4) * 4, 0x20);
  jsonBuffer.copy(jsonPadded);
  const binPadded = Buffer.alloc(Math.ceil(paddedBin.length / 4) * 4, 0);
  paddedBin.copy(binPadded);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
}

async function main(): Promise<void> {
  console.log(`封面渲染自测（临时目录: ${path.relative(repoRoot, tempRoot)}）`);

  const objPath = path.join(tempRoot, 'cube.obj');
  const gltfPath = path.join(tempRoot, 'triangle.gltf');
  const texturedPath = path.join(tempRoot, 'textured.glb');
  const badPath = path.join(tempRoot, 'model.usdz');
  await fs.writeFile(objPath, objCube(), 'utf8');
  await fs.writeFile(gltfPath, gltfTriangle(), 'utf8');
  await fs.writeFile(texturedPath, texturedGlb());
  await fs.writeFile(badPath, 'fake', 'utf8');

  // 生产里只有一个封面渲染器（headless-gl 原生模块不能在同一进程的多个 worker 里重复加载）
  const renderer = getCoverRenderer();

  try {
    console.log('\n[1] OBJ 立方体（WebGL 引擎）');
    const startedAt = Date.now();
    const objResult = await renderer.renderWithMeta({ filePath: objPath, size: 128 });
    const objInfo = pngInfo(objResult.png);
    const objStats = analyze(decodePng(objResult.png).rgba);
    check('渲染引擎是 webgl（headless-gl）', objResult.engine === 'webgl', objResult.engine);
    check('输出是合法 PNG', objResult.png.length > 500, { bytes: objResult.png.length });
    check('尺寸正确 (128×128)', objInfo.width === 128 && objInfo.height === 128, objInfo);
    check('画出了非空内容（覆盖率 2%~95%）', objStats.coverage > 0.02 && objStats.coverage < 0.95, objStats);
    check('有明暗层次（≥3 种颜色）', objStats.colors >= 3, objStats);
    console.log(`  渲染耗时 ${Date.now() - startedAt}ms`);

    console.log('\n[2] glTF（data URI buffer）');
    const gltfResult = await renderer.renderWithMeta({ filePath: gltfPath, size: 96 });
    const gltfStats = analyze(decodePng(gltfResult.png).rgba);
    check('glTF 渲染成功', pngInfo(gltfResult.png).width === 96);
    check('glTF 三角面可见', gltfStats.coverage > 0.01, gltfStats);
    check('使用了材质颜色（偏红）', gltfStats.red > 0.01, gltfStats);

    console.log('\n[3] 带 PNG 贴图的 GLB（真实 UV 采样）');
    const textured = await renderer.renderWithMeta({ filePath: texturedPath, size: 128 });
    const texturedStats = analyze(decodePng(textured.png).rgba);
    check('贴图模型渲染成功', pngInfo(textured.png).width === 128);
    check('棋盘格两色都出现（红 + 蓝）', texturedStats.red > 0.05 && texturedStats.blue > 0.05, texturedStats);
    check('贴图细节不止 3 种颜色', texturedStats.colors >= 4, texturedStats);

    console.log('\n[4] 并发 + Worker 复用');
    const [left, right] = await Promise.all([
      renderer.renderWithMeta({ filePath: objPath, size: 64 }),
      renderer.renderWithMeta({ filePath: gltfPath, size: 64 }),
    ]);
    check('两个任务并发完成', pngInfo(left.png).width === 64 && pngInfo(right.png).width === 64);
    const again = await renderer.renderWithMeta({ filePath: objPath, size: 64 });
    check('Worker 复用（连续第三次仍成功）', pngInfo(again.png).width === 64);

    console.log('\n[5] 不支持格式 & 软件渲染兜底');
    let rejected = false;
    try {
      await renderer.render({ filePath: badPath, size: 64 });
    } catch {
      rejected = true;
    }
    check('.usdz 之类的格式会明确失败（前端回退浏览器渲染）', rejected);
    const software = await renderer.renderWithMeta({ filePath: objPath, size: 64, engine: 'software' });
    check('显式 software 引擎仍可用（兜底）', software.engine === 'software' && pngInfo(software.png).width === 64);

    console.log('\n[6] 封面磁盘缓存（项目内 data/cache）');
    const fbxDir = 'D:/sgames/CozyVale/assets/mixamo';
    const fbxNames = await fs.readdir(fbxDir).catch(() => [] as string[]);
    const fbxName = fbxNames.find((name) => name.toLowerCase().endsWith('.fbx'));
    if (!fbxName) {
      console.log('  - 本机没有 Mixamo 目录，跳过 IMAGE 缓存测试');
    } else {
      const fbxPath = path.join(fbxDir, fbxName);
      const started = Date.now();
      const first = await animationCover(fbxPath, { size: 128, poseFraction: 0.35 });
      const firstMs = Date.now() - started;
      const cacheDir = getCoverCacheDir();
      check('缓存目录在项目内（不是系统盘临时目录）', cacheDir.startsWith(repoRoot), cacheDir);
      const files = await fs.readdir(cacheDir);
      check('渲染后写出了磁盘缓存', files.some((name) => name.endsWith('.png')), files.length);
      clearAnimationCoverCache();
      const secondStart = Date.now();
      const second = await animationCover(fbxPath, { size: 128, poseFraction: 0.35 });
      const secondMs = Date.now() - secondStart;
      check('第二次命中磁盘缓存（字节一致）', Buffer.compare(first, second) === 0);
      console.log(`  首次 ${firstMs}ms → 缓存命中 ${secondMs}ms`);
      check('缓存命中明显更快', secondMs < firstMs, { firstMs, secondMs });
      const stats = analyze(decodePng(second).rgba);
      check('FBX 姿态封面非空', stats.coverage > 0.02, stats);
    }
  } finally {
    await shutdownCoverRenderer();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('自测异常退出:', (err as Error).stack ?? err);
  process.exit(1);
});
