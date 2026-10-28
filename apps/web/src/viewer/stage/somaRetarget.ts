import * as THREE from 'three';

/**
 * Mixamo / FBX 姿态 → SOMA 姿势的逆向重定向。
 *
 * 正向（SOMA → Mixamo）在 `tools/kimodo/to_mixamo.py` 里是：
 *     world_mixamo = somaGlobal ⊗ restWorld_mixamo
 * 其中 somaGlobal 是 SOMA 关节局部旋转链式累乘的结果（SOMA 静止姿态的局部旋转为单位）。
 *
 * 逆向变换就是同一条式子的反解：
 *     somaGlobal = world_mixamo ⊗ conj(restWorld_mixamo)
 *     somaLocal  = conj(somaGlobal[parent]) ⊗ somaGlobal
 *
 * 于是任意 FBX 片段都能在浏览器里被采样成一帧 f32（根位置 + 30 关节局部四元数），
 * 交给 conditioned shim 做真实 pose 约束——不必因为「FBX 没有现成的 f32」
 * 就退回纯文本 prompt，导致过渡段首尾对不上。
 */

/** SOMA 关节数（与 apps/api/src/services/soma-skeleton.ts 的骨架定义一致） */
export const SOMA_JOINT_COUNT = 30;

/** SOMA 关节的父索引（-1 表示根），顺序与 SOMA 骨架定义一致 */
export const SOMA_PARENTS: readonly number[] = [
  -1, 0, 1, 2, 3, 4, 5, 6, 6, 6, 3, 10, 11, 12, 13, 13,
  3, 16, 17, 18, 19, 19, 0, 22, 23, 24, 0, 26, 27, 28,
];

/**
 * SOMA 关节 → Mixamo 骨骼标签（已去掉 `mixamorig` 前缀并转小写）。
 *
 * 与 to_mixamo.py 的 SOMA_TO_MIXAMO 一一对应；Neck2 / Jaw / 眼球 / 指尖这些
 * SOMA 有、Mixamo 没有的关节不在表里，采样时按「局部旋转 = 单位」处理。
 */
export const SOMA_TO_MIXAMO_LABEL: ReadonlyMap<number, string> = new Map<number, string>([
  [0, 'hips'],
  [1, 'spine'],
  [2, 'spine1'],
  [3, 'spine2'],
  [4, 'neck'],
  [6, 'head'],
  [10, 'leftshoulder'],
  [11, 'leftarm'],
  [12, 'leftforearm'],
  [13, 'lefthand'],
  [16, 'rightshoulder'],
  [17, 'rightarm'],
  [18, 'rightforearm'],
  [19, 'righthand'],
  [22, 'leftupleg'],
  [23, 'leftleg'],
  [24, 'leftfoot'],
  [25, 'lefttoebase'],
  [26, 'rightupleg'],
  [27, 'rightleg'],
  [28, 'rightfoot'],
  [29, 'righttoebase'],
]);

/**
 * Kimodo 输出里根关节（髋）的标准高度，单位米。
 *
 * 实测 Kimodo 的 root_positions.f32 里髋部 y 稳定在 0.9656 附近；
 * FBX 角色身高各不相同，把髋高归一到这个值，能让约束和 SOMA 空间对齐，
 * 生成的过渡段不会出现整体抬高/下蹲。
 */
export const SOMA_HIPS_HEIGHT_M = 0.9656;

/**
 * 一帧采样好的 SOMA 姿势。
 *
 * 排布与 Kimodo 原始 f32 完全一致，可以直接写成约束文件：
 * - `root`：float32[3]，根（髋）位置，单位米，Y-up；
 * - `rotations`：float32[30*4]，30 个关节的局部四元数（相对 SOMA 静止姿态）。
 */
export interface SomaPoseSample {
  root: Float32Array;
  rotations: Float32Array;
}

/**
 * 把「关节相对静止姿态的世界增量」还原成 SOMA 局部旋转。
 *
 * @param globals 长度 30；`null` 表示该关节在 Mixamo 里没有对应骨骼，
 *                会退化成「局部旋转 = 单位」（等价于让父关节把姿态全部吸收）。
 */
export function somaLocalsFromGlobals(
  globals: readonly (THREE.Quaternion | null)[],
): Float32Array {
  const locals = new Float32Array(SOMA_JOINT_COUNT * 4);
  const resolved: THREE.Quaternion[] = [];
  const identity = new THREE.Quaternion();

  for (let index = 0; index < SOMA_JOINT_COUNT; index += 1) {
    const parent = SOMA_PARENTS[index] ?? -1;
    // 没有对应骨骼的关节：直接把父关节的增量顶上来，自身局部旋转即为单位
    const global = globals[index] ?? (parent >= 0 ? resolved[parent]! : identity);
    const parentGlobal = parent >= 0 ? resolved[parent]! : identity;
    const local = parentGlobal.clone().invert().multiply(global).normalize();
    local.toArray(locals, index * 4);
    resolved[index] = global;
  }

  return locals;
}

/** Float32Array → base64（小端字节序；Node 端 Float32Array/Buffer 默认同为小端） */
export function floatsToBase64(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  // 分块拼字符串，避免超大数组一次性展开导致调用栈溢出
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * 多帧采样结果 → 接口需要的 base64 载荷。
 *
 * 约束窗口按帧拼接：root 为 [N*3]，rot 为 [N*30*4]，
 * 帧顺序与舞台时间一致（prev 窗口末帧在最后，next 窗口首帧在最前）。
 */
export function somaPosesToBase64(samples: readonly SomaPoseSample[]): { root: string; rot: string } {
  if (samples.length === 0) throw new Error('somaPosesToBase64: empty samples');
  const count = samples.length;
  const root = new Float32Array(count * 3);
  const rot = new Float32Array(count * SOMA_JOINT_COUNT * 4);
  samples.forEach((sample, index) => {
    root.set(sample.root, index * 3);
    rot.set(sample.rotations, index * SOMA_JOINT_COUNT * 4);
  });
  return { root: floatsToBase64(root), rot: floatsToBase64(rot) };
}

