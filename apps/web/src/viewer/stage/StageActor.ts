import * as THREE from 'three';
import { solveTwoBoneIk, type LegChain } from './FootIK';
import type { ActorKind, ActorTransform, ResolvedSlot, SegmentPose, StageActorDef } from './StageTypes';

/** 一段已加载好的片段 + 裁剪区间（clip 为 null 表示该段素材加载失败） */
export interface ActorClipInput {
  clip: THREE.AnimationClip | null;
  trimStart: number;
  trimEnd: number;
  /** 该段的独立站位（相对角色摆放的偏移） */
  pose?: SegmentPose;
}

/** 残影外观选项：起始帧残影带标识色且可点击，运动残影保持中性 */
export interface GhostOptions {
  opacity: number;
  /** 标识色；不给则沿用模型原材质 */
  color?: number;
  /** 是否参与射线拾取（起始帧残影需要可点击） */
  pickable?: boolean;
}

/** 洋葱皮残影：独立的一副骨架/网格，可求值到任意时刻 */
export interface ActorGhost {
  /** 挂在 placement 下，局部空间即角色摆放空间 */
  readonly root: THREE.Object3D;
  setVisible(visible: boolean): void;
  /** 按 slot 写权重与时间并求值 */
  applySlots(slots: readonly ResolvedSlot[]): void;
  /** 写入该时刻的段偏移与根对齐偏移（角色摆放空间） */
  setFrame(pose: SegmentPose, offsetX: number, offsetZ: number): void;
  /** 髋部在当前根节点局部空间的位置 */
  currentHips(out: THREE.Vector3): boolean;
  updateWorld(): void;
  updateVisuals(): void;
  dispose(): void;
}

export interface HipsSample {
  /** 髋部在 actor 局部空间（不含摆放与根对齐偏移）的水平坐标 */
  x: number;
  z: number;
  /** 髋部相对 actor 局部的偏航角（弧度） */
  yaw: number;
}

export interface StageActor {
  readonly id: string;
  readonly kind: ActorKind;
  /** 用户摆放用的根节点（gizmo 直接作用于它） */
  readonly placement: THREE.Group;
  readonly ready: boolean;
  setPlacement(transform: ActorTransform): void;
  setVisible(visible: boolean): void;
  /** 按当前序列重建 action 池；片段变更后必须调用 */
  buildSequence(inputs: readonly ActorClipInput[]): void;
  /** 按解算出的 slot 写时间与权重，并强制求值一次骨骼 */
  applySlots(slots: readonly ResolvedSlot[]): void;
  /** 根对齐偏移（actor 局部空间），由 StagePlayer 每帧写入 */
  setMotion(x: number, z: number): void;
  /** 该时刻生效的段独立站位（相对角色摆放的偏移） */
  setSegmentPose(pose: SegmentPose): void;
  /** 把运动帧局部坐标（根对齐偏移所在空间）换算到世界坐标 */
  segmentPointToWorld(point: THREE.Vector3): THREE.Vector3;
  /** 创建洋葱皮残影；不支持的角色返回 null */
  createGhost(inputs: readonly ActorClipInput[], options: GhostOptions): ActorGhost | null;
  updateWorld(): void;
  /** 采样某个片段在指定时间（片段内秒）的髋部根变换 */
  sampleHips(clip: THREE.AnimationClip, time: number): HipsSample | null;
  /** 采样某个片段在指定时间双脚中点的水平位置（motion 局部空间） */
  sampleFeetCenter(clip: THREE.AnimationClip, time: number): { x: number; z: number } | null;
  /**
   * 动画轨道单位相对舞台单位的倍率：舞台位移 × 该值 = 轨道位移。
   *
   * 轨道写的是骨骼在模型局部空间的位移，还要乘上模型自身的缩放才是舞台单位：
   * Mixamo FBX 模型被归一化到 2.4 高（厘米骨架 → 约 0.0133），
   * Soma 骨架按身高缩放（约 1.4）。写回根轨前必须用它换算，否则位移会差几十倍。
   */
  readonly clipUnitScale: number;
  /** 当前髋部位置，写入 actor 局部坐标；没有髋部返回 false */
  currentHips(out: THREE.Vector3): boolean;
  /** 双脚脚踝位置（actor 局部），供脚步锁定使用 */
  currentFeet(): { left: THREE.Vector3 | null; right: THREE.Vector3 | null };
  /** 两骨腿部 IK（交叉窗口内使用），目标点为世界坐标；没有对应腿链返回 false */
  solveLegIk(side: 'left' | 'right', targetWorld: THREE.Vector3, strength: number): boolean;
  /** 骨架类角色的线/点缓冲刷新；FBX 角色为空实现 */
  syncVisuals(): void;
  /** 骨架连线用的骨骼对（父→子）；不支持骨骼渲染的角色返回空数组 */
  boneSegments(): { parent: THREE.Object3D; child: THREE.Object3D }[];
  dispose(): void;
}

