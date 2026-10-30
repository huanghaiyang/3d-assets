/**
 * 封面渲染 Worker（Node worker_threads，浏览器主线程之外）。
 *
 * 两种渲染引擎：
 *   1) webgl（首选）：headless-gl（`gl`）提供真实的 WebGL 上下文，three 的 WebGLRenderer
 *      直接渲染，贴图/光照/PBR 与浏览器里一致；
 *   2) software（兜底）：纯 JS 软件光栅器，不需要任何原生依赖，贴图只取平均色。
 *
 * three 的 Loader（GLB / GLTF / FBX / OBJ / STL）在 Node 里可以解析几何；
 * 图片资源没有 DOM，这里把 `URL.createObjectURL` 接成内存 blob 表，
 * 再自己用 pngjs / jpeg-js 解码成 DataTexture 喂给 WebGL。
 *
 * 输入消息：{ id, filePath, size, poseFraction?, engine?, animation?, animationOnly? }
 * 输出消息：{ id, ok: true, png, engine } | { id, ok: false, error }
 *
 * 这个文件是运行期 JS（不参与 tsc），由 scripts/copy-runtime-files.mjs 复制到 dist。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// ===== 无 DOM 垫片 =====
globalThis.self = globalThis;

/** 内存 blob 表：GLTFLoader 会把内嵌贴图做成 Blob 再 createObjectURL，这里拦截下来自己解码 */
const blobStore = new Map();
let blobSeq = 0;
URL.createObjectURL = (blob) => {
  const id = `blob:cover/${blobSeq++}`;
  if (blob && typeof blob.arrayBuffer === 'function') blobStore.set(id, blob);
  return id;
};
URL.revokeObjectURL = (id) => {
  blobStore.delete(id);
};

const emptyTexture = () => new THREE.Texture();

let pngModulePromise = null;
let jpegModulePromise = null;

/** 封面贴图最大边长：封面只有 256px，8192² 的原图上传到 headless-gl 又慢又费内存 */
const MAX_COVER_TEXTURE_SIZE = 1024;
/**
 * jpeg-js 默认只给 512MB 解码内存，超了直接抛错。
 * 生成模型的贴图常见 4096² / 8192²（8192² 全量解码需要 800MB+），
 * 一旦解码失败 GLTFLoader 会丢掉 baseColorTexture，材质退回默认白色 → 封面就成了「白模」。
 * 所以超过这个阈值就先走「只解 DC 系数」的 1/8 降采样路径（见 decodeJpegDownscaled）；
 * 只有降采样不支持的格式（如渐进式 JPEG）才退回全量解码，并按像素量把上限放宽到 1024MB。
 */
const JPEG_FULL_DECODE_MB = 512;
const MAX_JPEG_DECODE_MB = 1024;

/** 从 SOF 段读出 JPEG 尺寸（扫描头里不包含完整图像，只解段头） */
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return null;
}

/** 等比缩到 maxSize 以内（按面积平均降采样），过大贴图不必原样交给 WebGL */
function shrinkRgba(image, maxSize = MAX_COVER_TEXTURE_SIZE) {
  const { width, height, rgba } = image;
  if (width <= maxSize && height <= maxSize) return image;
  const scale = Math.max(width, height) / maxSize;
  const outWidth = Math.max(1, Math.round(width / scale));
  const outHeight = Math.max(1, Math.round(height / scale));
  const out = Buffer.alloc(outWidth * outHeight * 4);
  const stepX = width / outWidth;
  const stepY = height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = Math.floor(y * stepY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * stepY));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = Math.floor(x * stepX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * stepX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        const row = sy * width;
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (row + sx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
          count += 1;
        }
      }
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return { width: outWidth, height: outHeight, rgba: out };
}

/** 把 PNG/JPEG 字节解码成 RGBA（超大图降到 MAX_COVER_TEXTURE_SIZE 以内） */
async function decodeImageBuffer(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') {
    if (!pngModulePromise) pngModulePromise = import('pngjs');
    const mod = await pngModulePromise;
    const PNG = mod.PNG ?? mod.default?.PNG;
    const png = PNG.sync.read(bytes);
    return shrinkRgba({ width: png.width, height: png.height, rgba: png.data });
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (!jpegModulePromise) jpegModulePromise = import('jpeg-js').then((mod) => mod.default ?? mod);
    const jpeg = await jpegModulePromise;
    const size = jpegDimensions(bytes);
    const requiredMb = size
      ? Math.ceil((size.width * size.height * 12) / 1048576) + 48
      : MAX_JPEG_DECODE_MB;
    if (requiredMb > JPEG_FULL_DECODE_MB) {
      // 超大贴图：全量解码要 800MB+ 且慢，先走内存几 MB 的 1/8 降采样路径
      try {
        return shrinkRgba(decodeJpegDownscaled(bytes));
      } catch {
        /* 结构不支持降采样（如渐进式 JPEG）时退回全量解码 */
      }
    }
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: Math.max(512, Math.min(MAX_JPEG_DECODE_MB, requiredMb)),
    });
    return shrinkRgba({
      width: decoded.width,
      height: decoded.height,
      rgba: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    });
  }
  return null;
}

/**
 * 贴图加载：无 DOM 环境，自己把 blob 解码成 DataTexture。
 * 其它 URL（远程/文件）返回空纹理，不阻塞模型加载。
 */
THREE.TextureLoader.prototype.load = function load(url, onLoad, _onProgress, onError) {
  if (typeof url === 'string' && url.startsWith('blob:cover/')) {
    const blob = blobStore.get(url);
    blobStore.delete(url);
    if (!blob) {
      queueMicrotask(() => onLoad?.(emptyTexture()));
      return emptyTexture();
    }
    blob
      .arrayBuffer()
      .then((buffer) => decodeImageBuffer(Buffer.from(buffer)))
      .then((image) => {
        if (!image) {
          onLoad?.(emptyTexture());
          return;
        }
        const texture = new THREE.DataTexture(image.rgba, image.width, image.height, THREE.RGBAFormat);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        onLoad?.(texture);
      })
      .catch((err) => {
        // 解码失败后 GLTFLoader 会丢掉这张贴图，材质只剩底色，这里至少留下日志便于排查
        console.warn(
          `[covers] 贴图解码失败（${err instanceof Error ? err.message : String(err)}），该材质将退化为纯色`,
        );
        onError?.(err);
      });
    return emptyTexture();
  }
  const texture = emptyTexture();
  if (onLoad) queueMicrotask(() => onLoad(texture));
  return texture;
};
THREE.ImageLoader.prototype.load = function load(_url, onLoad) {
  const texture = emptyTexture();
  if (onLoad) queueMicrotask(() => onLoad(texture));
  return texture;
};

/** GLTF 的外部 .bin / .gltf 引用走 fs；当前模型所在目录由 loadModel 设置 */
let activeBaseDir = process.cwd();
THREE.FileLoader.prototype.load = function load(url, onLoad, _onProgress, onError) {
  try {
    if (/^data:/i.test(url)) {
      // data URI：glTF 会把内嵌 buffer 写成 base64
      const comma = url.indexOf(',');
      const meta = url.slice(0, comma);
      const body = url.slice(comma + 1);
      const buffer = meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
      if (onLoad) {
        if (this.responseType === 'arraybuffer') {
          onLoad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        } else {
          onLoad(buffer.toString('utf8'));
        }
      }
      return undefined;
    }
    const target = /^https?:/i.test(url) ? url : path.resolve(activeBaseDir, url);
    if (/^https?:/i.test(target)) {
      if (onError) onError(new Error(`封面渲染不支持远程资源: ${url}`));
      return undefined;
    }
    const buffer = fs.readFileSync(target);
    if (onLoad) {
      if (this.responseType === 'arraybuffer') {
        onLoad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
      } else {
        onLoad(buffer.toString('utf8'));
      }
    }
  } catch (err) {
    if (onError) onError(err);
  }
  return undefined;
};

