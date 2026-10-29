import * as THREE from 'three';

/**
 * 人形模型自动绑骨（实验性）。
 *
 * 旧实现直接用「身高 × 固定人体比例」摆放骨骼，隐含假设模型是双臂水平伸展的
 * T-pose。一旦模型是 A-pose / 手臂自然下垂 / 臂展比身高窄，手掌骨与肘关节就会
 * 落到网格外面（最典型的现象是手臂骨骼悬在模型外部），胶囊半径也会与肢体粗细
 * 不匹配，导致蒙皮权重出错。
 *
 * 现在的流程改为「几何测量 + 模板兜底」：
 *
 *  1. 先用几何法判断模型朝向（素材库里的生成模型普遍少一次 Y 轴旋转，正面朝向
 *     ±X 而不是 +Z），需要时先把它转正；
 *  2. 对网格顶点做等距采样（最多 9 万个点），从采样点云里测量：
 *       - 躯干宽度：在腰部薄层里找「以中线为中心的连续横向簇」，避免把手/腿算进来；
 *       - 腿部走向：先测腿，踝 / 膝 / 髋三个高度带从下往上「窗口跟踪」取横向
 *         中位数 —— 自然下垂的手掌就落在大腿两侧，直接从整带取中位数会被手带偏；
 *       - 手臂走向：左右两侧分别对「躯干以外、且不属于同侧大腿」的点云做 PCA，
 *         得到真实的手臂中轴，再沿中轴取肩、肘、腕、指尖四点。T-pose 时中轴水平，
 *         A-pose 时中轴倾斜，手臂下垂时中轴接近竖直，三种站姿都能落进网格内部；
 *       - 肢体粗细：上臂 / 前臂 / 手掌、大腿 / 小腿 / 脚掌各段分别用「点到该段
 *         线段的垂直距离」分位数估计胶囊半径，细的那一段不会被粗的一段撑大。
 *  3. 任何一项测量失败（点太少、数值异常）时，只回退该项到模板比例，其余部位仍
 *     使用几何测量结果；
 *  4. 每根骨骼对应一到多条「胶囊」（骨骼段 + 半径），顶点权重 = 胶囊衰减
 *     `max(0, 1 - d/r)^2`，左右肢体互相抑制（异侧 ×0.05）防止手臂粘连到对侧；
 *  5. 每顶点取权重最高的 4 根骨骼；完全落在所有胶囊外的顶点改为挂到「归一化距离
 *     最近的胶囊」而不是骨盆，避免头发 / 配饰被强行拽到胯部；
 *  6. 用 Bone 层级 + Skeleton 绑定出 SkinnedMesh，绑定姿态即模型当前姿态，
 *     因此绑骨完成后模型外观不变，之后可以摆姿势或导出 GLB。
 *
 * 已知限制（写入 UI 提示）：
 *  - 仍假设模型是「站立人形、左右对称、脚底贴地」，躺倒 / 非人形模型不适合；
 *  - 手指、面部没有骨骼；权重没有网格测地线，仅为欧氏距离近似。
 */

/** 模板骨骼：关节位置以「模型高度 H」为 1 的比例给出，x/z 同理按 H 缩放 */
interface BoneDef {
  name: string;
  parent: string | null;
  joint: [number, number, number];
}

/** 蒙皮胶囊：a/b 为世界坐标，radius 为世界半径；side 用于左右互斥 */
interface CapsuleSpec {
  bone: string;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
  side: 'left' | 'right' | 'center';
}

/**
 * 19 根骨骼的模板位置。数组顺序必须是「父先子后」，后面按顺序设置局部位置时
 * 父骨骼的 matrixWorld 才是最新的。
 *
 * 注意：joint 只作为几何测量失败时的兜底，不再直接决定骨骼位置。
 */
const BONE_DEFS: BoneDef[] = [
  { name: 'Hips', parent: null, joint: [0, 0.52, 0] },
  { name: 'Spine', parent: 'Hips', joint: [0, 0.6, 0] },
  { name: 'Chest', parent: 'Spine', joint: [0, 0.7, 0] },
  { name: 'Neck', parent: 'Chest', joint: [0, 0.84, 0] },
  { name: 'Head', parent: 'Neck', joint: [0, 0.89, 0] },

  { name: 'ShoulderL', parent: 'Chest', joint: [0.095, 0.815, 0] },
  { name: 'UpperArmL', parent: 'ShoulderL', joint: [0.16, 0.815, 0] },
  { name: 'ForearmL', parent: 'UpperArmL', joint: [0.3, 0.815, 0] },
  { name: 'HandL', parent: 'ForearmL', joint: [0.44, 0.815, 0] },

  { name: 'ShoulderR', parent: 'Chest', joint: [-0.095, 0.815, 0] },
  { name: 'UpperArmR', parent: 'ShoulderR', joint: [-0.16, 0.815, 0] },
  { name: 'ForearmR', parent: 'UpperArmR', joint: [-0.3, 0.815, 0] },
  { name: 'HandR', parent: 'ForearmR', joint: [-0.44, 0.815, 0] },

  { name: 'UpperLegL', parent: 'Hips', joint: [0.09, 0.5, 0] },
  { name: 'LowerLegL', parent: 'UpperLegL', joint: [0.095, 0.27, 0] },
  { name: 'FootL', parent: 'LowerLegL', joint: [0.095, 0.055, 0] },

  { name: 'UpperLegR', parent: 'Hips', joint: [-0.09, 0.5, 0] },
  { name: 'LowerLegR', parent: 'UpperLegR', joint: [-0.095, 0.27, 0] },
  { name: 'FootR', parent: 'LowerLegR', joint: [-0.095, 0.055, 0] },
];

/** 每顶点最多 4 个骨骼影响（WebGL / glTF 上限） */
const MAX_INFLUENCES = 4;
/** 每处理这么多顶点让出一次主线程，避免大模型卡死 UI */
const CHUNK_VERTICES = 16384;
/** 异侧肢体权重衰减系数 */
const OPPOSITE_SIDE_FACTOR = 0.05;
/** 判定正脸朝向用的「脚部薄层」厚度（相对身高） */
const FOOT_SLAB_RATIO = 0.05;
/** 脚尖一侧比脚跟一侧至少多伸出这个倍数，才认为朝向判定可靠 */
const TOE_SKEW_THRESHOLD = 1.15;
/** 几何拟合最多采样的顶点数：既保证测量稳定，又避免百万面模型卡死主线程 */
const MAX_FIT_SAMPLES = 90_000;
/** 朝向检测最多采样的顶点数（脚部薄层只需要统计范围，不需要全量顶点） */
const MAX_ORIENTATION_SAMPLES = 150_000;
/**
 * 肢体 / 躯干测量的兜底半径（相对身高）。
 * 上臂比前臂粗、大腿比小腿粗，所以按段各给一个兜底值，避免宁可「一样粗」
 * 导致细的那一段胶囊覆盖过宽。
 */
const FALLBACK_TORSO_HALF_WIDTH = 0.115;
const FALLBACK_UPPER_ARM_RADIUS = 0.05;
const FALLBACK_FOREARM_RADIUS = 0.043;
const FALLBACK_HAND_RADIUS = 0.03;
const FALLBACK_THIGH_RADIUS = 0.075;
const FALLBACK_SHIN_RADIUS = 0.06;
const FALLBACK_FOOT_RADIUS = 0.038;
const FALLBACK_HEAD_RADIUS = 0.08;

export interface AutoRigResult {
  bones: number;
  skinnedMeshes: number;
  vertices: number;
  /** 朝向纠正结果；yaw 为 0 表示模型本来朝向就正确 */
  orientation: OrientationFix;
  /** 各部位是否成功用几何测量（false 表示该部位回退到了模板比例） */
  fit: {
    torso: boolean;
    arms: boolean;
    legs: boolean;
  };
}