/** 四元数 → 绕 Y 轴偏航角 */
export function yawFromQuaternion(quaternion: THREE.Quaternion): number {
  const { x, y, z, w } = quaternion;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

/** 绕 Y 轴旋转一个水平向量 */
export function rotateXZ(x: number, z: number, yaw: number): { x: number; z: number } {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return { x: x * cos + z * sin, z: -x * sin + z * cos };
}

const TIME_EPSILON = 1e-4;

export interface GhostActionPool {
  actions: Array<THREE.AnimationAction | null>;
  durations: number[];
}

/** 残影的 action 池：与主角色同一条约束（同一 clip 的每段都要 clone） */
export function buildGhostActions(
  mixer: THREE.AnimationMixer,
  inputs: readonly ActorClipInput[],
): GhostActionPool {
  const actions: Array<THREE.AnimationAction | null> = [];
  const durations: number[] = [];
  for (const input of inputs) {
    if (!input.clip) {
      actions.push(null);
      durations.push(0);
      continue;
    }
    const clip = input.clip.clone();
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();
    action.paused = true;
    action.setEffectiveWeight(0);
    action.enabled = false;
    actions.push(action);
    durations.push(Math.max(TIME_EPSILON * 2, Math.min(clip.duration, input.trimEnd)));
  }
  return { actions, durations };
}

/** 残影按 slot 写权重与时间并求值一次 */
export function applyGhostSlots(
  mixer: THREE.AnimationMixer,
  pool: GhostActionPool,
  slots: readonly ResolvedSlot[],
): void {
  const planned = new Map<number, ResolvedSlot>();
  for (const slot of slots) planned.set(slot.index, slot);
  for (let index = 0; index < pool.actions.length; index += 1) {
    const action = pool.actions[index];
    if (!action) continue;
    const slot = planned.get(index);
    if (!slot) {
      if (action.enabled) {
        action.enabled = false;
        action.setEffectiveWeight(0);
      }
      continue;
    }
    action.enabled = true;
    action.setEffectiveWeight(slot.weight);
    const duration = pool.durations[index] ?? action.getClip().duration;
    action.time = Math.min(Math.max(slot.clipTime, 0), Math.max(0, duration - TIME_EPSILON));
  }
  mixer.update(0);
}

/**
 * 用 AnimationMixer 驱动角色的公共实现。
 *
 * 关键约束（踩过的坑）：
 *  - 只用 `setEffectiveWeight` 手动写权重，绝不用 crossFadeTo / fadeIn / fadeOut：
 *    它们依赖 `mixer.time` 推进，而我们每帧只 `update(0)`，权重插值会永久卡死。
 *  - action 只建一次，`reset(); play(); setLoop(LoopRepeat, Infinity); paused = true`。
 *  - `paused` 只冻结 timeScale，不阻止写骨骼；`update(0)` 仍会求值并写入绑定。
 *  - 同一 clip 不能建两个不同 time 的 action（按 clip.uuid 缓存），所以每段都 clone 一份。
 */
export abstract class MixerActor implements StageActor {
  readonly id: string;
  readonly kind: ActorKind;
  readonly placement = new THREE.Group();
  /** 每段独立站位（段偏移）作用的分组，位于 placement 之下 */
  readonly segmentFrame = new THREE.Group();
  /** 根对齐 / 脚步补偿作用的运动组，位于 segmentFrame 之下 */
  readonly motion = new THREE.Group();

  protected model: THREE.Object3D | null = null;
  protected mixer: THREE.AnimationMixer | null = null;
  private actions: Array<THREE.AnimationAction | null> = [];
  private durations: number[] = [];

  constructor(def: StageActorDef) {
    this.id = def.id;
    this.kind = def.kind;
    this.placement.name = `actor:${def.id}`;
    this.segmentFrame.name = `pose:${def.id}`;
    this.motion.name = `motion:${def.id}`;
    this.placement.add(this.segmentFrame);
    this.segmentFrame.add(this.motion);
    this.setPlacement(def.transform);
    this.placement.visible = def.visible !== false;
  }

  abstract get ready(): boolean;

  /**
   * 轨道单位 → 舞台单位的换算倍率。
   * 骨骼位置轨的数值是「模型局部空间」的，渲染时还要乘 model.scale，
   * 所以 1 舞台单位 = 1/model.scale 个轨道单位。
   */
  get clipUnitScale(): number {
    const scale = this.model?.scale.x ?? 1;
    return scale > 1e-6 ? 1 / scale : 1;
  }

  protected abstract get hipsNode(): THREE.Object3D | null;

  protected abstract get mixerRoot(): THREE.Object3D | null;

  protected abstract footNodes(): [THREE.Object3D | null, THREE.Object3D | null];

  /** 两条腿的骨骼链；不支持两骨 IK 的角色返回 null */
  protected abstract legChain(side: 'left' | 'right'): LegChain | null;

  /** 目标点为世界坐标，求解后写骨骼；没有对应腿链返回 false */
  solveLegIk(side: 'left' | 'right', targetWorld: THREE.Vector3, strength: number): boolean {
    const chain = this.legChain(side);
    if (!chain) return false;
    solveTwoBoneIk(chain, targetWorld, strength);
    return true;
  }

  setPlacement(transform: ActorTransform): void {
    this.placement.position.set(transform.x, 0, transform.z);
    this.placement.rotation.y = transform.yaw;
    this.placement.updateMatrixWorld(true);
  }

  setMotion(x: number, z: number): void {
    this.motion.position.set(x, 0, z);
    this.motion.updateMatrixWorld(true);
  }

  setSegmentPose(pose: SegmentPose): void {
    this.segmentFrame.position.set(pose.x, 0, pose.z);
    this.segmentFrame.rotation.y = pose.yaw;
    this.segmentFrame.updateMatrixWorld(true);
  }

  segmentPointToWorld(point: THREE.Vector3): THREE.Vector3 {
    const frame = this.motion.parent ?? this.segmentFrame;
    return point.applyMatrix4(frame.matrixWorld);
  }

  createGhost(_inputs: readonly ActorClipInput[], _options: GhostOptions): ActorGhost | null {
    return null;
  }

  setVisible(visible: boolean): void {
    this.placement.visible = visible;
  }

  buildSequence(inputs: readonly ActorClipInput[]): void {
    const mixer = this.mixer;
    if (!mixer) return;

    for (const action of this.actions) {
      if (!action) continue;
      action.stop();
      mixer.uncacheClip(action.getClip());
    }
    this.actions = [];
    this.durations = [];

    for (const input of inputs) {
      if (!input.clip) {
        this.actions.push(null);
        this.durations.push(0);
        continue;
      }
      // 同一 clip 在序列里可能出现两次，必须各自 clone，否则 time 会互相覆盖
      const clip = input.clip.clone();
      const action = mixer.clipAction(clip);
      action.reset();
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.play();
      action.paused = true;
      action.setEffectiveWeight(0);
      action.enabled = false;
      this.actions.push(action);
      this.durations.push(Math.max(TIME_EPSILON * 2, Math.min(clip.duration, input.trimEnd)));
    }
  }

  applySlots(slots: readonly ResolvedSlot[]): void {
    const mixer = this.mixer;
    if (!mixer) return;

    const planned = new Map<number, ResolvedSlot>();
    for (const slot of slots) planned.set(slot.index, slot);

    for (let index = 0; index < this.actions.length; index += 1) {
      const action = this.actions[index];
      if (!action) continue;
      const slot = planned.get(index);
      if (!slot) {
        if (action.enabled) {
          action.enabled = false;
          action.setEffectiveWeight(0);
        }
        continue;
      }
      action.enabled = true;
      action.setEffectiveWeight(slot.weight);
      const duration = this.durations[index] ?? action.getClip().duration;
      action.time = Math.min(Math.max(slot.clipTime, 0), Math.max(0, duration - TIME_EPSILON));
    }

    // 手动权重驱动：只推进 0，求值并写回骨骼局部 TRS
    mixer.update(0);
  }

  updateWorld(): void {
    this.placement.updateMatrixWorld(true);
  }

  sampleHips(clip: THREE.AnimationClip, time: number): HipsSample | null {
    if (!this.mixerRoot || !this.hipsNode) return null;
    return this.withClipSample(clip, time, () => {
      const hips = this.hipsNode;
      if (!hips) return null;
      const position = new THREE.Vector3();
      hips.getWorldPosition(position);
      this.motion.worldToLocal(position);

      const worldQuaternion = new THREE.Quaternion();
      hips.getWorldQuaternion(worldQuaternion);
      const motionQuaternion = new THREE.Quaternion();
      this.motion.getWorldQuaternion(motionQuaternion).invert();
      worldQuaternion.premultiply(motionQuaternion);

      return { x: position.x, z: position.z, yaw: yawFromQuaternion(worldQuaternion) };
    });
  }

  /** 双脚脚踝中点在 motion 局部空间的水平位置；路径曲线用它作中心，避免用髋部左右摆动 */
  sampleFeetCenter(clip: THREE.AnimationClip, time: number): { x: number; z: number } | null {
    if (!this.mixerRoot) return null;
    return this.withClipSample(clip, time, () => {
      const [left, right] = this.footNodes();
      if (!left || !right) return null;
      const a = this.toLocal(left);
      const b = this.toLocal(right);
      return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    });
  }

  /** 用一次性 mixer 求值某个片段，避免污染正在播放的主 mixer 状态 */
  private withClipSample<T>(clip: THREE.AnimationClip, time: number, read: () => T | null): T | null {
    const root = this.mixerRoot;
    if (!root) return null;
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.reset();
    action.play();
    action.paused = true;
    action.setEffectiveWeight(1);
    action.time = Math.min(Math.max(time, 0), Math.max(0, clip.duration - TIME_EPSILON));
    mixer.update(0);
    this.updateWorld();

    const result = read();

    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    return result;
  }

  currentHips(out: THREE.Vector3): boolean {
    const hips = this.hipsNode;
    if (!hips) return false;
    hips.getWorldPosition(out);
    this.motion.worldToLocal(out);
    return true;
  }

  currentFeet(): { left: THREE.Vector3 | null; right: THREE.Vector3 | null } {
    const [left, right] = this.footNodes();
    return { left: left ? this.toLocal(left) : null, right: right ? this.toLocal(right) : null };
  }

  private toLocal(node: THREE.Object3D): THREE.Vector3 {
    const position = new THREE.Vector3();
    node.getWorldPosition(position);
    this.motion.worldToLocal(position);
    return position;
  }

  syncVisuals(): void {
    // FBX 角色由网格承载，不需要额外刷新
  }

  boneSegments(): { parent: THREE.Object3D; child: THREE.Object3D }[] {
    return [];
  }

  dispose(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
      this.mixer = null;
    }
    this.actions = [];
    this.durations = [];
    this.placement.removeFromParent();
    this.disposeModel();
    this.model = null;
  }

  /**
   * 释放模型资源。FBX 角色是 SkeletonUtils 克隆出来的，几何体与材质与源对象共享，
   * 释放会误伤其他同模型角色，因此 FbxActor 覆写为空实现。
   */
  protected disposeModel(): void {
    if (this.model) disposeObject(this.model);
  }
}

/** 释放几何体与材质，避免反复切换角色时显存泄漏 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh & THREE.Points & THREE.LineSegments;
    if (!mesh.isMesh && !mesh.isPoints && !mesh.isLineSegments) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material?.dispose();
  });
}