// ===== PNG 编码（RGBA8）=====

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ===== 贴图主色提取（封面不着色会全白，这里只取平均色）=====

/** 取 PNG 的平均颜色（支持 8bit 灰度/RGB/调色板/RGBA，非隔行） */
function decodePngAverage(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let paletteAlpha = null;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      paletteAlpha = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (interlace !== 0) throw new Error('隔行 PNG 不支持');
  if (bitDepth !== 8) throw new Error(`PNG 位深 ${bitDepth} 不支持`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || !width || !height) throw new Error('PNG 格式不支持');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // 流式解滤波：只保留上一行/当前行（贴图动辄 2048²，没必要整张解码），
  // 并且只采样前 512 行、每行最多 64 个像素，足够算主色。
  let previousRow = Buffer.alloc(stride);
  let currentRow = Buffer.alloc(stride);
  const rowLimit = Math.min(height, 512);
  const columnStep = Math.max(1, Math.floor(width / 64));
  let rawOffset = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let weightSum = 0;

  for (let y = 0; y < rowLimit; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const row = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? currentRow[x - channels] : 0;
      const up = previousRow[x];
      const upLeft = x >= channels ? previousRow[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      currentRow[x] = value & 0xff;
    }

    for (let x = 0; x < width; x += columnStep) {
      const index = x * channels;
      let alpha = 1;
      let red = 0;
      let green = 0;
      let blue = 0;
      if (colorType === 0) {
        red = green = blue = currentRow[index];
      } else if (colorType === 2) {
        red = currentRow[index];
        green = currentRow[index + 1];
        blue = currentRow[index + 2];
      } else if (colorType === 3) {
        const paletteIndex = currentRow[index];
        if (palette && paletteIndex * 3 + 2 < palette.length) {
          red = palette[paletteIndex * 3];
          green = palette[paletteIndex * 3 + 1];
          blue = palette[paletteIndex * 3 + 2];
          if (paletteAlpha && paletteIndex < paletteAlpha.length) alpha = paletteAlpha[paletteIndex] / 255;
        }
      } else if (colorType === 4) {
        red = green = blue = currentRow[index];
        alpha = currentRow[index + 1] / 255;
      } else {
        red = currentRow[index];
        green = currentRow[index + 1];
        blue = currentRow[index + 2];
        alpha = currentRow[index + 3] / 255;
      }
      if (alpha <= 0.02) continue;
      r += red * alpha;
      g += green * alpha;
      b += blue * alpha;
      weightSum += alpha;
    }

    const swap = previousRow;
    previousRow = currentRow;
    currentRow = swap;
  }

  if (weightSum <= 0) throw new Error('PNG 全透明');
  return [r / weightSum / 255, g / weightSum / 255, b / weightSum / 255];
}

/**
 * 解析 JPEG 段头（读到第一个 SOS 为止）。
 * @returns {{frame, scanComponents, quantTables, huffmanTables, restartInterval, scanOffset}}
 *   scanOffset 为熵编码数据起点；-1 表示文件里没有扫描数据。
 */
function parseJpegSegments(bytes) {
  const quantTables = new Map();
  const huffmanTables = new Map();
  let frame = null;
  let restartInterval = 0;
  let scanOffset = -1;
  let scanComponents = [];
  let offset = 2;

  const readUInt16 = (position) => (bytes[position] << 8) | bytes[position + 1];

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    const length = readUInt16(offset);
    const segment = bytes.subarray(offset + 2, offset + length);
    offset += length;

    if (marker === 0xdb) {
      let position = 0;
      while (position < segment.length) {
        const info = segment[position];
        position += 1;
        const precision = info >> 4;
        const tableId = info & 0x0f;
        const table = new Float32Array(64);
        for (let i = 0; i < 64; i += 1) {
          table[i] = precision === 0 ? segment[position + i] : readUInt16(position + i * 2);
          if (precision !== 0) position += 1;
        }
        position += 64;
        quantTables.set(tableId, table);
      }
    } else if (marker === 0xc4) {
      let position = 0;
      while (position < segment.length) {
        const info = segment[position];
        position += 1;
        const counts = segment.subarray(position, position + 16);
        position += 16;
        let total = 0;
        for (const count of counts) total += count;
        const symbols = segment.subarray(position, position + total);
        position += total;
        huffmanTables.set(`${info >> 4}-${info & 0x0f}`, buildHuffman(counts, symbols));
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      const precision = segment[0];
      const height = (segment[1] << 8) | segment[2];
      const width = (segment[3] << 8) | segment[4];
      const components = [];
      const count = segment[5];
      for (let i = 0; i < count; i += 1) {
        const base = 6 + i * 3;
        components.push({
          id: segment[base],
          h: segment[base + 1] >> 4,
          v: segment[base + 1] & 0x0f,
          quantId: segment[base + 2],
          dcSum: 0,
          blocks: 0,
        });
      }
      frame = { precision, height, width, components };
    } else if (marker === 0xdd) {
      restartInterval = (segment[0] << 8) | segment[1];
    } else if (marker === 0xda) {
      if (!frame) throw new Error('JPEG 缺少 SOF');
      const count = segment[0];
      scanComponents = [];
      for (let i = 0; i < count; i += 1) {
        const base = 1 + i * 2;
        const component = frame.components.find((item) => item.id === segment[base]);
        if (!component) throw new Error('JPEG 扫描分量缺失');
        component.dcTable = segment[base + 1] >> 4;
        component.acTable = segment[base + 1] & 0x0f;
        scanComponents.push(component);
      }
      scanOffset = offset;
      break;
    } else if (marker === 0xc2) {
      throw new Error('渐进式 JPEG 不支持');
    }
  }

  if (!frame) throw new Error('JPEG 解析失败');
  return { frame, scanComponents, quantTables, huffmanTables, restartInterval, scanOffset };
}

