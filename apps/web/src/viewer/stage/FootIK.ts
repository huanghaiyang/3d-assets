import * as THREE from 'three';

/** 脚步补偿量（actor 运动组局部空间） */
export interface FootCompensation {
  x: number;
  z: number;
}

/** 一条腿的三节骨骼：大腿（髋→膝）、小腿（膝→踝）、脚（踝→末端） */
export interface LegChain {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  foot: THREE.Object3D;
}

const ZERO: FootCompensation = { x: 0, z: 0 };
/** 补偿上限（米），防止个别片段脚部数据异常时把角色整体拽飞 */
const MAX_DRIFT = 0.6;
const SMOOTHING = 0.5;

/**
 * 支撑脚锁定（第一步：漂移补偿）。
 *
 * 只在一个衔接的交叉窗口内生效：窗口刚打开时记录支撑脚（髋部以下、高度更低的那只）
 * 在角色摆放空间里的位置作为锚点，之后如果它发生水平漂移，就把反向位移加回角色运动组，
 * 让观感上脚"钉"在原地。同时把锚点暴露给第二步的两骨 IK 作为目标点。
 */
export class FootLock {
  private key: string | null = null;
  private side: 'left' | 'right' = 'left';
  /** 锚点在角色摆放空间（placement 局部）中的位置 */
  private readonly anchor = new THREE.Vector3();
  private readonly offset = new THREE.Vector2();
  private hasAnchor = false;

  /** 当前锁定的脚，供两骨 IK 选择腿链 */
  get lockedSide(): 'left' | 'right' {
    return this.side;
  }

  /** 锚点（角色摆放空间）。调用前先确认 hasTarget */
  get target(): THREE.Vector3 {
    return this.anchor;
  }

  get hasTarget(): boolean {
    return this.hasAnchor && this.key !== null;
  }

  update(
    key: string | null,
    feet: { left: THREE.Vector3 | null; right: THREE.Vector3 | null },
    base: { x: number; z: number },
  ): FootCompensation {
    if (!key || !feet.left || !feet.right) {
      this.reset();
      return ZERO;
    }

    if (key !== this.key) {
      this.key = key;
      this.side = feet.left.y <= feet.right.y ? 'left' : 'right';
      const anchor = this.side === 'left' ? feet.left : feet.right;
      this.anchor.set(anchor.x + base.x, anchor.y, anchor.z + base.z);
      this.offset.set(0, 0);
      this.hasAnchor = true;
      return ZERO;
    }

    const foot = this.side === 'left' ? feet.left : feet.right;
    // 摆放空间里的位置 = 根对齐偏移 + 片段内的脚部局部坐标
    const desiredX = THREE.MathUtils.clamp(this.anchor.x - (foot.x + base.x), -MAX_DRIFT, MAX_DRIFT);
    const desiredZ = THREE.MathUtils.clamp(this.anchor.z - (foot.z + base.z), -MAX_DRIFT, MAX_DRIFT);
    this.offset.x += (desiredX - this.offset.x) * SMOOTHING;
    this.offset.y += (desiredZ - this.offset.y) * SMOOTHING;
    return { x: this.offset.x, z: this.offset.y };
  }

  private reset(): void {
    this.key = null;
    this.hasAnchor = false;
    this.offset.set(0, 0);
  }
}

// ===== 第二步：解析两骨 IK =====

const H = new THREE.Vector3();
const K = new THREE.Vector3();
const A = new THREE.Vector3();
const DIR = new THREE.Vector3();
const BEND = new THREE.Vector3();
const NEW_K = new THREE.Vector3();
const WORK = new THREE.Vector3();
const Q_DELTA = new THREE.Quaternion();
const Q_WORLD = new THREE.Quaternion();
const Q_PARENT = new THREE.Quaternion();
const Q_FOOT = new THREE.Quaternion();