/** 朝向纠正结果 */
export interface OrientationFix {
  /** 已施加到模型根上的绕 Y 旋转（弧度） */
  yaw: number;
  /** 供 UI 展示的说明；yaw 为 0 时是空串 */
  note: string;
}

export interface AutoRigProgress {
  (done: number, total: number): void;
}

/** 判断模型是否已有骨架 / 蒙皮 */
export function rootHasSkeleton(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((child) => {
    if (found) return;
    if ((child as THREE.Bone).isBone || (child as THREE.SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}

/**
 * 判断人形模型的水平朝向，给出把「正面」转回 +Z 所需的绕 Y 旋转。
 *
 * 素材库里的生成模型普遍少了一次 Y 轴旋转（正面朝向 ±X），这里不依赖模型的元数据，
 * 纯几何判断：
 *  1) 厚度轴 = 水平两轴里尺寸更小的那条。人形左右方向的尺寸（肩宽 / 臂展）通常
 *     明显大于前后厚度，据此区分「左右轴」和「前后轴」；
 *  2) 取最低 5% 身高的一层顶点（脚），脚尖一定比脚跟伸得远 —— 朝前的那一侧，
 *     顶点离模型中线更远，由此定出正面在厚度轴的哪一侧；
 *  3) 正面目标方向是 +Z（glTF 约定，也是素材库里自带骨架模型的朝向）。
 *
 * 判定不可靠时一律返回 yaw 0（宁可不转，也不要把本来正确的模型转坏）。
 * 大模型会按固定步长抽样，避免为了一次朝向判断遍历上百万个顶点。
 */
export function detectOrientation(root: THREE.Object3D, meshes: THREE.Mesh[]): OrientationFix {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const height = size.y;
  if (!Number.isFinite(height) || height <= 0) return { yaw: 0, note: '' };

  const depthIsX = size.x < size.z;
  const depth = depthIsX ? size.x : size.z;
  const span = depthIsX ? size.z : size.x;
  // 左右方向必须明显比前后厚，否则可能不是站立人形（树、道具、躺倒的模型）。
  // 这里不再要求臂展接近身高，手臂自然下垂的模型同样能识别左右轴。
  if (depth > height * 0.6 || span < height * 0.3 || span > height * 1.35 || span < depth * 1.12) {
    return { yaw: 0, note: '' };
  }

  // 脚部薄层里，脚尖朝向的一侧会明显伸得更远
  const slabTop = box.min.y + height * FOOT_SLAB_RATIO;
  const reference = depthIsX ? center.x : center.z;
  const total = meshes.reduce((sum, mesh) => sum + totalVerticesSafe(mesh), 0);
  // 全量遍历百万顶点只为统计脚尖方向太浪费，这里按全局步长抽样
  const stride = Math.max(1, Math.ceil(total / MAX_ORIENTATION_SAMPLES));
  const vertex = new THREE.Vector3();
  let min = Infinity;
  let max = -Infinity;
  let sampled = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position) continue;
    for (let i = 0; i < position.count; i += stride) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      if (vertex.y > slabTop) continue;
      const value = depthIsX ? vertex.x : vertex.z;
      if (value < min) min = value;
      if (value > max) max = value;
      sampled += 1;
    }
  }
  if (sampled < 20) return { yaw: 0, note: '' };

  const positive = max - reference;
  const negative = reference - min;
  const frontIsPositive = positive > negative * TOE_SKEW_THRESHOLD;
  const frontIsNegative = negative > positive * TOE_SKEW_THRESHOLD;
  if (!frontIsPositive && !frontIsNegative) return { yaw: 0, note: '' };

  if (!depthIsX) {
    // 厚度轴本来就是 Z：朝向最多前后颠倒
    return frontIsPositive ? { yaw: 0, note: '' } : { yaw: Math.PI, note: '模型朝向反了 180°，已自动转正' };
  }
  // 厚度轴是 X：整体偏了 90°
  return {
    yaw: frontIsPositive ? -Math.PI / 2 : Math.PI / 2,
    note: '模型朝向偏了 90°，已自动转正',
  };
}

/** 世界坐标下的胶囊（绑骨前先把比例坐标换算成真实尺寸） */
interface WorldCapsule {
  boneIndex: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radiusSq: number;
  radius: number;
  side: 'left' | 'right' | 'center';
}

/** 点云采样结果：扁平存放 [x0,y0,z0, x1,y1,z1, ...]，减少对象分配 */
interface SampleCloud {
  data: Float32Array;
  count: number;
}

/** 从模型网格里等距采样世界坐标顶点（最多 MAX_FIT_SAMPLES 个） */
function collectSamples(meshes: THREE.Mesh[]): SampleCloud {
  let total = 0;
  for (const mesh of meshes) total += totalVerticesSafe(mesh);
  if (total === 0) return { data: new Float32Array(0), count: 0 };

  const budget = Math.min(total, MAX_FIT_SAMPLES);
  const globalStride = Math.max(1, Math.ceil(total / budget));
  let capacity = 0;
  for (const mesh of meshes) capacity += Math.ceil(totalVerticesSafe(mesh) / globalStride);

  const data = new Float32Array(capacity * 3);
  const vertex = new THREE.Vector3();
  let cursor = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position) continue;
    for (let i = 0; i < position.count; i += globalStride) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      data[cursor] = vertex.x;
      data[cursor + 1] = vertex.y;
      data[cursor + 2] = vertex.z;
      cursor += 3;
    }
  }
  return { data, count: cursor / 3 };
}

/** 已排序数组的分位数（ratio ∈ [0,1]） */
function quantileSorted(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index]!;
}

/** 中位数（会复制并排序，调用方无需预先排序） */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.5);
}

/**
 * 收集「y 落在指定高度带」的点到一条线段的垂直距离（已排序）。
 *
 * 用来分段估计肢体粗细：上臂 / 前臂 / 大腿 / 小腿的半径差别明显，若整条肢体
 * 共用一个平均半径，细的那一段（前臂、小腿）胶囊就会明显偏粗，把相邻躯干或
 * 另一侧肢体的顶点也吸到自己身上。
 */
function segmentDistances(
  points: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  minRatio: number,
  maxRatio: number,
  baseY: number,
  height: number,
): number[] {
  const ab = new THREE.Vector3().subVectors(b, a);
  const p = new THREE.Vector3();
  const distances: number[] = [];
  for (let i = 0; i < points.length; i += 3) {
    const y = points[i + 1]!;
    const ratio = (y - baseY) / height;
    if (ratio < minRatio || ratio > maxRatio) continue;
    p.set(points[i]!, y, points[i + 2]!);
    distances.push(Math.sqrt(pointSegmentDistanceSq(p, a, ab)));
  }
  distances.sort((left, right) => left - right);
  return distances;
}

/** 从距离样本里取分位数半径；样本不足或数值异常时用兜底值 */
function radiusFromDistances(
  distances: number[],
  ratio: number,
  minRadius: number,
  maxRadius: number,
  fallback: number,
): number {
  if (distances.length < 4) return Math.min(maxRadius, Math.max(minRadius, fallback));
  return Math.min(maxRadius, Math.max(minRadius, quantileSorted(distances, ratio)));
}

interface TorsoMeasure {
  /** 腰部半宽（世界单位） */
  halfWidth: number;
  /** 躯干中心在前后的位置（世界 Z） */
  centerZ: number;
  /** 是否来自几何测量 */
  measured: boolean;
}

/**
 * 从一条腰部薄片里量一次躯干半宽。
 *
 * 对 x 做直方图，从模型中线所在 bin 向两侧扩展「连续有顶点的簇」：手臂即使垂在
 * 身侧，也会因为和躯干之间存在空隙而不会被并进同一个簇。
 * 薄片点太少、或量出来的宽度明显不合理（把手臂并进来了 / 只量到一条缝）时返回 null。
 */
