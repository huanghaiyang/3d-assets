import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';

const log = createLogger('glb-transform');

/**
 * GLB / glTF 模型的「中心点（轴心）与朝向」批量修正。
 *
 * 需求背景：素材库里的模型来自不同来源，轴心经常在包围盒外（例如导出时原点在
 * 世界原点、模型却偏移在一边），朝向也不统一（有的正面朝 +X、朝 -Z）。
 * 直接在 3D 软件里逐个改太慢，这里在服务端直接改写模型文件本身：
 *
 *  - 只改 glTF 的 **节点变换**（node.matrix），不动顶点 / 缓冲 / 蒙皮数据，
 *    因此不会破坏材质、贴图、骨骼绑定，也不会显著改变文件体积；
 *  - 变换会预先乘到场景根节点的局部矩阵上（新局部矩阵 = M × 旧局部矩阵），
 *    不额外插入 wrapper 节点，重复执行也不会产生层层嵌套；
 *  - 支持 .glb（二进制）与 .gltf（文本 + 外部 .bin）两种容器；
 *  - 朝向修正基于几何：用包围盒判断「厚度轴」，再用脚部薄层里脚尖相对脚跟的
 *    伸出量确定正面方向，与前端自动绑骨的 detectOrientation 使用同一套判据。
 *
 * 注意：bounding box 对蒙皮网格是「绑定姿态」的近似值；蒙皮网格的实际姿态由
 * 骨骼决定，但节点变换会同时作用于骨骼根与网格节点，因此整体朝向 / 轴心修正
 * 仍然是正确的。
 */