/** 取 JPEG 的平均颜色：只解 DC 系数（逐块平均值），不重建像素 */
let lastJpegDebug = null;
function decodeJpegAverage(bytes) {
  const { frame, scanComponents, quantTables, huffmanTables, restartInterval, scanOffset } = parseJpegSegments(bytes);
  if (scanOffset >= 0) {
    decodeJpegScan(bytes, scanOffset, frame, scanComponents, quantTables, huffmanTables, restartInterval);
  }
  const maxH = Math.max(...frame.components.map((component) => component.h));
  const maxV = Math.max(...frame.components.map((component) => component.v));
  let ySum = 0;
  let cbSum = 0;
  let crSum = 0;
  let yWeight = 0;
  let cbWeight = 0;
  let crWeight = 0;
  for (const component of frame.components) {
    const blocks = component.blocks || 1;
    const average = component.dcSum / blocks; // 已含 /8 与 +128
    if (component.id === 1 || frame.components.length === 1) {
      ySum += average * blocks;
      yWeight += blocks;
    } else if (component.id === 2) {
      cbSum += average * blocks;
      cbWeight += blocks;
    } else if (component.id === 3) {
      crSum += average * blocks;
      crWeight += blocks;
    }
    if (component.h > maxH || component.v > maxV) throw new Error('JPEG 采样异常');
  }
  const y = yWeight ? ySum / yWeight : 0;
  const cb = cbWeight ? cbSum / cbWeight - 128 : 0;
  const cr = crWeight ? crSum / crWeight - 128 : 0;
  lastJpegDebug = {
    frame: { width: frame.width, height: frame.height, components: frame.components.length },
    components: frame.components.map((component) => ({
      id: component.id,
      h: component.h,
      v: component.v,
      quantId: component.quantId,
      blocks: component.blocks,
      average: component.blocks ? component.dcSum / component.blocks : null,
    })),
    y,
    cb,
    cr,
  };
  const red = y + 1.402 * cr;
  const green = y - 0.344136 * cb - 0.714136 * cr;
  const blue = y + 1.772 * cb;
  const clamp = (value) => Math.min(1, Math.max(0, value / 255));
  return [clamp(red), clamp(green), clamp(blue)];
}

/**
 * 超大 JPEG 的降采样解码：只取每个 8×8 块的 DC 系数（即该块平均色），
 * 直接产出 1/8 分辨率的 RGBA（8192² → 1024²，内存几 MB）。
 *
 * 为什么要走这条路径：jpeg-js 全量解码 8192² 需要 800MB+ 内存（默认上限 512MB 直接报错），
 * 而报错会让 GLTFLoader 丢掉 baseColorTexture，封面就渲染成白模。
 * 封面输出只有 256px，1/8 分辨率完全够用。
 *
 * 只支持基线 JPEG（渐进式由调用方回退到全量解码）。
 */
function decodeJpegDownscaled(bytes) {
  const parsed = parseJpegSegments(bytes);
  if (parsed.scanOffset < 0) throw new Error('JPEG 没有扫描数据');
  const { frame, scanComponents, quantTables, huffmanTables, restartInterval, scanOffset } = parsed;

  const maxH = Math.max(...frame.components.map((component) => component.h));
  const maxV = Math.max(...frame.components.map((component) => component.v));
  const planes = new Map();
  for (const component of frame.components) {
    const columns = Math.ceil((frame.width * component.h) / (maxH * 8));
    const rows = Math.ceil((frame.height * component.v) / (maxV * 8));
    planes.set(component, { columns, rows, data: new Float32Array(columns * rows).fill(128) });
  }

  decodeJpegScan(bytes, scanOffset, frame, scanComponents, quantTables, huffmanTables, restartInterval, (component, blockRow, blockCol, value) => {
    const plane = planes.get(component);
    if (!plane || blockRow >= plane.rows || blockCol >= plane.columns) return;
    plane.data[blockRow * plane.columns + blockCol] = value;
  });

  const luma = frame.components[0];
  const lumaPlane = planes.get(luma);
  const outWidth = lumaPlane.columns;
  const outHeight = lumaPlane.rows;
  const rgba = Buffer.alloc(outWidth * outHeight * 4);
  const cb = frame.components[1];
  const cr = frame.components[2];

  /** 按分量采样率取该输出块对应的色度块 */
  const sample = (component, x, y) => {
    const plane = planes.get(component);
    const column = Math.min(plane.columns - 1, Math.floor((x * component.h) / maxH));
    const row = Math.min(plane.rows - 1, Math.floor((y * component.v) / maxV));
    return plane.data[row * plane.columns + column];
  };

  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const lumaValue = lumaPlane.data[y * outWidth + x];
      const out = (y * outWidth + x) * 4;
      if (!cb || !cr) {
        // 灰度图：Y 分量直接作为 RGB
        const gray = Math.max(0, Math.min(255, lumaValue));
        rgba[out] = gray;
        rgba[out + 1] = gray;
        rgba[out + 2] = gray;
        rgba[out + 3] = 255;
        continue;
      }
      const cbValue = sample(cb, x, y) - 128;
      const crValue = sample(cr, x, y) - 128;
      rgba[out] = Math.max(0, Math.min(255, Math.round(lumaValue + 1.402 * crValue)));
      rgba[out + 1] = Math.max(0, Math.min(255, Math.round(lumaValue - 0.344136 * cbValue - 0.714136 * crValue)));
      rgba[out + 2] = Math.max(0, Math.min(255, Math.round(lumaValue + 1.772 * cbValue)));
      rgba[out + 3] = 255;
    }
  }

  return { width: outWidth, height: outHeight, rgba };
}

function buildHuffman(counts, symbols) {
  const table = new Map();
  const codes = new Map();
  let code = 0;
  let symbolIndex = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = counts[length - 1];
    for (let i = 0; i < count; i += 1) {
      codes.set(`${length}-${code}`, symbols[symbolIndex]);
      symbolIndex += 1;
      code += 1;
    }
    code <<= 1;
  }
  table.codes = codes;
  return table;
}

/**
 * 解熵编码数据，逐块读出 DC 系数。
 * @param {((component, blockRow, blockCol, value) => void) | null} onBlock
 *   可选回调：拿到每个 8×8 块的平均值（降采样重建用）
 */
function decodeJpegScan(bytes, start, frame, components, quantTables, huffmanTables, restartInterval, onBlock = null) {
  let offset = start;
  let bitBuffer = 0;
  let bitCount = 0;
  let dcPredictors = new Map();
  const readBit = () => {
    if (bitCount === 0) {
      if (bytes[offset] === 0xff) {
        const next = bytes[offset + 1];
        if (next === 0x00) {
          // 字节填充：FF 00 代表数据 0xFF
          bitBuffer = 0xff;
          offset += 2;
        } else if (next >= 0xd0 && next <= 0xd7) {
          offset += 2;
          bitBuffer = 0;
          bitCount = 0;
          return readBit();
        } else {
          return false;
        }
      } else {
        bitBuffer = bytes[offset];
        offset += 1;
      }
      bitCount = 8;
    }
    const bit = (bitBuffer >> 7) & 1;
    bitBuffer = (bitBuffer << 1) & 0xff;
    bitCount -= 1;
    return bit;
  };
  const readBits = (count) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | readBit();
    return value;
  };
  const decodeHuffman = (table) => {
    let code = 0;
    for (let length = 1; length <= 16; length += 1) {
      code = (code << 1) | readBit();
      const symbol = table.codes.get(`${length}-${code}`);
      if (symbol !== undefined) return symbol;
    }
    return 0;
  };
  const receiveExtend = (count) => {
    if (count === 0) return 0;
    const value = readBits(count);
    return value < 1 << (count - 1) ? value - (1 << count) + 1 : value;
  };

  const maxH = Math.max(...components.map((component) => component.h));
  const maxV = Math.max(...components.map((component) => component.v));
  const mcuWidth = Math.ceil(frame.width / 8);
  const mcuHeight = Math.ceil(frame.height / 8);
  const mcuCols = Math.ceil(mcuWidth / maxH);
  const mcuRows = Math.ceil(mcuHeight / maxV);
  let mcuSinceRestart = 0;

  for (let mcuRow = 0; mcuRow < mcuRows; mcuRow += 1) {
    for (let mcuCol = 0; mcuCol < mcuCols; mcuCol += 1) {
      if (restartInterval > 0 && mcuSinceRestart === restartInterval) {
        // 跳过 RST 标记并重置 DC 预测
        dcPredictors = new Map();
        mcuSinceRestart = 0;
        if (bytes[offset] === 0xff && bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7) offset += 2;
        bitBuffer = 0;
        bitCount = 0;
      }
      mcuSinceRestart += 1;
      for (const component of components) {
        for (let v = 0; v < component.v; v += 1) {
          for (let h = 0; h < component.h; h += 1) {
            const dcTable = huffmanTables.get(`${0}-${component.dcTable}`);
            const acTable = huffmanTables.get(`${1}-${component.acTable}`);
            if (!dcTable || !acTable) throw new Error('JPEG 缺少 Huffman 表');
            const category = decodeHuffman(dcTable);
            const diff = receiveExtend(category);
            const previous = dcPredictors.get(component.id) ?? 0;
            const dc = previous + diff;
            dcPredictors.set(component.id, dc);
            const quant = quantTables.get(component.quantId)?.[0] ?? 8;
            const blockValue = (dc * quant) / 8 + 128;
            component.dcSum += blockValue;
            component.blocks += 1;
            if (onBlock) {
              onBlock(component, mcuRow * component.v + v, mcuCol * component.h + h, blockValue);
            }
            // 跳过 AC 系数
            let k = 1;
            while (k < 64) {
              const symbol = decodeHuffman(acTable);
              if (symbol === 0x00) break;
              const run = symbol >> 4;
              const size = symbol & 0x0f;
              if (size === 0 && run === 15) {
                k += 16;
                continue;
              }
              k += run + 1;
              readBits(size);
            }
          }
        }
      }
    }
  }
}