function sliceHalfWidth(xs: number[], centerX: number, height: number): number | null {
  if (xs.length < 8) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const x of xs) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const span = Math.max(maxX - minX, 1e-6);
  const bins = 64;
  const counts = new Uint32Array(bins);
  for (const x of xs) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(((x - minX) / span) * bins)));
    counts[index] += 1;
  }
  // 稀疏采样时单个 bin 可能只有一两个点，低于该阈值的 bin 视为空隙
  const occupiedThreshold = Math.max(1, Math.floor((xs.length / bins) * 0.15));
  const occupied = (index: number): boolean =>
    index >= 0 && index < bins && counts[index]! >= occupiedThreshold;

  const centerBin = Math.min(bins - 1, Math.max(0, Math.floor(((centerX - minX) / span) * bins)));
  let centerIndex = centerBin;
  if (!occupied(centerIndex)) {
    // 中线刚好落在空隙里（例如双腿之间）：向左右各找一个最近的有顶点的 bin
    for (let offset = 1; offset < bins; offset += 1) {
      if (occupied(centerBin - offset)) {
        centerIndex = centerBin - offset;
        break;
      }
      if (occupied(centerBin + offset)) {
        centerIndex = centerBin + offset;
        break;
      }
    }
  }

  // 允许跨过极窄的空隙（最多 2 个 bin），但跨不过手臂与躯干之间的大空隙
  const expand = (direction: -1 | 1): number => {
    let edge = centerIndex;
    let gap = 0;
    for (let index = centerIndex + direction; index >= 0 && index < bins; index += direction) {
      if (occupied(index)) {
        edge = index;
        gap = 0;
      } else if (++gap > 2) {
        break;
      }
    }
    return edge;
  };
  const binSize = span / bins;
  const leftX = minX + expand(-1) * binSize;
  const rightX = minX + (expand(1) + 1) * binSize;
  const halfWidth = Math.max(centerX - leftX, rightX - centerX);
  if (!Number.isFinite(halfWidth) || halfWidth <= height * 0.03 || halfWidth >= height * 0.2) {
    return null;
  }
  return halfWidth;
}

/**
 * 测量躯干宽度。
 *
 * 把腰部高度带（0.45H ~ 0.62H）切成 6 条薄片分别测量，再对这些结果取中位数。
 * A-pose / 手臂贴近身体时，总有一两条薄片刚好和手肘粘成一片、量出来明显偏宽；
 * 只用整带量一次的话，一次粘连就会让整项测量失败并回退模板比例。分片 + 中位数
 * 能把异常薄片压掉，同时保留真正测到的躯干宽度。
 */
function measureTorso(
  samples: SampleCloud,
  centerX: number,
  defaultZ: number,
  baseY: number,
  height: number,
): TorsoMeasure {
  const lo = baseY + height * 0.45;
  const hi = baseY + height * 0.62;
  const slices = 6;
  const sliceXs: number[][] = Array.from({ length: slices }, () => []);
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < samples.count; i += 1) {
    const base = i * 3;
    const y = samples.data[base + 1]!;
    if (y < lo || y > hi) continue;
    const x = samples.data[base]!;
    xs.push(x);
    zs.push(samples.data[base + 2]!);
    const slot = Math.min(slices - 1, Math.floor(((y - lo) / (hi - lo)) * slices));
    sliceXs[slot]!.push(x);
  }
  if (xs.length < 24) {
    return { halfWidth: height * FALLBACK_TORSO_HALF_WIDTH, centerZ: defaultZ, measured: false };
  }

  const widths: number[] = [];
  for (const slice of sliceXs) {
    const value = sliceHalfWidth(slice, centerX, height);
    if (value !== null) widths.push(value);
  }
  // 取偏窄的一档（25% 分位）而不是中位数：测量只会因为「和手臂 / 大腿粘在一起」
  // 而偏宽，几乎不会凭空偏窄，所以窄的那几片更接近真实躯干宽度。
  const measured = widths.length >= 2;
  widths.sort((left, right) => left - right);
  const measuredWidth = widths.length > 0 ? quantileSorted(widths, 0.25) : height * FALLBACK_TORSO_HALF_WIDTH;
  const halfWidth = Math.min(measuredWidth, height * 0.17);

  // 只统计躯干横向簇内的 z，忽略手臂/裙摆对深度中心的影响
  const near: number[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (Math.abs(xs[i]! - centerX) <= halfWidth * 1.05) near.push(zs[i]!);
  }
  const centerZ = near.length > 0 ? median(near) : defaultZ;
  return { halfWidth, centerZ, measured };
}

/** 全身轮廓半宽（用于手臂测量失败时的「手臂下垂」兜底） */
function measureSilhouetteHalfWidth(
  samples: SampleCloud,
  centerX: number,
  baseY: number,
  height: number,
): number {
  let half = 0;
  const lo = baseY + height * 0.3;
  const hi = baseY + height * 0.95;
  for (let i = 0; i < samples.count; i += 1) {
    const base = i * 3;
    const y = samples.data[base + 1]!;
    if (y < lo || y > hi) continue;
    const offset = Math.abs(samples.data[base]! - centerX);
    if (offset > half) half = offset;
  }
  return half > 0 ? half : height * 0.44;
}

interface ArmFit {
  /** 肩关节（手臂中轴靠近躯干的一端） */
  socket: THREE.Vector3;
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
  /** 指尖（中轴最远端） */
  tip: THREE.Vector3;
  /** 上臂 / 前臂 / 手掌三段各自的胶囊半径 */
  upperRadius: number;
  foreRadius: number;
  handRadius: number;
  fitted: boolean;
}

/**
 * 用 PCA 拟合一侧手臂的中轴，再沿中轴均分肩/肘/腕/指尖。
 *
 * 这一版不再假设手臂水平：T-pose 时主轴接近水平，A-pose 是斜线，手臂自然下垂
 * 时接近竖直，三种姿势都能得到落在网格内部的手臂骨骼。
 * 点云取「离躯干中线超过腰部半宽」的顶点，并排除髋部以下（腿）区域。
 *
 * `leg` 是同一侧已经测好的腿：自然下垂的手臂和大腿在髋部高度带里横向位置很接近，
 * 只按「躯干外侧」筛选会把大腿点也算进手臂点云；这些点会把 PCA 主轴拽向竖直方向、
 * 把肩端拉低，表现出来就是整条手臂骨下沉 / 骨骼落到网格外。
 */