/**
 * 只对检测到的支撑脚做两骨 IK，把脚踝钉到目标点。
 *
 * 余弦定理求膝弯角 → 大腿先用 setFromUnitVectors 对齐 H→K' → 重新取小腿世界朝向
 * 对齐到目标 → 脚掌恢复窗口起点的世界朝向，避免脚腕被小腿带着翻起来。
 * 每个骨骼都用 slerp 按 strength 淡入，窗口边缘不会跳变。
 *
 * 必须在 `mixer.update(0)` + `updateMatrixWorld()` 之后调用，这一帧不能再 update mixer。
 */
export function solveTwoBoneIk(chain: LegChain, targetWorld: THREE.Vector3, strength: number): void {
  if (strength <= 0.001) return;
  const { upper, lower, foot } = chain;
  const upperParent = upper.parent;
  if (!upperParent) return;

  // 整棵子树刷新一次，保证 H/K/A 与四元数都是当前姿态
  upper.updateWorldMatrix(true, true);

  H.setFromMatrixPosition(upper.matrixWorld);
  K.setFromMatrixPosition(lower.matrixWorld);
  A.setFromMatrixPosition(foot.matrixWorld);
  const l1 = H.distanceTo(K);
  const l2 = K.distanceTo(A);
  if (l1 < 1e-4 || l2 < 1e-4) return;

  foot.getWorldQuaternion(Q_FOOT);

  WORK.copy(targetWorld).sub(H);
  const reach = THREE.MathUtils.clamp(WORK.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  if (reach < 1e-4) return;
  DIR.copy(WORK).normalize();

  // 膝盖弯曲方向沿用当前姿势：取 K 相对 H→目标 连线的垂直分量
  WORK.copy(K).sub(H);
  BEND.copy(WORK).addScaledVector(DIR, -WORK.dot(DIR));
  if (BEND.lengthSq() < 1e-8) return; // 腿完全伸直时无法确定弯曲平面，跳过
  BEND.normalize();

  const cosHip = THREE.MathUtils.clamp((l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach), -1, 1);
  const hipAngle = Math.acos(cosHip);
  NEW_K.copy(H).addScaledVector(DIR, l1 * Math.cos(hipAngle)).addScaledVector(BEND, l1 * Math.sin(hipAngle));

  // 1) 大腿：把 H→K 转到 H→K'
  WORK.copy(K).sub(H).normalize();
  Q_DELTA.setFromUnitVectors(WORK, NEW_K.sub(H).normalize());
  upper.getWorldQuaternion(Q_WORLD);
  Q_DELTA.multiply(Q_WORLD);
  upperParent.getWorldQuaternion(Q_PARENT).invert();
  Q_DELTA.premultiply(Q_PARENT);
  upper.quaternion.slerpQuaternions(upper.quaternion.clone(), Q_DELTA, strength);
  upper.updateMatrixWorld(true);

  // 2) 小腿：把膝→踝 转到 膝→目标
  lower.getWorldPosition(K);
  foot.getWorldPosition(A);
  WORK.copy(A).sub(K).normalize();
  Q_DELTA.setFromUnitVectors(WORK, targetWorld.clone().sub(K).normalize());
  lower.getWorldQuaternion(Q_WORLD);
  Q_DELTA.multiply(Q_WORLD);
  lower.parent?.getWorldQuaternion(Q_PARENT).invert();
  Q_DELTA.premultiply(Q_PARENT);
  lower.quaternion.slerpQuaternions(lower.quaternion.clone(), Q_DELTA, strength);
  lower.updateMatrixWorld(true);

  // 3) 脚掌：恢复窗口起点的世界朝向（只是部分淡入，避免扭转）
  if (foot.parent) {
    foot.parent.getWorldQuaternion(Q_PARENT).invert();
    Q_DELTA.copy(Q_PARENT).multiply(Q_FOOT);
    foot.quaternion.slerpQuaternions(foot.quaternion.clone(), Q_DELTA, strength);
  }
}
