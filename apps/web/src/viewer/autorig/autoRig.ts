import * as THREE from 'three';

/**
 * 人形模型自动绑骨（实验性）。
 *
 * 目标场景：3D 生成 / 上传的网格没有骨架，无法摆姿态或播动画。这里用「模板骨架
 * 拟合 + 胶囊距离蒙皮」的做法自动补一套 T-pose 骨架：
 *
 *  1. 先用几何法判断模型朝向（素材库里的生成模型普遍少一次 Y 轴旋转，正面朝向
 *     ±X 而不是 +Z），需要时先把它转正，再套模板；
 *  2. 以模型包围盒的高度 H 为基准，按人体比例摆放 19 根骨骼（假设模型是
 *     四肢水平伸展的 T-pose，面朝 +Z，脚底贴地）；
 *  3. 每根骨骼对应一到两条「胶囊」（骨骼段 + 半径），顶点权重 = 胶囊衰减
 *     `max(0, 1 - d/r)^2`，左右肢体互相抑制（异侧 ×0.05）防止手臂粘连到对侧；
 *  4. 每顶点取权重最高的 4 根骨骼，归一化后写入 skinIndex / skinWeight；
 *  5. 用 Bone 层级 + Skeleton 绑定出 SkinnedMesh，绑定姿态即模型当前姿态，
 *     因此绑骨完成后模型外观不变，之后可以摆姿势或导出 GLB。
 *
 * 已知限制（写入 UI 提示）：
 *  - 只适用于 T-pose（或接近 T-pose）的人形；A-pose / 非人形会绑错；
 *  - 手指、面部没有骨骼；权重没有网格测地线，仅为欧氏距离近似。
 */

/** 模板骨骼：关节位置以「模型高度 H」为 1 的比例给出，x/z 同理按 H 缩放 */
interface BoneDef {
  name: string;
  parent: string | null;
  joint: [number, number, number];
}

/** 蒙皮胶囊：a/b 为比例坐标，radius 为相对 H 的半径；side 用于左右互斥 */
interface CapsuleDef {
  bone: string;
  a: [number, number, number];
  b: [number, number, number];
  radius: number;
  side: 'left' | 'right' | 'center';
}