function fitArm(
  samples: SampleCloud,
  centerX: number,
  baseY: number,
  height: number,
  torsoHalfWidth: number,
  side: 1 | -1,
  leg: LegFit,
): ArmFit | null {
  const threshold = torsoHalfWidth * 1.05 + height * 0.004;
  const points: number[] = [];
  const minY = baseY + height * 0.28;
  const maxY = baseY + height * 0.985;
  const legAB = new THREE.Vector3().subVectors(leg.knee, leg.hip);
  const thighExcludeRadius = leg.thighRadius * 1.05;
  const legProbe = new THREE.Vector3();
  /** 是否属于大腿柱（髋线到膝线之间）——这类点不能参与手臂拟合 */
  const nearThigh = (x: number, y: number, z: number): boolean => {
    const ratio = (y - baseY) / height;
    if (ratio < 0.26 || ratio > 0.55) return false;
    legProbe.set(x, y, z);
    return pointSegmentDistanceSq(legProbe, leg.hip, legAB) < thighExcludeRadius * thighExcludeRadius;
  };
  for (let i = 0; i < samples.count; i += 1) {
    const base = i * 3;
    const x = samples.data[base]!;
    const y = samples.data[base + 1]!;
    if (y < minY || y > maxY) continue;
    if ((x - centerX) * side <= threshold) continue;
    if (nearThigh(x, y, samples.data[base + 2]!)) continue;
    points.push(x, y, samples.data[base + 2]!);
  }
  const count = points.length / 3;
  if (count < Math.max(20, samples.count * 0.0006)) return null;

  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;
  for (let i = 0; i < count; i += 1) {
    meanX += points[i * 3]!;
    meanY += points[i * 3 + 1]!;
    meanZ += points[i * 3 + 2]!;
  }
  meanX /= count;
  meanY /= count;
  meanZ /= count;

  let covXX = 0;
  let covXY = 0;
  let covYY = 0;
  for (let i = 0; i < count; i += 1) {
    const dx = points[i * 3]! - meanX;
    const dy = points[i * 3 + 1]! - meanY;
    covXX += dx * dx;
    covXY += dx * dy;
    covYY += dy * dy;
  }
  // 2×2 协方差矩阵的主轴方向（最大方差方向），避免对整段点云做特征分解
  const theta = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const dirX = Math.cos(theta);
  const dirY = Math.sin(theta);

  // 把每个点投影到主轴上，取 2% / 98% 分位作为手臂两端，避免个别装饰顶点把长度拉爆
  const projections: number[] = [];
  for (let i = 0; i < count; i += 1) {
    projections.push(
      (points[i * 3]! - meanX) * dirX + (points[i * 3 + 1]! - meanY) * dirY,
    );
  }
  const sorted = [...projections].sort((a, b) => a - b);
  const tMin = quantileSorted(sorted, 0.02);
  const tMax = quantileSorted(sorted, 0.98);
  const length = tMax - tMin;
  if (!(length > height * 0.08) || !Number.isFinite(length)) return null;

  // 主轴的正负号本身没有含义，必须先判断哪一端才是「肩」，否则自然下垂的手臂
  // 会因为主轴朝向的噪声把"手"当成"肩"：肩线跑到脚下、脖子跟着塌下来，
  // 表现出来就是骨骼整体错位（甚至看起来在模型外面）。
  // 判据：
  // - 手臂接近竖直（自然下垂 / A-pose）：肩一定在更高的一端；
  // - 手臂接近水平（T-pose）：肩在更靠近躯干中轴的一端。
  const yAt = (t: number): number => meanY + dirY * t;
  const xAt = (t: number): number => meanX + dirX * t;
  const mostlyVertical = Math.abs(dirY) >= Math.abs(dirX);
  const startAtMax = mostlyVertical
    ? yAt(tMin) < yAt(tMax)
    : Math.abs(xAt(tMin) - centerX) > Math.abs(xAt(tMax) - centerX);
  const startT = startAtMax ? tMax : tMin;
  const endT = startAtMax ? tMin : tMax;
  /** 沿主轴从肩到手的符号方向（+1 表示沿 t 增大方向） */
  const sign = endT >= startT ? 1 : -1;
  /** 把 [from, to] 归一成 onAxis 需要的 [小, 大] 区间 */
  const span = (from: number, to: number): [number, number] =>
    from <= to ? [from, to] : [to, from];

  /** 中轴上的点；z 取附近采样点的中位数，适应手臂略微前伸/后摆 */
  const onAxis = (t: number, zFrom: number, zTo: number): THREE.Vector3 => {
    const zs: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const projection = projections[i]!;
      if (projection < zFrom || projection > zTo) continue;
      zs.push(points[i * 3 + 2]!);
    }
    const z = zs.length > 0 ? median(zs) : meanZ;
    return new THREE.Vector3(meanX + dirX * t, meanY + dirY * t, z);
  };

  const [socketFrom, socketTo] = span(startT, startT + sign * length * 0.12);
  const socket = onAxis(startT, socketFrom, socketTo);
  const [elbowFrom, elbowTo] = span(
    startT + sign * length * 0.36,
    startT + sign * length * 0.54,
  );
  const elbow = onAxis(startT + sign * length * 0.45, elbowFrom, elbowTo);
  const [wristFrom, wristTo] = span(
    startT + sign * length * 0.74,
    startT + sign * length * 0.9,
  );
  const wrist = onAxis(startT + sign * length * 0.82, wristFrom, wristTo);
  const [tipFrom, tipTo] = span(endT, endT - sign * length * 0.12);
  const tip = onAxis(endT, tipFrom, tipTo);

  // 半径：分段测量上臂 / 前臂 / 手掌。手臂上粗下细，若三段共用一个半径，
  // 前臂与手掌的胶囊会明显偏粗，把躯干侧面甚至腰部的顶点也吸到手臂骨上。
  const ab = new THREE.Vector3(dirX, dirY, 0);
  const abLen = ab.length();
  const unit = abLen > 0 ? ab.clone().divideScalar(abLen) : new THREE.Vector3(1, 0, 0);
  const abUpper = new THREE.Vector3().subVectors(elbow, socket);
  const abFore = new THREE.Vector3().subVectors(wrist, elbow);
  const abHand = new THREE.Vector3().subVectors(tip, wrist);
  const axisDistances: number[] = [];
  const upperDistances: number[] = [];
  const foreDistances: number[] = [];
  const handDistances: number[] = [];
  const probe = new THREE.Vector3();
  const axisSpan = endT - startT;
  for (let i = 0; i < count; i += 1) {
    probe.set(points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!);
    // 到中轴所在直线的垂直距离：分段样本不足时用它兜底
    const dx = probe.x - socket.x;
    const dy = probe.y - socket.y;
    const dz = probe.z - socket.z;
    const along = dx * unit.x + dy * unit.y + dz * unit.z;
    const px = dx - unit.x * along;
    const py = dy - unit.y * along;
    const pz = dz - unit.z * along;
    axisDistances.push(Math.sqrt(px * px + py * py + pz * pz));

    // u：0 = 肩端，1 = 指尖；只取避开关节的区间，防止端点的球面把半径撑大
    const u = (projections[i]! - startT) / axisSpan;
    if (u >= 0.05 && u <= 0.42) {
      upperDistances.push(Math.sqrt(pointSegmentDistanceSq(probe, socket, abUpper)));
    } else if (u >= 0.55 && u <= 0.86) {
      foreDistances.push(Math.sqrt(pointSegmentDistanceSq(probe, elbow, abFore)));
    } else if (u >= 0.9 && u <= 1) {
      handDistances.push(Math.sqrt(pointSegmentDistanceSq(probe, wrist, abHand)));
    }
  }
  axisDistances.sort((a, b) => a - b);
  upperDistances.sort((a, b) => a - b);
  foreDistances.sort((a, b) => a - b);
  handDistances.sort((a, b) => a - b);

  const baseRadius = radiusFromDistances(
    axisDistances,
    0.8,
    height * 0.014,
    height * 0.08,
    height * FALLBACK_UPPER_ARM_RADIUS,
  );
  const upperRadius = radiusFromDistances(
    upperDistances,
    0.78,
    height * 0.014,
    height * 0.08,
    baseRadius,
  );
  // 前臂 / 手掌不会比上臂更粗：袖口、手套这类局部加厚不应把半径放大
  const foreRadius = Math.min(
    upperRadius * 0.96,
    radiusFromDistances(
      foreDistances,
      0.78,
      height * 0.011,
      height * 0.062,
      baseRadius * 0.88,
    ),
  );
  const handRadius = Math.min(
    foreRadius * 1.08,
    radiusFromDistances(
      handDistances,
      0.78,
      height * 0.008,
      height * 0.055,
      baseRadius * 0.8,
    ),
  );

  clampInsideBox(socket, centerX, baseY, height);
  clampInsideBox(elbow, centerX, baseY, height);
  clampInsideBox(wrist, centerX, baseY, height);
  clampInsideBox(tip, centerX, baseY, height);

  return { socket, elbow, wrist, tip, upperRadius, foreRadius, handRadius, fitted: true };
}