/** 解析 GLB 容器，返回 JSON 与 BIN 块 */
function parseGlbContainer(buffer) {
  const length = buffer.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (chunkType === 0x004e4942) bin = chunk;
    offset += 8 + chunkLength;
  }
  return { json, bin };
}

function glbMaterialAverages(container) {
  const { json, bin } = container;
  if (!json || !bin) return [];
  const bufferViews = json.bufferViews ?? [];
  const textures = json.textures ?? [];
  const images = json.images ?? [];

  const imageBytes = (index) => {
    const image = images[index];
    if (!image || image.bufferView === undefined) return null;
    const view = bufferViews[image.bufferView];
    if (!view) return null;
    const start = view.byteOffset ?? 0;
    return { bytes: bin.subarray(start, start + view.byteLength), mimeType: image.mimeType ?? '' };
  };
  const textureAverage = (textureIndex) => {
    const texture = textures[textureIndex];
    if (!texture || texture.source === undefined) return null;
    const entry = imageBytes(texture.source);
    if (!entry) return null;
    try {
      if (entry.mimeType.includes('png')) return decodePngAverage(entry.bytes);
      if (entry.mimeType.includes('jpeg') || entry.mimeType.includes('jpg')) return decodeJpegAverage(entry.bytes);
    } catch {
      return null;
    }
    return null;
  };

  return (json.materials ?? []).map((material) => {
    const pbr = material.pbrMetallicRoughness ?? {};
    const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const textureIndex = pbr.baseColorTexture?.index;
    const average = textureIndex !== undefined ? textureAverage(textureIndex) : null;
    const linearFactor = factor.slice(0, 3).map((value) => Math.pow(value, 2.2));
    const linear = average
      ? average.map((value, index) => Math.pow(value, 2.2) * linearFactor[index])
      : linearFactor;
    return linear.map((value) => Math.pow(Math.min(1, Math.max(0, value)), 1 / 2.2));
  });
}

/** 用贴图主色替换 GLB 材质颜色（没有贴图/解析失败时保持原色） */
function applyGlbMaterialColors(gltf, container) {
  let colors;
  try {
    colors = glbMaterialAverages(container);
  } catch {
    return;
  }
  if (!colors.length) return;
  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      const association = gltf.parser.associations.get(material);
      const index = association?.materials;
      if (typeof index !== 'number') continue;
      const color = colors[index];
      if (!color) continue;
      material.color = new THREE.Color(color[0], color[1], color[2]);
    }
  });
}

/**
 * WebGL 管线的兜底色：贴图没能加载出来（超大 JPEG 解码失败等）时，
 * GLTF 的材质默认是白色，封面会变成「白模」。这里把贴图主色记到 userData，
 * 提取渲染批次时用它替代白色。
 */
function stampFallbackColors(gltf, container) {
  let colors;
  try {
    colors = glbMaterialAverages(container);
  } catch {
    return;
  }
  if (!colors.length) return;
  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material || material.map?.image) continue;
      const association = gltf.parser.associations.get(material);
      const index = association?.materials;
      if (typeof index !== 'number') continue;
      const color = colors[index];
      if (color) material.userData.coverFallbackColor = color;
    }
  });
}

// ===== 模型加载 =====

function loadModel(filePath, options = {}) {
  activeBaseDir = path.dirname(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  if (ext === 'glb' || ext === 'gltf') {
    const container = ext === 'glb' ? parseGlbContainer(buffer) : null;
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(
        ext === 'gltf' ? buffer.toString('utf8') : array,
        activeBaseDir,
        (gltf) => {
          // WebGL 管线保留真实贴图，只给缺贴图的材质留兜底色；软件管线整体替换成贴图主色
          if (container && options.realTextures) stampFallbackColors(gltf, container);
          else if (container) applyGlbMaterialColors(gltf, container);
          resolve({ root: gltf.scene, animations: gltf.animations ?? [] });
        },
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }
  if (ext === 'fbx') {
    const object = new FBXLoader().parse(array, activeBaseDir);
    return Promise.resolve({ root: object, animations: object.animations ?? [] });
  }
  if (ext === 'obj') {
    const object = new OBJLoader().parse(buffer.toString('utf8'));
    return Promise.resolve({ root: object, animations: [] });
  }
  if (ext === 'stl') {
    const geometry = new STLLoader().parse(array);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xb9c1cf, metalness: 0.05, roughness: 0.65 }),
    );
    return Promise.resolve({ root: mesh, animations: [] });
  }
  return Promise.reject(new Error(`封面渲染不支持 .${ext} 格式`));
}

// ===== 参数归一化与姿态 =====

/** 去掉 Mixamo 前缀，与前端 cleanBoneLabel 一致 */
function cleanBoneLabel(name) {
  return name.replace(/^mixamorig[:_]?/i, '') || name;
}

/**
 * 把新建动画项目里保存的动画数据（fbx-animation-data）转成 three 的 AnimationClip。
 *
 * 轨道结构与前端 FbxPlayer.applyAnimationData 保持一致：
 *   - 轨道名可能是 "mixamorigHips.quaternion" 或清理后的显示名，需要映射回真实骨骼名；
 *   - 只接受 times/values 长度自洽的轨道，无法匹配骨骼的轨道直接跳过。
 * 返回 null 表示这份数据不可用（调用方决定是否回退到 FBX 自带动画）。
 */