/** glTF JSON 文档结构（只声明本文件用到的字段，其余原样保留） */
interface GltfDoc {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
  accessors?: Array<GltfAccessor>;
  bufferViews?: Array<GltfBufferView>;
  buffers?: Array<{ uri?: string; byteLength?: number }>;
  [key: string]: unknown;
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  [key: string]: unknown;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GlbChunk {
  /** chunk 类型：0x4E4F534A = JSON，0x004E4942 = BIN */
  type: number;
  data: Buffer;
}

interface ModelHandle {
  filePath: string;
  isGlb: boolean;
  doc: GltfDoc;
  /** 原始 GLB chunk 列表（保留扩展 chunk，重写时只替换 JSON chunk） */
  chunks: GlbChunk[] | null;
  /** GLB 里的 BIN chunk（按出现顺序），供无 uri 的 buffer 使用 */
  binBuffers: Buffer[];
  /** 外部 / data URI buffer 缓存；null 表示读取失败 */
  bufferCache: Map<number, Buffer | null>;
  /** 无 uri 的 buffer 索引 → binBuffers 下标 */
  binBufferIndexes: number[];
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

/** 轴心模式 */
export type PivotMode = 'none' | 'center' | 'bottom';

export interface TransformOptions {
  /** 轴心处理方式：none 保持原地、center 包围盒中心归零、bottom 底部中心归零 */
  pivot: PivotMode;
  /** 朝向：auto 自动检测；数字表示绕 Y 轴再转多少度（必须是 90 的倍数） */
  yaw: 'auto' | number;
}

export interface TransformResult {
  /** 本次实际施加的绕 Y 旋转（度，已归一化到 (-180, 180]） */
  yawDeg: number;
  /** 实际使用的轴心模式 */
  pivot: PivotMode;
  /** 变换前模型的世界包围盒尺寸，便于前端展示 */
  size: [number, number, number];
  /** 是否真正改写了文件；false = 模型本来就符合目标状态，文件未变、无需重渲染封面 */
  changed: boolean;
}

type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** 节点遍历的最大深度，防御异常 glTF 的循环引用 */
const MAX_NODE_DEPTH = 64;
/** 朝向检测最多采样 15 万个顶点 */
const MAX_ORIENTATION_SAMPLES = 150_000;

// ===== 4×4 矩阵（列主序，与 glTF / three.js 一致） =====

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: Mat4 = new Array(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function translationMatrix(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function rotationYMatrix(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // 绕 Y 轴旋转（右手系）：+X 转向 -Z
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/** 由 TRS 组合局部矩阵：T × R × S（列主序） */
function composeLocalMatrix(node: GltfNode): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return [...(node.matrix as number[])];
  }
  const t = Array.isArray(node.translation) ? node.translation : [0, 0, 0];
  const r = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1];
  const s = Array.isArray(node.scale) ? node.scale : [1, 1, 1];

  const [x, y, z, w] = r as [number, number, number, number];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  const m: Mat4 = [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
  // 缩放：逐列乘
  m[0] = m[0]! * s[0]!;
  m[1] = m[1]! * s[0]!;
  m[2] = m[2]! * s[0]!;
  m[4] = m[4]! * s[1]!;
  m[5] = m[5]! * s[1]!;
  m[6] = m[6]! * s[1]!;
  m[8] = m[8]! * s[2]!;
  m[9] = m[9]! * s[2]!;
  m[10] = m[10]! * s[2]!;
  return m;
}

function applyMatrixToPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

// ===== 读取模型容器 =====

async function loadModel(filePath: string): Promise<ModelHandle> {
  const raw = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.glb') {
    if (raw.length < 20 || raw.readUInt32LE(0) !== GLB_MAGIC) {
      throw new Error('不是有效的 GLB 文件（magic 校验失败）');
    }
    const version = raw.readUInt32LE(4);
    if (version !== 2) throw new Error(`不支持的 GLB 版本 ${version}`);
    const totalLength = raw.readUInt32LE(8);
    if (totalLength > raw.length) throw new Error('GLB 文件长度字段损坏');

    const chunks: GlbChunk[] = [];
    let offset = 12;
    while (offset + 8 <= totalLength) {
      const length = raw.readUInt32LE(offset);
      const type = raw.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (length <= 0 || start + length > totalLength) break;
      chunks.push({ type, data: raw.subarray(start, start + length) });
      offset = start + length;
    }
    const jsonChunk = chunks.find((chunk) => chunk.type === GLB_JSON_CHUNK);
    if (!jsonChunk) throw new Error('GLB 缺少 JSON chunk');
    const doc = JSON.parse(jsonChunk.data.toString('utf8')) as GltfDoc;
    const binBuffers = chunks.filter((chunk) => chunk.type === GLB_BIN_CHUNK).map((chunk) => chunk.data);
    return makeHandle(filePath, true, doc, chunks, binBuffers);
  }

  if (ext === '.gltf') {
    const doc = JSON.parse(raw.toString('utf8')) as GltfDoc;
    return makeHandle(filePath, false, doc, null, []);
  }

  throw new Error(`仅支持 .glb / .gltf 模型（当前 ${ext || '无扩展名'}）`);
}

function makeHandle(
  filePath: string,
  isGlb: boolean,
  doc: GltfDoc,
  chunks: GlbChunk[] | null,
  binBuffers: Buffer[],
): ModelHandle {
  // 无 uri 的 buffer 按顺序对应 GLB 的 BIN chunk（glTF 规范只允许 1 个，这里兼容多个）
  const binBufferIndexes: number[] = [];
  (doc.buffers ?? []).forEach((buffer, index) => {
    if (!buffer.uri) binBufferIndexes.push(index);
  });
  return {
    filePath,
    isGlb,
    doc,
    chunks,
    binBuffers,
    bufferCache: new Map(),
    binBufferIndexes,
  };
}

/** 读取 glTF buffer 第 index 个；GLB 用 BIN chunk，glTF 用 data URI 或同目录外部文件 */
async function getBuffer(handle: ModelHandle, index: number): Promise<Buffer | null> {
  if (handle.bufferCache.has(index)) return handle.bufferCache.get(index)!;
  const definition = handle.doc.buffers?.[index];
  if (!definition) return null;

  let data: Buffer | null = null;
  if (!definition.uri) {
    const binIndex = handle.binBufferIndexes.indexOf(index);
    data = binIndex >= 0 ? handle.binBuffers[binIndex] ?? null : null;
  } else if (definition.uri.startsWith('data:')) {
    const comma = definition.uri.indexOf(',');
    if (comma >= 0) data = Buffer.from(definition.uri.slice(comma + 1), 'base64');
  } else {
    // 外部 .bin：只允许同目录文件，避免恶意 glTF 读取任意路径
    const dir = path.dirname(handle.filePath);
    let relative: string;
    try {
      relative = decodeURIComponent(definition.uri);
    } catch {
      relative = definition.uri;
    }
    const resolved = path.resolve(dir, relative);
    if (resolved === dir || !resolved.startsWith(dir + path.sep)) {
      data = null;
    } else {
      data = await fs.readFile(resolved).catch(() => null);
    }
  }
  handle.bufferCache.set(index, data);
  return data;
}

// ===== 节点遍历与包围盒 =====

interface SceneNodeVisit {
  node: GltfNode;
  world: Mat4;
}

/** 场景根节点索引：优先 doc.scene，缺省时用所有没有父节点的节点 */
function sceneRoots(doc: GltfDoc): number[] {
  const scene = doc.scenes?.[typeof doc.scene === 'number' ? doc.scene : 0];
  if (scene?.nodes?.length) return scene.nodes;
  const nodes = doc.nodes ?? [];
  const hasParent = new Set<number>();
  for (const node of nodes) for (const child of node.children ?? []) hasParent.add(child);
  return nodes.map((_, index) => index).filter((index) => !hasParent.has(index));
}

async function walkScene(
  handle: ModelHandle,
  visit: (entry: SceneNodeVisit) => Promise<void> | void,
): Promise<void> {
  const nodes = handle.doc.nodes ?? [];
  const stack = sceneRoots(handle.doc).map((index) => ({
    index,
    parentMatrix: IDENTITY,
    depth: 0,
  }));
  while (stack.length > 0) {
    const { index, parentMatrix, depth } = stack.pop()!;
    const node = nodes[index];
    if (!node || depth > MAX_NODE_DEPTH) continue;
    const world = multiply(parentMatrix, composeLocalMatrix(node));
    await visit({ node, world });
    for (const child of node.children ?? []) {
      stack.push({ index: child, parentMatrix: world, depth: depth + 1 });
    }
  }
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  valid: boolean;
}

function emptyBounds(): Bounds {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    valid: false,
  };
}

function expandBounds(bounds: Bounds, point: [number, number, number]): void {
  for (let axis = 0; axis < 3; axis += 1) {
    if (point[axis]! < bounds.min[axis]!) bounds.min[axis] = point[axis]!;
    if (point[axis]! > bounds.max[axis]!) bounds.max[axis] = point[axis]!;
  }
  bounds.valid = true;
}

/**
 * 计算模型在当前场景里的世界包围盒。
 *
 * POSITION accessor 按 glTF 规范必须提供 min/max，绝大多数文件可以直接用；
 * 个别导出器缺失时退回逐顶点读取。包围盒用「中心点变换 + 绝对矩阵缩放」的方式
 * 变换到世界空间，比直接变换 8 个角点更贴合实际（旋转后不会虚胖）。
 */
async function computeBounds(handle: ModelHandle): Promise<Bounds> {
  const bounds = emptyBounds();
  const doc = handle.doc;

  await walkScene(handle, async ({ node, world }) => {
    if (node.mesh === undefined) return;
    const primitives = doc.meshes?.[node.mesh]?.primitives ?? [];
    for (const primitive of primitives) {
      const accessorIndex = primitive.attributes?.POSITION;
      if (accessorIndex === undefined) continue;
      const accessor = doc.accessors?.[accessorIndex];
      if (!accessor) continue;

      if (Array.isArray(accessor.min) && accessor.min.length >= 3 && Array.isArray(accessor.max) && accessor.max.length >= 3) {
        const centerLocal = [
          (accessor.min[0]! + accessor.max[0]!) / 2,
          (accessor.min[1]! + accessor.max[1]!) / 2,
          (accessor.min[2]! + accessor.max[2]!) / 2,
        ] as [number, number, number];
        const extent = [
          Math.abs(accessor.max[0]! - accessor.min[0]!) / 2,
          Math.abs(accessor.max[1]! - accessor.min[1]!) / 2,
          Math.abs(accessor.max[2]! - accessor.min[2]!) / 2,
        ] as [number, number, number];
        const worldCenter = applyMatrixToPoint(world, ...centerLocal);
        // 世界空间的半尺寸：|M3x3| × 局部半尺寸
        const halfX =
          Math.abs(world[0]!) * extent[0] + Math.abs(world[4]!) * extent[1] + Math.abs(world[8]!) * extent[2];
        const halfY =
          Math.abs(world[1]!) * extent[0] + Math.abs(world[5]!) * extent[1] + Math.abs(world[9]!) * extent[2];
        const halfZ =
          Math.abs(world[2]!) * extent[0] + Math.abs(world[6]!) * extent[1] + Math.abs(world[10]!) * extent[2];
        expandBounds(bounds, [worldCenter[0] - halfX, worldCenter[1] - halfY, worldCenter[2] - halfZ]);
        expandBounds(bounds, [worldCenter[0] + halfX, worldCenter[1] + halfY, worldCenter[2] + halfZ]);
        continue;
      }

      const positions = await readAccessorSampled(handle, accessorIndex, 1);
      if (!positions) continue;
      for (let i = 0; i < positions.length; i += 3) {
        expandBounds(
          bounds,
          applyMatrixToPoint(world, positions[i]!, positions[i + 1]!, positions[i + 2]!),
        );
      }
    }
  });
  return bounds;
}

// ===== accessor 读取 =====

function componentByteSize(componentType: number): number | null {
  switch (componentType) {
    case 5120: // BYTE
    case 5121: // UNSIGNED_BYTE
      return 1;
    case 5122: // SHORT
    case 5123: // UNSIGNED_SHORT
      return 2;
    case 5125: // UNSIGNED_INT
    case 5126: // FLOAT
      return 4;
    default:
      return null;
  }
}

function readComponent(view: DataView, offset: number, componentType: number, normalized: boolean): number {
  switch (componentType) {
    case 5120: {
      const value = view.getInt8(offset);
      return normalized ? Math.max(value / 127, -1) : value;
    }
    case 5121: {
      const value = view.getUint8(offset);
      return normalized ? value / 255 : value;
    }
    case 5122: {
      const value = view.getInt16(offset, true);
      return normalized ? Math.max(value / 32767, -1) : value;
    }
    case 5123: {
      const value = view.getUint16(offset, true);
      return normalized ? value / 65535 : value;
    }
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
      return view.getFloat32(offset, true);
    default:
      return 0;
  }
}

/**
 * 读取 VEC3 accessor，并按 step 抽样（step 以「顶点」为单位）。
 *
 * @returns 扁平的 [x,y,z,...]，顶点数量约为 ceil(count / step)；
 *          稀疏 accessor / 数据损坏 / 非 VEC3 时返回 null（调用方据此跳过该图元）。
 */
async function readAccessorSampled(
  handle: ModelHandle,
  accessorIndex: number,
  step: number,
): Promise<Float32Array | null> {
  const accessor = handle.doc.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== 'VEC3') return null;
  if (accessor.sparse) return null;
  if (accessor.bufferView === undefined) return null;
  const viewDef = handle.doc.bufferViews?.[accessor.bufferView];
  if (!viewDef) return null;
  const buffer = await getBuffer(handle, viewDef.buffer);
  if (!buffer) return null;