/**
 * 手臂测量的兜底方案。
 *
 * - 轮廓较宽（接近 T-pose）：沿水平方向摆臂，手掌落在轮廓边缘内侧；
 * - 轮廓较窄（手臂下垂 / A-pose 但点云太少）：沿垂直方向摆臂。
 *
 * 无论哪种都使用「轮廓半宽」而不是固定的 0.44H，因此骨骼不会跑到网格外。
 */
function fallbackArm(
  centerX: number,
  baseY: number,
  height: number,
  torsoHalfWidth: number,
  silhouetteHalfWidth: number,
  centerZ: number,
  side: 1 | -1,
): ArmFit {
  const isWide = silhouetteHalfWidth > height * 0.28;
  const tipX = centerX + side * Math.max(height * 0.05, silhouetteHalfWidth - height * 0.01);
  const socketOffset = isWide
    ? Math.min(silhouetteHalfWidth * 0.85, torsoHalfWidth * 1.15)
    : Math.max(torsoHalfWidth * 0.7, silhouetteHalfWidth * 0.72);
  const socketX = centerX + side * socketOffset;
  const socketY = isWide ? baseY + height * 0.815 : baseY + height * 0.76;
  const tipY = isWide ? baseY + height * 0.815 : baseY + height * 0.4;
  const socket = new THREE.Vector3(socketX, socketY, centerZ);
  const tip = new THREE.Vector3(tipX, tipY, centerZ);
  const lerp = (ratio: number): THREE.Vector3 => socket.clone().lerp(tip, ratio);
  return {
    socket,
    elbow: lerp(0.45),
    wrist: lerp(0.82),
    tip,
    upperRadius: height * FALLBACK_UPPER_ARM_RADIUS,
    foreRadius: height * FALLBACK_FOREARM_RADIUS,
    handRadius: height * FALLBACK_HAND_RADIUS,
    fitted: false,
  };
}

interface LegFit {
  hip: THREE.Vector3;
  knee: THREE.Vector3;
  ankle: THREE.Vector3;
  /** 脚尖位置（只用于脚部胶囊，不写成骨骼关节） */
  toe: THREE.Vector3;
  /** 大腿 / 小腿 / 脚掌三段各自的胶囊半径 */
  thighRadius: number;
  shinRadius: number;
  footRadius: number;
  fitted: boolean;
}

/**
 * 测量一侧腿骨位置。
 *
 * 髋 / 膝 / 踝三个高度带分别取横向中位数，能适配宽站姿、窄站姿和轻微弯曲的腿。
 *
 * 髋、膝两带不直接对整条带取中位数，而是以「下一段的中心」为基准先做窗口初筛：
 * 自然下垂的手掌正好落在大腿两侧的同一高度带里，直接取中位数会被手部点带偏。
 * 踝部高度带只有脚、不会混进手，所以从踝往上一级级跟踪最稳。
 * 脚部薄层再测量脚尖的 Z 范围，保证脚掌胶囊覆盖到脚趾而不会缩在脚踝。
 */
function fitLeg(
  samples: SampleCloud,
  centerX: number,
  centerZ: number,
  baseY: number,
  height: number,
  side: 1 | -1,
): LegFit | null {
  /** 同侧髋部以下的所有点，用于分段测半径 */
  const points: number[] = [];
  const hipBand: number[] = [];
  const kneeBand: number[] = [];
  const ankleBand: number[] = [];
  const zHip: number[] = [];
  const zAnkle: number[] = [];
  const footZ: number[] = [];

  for (let i = 0; i < samples.count; i += 1) {
    const base = i * 3;
    const x = samples.data[base]!;
    const y = samples.data[base + 1]!;
    const z = samples.data[base + 2]!;
    if ((x - centerX) * side <= height * 0.004) continue;
    const ratio = (y - baseY) / height;
    if (ratio < 0.005 || ratio > 0.5) continue;
    points.push(x, y, z);
    if (ratio >= 0.38 && ratio <= 0.47) {
      hipBand.push(x);
      zHip.push(z);
    } else if (ratio >= 0.2 && ratio <= 0.29) {
      kneeBand.push(x);
    } else if (ratio <= 0.11) {
      ankleBand.push(x);
      zAnkle.push(z);
      if (ratio <= 0.07) footZ.push(z);
    }
  }

  /**
   * 以 anchor 为中心取窗口内的中位数；窗口内点太少时逐步放宽，
   * 都不够时才退回整条带的中位数（宁可被手带偏，也不要丢掉整条腿的测量）。
   */
  const bandCenter = (values: number[], anchor: number): number | null => {
    if (values.length < 4) return null;
    const near = values.filter((value) => Math.abs(value - anchor) <= height * 0.07);
    if (near.length >= 4) return median(near);
    const wider = values.filter((value) => Math.abs(value - anchor) <= height * 0.14);
    return wider.length >= 4 ? median(wider) : median(values);
  };

  if (ankleBand.length < 4) return null;
  const ankleX = median(ankleBand);
  const kneeX = bandCenter(kneeBand, ankleX);
  if (kneeX === null) return null;
  const hipX = bandCenter(hipBand, kneeX);
  if (hipX === null) return null;
  // 腿必须确实在对应侧，否则说明左右腿被错误合并
  if ((hipX - centerX) * side <= height * 0.002) return null;

  const hipY = baseY + height * 0.5;
  const kneeY = baseY + height * 0.27;
  const ankleY = baseY + height * 0.055;
  const hipZ = zHip.length > 0 ? median(zHip) : centerZ;
  const ankleZ = zAnkle.length > 0 ? median(zAnkle) : centerZ;

  const hip = new THREE.Vector3(hipX, hipY, hipZ);
  const knee = new THREE.Vector3(kneeX, kneeY, centerZ);
  const ankle = new THREE.Vector3(ankleX, ankleY, ankleZ);

  // 脚尖：脚部薄层里 z 最大的一侧；数据不足时按 +Z（模型已转正）兜底
  let toeZ = -Infinity;
  for (const value of footZ) {
    if (value > toeZ) toeZ = value;
  }
  if (footZ.length <= 2 || !Number.isFinite(toeZ)) toeZ = centerZ + height * 0.08;
  const toe = new THREE.Vector3(ankleX, baseY + height * 0.02, toeZ - height * 0.005);

  // 半径：大腿 / 小腿 / 脚掌分别测量。大腿比小腿粗一大圈，共用半径会让小腿
  // 胶囊明显偏粗，把另一条腿、裙摆甚至对侧脚踝的顶点也吸到这条腿上。
  const thighRadius = radiusFromDistances(
    segmentDistances(points, hip, knee, 0.33, 0.47, baseY, height),
    0.8,
    height * 0.032,
    height * 0.11,
    height * FALLBACK_THIGH_RADIUS,
  );
  const shinRadius = Math.min(
    thighRadius * 0.9,
    radiusFromDistances(
      segmentDistances(points, knee, ankle, 0.12, 0.26, baseY, height),
      0.8,
      height * 0.026,
      height * 0.09,
      height * FALLBACK_SHIN_RADIUS,
    ),
  );
  const footRadius = radiusFromDistances(
    segmentDistances(
      points,
      new THREE.Vector3(ankleX, baseY + height * 0.04, ankleZ),
      toe,
      0.005,
      0.085,
      baseY,
      height,
    ),
    0.7,
    height * 0.018,
    height * 0.055,
    height * FALLBACK_FOOT_RADIUS,
  );

  clampInsideBox(hip, centerX, baseY, height);
  clampInsideBox(knee, centerX, baseY, height);
  clampInsideBox(ankle, centerX, baseY, height);
  return { hip, knee, ankle, toe, thighRadius, shinRadius, footRadius, fitted: true };
}