function clipFromAnimationData(root, data) {
  const clips = Array.isArray(data?.clips) ? data.clips : [];
  const clipData = clips.find((clip) => Array.isArray(clip?.tracks) && clip.tracks.length > 0);
  if (!clipData) return null;

  const nameMap = new Map();
  root.traverse((child) => {
    if (!child.name) return;
    const aliases = [child.name, THREE.PropertyBinding.sanitizeNodeName(child.name), cleanBoneLabel(child.name)];
    for (const alias of aliases) {
      if (!nameMap.has(alias)) nameMap.set(alias, child.name);
    }
  });

  const tracks = [];
  for (const track of clipData.tracks) {
    if (!track?.name || !Array.isArray(track.times) || !Array.isArray(track.values)) continue;
    if (track.times.length === 0) continue;
    const valueSize = Number(track.valueSize);
    if (!valueSize || track.times.length * valueSize !== track.values.length) continue;

    const dot = track.name.lastIndexOf('.');
    const nodeName = dot > 0 ? track.name.slice(0, dot) : track.name;
    const property =
      typeof track.property === 'string' && track.property
        ? track.property
        : dot > 0
          ? track.name.slice(dot + 1)
          : '';
    // 优先用导出时记录的 joint 名，再退回轨道里的节点名/去前缀名
    const target =
      (track.joint ? nameMap.get(track.joint) : undefined) ??
      nameMap.get(nodeName) ??
      nameMap.get(cleanBoneLabel(nodeName));
    if (!target) continue;

    const trackName = property ? `${target}.${property}` : track.name;
    if (valueSize === 4) tracks.push(new THREE.QuaternionKeyframeTrack(trackName, track.times, track.values));
    else if (valueSize === 3) tracks.push(new THREE.VectorKeyframeTrack(trackName, track.times, track.values));
    else if (valueSize === 1) tracks.push(new THREE.NumberKeyframeTrack(trackName, track.times, track.values));
  }
  if (tracks.length === 0) return null;

  const lastTime = tracks.reduce((max, track) => Math.max(max, track.times[track.times.length - 1] ?? 0), 0);
  const duration = Math.max(Number(clipData.duration) || 0, lastTime);
  return new THREE.AnimationClip(typeof clipData.name === 'string' && clipData.name ? clipData.name : 'project', duration, tracks);
}

/**
 * 取某一时刻的姿态。
 * @param {THREE.Object3D} root
 * @param {THREE.AnimationClip[]} animations FBX 自带的动画片段
 * @param {number|null} poseFraction 0~1，null 表示绑定姿态
 * @param {unknown} animation 新建动画项目的动画数据（可选）
 * @param {boolean} animationOnly true 时不回退到 FBX 自带动画（新建动画的基础模型应是无动画的）
 */
function applyPose(root, animations, poseFraction, animation = null, animationOnly = false) {
  let clip = null;
  if (animation) {
    try {
      clip = clipFromAnimationData(root, animation);
    } catch {
      clip = null;
    }
  }
  // 与前端 FbxPlayer 保持一致：过滤掉空片段（Mixamo 的 FBX 经常带一个
  // "Take 001"：duration=0、0 条轨道；直接用 animations[0] 会渲染成 T-pose）
  if (!clip && !animationOnly) {
    const clips = (animations ?? []).filter((item) => item.duration > 0 && item.tracks.length > 0);
    clip = clips[0] ?? null;
  }
  if (!clip || poseFraction === null || poseFraction === undefined) {
    root.updateMatrixWorld(true);
    return;
  }
  try {
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : 0;
    mixer.setTime(Math.min(Math.max(duration * poseFraction, 0), duration));
  } catch {
    /* 姿态失败不影响静态封面 */
  }
  root.updateMatrixWorld(true);
}

function materialColor(mesh) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const color = material?.color;
  if (color && typeof color.r === 'number') return [color.r, color.g, color.b];
  return [0.72, 0.76, 0.82];
}

/**
 * 把所有网格三角形展开成世界坐标数组。
 * 蒙皮模型（FBX 动画）按当前姿态逐顶点做骨骼变换。
 */
function collectTriangles(root) {
  const positions = [];
  const colors = [];
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const local = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    const mesh = child;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr || positionAttr.count < 3) return;
    const index = geometry.getIndex();
    const baseColor = materialColor(mesh);
    const vertexCount = positionAttr.count;
    const world = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i += 1) {
      local.set(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
      if (mesh.isSkinnedMesh && mesh.skeleton) {
        try {
          mesh.applyBoneTransform(i, local);
        } catch {
          /* 骨骼数据异常时退回未蒙皮位置 */
        }
      }
      local.applyMatrix4(mesh.matrixWorld);
      world[i * 3] = local.x;
      world[i * 3 + 1] = local.y;
      world[i * 3 + 2] = local.z;
      if (local.x < min.x) min.x = local.x;
      if (local.y < min.y) min.y = local.y;
      if (local.z < min.z) min.z = local.z;
      if (local.x > max.x) max.x = local.x;
      if (local.y > max.y) max.y = local.y;
      if (local.z > max.z) max.z = local.z;
    }

    const triCount = index ? Math.floor(index.count / 3) : Math.floor(vertexCount / 3);
    for (let t = 0; t < triCount; t += 1) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      positions.push(
        world[a * 3], world[a * 3 + 1], world[a * 3 + 2],
        world[b * 3], world[b * 3 + 1], world[b * 3 + 2],
        world[c * 3], world[c * 3 + 1], world[c * 3 + 2],
      );
      colors.push(baseColor);
    }
  });

  return { positions, colors, min, max };
}

// ===== 软件光栅化 =====

function srgbToLinear(value) {
  return Math.pow(value, 2.2);
}
function linearToSrgb(value) {
  return Math.pow(Math.min(1, Math.max(0, value)), 1 / 2.2);
}

function renderCover({ positions, colors, min, max }, width, height, options = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  const depth = new Float32Array(width * height).fill(Infinity);
  if (positions.length === 0) return rgba;

  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const size = new THREE.Vector3().subVectors(max, min);
  const radius = Math.max(1e-4, size.length() * 0.5);

  const fov = THREE.MathUtils.degToRad(options.fov ?? 32);
  const distance = (radius / Math.tan(fov / 2)) * (options.padding ?? 1.12);
  const direction = new THREE.Vector3(0.55, 0.42, 1).normalize();
  const eye = center.clone().addScaledVector(direction, distance);
  const up = new THREE.Vector3(0, 1, 0);

  const view = new THREE.Matrix4().lookAt(eye, center, up);
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(fov), width / height, distance * 0.01, distance * 8);
  camera.position.copy(eye);
  camera.up.copy(up);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  // 光源方向（视空间固定，突出体积感）
  const light = new THREE.Vector3(-0.35, 0.65, 0.7).normalize();

  const projected = new Float32Array(3 * 4); // 每个三角形 3 点，每点 x,y,z,w

  for (let tri = 0; tri < positions.length / 9; tri += 1) {
    const offset = tri * 9;
    let culled = false;
    for (let v = 0; v < 3; v += 1) {
      const p = new THREE.Vector4(
        positions[offset + v * 3],
        positions[offset + v * 3 + 1],
        positions[offset + v * 3 + 2],
        1,
      ).applyMatrix4(viewProjection);
      if (p.w <= 0.0001) {
        culled = true;
        break;
      }
      const ndcX = p.x / p.w;
      const ndcY = p.y / p.w;
      const ndcZ = p.z / p.w;
      projected[v * 4] = (ndcX * 0.5 + 0.5) * width;
      projected[v * 4 + 1] = (1 - (ndcY * 0.5 + 0.5)) * height;
      projected[v * 4 + 2] = ndcZ;
      projected[v * 4 + 3] = 1 / p.w;
    }
    if (culled) continue;

    const x0 = projected[0];
    const y0 = projected[1];
    const x1 = projected[4];
    const y1 = projected[5];
    const x2 = projected[8];
    const y2 = projected[9];

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-8) continue;

    // 世界空间法线
    const ax = positions[offset + 3] - positions[offset];
    const ay = positions[offset + 4] - positions[offset + 1];
    const az = positions[offset + 5] - positions[offset + 2];
    const bx = positions[offset + 6] - positions[offset];
    const by = positions[offset + 7] - positions[offset + 1];
    const bz = positions[offset + 8] - positions[offset + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;
    if (nx * direction.x + ny * direction.y + nz * direction.z < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const diffuse = Math.max(0, nx * light.x + ny * light.y + nz * light.z);
    const shade = 0.34 + 0.66 * diffuse;
    const color = colors[tri];
    const red = Math.round(255 * linearToSrgb(srgbToLinear(color[0]) * shade));
    const green = Math.round(255 * linearToSrgb(srgbToLinear(color[1]) * shade));
    const blue = Math.round(255 * linearToSrgb(srgbToLinear(color[2]) * shade));

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) continue;

    const invArea = 1 / area;
    const z0 = projected[2];
    const z1 = projected[6];
    const z2 = projected[10];

    for (let py = minY; py <= maxY; py += 1) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px += 1) {
        const cx = px + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * invArea;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const index = py * width + px;
        if (z >= depth[index]) continue;
        depth[index] = z;
        const out = index * 4;
        rgba[out] = red;
        rgba[out + 1] = green;
        rgba[out + 2] = blue;
        rgba[out + 3] = 255;
      }
    }
  }

  return rgba;
}