/**
 * 19 根骨骼。数组顺序必须是「父先子后」，后面按顺序设置局部位置时
 * 父骨骼的 matrixWorld 才是最新的。
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

/** 每根骨骼的蒙皮胶囊；一根骨骼可以有多条（骨盆 / 胸廓需要横向覆盖） */
const CAPSULE_DEFS: CapsuleDef[] = [
  // 骨盆：竖直主胶囊 + 横向一条覆盖腹股沟
  { bone: 'Hips', a: [0, 0.44, 0], b: [0, 0.56, 0], radius: 0.115, side: 'center' },
  { bone: 'Hips', a: [-0.09, 0.5, 0], b: [0.09, 0.5, 0], radius: 0.085, side: 'center' },
  { bone: 'Spine', a: [0, 0.56, 0], b: [0, 0.66, 0], radius: 0.1, side: 'center' },
  { bone: 'Chest', a: [0, 0.66, 0], b: [0, 0.82, 0], radius: 0.11, side: 'center' },
  // 胸廓横向条，避免肩膀根部漏给手臂
  { bone: 'Chest', a: [-0.1, 0.815, 0], b: [0.1, 0.815, 0], radius: 0.07, side: 'center' },
  { bone: 'Neck', a: [0, 0.8, 0], b: [0, 0.9, 0], radius: 0.05, side: 'center' },
  { bone: 'Head', a: [0, 0.88, 0], b: [0, 1.0, 0], radius: 0.085, side: 'center' },

  { bone: 'ShoulderL', a: [0.05, 0.815, 0], b: [0.16, 0.815, 0], radius: 0.055, side: 'left' },
  { bone: 'UpperArmL', a: [0.14, 0.815, 0], b: [0.3, 0.815, 0], radius: 0.055, side: 'left' },
  { bone: 'ForearmL', a: [0.3, 0.815, 0], b: [0.44, 0.815, 0], radius: 0.045, side: 'left' },
  { bone: 'HandL', a: [0.44, 0.815, 0], b: [0.5, 0.815, 0], radius: 0.05, side: 'left' },

  { bone: 'ShoulderR', a: [-0.05, 0.815, 0], b: [-0.16, 0.815, 0], radius: 0.055, side: 'right' },
  { bone: 'UpperArmR', a: [-0.14, 0.815, 0], b: [-0.3, 0.815, 0], radius: 0.055, side: 'right' },
  { bone: 'ForearmR', a: [-0.3, 0.815, 0], b: [-0.44, 0.815, 0], radius: 0.045, side: 'right' },
  { bone: 'HandR', a: [-0.44, 0.815, 0], b: [-0.5, 0.815, 0], radius: 0.05, side: 'right' },

  { bone: 'UpperLegL', a: [0.09, 0.5, 0], b: [0.095, 0.27, 0], radius: 0.085, side: 'left' },
  { bone: 'LowerLegL', a: [0.095, 0.27, 0], b: [0.095, 0.06, 0], radius: 0.06, side: 'left' },
  // 脚：从脚踝向前（+Z）伸出
  { bone: 'FootL', a: [0.095, 0.06, -0.02], b: [0.095, 0.02, 0.1], radius: 0.055, side: 'left' },

  { bone: 'UpperLegR', a: [-0.09, 0.5, 0], b: [-0.095, 0.27, 0], radius: 0.085, side: 'right' },
  { bone: 'LowerLegR', a: [-0.095, 0.27, 0], b: [-0.095, 0.06, 0], radius: 0.06, side: 'right' },
  { bone: 'FootR', a: [-0.095, 0.06, -0.02], b: [-0.095, 0.02, 0.1], radius: 0.055, side: 'right' },
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

export interface AutoRigResult {
  bones: number;
  skinnedMeshes: number;
  vertices: number;
  /** 朝向纠正结果；yaw 为 0 表示模型本来朝向就正确 */
  orientation: OrientationFix;
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
 *  1) 厚度轴 = 水平两轴里尺寸更小的那条。T-pose 人形两臂展方向的尺寸接近身高，
 *     前后厚度明显更小，据此先确认这是「站着的人形」，否则不动它；
 *  2) 取最低 5% 身高的一层顶点（脚），脚尖一定比脚跟伸得远 —— 朝前的那一侧，
 *     顶点离模型中线更远，由此定出正面在厚度轴的哪一侧；
 *  3) 正面目标方向是 +Z（glTF 约定，也是素材库里自带骨架模型的朝向）。
 *
 * 判定不可靠时一律返回 yaw 0（宁可不转，也不要把本来正确的模型转坏）。
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
  // 臂展要接近身高、厚度要明显更小，否则可能不是站立人形（树、道具、躺倒的模型）
  if (depth > height * 0.5 || span < height * 0.55 || span > height * 1.35) {
    return { yaw: 0, note: '' };
  }

  // 脚部薄层里，脚尖朝向的一侧会明显伸得更远
  const slabTop = box.min.y + height * FOOT_SLAB_RATIO;
  const reference = depthIsX ? center.x : center.z;
  const vertex = new THREE.Vector3();
  let min = Infinity;
  let max = -Infinity;
  let sampled = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position) continue;
    for (let i = 0; i < position.count; i += 1) {
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

  // ---- 用包围盒确定人体比例尺：H = 高度，脚底 y=0，中心 x/z 居中 ----
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const height = size.y;
  if (!Number.isFinite(height) || height <= 0) throw new Error('模型包围盒异常，无法绑骨');
  const baseY = box.min.y;

  const toWorld = (p: [number, number, number]): THREE.Vector3 =>
    new THREE.Vector3(center.x + p[0] * height, baseY + p[1] * height, center.z + p[2] * height);

  // ---- 骨骼世界坐标 ----
  const boneIndexByName = new Map<string, number>();
  BONE_DEFS.forEach((def, index) => boneIndexByName.set(def.name, index));
  const jointWorld = BONE_DEFS.map((def) => toWorld(def.joint));

  // ---- 蒙皮胶囊换算到世界坐标 ----
  const capsules: WorldCapsule[] = CAPSULE_DEFS.map((def) => {
    const a = toWorld(def.a);
    const b = toWorld(def.b);
    const radius = def.radius * height;
    return {
      boneIndex: boneIndexByName.get(def.bone)!,
      a,
      b,
      radius,
      radiusSq: radius * radius,
      side: def.side,
    };
  });
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
      computeWeights(vertex, capsules, abList, center.x, weights);
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
  };
}

function totalVerticesSafe(mesh: THREE.Mesh): number {
  const attribute = mesh.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  return attribute ? attribute.count : 0;
}

/** 计算一个顶点对所有骨骼的胶囊衰减权重（写入 out，长度为骨骼数） */
function computeWeights(
  vertex: THREE.Vector3,
  capsules: WorldCapsule[],
  abList: THREE.Vector3[],
  centerX: number,
  out: Float32Array,
): void {
  out.fill(0);
  for (let i = 0; i < capsules.length; i += 1) {
    const capsule = capsules[i]!;
    const distanceSq = pointSegmentDistanceSq(vertex, capsule.a, abList[i]!);
    if (distanceSq >= capsule.radiusSq) continue;
    const falloff = 1 - Math.sqrt(distanceSq) / capsule.radius;
    let weight = falloff * falloff;
    // 左右互斥：异侧顶点只保留 5%，防止手臂/大腿粘到对侧骨骼（中线为包围盒中心）
    if (capsule.side === 'left' && vertex.x < centerX) weight *= OPPOSITE_SIDE_FACTOR;
    else if (capsule.side === 'right' && vertex.x > centerX) weight *= OPPOSITE_SIDE_FACTOR;
    if (weight > out[capsule.boneIndex]!) out[capsule.boneIndex] = weight;
  }
}

/** 取权重最高的 4 根骨骼写入属性；全零（顶点在所有胶囊外）时挂到骨盆，避免塌缩到原点 */
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