/** 腿部兜底：按模板比例摆放，但左右腿的横向位置跟随轮廓宽度略微展开 */
function fallbackLeg(
  centerX: number,
  centerZ: number,
  baseY: number,
  height: number,
  silhouetteHalfWidth: number,
  side: 1 | -1,
): LegFit {
  const hipOffset = Math.min(height * 0.12, Math.max(height * 0.07, silhouetteHalfWidth * 0.32));
  const x = centerX + side * hipOffset;
  return {
    hip: new THREE.Vector3(x, baseY + height * 0.5, centerZ),
    knee: new THREE.Vector3(x, baseY + height * 0.27, centerZ),
    ankle: new THREE.Vector3(x, baseY + height * 0.055, centerZ),
    toe: new THREE.Vector3(x, baseY + height * 0.02, centerZ + height * 0.09),
    thighRadius: height * FALLBACK_THIGH_RADIUS,
    shinRadius: height * FALLBACK_SHIN_RADIUS,
    footRadius: height * FALLBACK_FOOT_RADIUS,
    fitted: false,
  };
}

interface BodyFit {
  /** 骨骼名 → 世界坐标关节 */
  joints: Map<string, THREE.Vector3>;
  /** 世界坐标蒙皮胶囊 */
  capsules: CapsuleSpec[];
  height: number;
  baseY: number;
  centerX: number;
  centerZ: number;
  fit: AutoRigResult['fit'];
}

/**
 * 把顶点测量结果整理成「骨骼关节 + 蒙皮胶囊」。
 *
 * 所有关节都以世界坐标给出，后续建 Bone 层级时再用 worldToLocal 反解局部坐标，
 * 这样 modelRoot 自带缩放 / 旋转时也不会错位。
 */
function fitBody(root: THREE.Object3D, meshes: THREE.Mesh[]): BodyFit {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const height = size.y;
  if (!Number.isFinite(height) || height <= 0) throw new Error('模型包围盒异常，无法绑骨');
  const baseY = box.min.y;
  const centerX = center.x;

  const samples = collectSamples(meshes);
  const torso = measureTorso(samples, centerX, center.z, baseY, height);
  const torsoHalfWidth = torso.halfWidth;
  const centerZ = torso.centerZ;
  const silhouette = measureSilhouetteHalfWidth(samples, centerX, baseY, height);

  // 先测腿、再测手臂：手臂拟合需要已测出的腿柱，用来把「髋部以下的大腿点」
  // 从手臂点云里剔除（自然下垂时手掌/大腿在横向位置上几乎重叠）。
  const legL = fitLeg(samples, centerX, centerZ, baseY, height, 1)
    ?? fallbackLeg(centerX, centerZ, baseY, height, silhouette, 1);
  const legR = fitLeg(samples, centerX, centerZ, baseY, height, -1)
    ?? fallbackLeg(centerX, centerZ, baseY, height, silhouette, -1);
  const armL = fitArm(samples, centerX, baseY, height, torsoHalfWidth, 1, legL)
    ?? fallbackArm(centerX, baseY, height, torsoHalfWidth, silhouette, centerZ, 1);
  const armR = fitArm(samples, centerX, baseY, height, torsoHalfWidth, -1, legR)
    ?? fallbackArm(centerX, baseY, height, torsoHalfWidth, silhouette, centerZ, -1);

  const shoulderY = (armL.socket.y + armR.socket.y) / 2;
  const hipY = baseY + height * 0.52;
  const spineY = baseY + height * 0.6;
  const chestY = baseY + height * 0.7;

  // 躯干：如果手臂测量成功，肩线用测量值；否则退回模板的 0.815H
  const torsoShoulderY = armL.fitted || armR.fitted ? shoulderY : baseY + height * 0.815;
  const resolvedNeckY = Math.min(baseY + height * 0.97, torsoShoulderY + height * 0.025);
  const resolvedHeadY = Math.min(baseY + height * 0.97, resolvedNeckY + height * 0.05);

  const joints = new Map<string, THREE.Vector3>();
  joints.set('Hips', new THREE.Vector3(centerX, hipY, centerZ));
  joints.set('Spine', new THREE.Vector3(centerX, spineY, centerZ));
  joints.set('Chest', new THREE.Vector3(centerX, chestY, centerZ));
  joints.set('Neck', new THREE.Vector3(centerX, resolvedNeckY, centerZ));
  joints.set('Head', new THREE.Vector3(centerX, resolvedHeadY, centerZ));

  // 肩骨：从胸廓外侧到手臂中轴起点
  const shoulderJoint = (side: 1 | -1, socket: THREE.Vector3): THREE.Vector3 => {
    const reach = Math.min(torsoHalfWidth * 0.55, Math.abs(socket.x - centerX));
    return new THREE.Vector3(centerX + side * Math.max(height * 0.02, reach), socket.y, centerZ);
  };
  joints.set('ShoulderL', shoulderJoint(1, armL.socket));
  joints.set('UpperArmL', armL.socket.clone());
  joints.set('ForearmL', armL.elbow.clone());
  joints.set('HandL', armL.wrist.clone());

  joints.set('ShoulderR', shoulderJoint(-1, armR.socket));
  joints.set('UpperArmR', armR.socket.clone());
  joints.set('ForearmR', armR.elbow.clone());
  joints.set('HandR', armR.wrist.clone());

  joints.set('UpperLegL', legL.hip.clone());
  joints.set('LowerLegL', legL.knee.clone());
  joints.set('FootL', legL.ankle.clone());
  joints.set('UpperLegR', legR.hip.clone());
  joints.set('LowerLegR', legR.knee.clone());
  joints.set('FootR', legR.ankle.clone());

  // ---- 蒙皮胶囊：全部由测量出的关节/半径生成，不再使用固定比例 ----
  const torsoRadius = Math.min(
    height * 0.15,
    Math.max(height * 0.06, torsoHalfWidth * 0.95),
  );
  const neckRadius = Math.max(height * 0.035, Math.min(torsoRadius * 0.45, height * 0.06));
  const headRadius = measureHeadRadius(samples, centerX, centerZ, resolvedNeckY, baseY + height, height);
  // 左右两侧各用自己测出的半径：一侧拟合失败回退模板时，不会把另一侧也带偏
  const shoulderBandRadius = Math.max(
    Math.max(armL.upperRadius, armR.upperRadius) * 0.9,
    torsoRadius * 0.55,
  );
  const hipBandRadius = Math.max(
    Math.max(legL.thighRadius, legR.thighRadius) * 0.78,
    height * 0.04,
  );

  const capsules: CapsuleSpec[] = [];
  const hips = joints.get('Hips')!;
  const spine = joints.get('Spine')!;
  const chest = joints.get('Chest')!;
  const neck = joints.get('Neck')!;
  const head = joints.get('Head')!;
  const shoulderL = joints.get('ShoulderL')!;
  const shoulderR = joints.get('ShoulderR')!;

  capsules.push(
    // 骨盆：竖直主胶囊 + 横向一条覆盖胯部
    { bone: 'Hips', a: new THREE.Vector3(centerX, hipY - height * 0.06, centerZ), b: hips.clone(), radius: torsoRadius * 0.95, side: 'center' },
    { bone: 'Hips', a: legR.hip.clone(), b: legL.hip.clone(), radius: hipBandRadius, side: 'center' },
    { bone: 'Spine', a: hips.clone(), b: spine.clone(), radius: torsoRadius * 0.92, side: 'center' },
    { bone: 'Chest', a: spine.clone(), b: chest.clone(), radius: torsoRadius, side: 'center' },
    // 肩带横条：覆盖锁骨 / 上胸，避免整个肩膀被手臂骨骼抢走
    { bone: 'Chest', a: shoulderR.clone(), b: shoulderL.clone(), radius: shoulderBandRadius, side: 'center' },
    { bone: 'Neck', a: neck.clone(), b: new THREE.Vector3(centerX, resolvedNeckY + height * 0.02, centerZ), radius: neckRadius, side: 'center' },
    { bone: 'Head', a: head.clone(), b: new THREE.Vector3(centerX, baseY + height * 0.995, centerZ), radius: headRadius, side: 'center' },
  );

  const addArm = (side: 1 | -1, fit: ArmFit): void => {
    const suffix = side === 1 ? 'L' : 'R';
    const tag = side === 1 ? 'left' : 'right';
    const shoulder = joints.get(`Shoulder${suffix}`)!;
    const socket = joints.get(`UpperArm${suffix}`)!;
    const elbow = joints.get(`Forearm${suffix}`)!;
    const wrist = joints.get(`Hand${suffix}`)!;
    capsules.push(
      { bone: `Shoulder${suffix}`, a: shoulder.clone(), b: socket.clone(), radius: Math.max(fit.upperRadius * 1.08, height * 0.03), side: tag },
      { bone: `UpperArm${suffix}`, a: socket.clone(), b: elbow.clone(), radius: fit.upperRadius, side: tag },
      { bone: `Forearm${suffix}`, a: elbow.clone(), b: wrist.clone(), radius: fit.foreRadius, side: tag },
      { bone: `Hand${suffix}`, a: wrist.clone(), b: fit.tip.clone(), radius: Math.max(fit.handRadius, height * 0.018), side: tag },
    );
  };
  addArm(1, armL);
  addArm(-1, armR);

  const addLeg = (side: 1 | -1, fit: LegFit): void => {
    const suffix = side === 1 ? 'L' : 'R';
    const tag = side === 1 ? 'left' : 'right';
    const hip = joints.get(`UpperLeg${suffix}`)!;
    const knee = joints.get(`LowerLeg${suffix}`)!;
    const ankle = joints.get(`Foot${suffix}`)!;
    capsules.push(
      { bone: `UpperLeg${suffix}`, a: hip.clone(), b: knee.clone(), radius: fit.thighRadius, side: tag },
      { bone: `LowerLeg${suffix}`, a: knee.clone(), b: ankle.clone(), radius: fit.shinRadius, side: tag },
      {
        bone: `Foot${suffix}`,
        a: new THREE.Vector3(ankle.x, baseY + height * 0.04, ankle.z - height * 0.02),
        b: fit.toe.clone(),
        radius: Math.max(fit.footRadius, height * 0.022),
        side: tag,
      },
    );
  };
  addLeg(1, legL);
  addLeg(-1, legR);

  return {
    joints,
    capsules,
    height,
    baseY,
    centerX,
    centerZ,
    fit: {
      torso: torso.measured,
      arms: armL.fitted && armR.fitted,
      legs: legL.fitted && legR.fitted,
    },
  };
}