/** 2x 超采样后做 box downsample，边缘更平滑 */
function downsample(rgba, bigW, bigH, outW, outH, factor) {
  if (factor <= 1) return rgba;
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= bigW || sy >= bigH) continue;
          const i = (sy * bigW + sx) * 4;
          const alpha = rgba[i + 3] / 255;
          r += rgba[i] * alpha;
          g += rgba[i + 1] * alpha;
          b += rgba[i + 2] * alpha;
          a += rgba[i + 3];
          count += 1;
        }
      }
      const outIndex = (y * outW + x) * 4;
      if (count === 0) continue;
      const avgAlpha = a / count;
      const weight = avgAlpha > 0 ? avgAlpha / 255 : 0;
      out[outIndex] = weight > 0 ? Math.round(r / (count * weight)) : 0;
      out[outIndex + 1] = weight > 0 ? Math.round(g / (count * weight)) : 0;
      out[outIndex + 2] = weight > 0 ? Math.round(b / (count * weight)) : 0;
      out[outIndex + 3] = Math.round(avgAlpha);
    }
  }
  return out;
}

// ===== WebGL 渲染（headless-gl，自写 WebGL1 管线）=====
//
// 前端封面（ModelViewer / FbxPlayer）的实际观感：
//   - ACES Filmic tone mapping，exposure 1.05，sRGB 输出；
//   - 半球光 white / #404652，强度 1.15；主光 white 2.1（方向 4,6.5,4.5）；
//   - 轮廓光 #bcd0ff 0.75（方向 -5,3,-5）；RoomEnvironment 环境光强度 0.85；
//   - 深色背景 #1b1e25；地面接触阴影（ShadowMaterial opacity ≈0.28）。
// 后端这里用同一套光照方向/颜色/强度 + ACES + 深色底 + 软接触阴影，尽量做到与前端一致。

let glModulePromise = null;

async function loadGLModule() {
  if (!glModulePromise) glModulePromise = import('gl').then((mod) => mod.default ?? mod);
  return glModulePromise;
}

const COVER_VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uViewProjection;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vWorldPos = aPosition;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}
`;

const COVER_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTexture;
uniform vec3 uColor;
uniform float uHasTexture;
uniform vec3 uCameraPos;
uniform vec3 uKeyDir;
uniform vec3 uRimDir;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
uniform float uHemiIntensity;
uniform float uKeyIntensity;
uniform float uRimIntensity;
uniform float uEnvIntensity;
uniform float uExposure;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  if (dot(n, viewDir) < 0.0) n = -n;

  vec3 base = uColor;
  if (uHasTexture > 0.5) base *= texture2D(uTexture, vUv).rgb;
  vec3 albedo = pow(max(base, vec3(0.0)), vec3(2.2));

  float hemiMix = n.y * 0.5 + 0.5;
  vec3 hemi = mix(uHemiGround, uHemiSky, hemiMix) * uHemiIntensity * 0.55;
  float key = max(dot(n, normalize(uKeyDir)), 0.0) * uKeyIntensity * 0.35;
  float rim = max(dot(n, normalize(uRimDir)), 0.0) * uRimIntensity * 0.35;
  // RoomEnvironment 的近似：中性环境辐照
  vec3 irradiance = hemi + vec3(key + rim) + vec3(0.24 * uEnvIntensity);

  vec3 linear = albedo * irradiance;
  vec3 mapped = acesFilm(linear * uExposure);
  gl_FragColor = vec4(pow(mapped, vec3(1.0 / 2.2)), 1.0);
}
`;

const SHADOW_VERTEX_SHADER = `
attribute vec2 aCorner;
uniform mat4 uViewProjection;
uniform vec3 uCenter;
uniform vec2 uRadius;
varying vec2 vUv;
void main() {
  vUv = aCorner;
  vec3 position = vec3(uCenter.x + aCorner.x * uRadius.x, uCenter.y, uCenter.z + aCorner.y * uRadius.y);
  gl_Position = uViewProjection * vec4(position, 1.0);
}
`;

const SHADOW_FRAGMENT_SHADER = `
precision mediump float;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float alpha = (1.0 - smoothstep(0.2, 1.0, length(vUv))) * uOpacity;
  gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader 编译失败: ${info}`);
  }
  return shader;
}

function linkProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program 链接失败: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

function compileCoverProgram(gl) {
  const program = linkProgram(gl, COVER_VERTEX_SHADER, COVER_FRAGMENT_SHADER);
  return {
    program,
    aPosition: gl.getAttribLocation(program, 'aPosition'),
    aNormal: gl.getAttribLocation(program, 'aNormal'),
    aUv: gl.getAttribLocation(program, 'aUv'),
    uViewProjection: gl.getUniformLocation(program, 'uViewProjection'),
    uTexture: gl.getUniformLocation(program, 'uTexture'),
    uColor: gl.getUniformLocation(program, 'uColor'),
    uHasTexture: gl.getUniformLocation(program, 'uHasTexture'),
    uCameraPos: gl.getUniformLocation(program, 'uCameraPos'),
    uKeyDir: gl.getUniformLocation(program, 'uKeyDir'),
    uRimDir: gl.getUniformLocation(program, 'uRimDir'),
    uHemiSky: gl.getUniformLocation(program, 'uHemiSky'),
    uHemiGround: gl.getUniformLocation(program, 'uHemiGround'),
    uHemiIntensity: gl.getUniformLocation(program, 'uHemiIntensity'),
    uKeyIntensity: gl.getUniformLocation(program, 'uKeyIntensity'),
    uRimIntensity: gl.getUniformLocation(program, 'uRimIntensity'),
    uEnvIntensity: gl.getUniformLocation(program, 'uEnvIntensity'),
    uExposure: gl.getUniformLocation(program, 'uExposure'),
  };
}