  const componentSize = componentByteSize(accessor.componentType);
  if (!componentSize) return null;
  const vertexBytes = componentSize * 3;
  const byteStride = viewDef.byteStride ?? vertexBytes;
  const start = (viewDef.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const lastOffset = start + (accessor.count - 1) * byteStride + vertexBytes;
  if (accessor.count <= 0 || lastOffset > buffer.length || byteStride < vertexBytes) return null;

  const normalized = Boolean(accessor.normalized);
  const safeStep = Math.max(1, Math.floor(step));
  const outputCount = Math.ceil(accessor.count / safeStep);
  const output = new Float32Array(outputCount * 3);
  const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let cursor = 0;
  for (let i = 0; i < accessor.count; i += safeStep) {
    const offset = start + i * byteStride;
    output[cursor] = readComponent(dataView, offset, accessor.componentType, normalized);
    output[cursor + 1] = readComponent(dataView, offset + componentSize, accessor.componentType, normalized);
    output[cursor + 2] = readComponent(dataView, offset + componentSize * 2, accessor.componentType, normalized);
    cursor += 3;
  }
  return output;
}

/** 统计所有图元的 POSITION 顶点数（含节点实例重复），用于决定朝向检测的抽样步长 */
async function countPositionVertices(handle: ModelHandle): Promise<number> {
  let total = 0;
  await walkScene(handle, ({ node }) => {
    if (node.mesh === undefined) return;
    for (const primitive of handle.doc.meshes?.[node.mesh]?.primitives ?? []) {
      const accessorIndex = primitive.attributes?.POSITION;
      if (accessorIndex === undefined) continue;
      total += handle.doc.accessors?.[accessorIndex]?.count ?? 0;
    }
  });
  return total;
}

// ===== 朝向检测 =====

/**
 * 与前端 detectOrientation 相同的几何判据：
 *  - 水平两轴中尺寸较小的是「前后厚度轴」；
 *  - 脚部薄层里脚尖一侧比脚跟一侧伸得更远 → 该侧是正面；
 *  - 正面目标是 +Z。
 * 判断不成立时返回 0（不旋转）。
 */
async function detectYaw(handle: ModelHandle, bounds: Bounds): Promise<number> {
  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeY = bounds.max[1] - bounds.min[1];
  const sizeZ = bounds.max[2] - bounds.min[2];
  const height = sizeY;
  if (!bounds.valid || height <= 0) return 0;

  const depthIsX = sizeX < sizeZ;
  const depth = depthIsX ? sizeX : sizeZ;
  const span = depthIsX ? sizeZ : sizeX;
  if (depth > height * 0.6 || span < height * 0.3 || span > height * 1.35 || span < depth * 1.12) {
    return 0;
  }

  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  const reference = depthIsX ? centerX : centerZ;
  const slabTop = bounds.min[1] + height * 0.05;

  const total = await countPositionVertices(handle);
  const step = Math.max(1, Math.ceil(total / MAX_ORIENTATION_SAMPLES));

  let min = Infinity;
  let max = -Infinity;
  let sampled = 0;
  await walkScene(handle, async ({ node, world }) => {
    if (node.mesh === undefined) return;
    for (const primitive of handle.doc.meshes?.[node.mesh]?.primitives ?? []) {
      const accessorIndex = primitive.attributes?.POSITION;
      if (accessorIndex === undefined) continue;
      const positions = await readAccessorSampled(handle, accessorIndex, step);
      if (!positions) continue;
      for (let i = 0; i < positions.length; i += 3) {
        const point = applyMatrixToPoint(world, positions[i]!, positions[i + 1]!, positions[i + 2]!);
        if (point[1] > slabTop) continue;
        const value = depthIsX ? point[0] : point[2];
        if (value < min) min = value;
        if (value > max) max = value;
        sampled += 1;
      }
    }
  });
  if (sampled < 20) return 0;

  const positive = max - reference;
  const negative = reference - min;
  const frontIsPositive = positive > negative * 1.15;
  const frontIsNegative = negative > positive * 1.15;
  if (!frontIsPositive && !frontIsNegative) return 0;

  if (!depthIsX) return frontIsPositive ? 0 : Math.PI;
  return frontIsPositive ? -Math.PI / 2 : Math.PI / 2;
}

// ===== 应用变换 =====

/**
 * 把 M 预先乘到场景所有根节点上。
 *
 * 这样节点子树的相对关系保持不变，且多次调用只会不断累积为一个矩阵，
 * 不会像「新增 wrapper 节点」那样越套越深。
 */
function applyMatrixToSceneRoots(handle: ModelHandle, matrix: Mat4): void {
  const doc = handle.doc;
  const nodes = doc.nodes ?? [];
  const roots = new Set(sceneRoots(doc));
  for (const index of roots) {
    const node = nodes[index];
    if (!node) continue;
    node.matrix = multiply(matrix, composeLocalMatrix(node));
    // matrix 与 TRS 同时存在时以 matrix 为准，但为保持文件干净仍删掉冗余字段
    delete node.translation;
    delete node.rotation;
    delete node.scale;
  }
}

function isIdentity(matrix: Mat4): boolean {
  for (let i = 0; i < 16; i += 1) {
    const expected = i % 5 === 0 ? 1 : 0;
    if (Math.abs(matrix[i]! - expected) > 1e-9) return false;
  }
  return true;
}

/** 归一化角度到 (-180, 180]，并把接近 0 的浮点误差吃掉 */
function normalizeDegrees(deg: number): number {
  let value = deg % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return Math.abs(value) < 1e-6 ? 0 : value;
}

// ===== 重写文件 =====

async function writeModel(handle: ModelHandle): Promise<void> {
  const tempPath = `${handle.filePath}.${process.pid}.${Date.now()}.tmp`;
  if (handle.isGlb) {
    const chunks = handle.chunks;
    if (!chunks) throw new Error('GLB chunk 丢失');
    const jsonBytes = Buffer.from(JSON.stringify(handle.doc), 'utf8');
    const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
    const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);

    const parts: Buffer[] = [];
    let totalLength = 12;
    for (const chunk of chunks) {
      const data = chunk.type === GLB_JSON_CHUNK ? jsonChunk : chunk.data;
      const header = Buffer.alloc(8);
      header.writeUInt32LE(data.length, 0);
      header.writeUInt32LE(chunk.type, 4);
      parts.push(header, data);
      totalLength += 8 + data.length;
    }
    const header = Buffer.alloc(12);
    header.writeUInt32LE(GLB_MAGIC, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(totalLength, 8);
    await fs.writeFile(tempPath, Buffer.concat([header, ...parts]));
  } else {
    // .gltf 是纯文本，外部 .bin 原样保留，只替换 JSON
    await fs.writeFile(tempPath, JSON.stringify(handle.doc, null, 2), 'utf8');
  }
  await fs.rename(tempPath, handle.filePath);
}

/**
 * 对单个模型文件执行「轴心 + 朝向」修正，并就地写回文件。
 *
 * @param filePath .glb / .gltf 的绝对路径
 * @param options pivot / yaw 配置；两者都不产生变化时直接返回，不触碰文件
 * @returns 实际施加的旋转角与模型尺寸，供前端提示
 * @throws 文件损坏、格式不支持、角度非 90 倍数等错误
 */
export async function transformModelFile(
  filePath: string,
  options: TransformOptions,
): Promise<TransformResult> {
  if (options.pivot === 'none' && options.yaw !== 'auto' && options.yaw === 0) {
    throw new Error('没有需要执行的变换');
  }
  let manualYaw = 0;
  if (options.yaw !== 'auto') {
    if (!Number.isFinite(options.yaw)) throw new Error('旋转角度不合法');
    // 只接受 90° 的整数倍：避免「纠正朝向」被误用成任意角度旋转
    const snapped = Math.round(options.yaw / 90) * 90;
    if (Math.abs(snapped - options.yaw) > 1e-6) throw new Error('朝向旋转必须是 90° 的倍数');
    manualYaw = normalizeDegrees(snapped);
  }

  const handle = await loadModel(filePath);
  const bounds = await computeBounds(handle);
  if (!bounds.valid) throw new Error('无法计算模型包围盒（模型可能没有几何体）');

  const detectedYaw = options.yaw === 'auto' ? (await detectYaw(handle, bounds)) * (180 / Math.PI) : 0;
  const yawDeg = normalizeDegrees(manualYaw + detectedYaw);
  const yawRad = (yawDeg * Math.PI) / 180;

  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerY = (bounds.min[1] + bounds.max[1]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  const pivotPoint: [number, number, number] =
    options.pivot === 'bottom'
      ? [centerX, bounds.min[1], centerZ]
      : options.pivot === 'center'
        ? [centerX, centerY, centerZ]
        : [centerX, 0, centerZ];

  let matrix = rotationYMatrix(yawRad);
  matrix = multiply(matrix, translationMatrix(-pivotPoint[0], -pivotPoint[1], -pivotPoint[2]));
  if (options.pivot === 'none') {
    // 只转朝向：转完再平移回原位，模型在场景中的位置保持不变
    matrix = multiply(translationMatrix(pivotPoint[0], pivotPoint[1], pivotPoint[2]), matrix);
  }

  if (isIdentity(matrix)) {
    return {
      yawDeg: 0,
      pivot: options.pivot,
      size: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]],
      // 已经是目标状态：不写文件，调用方据此跳过 URL 版本号与封面重建
      changed: false,
    };
  }

  applyMatrixToSceneRoots(handle, matrix);
  await writeModel(handle);
  log.info(
    `${path.basename(filePath)} 变换完成：pivot=${options.pivot}, yaw=${yawDeg}° ` +
      `(auto=${detectedYaw.toFixed(1)}°, manual=${manualYaw}°)`,
  );
  return {
    yawDeg,
    pivot: options.pivot,
    size: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]],
    changed: true,
  };
}