/** 用头部高度的横向跨度估计头骨胶囊半径 */
function measureHeadRadius(
  samples: SampleCloud,
  centerX: number,
  centerZ: number,
  neckY: number,
  topY: number,
  height: number,
): number {
  const xs: number[] = [];
  const zs: number[] = [];
  const lo = neckY + (topY - neckY) * 0.15;
  for (let i = 0; i < samples.count; i += 1) {
    const base = i * 3;
    const y = samples.data[base + 1]!;
    if (y < lo || y > topY) continue;
    xs.push(Math.abs(samples.data[base]! - centerX));
    zs.push(Math.abs(samples.data[base + 2]! - centerZ));
  }
  if (xs.length < 8) return height * FALLBACK_HEAD_RADIUS;
  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const radius = Math.max(quantileSorted(xs, 0.9), quantileSorted(zs, 0.9));
  return Math.min(height * 0.13, Math.max(height * 0.045, radius * 1.02));
}

/** 把关节限制在模型包围盒的竖直范围内，避免测量异常时骨骼落到地面以下 / 头顶以上 */
function clampInsideBox(point: THREE.Vector3, centerX: number, baseY: number, height: number): void {
  const margin = height * 0.004;
  point.y = Math.max(baseY + margin, Math.min(baseY + height - margin, point.y));
  if (!Number.isFinite(point.x)) point.x = centerX;
  if (!Number.isFinite(point.z)) point.z = 0;
}