function compileShadowProgram(gl) {
  const program = linkProgram(gl, SHADOW_VERTEX_SHADER, SHADOW_FRAGMENT_SHADER);
  return {
    program,
    aCorner: gl.getAttribLocation(program, 'aCorner'),
    uViewProjection: gl.getUniformLocation(program, 'uViewProjection'),
    uCenter: gl.getUniformLocation(program, 'uCenter'),
    uRadius: gl.getUniformLocation(program, 'uRadius'),
    uOpacity: gl.getUniformLocation(program, 'uOpacity'),
  };
}

/** 上传一张 RGBA 贴图（WebGL1：NPOT 必须 CLAMP + 无 mipmap） */
function createGlTexture(gl, image) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    image.width,
    image.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** sRGB 颜色 → 线性（和 three 的颜色管理一致） */
function srgbColor(hex) {
  return [
    Math.pow(((hex >> 16) & 0xff) / 255, 2.2),
    Math.pow(((hex >> 8) & 0xff) / 255, 2.2),
    Math.pow((hex & 0xff) / 255, 2.2),
  ];
}

/**
 * 把模型展开成“按材质分批”的三角形：
 * 世界坐标（蒙皮网格按当前姿态）+ 法线 + UV + 材质贴图。
 */
function extractRenderBatches(root) {
  const batches = new Map();
  const normalMatrix = new THREE.Matrix3();
  const local = new THREE.Vector3();
  const normal = new THREE.Vector3();
  root.updateMatrixWorld(true);

  root.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr || positionAttr.count < 3) return;
    const normalAttr = geometry.getAttribute('normal');
    const uvAttr = geometry.getAttribute('uv') ?? geometry.getAttribute('uv1');
    const index = geometry.getIndex();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    const vertexCount = positionAttr.count;

    const worldPositions = new Float32Array(vertexCount * 3);
    const worldNormals = normalAttr ? new Float32Array(vertexCount * 3) : null;
    for (let i = 0; i < vertexCount; i += 1) {
      local.set(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
      if (mesh.isSkinnedMesh && mesh.skeleton) {
        try {
          mesh.applyBoneTransform(i, local);
        } catch {
          /* 骨骼异常时退回未蒙皮位置 */
        }
      }
      local.applyMatrix4(mesh.matrixWorld);
      worldPositions[i * 3] = local.x;
      worldPositions[i * 3 + 1] = local.y;
      worldPositions[i * 3 + 2] = local.z;
      if (worldNormals && normalAttr) {
        normal
          .set(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i))
          .applyMatrix3(normalMatrix)
          .normalize();
        worldNormals[i * 3] = normal.x;
        worldNormals[i * 3 + 1] = normal.y;
        worldNormals[i * 3 + 2] = normal.z;
      }
    }

    const totalCount = index ? index.count : vertexCount;
    const groups =
      geometry.groups && geometry.groups.length > 0
        ? geometry.groups
        : [{ start: 0, count: totalCount, materialIndex: 0 }];

    for (const group of groups) {
      const material = materials[group.materialIndex] ?? materials[0];
      if (!material) continue;
      const key = material.uuid || `${material.name || 'material'}-${group.materialIndex}`;
      let batch = batches.get(key);
      if (!batch) {
        const image = material.map?.image;
        batch = {
          // 贴图缺失时优先用贴图主色兜底（见 stampFallbackColors），否则才用材质底色
          color: material.userData?.coverFallbackColor
            ? material.userData.coverFallbackColor.slice()
            : material.color
              ? [material.color.r, material.color.g, material.color.b]
              : [0.8, 0.8, 0.8],
          texture:
            image && image.data && image.width > 0 && image.height > 0
              ? { data: image.data, width: image.width, height: image.height }
              : null,
          positions: [],
          normals: [],
          uvs: [],
        };
        batches.set(key, batch);
      }

      const start = Math.max(0, group.start | 0);
      const end = Math.min(start + (group.count || totalCount), totalCount);
      const canUseVertexNormals = Boolean(worldNormals) && !mesh.isSkinnedMesh;
      for (let i = start; i + 2 < end; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        const ax = worldPositions[ia * 3];
        const ay = worldPositions[ia * 3 + 1];
        const az = worldPositions[ia * 3 + 2];
        const bx = worldPositions[ib * 3];
        const by = worldPositions[ib * 3 + 1];
        const bz = worldPositions[ib * 3 + 2];
        const cx = worldPositions[ic * 3];
        const cy = worldPositions[ic * 3 + 1];
        const cz = worldPositions[ic * 3 + 2];
        batch.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);

        if (canUseVertexNormals) {
          batch.normals.push(
            worldNormals[ia * 3], worldNormals[ia * 3 + 1], worldNormals[ia * 3 + 2],
            worldNormals[ib * 3], worldNormals[ib * 3 + 1], worldNormals[ib * 3 + 2],
            worldNormals[ic * 3], worldNormals[ic * 3 + 1], worldNormals[ic * 3 + 2],
          );
        } else {
          let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
          let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
          let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          const length = Math.hypot(nx, ny, nz) || 1;
          nx /= length;
          ny /= length;
          nz /= length;
          batch.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        }

        if (uvAttr) {
          batch.uvs.push(
            uvAttr.getX(ia), uvAttr.getY(ia),
            uvAttr.getX(ib), uvAttr.getY(ib),
            uvAttr.getX(ic), uvAttr.getY(ic),
          );
        } else {
          batch.uvs.push(0, 0, 0, 0, 0, 0);
        }
      }
    }
  });

  return [...batches.values()].filter((batch) => batch.positions.length >= 9);
}

/** 深色底：与前端 captureThumbnail / captureFrame 填充的 #1b1e25 一致 */
const COVER_BACKGROUND = [0x1b / 255, 0x1e / 255, 0x25 / 255];