/** 点到线段的最短距离（平方）；ab 为预计算的 b-a，避免内层循环重复减法 */
function pointSegmentDistanceSq(
  p: THREE.Vector3,
  a: THREE.Vector3,
  ab: THREE.Vector3,
): number {
  const abLenSq = ab.lengthSq();
  let t = 0;
  if (abLenSq > 0) {
    t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / abLenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const dx = p.x - (a.x + ab.x * t);
  const dy = p.y - (a.y + ab.y * t);
  const dz = p.z - (a.z + ab.z * t);
  return dx * dx + dy * dy + dz * dz;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 给 modelRoot 里的所有普通网格自动绑骨。
 *
 * @param root 已归一化的模型根（ModelViewer.load 里的 modelRoot）
 * @param onProgress 进度回调（按顶点计数），可用于 UI 进度条
 * @throws 没有网格时抛错；已有骨架时请调用方先用 rootHasSkeleton 判断
 */
export async function autoRigHumanoid(
  root: THREE.Object3D,
  onProgress?: AutoRigProgress,
): Promise<AutoRigResult> {
  root.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (mesh.geometry?.getAttribute('position')) meshes.push(mesh);
  });
  if (meshes.length === 0) throw new Error('模型里没有可绑定的网格');

  // ---- 朝向纠正：素材库里的生成模型普遍少了一次 Y 轴旋转，先转正再套模板 ----
  // 模板骨架假定模型面朝 +Z 且左右对称；朝向不对时直接套模板会把手臂权重算到前后方向。
  const orientation = detectOrientation(root, meshes);
  if (orientation.yaw !== 0) {
    // 模型根的原点在模型水平中心、且缩放是等比的，所以绕 Y 旋转后模型仍然居中贴地
    root.rotation.y += orientation.yaw;
    root.updateMatrixWorld(true);
  }

  // ---- 从网格几何拟合人体关节与胶囊（失败部位单独回退模板比例）----
  const body = fitBody(root, meshes);

  // ---- 骨骼世界坐标 ----
  const boneIndexByName = new Map<string, number>();
  BONE_DEFS.forEach((def, index) => boneIndexByName.set(def.name, index));
  const jointWorld = BONE_DEFS.map((def) => body.joints.get(def.name)!.clone());

  // ---- 蒙皮胶囊换算成 WorldCapsule ----
  const capsules: WorldCapsule[] = body.capsules
    .map((def) => {
      const boneIndex = boneIndexByName.get(def.bone);
      if (boneIndex === undefined) return null;
      const radius = Math.max(def.radius, body.height * 0.012);
      return {
        boneIndex,
        a: def.a,
        b: def.b,
        radius,
        radiusSq: radius * radius,
        side: def.side,
      };
    })
    .filter((item): item is WorldCapsule => item !== null);
  if (capsules.length === 0) throw new Error('蒙皮胶囊生成失败');
  // 预计算每条线段的 b-a，内层循环少一次减法
  const abList = capsules.map((capsule) => capsule.b.clone().sub(capsule.a));

  // ---- 逐网格计算权重（此阶段不替换场景里的网格，只收集待换绑对象） ----
  const totalVertices = meshes.reduce((sum, mesh) => sum + totalVerticesSafe(mesh), 0);
  let doneVertices = 0;
  const vertex = new THREE.Vector3();
  const weights = new Float32Array(BONE_DEFS.length);
  const processedGeometries = new Set<string>();
  // 换绑列表：等骨架建好、绑定后一次性同步替换，避免渲染循环看到「未绑骨架的 SkinnedMesh」
  const pendingSwaps: Array<{ mesh: THREE.Mesh; skinned: THREE.SkinnedMesh }> = [];

  for (const mesh of meshes) {
    // 同一 geometry 被多个 mesh 共享时克隆一份，避免覆盖上一套的权重
    let geometry = mesh.geometry as THREE.BufferGeometry;
    if (processedGeometries.has(geometry.uuid)) geometry = geometry.clone();
    processedGeometries.add(geometry.uuid);

    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = position.count;
    const skinIndex = new Uint16Array(count * MAX_INFLUENCES);
    const skinWeight = new Float32Array(count * MAX_INFLUENCES);

    for (let i = 0; i < count; i += 1) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      computeWeights(vertex, capsules, abList, body.centerX, weights);
      writeTop4(weights, skinIndex, skinWeight, i);

      doneVertices += 1;
      if (doneVertices % CHUNK_VERTICES === 0) {
        onProgress?.(doneVertices, totalVertices);
        await yieldToUi();
      }
    }

    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, MAX_INFLUENCES));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, MAX_INFLUENCES));

    const skinned = new THREE.SkinnedMesh(geometry, mesh.material);
    skinned.name = mesh.name;
    skinned.position.copy(mesh.position);
    skinned.quaternion.copy(mesh.quaternion);
    skinned.scale.copy(mesh.scale);
    skinned.castShadow = mesh.castShadow;
    skinned.receiveShadow = mesh.receiveShadow;
    // 蒙皮后包围球不再可靠，骨骼动画时可能被错误剔除
    skinned.frustumCulled = false;
    // 预填绑定姿态的包围球：frustumCulled=false 时它只用于渲染排序；
    // 否则渲染器首帧会对蒙皮网格做全顶点 applyBoneTransform 扫描，白算一遍
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    skinned.boundingSphere = geometry.boundingSphere!.clone();

    pendingSwaps.push({ mesh, skinned });
  }
  onProgress?.(totalVertices, totalVertices);

  // ---- 建骨骼层级并挂到模型根下 ----
  const bones: THREE.Bone[] = BONE_DEFS.map((def) => {
    const bone = new THREE.Bone();
    bone.name = def.name;
    return bone;
  });
  BONE_DEFS.forEach((def, index) => {
    if (def.parent) bones[boneIndexByName.get(def.parent)!]!.add(bones[index]!);
  });
  const rootBone = bones[0]!;
  root.add(rootBone);
  // 父先子后：用父骨骼的世界矩阵反解局部坐标（modelRoot 自身带缩放，必须走 worldToLocal）
  BONE_DEFS.forEach((_, index) => {
    const bone = bones[index]!;
    const parent = bone.parent as THREE.Object3D;
    parent.updateWorldMatrix(true, false);
    bone.position.copy(parent.worldToLocal(jointWorld[index]!.clone()));
  });
  root.updateMatrixWorld(true);

  // 绑定姿态 = 当前姿态：Skeleton 构造时按当前 matrixWorld 计算 boneInverses
  const skeleton = new THREE.Skeleton(bones);
  // 换绑必须全程同步（中间没有 await）：渲染循环只会在任务边界运行，
  // 绝不会看到「已挂进场景但还没 bind 骨架」的 SkinnedMesh
  for (const { mesh, skinned } of pendingSwaps) {
    const parent = mesh.parent;
    // 个别 glTF 会在 mesh 节点下再挂子节点（例如碰撞体），换绑时把这些子节点原样搬过去
    while (mesh.children.length > 0) skinned.add(mesh.children[0]!);
    parent?.remove(mesh);
    parent?.add(skinned);
    skinned.updateWorldMatrix(true, false);
    skinned.bind(skeleton, skinned.matrixWorld.clone());
  }

  return {
    bones: bones.length,
    skinnedMeshes: pendingSwaps.length,
    vertices: doneVertices,
    orientation,
    fit: body.fit,
  };
}

function totalVerticesSafe(mesh: THREE.Mesh): number {
  const attribute = mesh.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  return attribute ? attribute.count : 0;
}

/**
 * 计算一个顶点对所有骨骼的胶囊衰减权重（写入 out，长度为骨骼数）。
 *
 * 如果顶点完全落在所有胶囊之外（头发、背包、披风等），使用「归一化距离最近
 * 的胶囊」给它一个权重：归一化距离 = 实际距离² / 胶囊半径²，这样粗胶囊不会
 * 因为半径大就无条件抢走远处顶点。异侧胶囊在兜底时会被 4× 惩罚。
 */
function computeWeights(
  vertex: THREE.Vector3,
  capsules: WorldCapsule[],
  abList: THREE.Vector3[],
  centerX: number,
  out: Float32Array,
): void {
  out.fill(0);
  let nearestIndex = -1;
  let nearestScore = Infinity;
  let covered = false;
  for (let i = 0; i < capsules.length; i += 1) {
    const capsule = capsules[i]!;
    const distanceSq = pointSegmentDistanceSq(vertex, capsule.a, abList[i]!);
    const score = distanceSq / capsule.radiusSq;
    // 兜底候选：异侧胶囊加权惩罚，避免左下摆的布料被吸到右臂
    let candidateScore = score;
    if (capsule.side === 'left' && vertex.x < centerX) candidateScore *= 4;
    else if (capsule.side === 'right' && vertex.x > centerX) candidateScore *= 4;
    if (candidateScore < nearestScore) {
      nearestScore = candidateScore;
      nearestIndex = i;
    }
    if (distanceSq >= capsule.radiusSq) continue;
    const falloff = 1 - Math.sqrt(distanceSq) / capsule.radius;
    let weight = falloff * falloff;
    // 左右互斥：异侧顶点只保留 5%，防止手臂/大腿粘到对侧骨骼（中线为包围盒中心）
    if (capsule.side === 'left' && vertex.x < centerX) weight *= OPPOSITE_SIDE_FACTOR;
    else if (capsule.side === 'right' && vertex.x > centerX) weight *= OPPOSITE_SIDE_FACTOR;
    if (weight > out[capsule.boneIndex]!) out[capsule.boneIndex] = weight;
    if (weight > 0) covered = true;
  }

  // 完全落在所有胶囊外（头发 / 配饰 / 披风）才回退到「归一化距离最近」的胶囊
  if (!covered && nearestIndex >= 0) out[capsules[nearestIndex]!.boneIndex] = 1;
}

/** 取权重最高的 4 根骨骼写入属性；全零时挂到骨盆，避免塌缩到原点 */
function writeTop4(
  weights: Float32Array,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  vertexIndex: number,
): void {
  const offset = vertexIndex * MAX_INFLUENCES;
  let sum = 0;
  let used = 0;

  for (let slot = 0; slot < MAX_INFLUENCES; slot += 1) {
    let bestIndex = -1;
    let bestWeight = 0;
    for (let boneIndex = 0; boneIndex < weights.length; boneIndex += 1) {
      const weight = weights[boneIndex]!;
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = boneIndex;
      }
    }
    if (bestIndex < 0) break;
    skinIndex[offset + slot] = bestIndex;
    skinWeight[offset + slot] = bestWeight;
    sum += bestWeight;
    used += 1;
    weights[bestIndex] = 0; // 从下一轮候选里移除
  }

  if (used === 0 || sum <= 0) {
    // 顶点在所有胶囊外：挂到骨盆，避免渲染时塌缩到原点
    skinIndex[offset] = 0;
    skinWeight[offset] = 1;
    return;
  }
  for (let slot = 0; slot < used; slot += 1) skinWeight[offset + slot] /= sum;
}