async function renderWithWebGL({
  filePath,
  size = 256,
  poseFraction = null,
  ground = 'shadow',
  fov = 42,
  animation = null,
  animationOnly = false,
}) {
  const createGL = await loadGLModule();
  const { root, animations } = await loadModel(filePath, { realTextures: true });
  applyPose(root, animations, poseFraction, animation, animationOnly);
  root.updateMatrixWorld(true);
  const batches = extractRenderBatches(root);
  if (batches.length === 0) throw new Error('模型没有可渲染的三角形');

  // 归一化取景：按所有批次的世界坐标包围盒
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const batch of batches) {
    for (let i = 0; i < batch.positions.length; i += 3) {
      const x = batch.positions[i];
      const y = batch.positions[i + 1];
      const z = batch.positions[i + 2];
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    }
  }
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const dimensions = new THREE.Vector3().subVectors(max, min);
  const radius = Math.max(0.01, dimensions.length() * 0.5);
  const distance = (radius / Math.tan(THREE.MathUtils.degToRad(fov / 2))) * 1.12;
  const direction = new THREE.Vector3(0.55, 0.42, 1).normalize();
  const eye = center.clone().addScaledVector(direction, distance);
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.01, distance * 8);
  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  const gl = createGL(size, size, { preserveDrawingBuffer: true, antialias: true, alpha: true });
  if (!gl) throw new Error('headless-gl 无法创建 WebGL 上下文');
  try {
    const shader = compileCoverProgram(gl);
    const shadowShader = compileShadowProgram(gl);
    gl.viewport(0, 0, size, size);
    gl.clearColor(COVER_BACKGROUND[0], COVER_BACKGROUND[1], COVER_BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // ===== 地面软接触阴影（对应前端 ShadowMaterial opacity 0.28）=====
    if (ground === 'shadow') {
      gl.useProgram(shadowShader.program);
      gl.uniformMatrix4fv(shadowShader.uViewProjection, false, viewProjection.elements);
      const footprint = Math.max(dimensions.x, dimensions.z, 0.4);
      const shadowRadius = footprint * 0.8 + 0.15;
      gl.uniform3f(shadowShader.uCenter, center.x, min.y + 0.0015, center.z);
      gl.uniform2f(shadowShader.uRadius, shadowRadius * 1.15, shadowRadius * 0.85);
      gl.uniform1f(shadowShader.uOpacity, 0.42);
      const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
      const quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(shadowShader.aCorner);
      gl.vertexAttribPointer(shadowShader.aCorner, 2, gl.FLOAT, false, 0, 0);
      gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.depthMask(true);
      gl.deleteBuffer(quadBuffer);
    }

    // ===== 模型 =====
    gl.useProgram(shader.program);
    gl.uniformMatrix4fv(shader.uViewProjection, false, viewProjection.elements);
    gl.uniform3f(shader.uCameraPos, eye.x, eye.y, eye.z);
    const keyDirection = new THREE.Vector3(4, 6.5, 4.5).normalize();
    const rimDirection = new THREE.Vector3(-5, 3, -5).normalize();
    gl.uniform3f(shader.uKeyDir, keyDirection.x, keyDirection.y, keyDirection.z);
    gl.uniform3f(shader.uRimDir, rimDirection.x, rimDirection.y, rimDirection.z);
    const hemiSky = srgbColor(0xffffff);
    const hemiGround = srgbColor(0x404652);
    gl.uniform3f(shader.uHemiSky, hemiSky[0], hemiSky[1], hemiSky[2]);
    gl.uniform3f(shader.uHemiGround, hemiGround[0], hemiGround[1], hemiGround[2]);
    gl.uniform1f(shader.uHemiIntensity, 1.15);
    gl.uniform1f(shader.uKeyIntensity, 2.1);
    gl.uniform1f(shader.uRimIntensity, 0.75);
    gl.uniform1f(shader.uEnvIntensity, 0.85);
    gl.uniform1f(shader.uExposure, 1.05);
    gl.uniform1i(shader.uTexture, 0);

    const whiteTexture = createGlTexture(gl, { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });

    for (const batch of batches) {
      const count = batch.positions.length / 3;
      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.positions), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(shader.aPosition);
      gl.vertexAttribPointer(shader.aPosition, 3, gl.FLOAT, false, 0, 0);

      const normalBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.normals), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(shader.aNormal);
      gl.vertexAttribPointer(shader.aNormal, 3, gl.FLOAT, false, 0, 0);

      const uvBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.uvs), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(shader.aUv);
      gl.vertexAttribPointer(shader.aUv, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      if (batch.texture) {
        gl.bindTexture(gl.TEXTURE_2D, createGlTexture(gl, batch.texture));
        gl.uniform1f(shader.uHasTexture, 1);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, whiteTexture);
        gl.uniform1f(shader.uHasTexture, 0);
      }
      gl.uniform3f(shader.uColor, batch.color[0], batch.color[1], batch.color[2]);
      gl.drawArrays(gl.TRIANGLES, 0, count);

      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(normalBuffer);
      gl.deleteBuffer(uvBuffer);
    }

    gl.finish();
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const flipped = Buffer.alloc(size * size * 4);
    const rowBytes = size * 4;
    for (let y = 0; y < size; y += 1) {
      Buffer.from(pixels.buffer, pixels.byteOffset + y * rowBytes, rowBytes).copy(flipped, (size - 1 - y) * rowBytes);
    }
    return encodePng(size, size, flipped);
  } finally {
    const destroy = gl.getExtension('STACKGL_destroy_context');
    if (destroy) destroy.destroy();
  }
}

// ===== 消息入口 =====

/** 软件光栅器兜底（没有 headless-gl 或 WebGL 渲染失败时） */
async function renderWithSoftware({ filePath, size = 256, poseFraction = null, animation = null, animationOnly = false }) {
  const { root, animations } = await loadModel(filePath);
  applyPose(root, animations, poseFraction, animation, animationOnly);
  const triangles = collectTriangles(root);
  const factor = size <= 256 ? 2 : 1;
  const big = size * factor;
  const rgba = renderCover(triangles, big, big);
  const final = downsample(rgba, big, big, size, size, factor);
  // 与 WebGL 版本一致的深色底（前端封面填充 #1b1e25）
  const background = [0x1b, 0x1e, 0x25];
  const composited = Buffer.alloc(size * size * 4);
  for (let i = 0; i < final.length; i += 4) {
    const alpha = final[i + 3] / 255;
    composited[i] = Math.round(final[i] * alpha + background[0] * (1 - alpha));
    composited[i + 1] = Math.round(final[i + 1] * alpha + background[1] * (1 - alpha));
    composited[i + 2] = Math.round(final[i + 2] * alpha + background[2] * (1 - alpha));
    composited[i + 3] = 255;
  }
  return encodePng(size, size, composited);
}

async function renderCoverForFile({
  filePath,
  size = 256,
  poseFraction = null,
  engine = 'auto',
  ground = 'shadow',
  fov = 42,
  animation = null,
  animationOnly = false,
}) {
  if (engine === 'software') {
    return {
      png: await renderWithSoftware({ filePath, size, poseFraction, animation, animationOnly }),
      engine: 'software',
    };
  }
  try {
    return {
      png: await renderWithWebGL({ filePath, size, poseFraction, ground, fov, animation, animationOnly }),
      engine: 'webgl',
    };
  } catch (err) {
    if (engine === 'webgl') throw err;
    // headless-gl 不可用（例如其它平台缺原生模块）时，退回软件光栅器
    const png = await renderWithSoftware({ filePath, size, poseFraction, animation, animationOnly });
    return { png, engine: 'software', fallbackReason: err instanceof Error ? err.message : String(err) };
  }
}

const { parentPort } = await import('node:worker_threads');

parentPort.on('message', async (message) => {
  if (message?.action === 'inspectMaterials') {
    // 自测钩子：返回 GLB 材质主色，方便验证 PNG/JPEG 主色提取
    try {
      const buffer = fs.readFileSync(message.filePath);
      const container = parseGlbContainer(buffer);
      const colors = glbMaterialAverages(container);
      parentPort.postMessage({ id: message.id, ok: true, colors, jpegDebug: lastJpegDebug });
    } catch (err) {
      parentPort.postMessage({ id: message.id, ok: false, error: String(err?.stack ?? err) });
    }
    return;
  }
  const { id, filePath, size, poseFraction, engine, ground, fov, animation, animationOnly } = message ?? {};
  try {
    const result = await renderCoverForFile({
      filePath,
      size,
      poseFraction,
      engine,
      ground,
      fov,
      animation,
      animationOnly,
    });
    parentPort.postMessage({ id, ok: true, png: result.png, engine: result.engine, fallbackReason: result.fallbackReason });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
  }
});
