import * as THREE from 'three';
import {
  MixerActor,
  applyGhostSlots,
  buildGhostActions,
  disposeObject,
  rotateXZ,
  type ActorClipInput,
  type ActorGhost,
  type GhostActionPool,
  type GhostOptions,
} from './StageActor';
import type { LegChain } from './FootIK';
import type { ResolvedSlot, SegmentPose, StageActorDef } from './StageTypes';

export interface SomaSkeletonData {
  names: string[];
  parents: number[];
  offsets: [number, number, number][];
}

/** Kimodo 原始动作的播放帧率 */
export const SOMA_FPS = 30;

/** 与 FBX 角色的归一化身高对齐（Mixamo 角色归一化后约 2.4 单位高） */
const TARGET_HEIGHT = 2.4;

/**
 * 把 Kimodo 的原始 f32 动作转成 AnimationClip：
 * 30 条关节四元数轨 + 1 条髋部位置轨，直接喂给 AnimationMixer。
 */
export function somaClipFromMotion(
  motion: { root: Float32Array; rotations: Float32Array },
  skeleton: SomaSkeletonData,
  name: string,
): THREE.AnimationClip | null {
  const jointCount = skeleton.names.length;
  const frames = Math.floor(motion.root.length / 3);
  if (frames <= 0) return null;
  if (motion.rotations.length < frames * jointCount * 4) return null;

  const duration = frames / SOMA_FPS;
  // 逐帧显式写时间，避免只给两个关键帧时被线性插值压平成一段
  const times = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) times[frame] = frame / SOMA_FPS;

  const tracks: THREE.KeyframeTrack[] = [];
  for (let joint = 0; joint < jointCount; joint += 1) {
    const values = new Float32Array(frames * 4);
    for (let frame = 0; frame < frames; frame += 1) {
      const base = (frame * jointCount + joint) * 4;
      values[frame * 4] = motion.rotations[base];
      values[frame * 4 + 1] = motion.rotations[base + 1];
      values[frame * 4 + 2] = motion.rotations[base + 2];
      values[frame * 4 + 3] = motion.rotations[base + 3];
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${skeleton.names[joint]}.quaternion`, times, values));
  }

  const hips = new Float32Array(frames * 3);
  hips.set(motion.root.subarray(0, frames * 3));
  tracks.push(new THREE.VectorKeyframeTrack(`${skeleton.names[0]}.position`, times, hips));

  return new THREE.AnimationClip(name, duration, tracks);
}

// ===== 骨架与点线显示 =====

export interface SomaRig {
  group: THREE.Group;
  joints: THREE.Object3D[];
  parentIndices: number[];
  segmentJoints: number[];
}

export interface SomaOverlay {
  points: THREE.Points;
  lines: THREE.LineSegments;
}

/** 按骨架定义搭出关节树，并缩放到与 Mixamo 角色接近的身高 */
export function buildSomaRig(skeleton: SomaSkeletonData): SomaRig {
  const group = new THREE.Group();
  const joints = skeleton.names.map((name, index) => {
    const joint = new THREE.Object3D();
    joint.name = name;
    const offset = skeleton.offsets[index] ?? [0, 0, 0];
    joint.position.set(offset[0], offset[1], offset[2]);
    return joint;
  });

  const parentIndices = skeleton.parents.slice();
  skeleton.names.forEach((_, index) => {
    const parent = skeleton.parents[index] ?? -1;
    if (parent >= 0 && joints[parent]) joints[parent].add(joints[index]);
    else group.add(joints[index]);
  });

  // 静止姿态逐级累加 Y，得到脚底高度，用于把骨架抬到地面上
  let lowest = 0;
  const restY: number[] = [];
  skeleton.names.forEach((_, index) => {
    const parent = skeleton.parents[index] ?? -1;
    const y = (parent >= 0 ? restY[parent] ?? 0 : 0) + (skeleton.offsets[index]?.[1] ?? 0);
    restY[index] = y;
    lowest = Math.min(lowest, y);
  });

  const height = Math.max(0.5, Math.abs(lowest) + Math.max(...restY));
  const scale = TARGET_HEIGHT / height;
  group.scale.setScalar(scale);
  group.position.y = -lowest * scale;

  const segmentJoints = skeleton.names
    .map((_, index) => index)
    .filter((index) => (skeleton.parents[index] ?? -1) >= 0);

  return { group, joints, parentIndices, segmentJoints };
}

/**
 * 点线缓冲：本体 opacity=1，残影传小值做半透明。
 * 传 color 时线段用该标识色，圆点用同色偏白的混合色，保证每段起始帧残影可区分。
 */
export function createSomaOverlay(rig: SomaRig, opacity: number, color?: number): SomaOverlay {
  const transparent = opacity < 1;
  const lineColor = color ?? 0x7dd3fc;
  const pointColor = color === undefined
    ? 0xe2e8f0
    : new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45).getHex();

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rig.segmentJoints.length * 6), 3));
  const lines = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({ color: lineColor, transparent, opacity }),
  );
  lines.frustumCulled = false;

  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rig.joints.length * 3), 3));
  const points = new THREE.Points(
    pointGeometry,
    new THREE.PointsMaterial({ color: pointColor, size: 0.03, sizeAttenuation: true, transparent, opacity }),
  );
  points.frustumCulled = false;

  return { points, lines };
}

/** 把点线缓冲写到 space 的局部空间（骨架上的世界坐标反算） */
export function updateSomaBuffers(rig: SomaRig, overlay: SomaOverlay, space: THREE.Object3D): void {
  const pointArray = (overlay.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const lineArray = (overlay.lines.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const world = new THREE.Vector3();

  space.updateMatrixWorld(true);
  for (let index = 0; index < rig.joints.length; index += 1) {
    rig.joints[index].getWorldPosition(world);
    space.worldToLocal(world);
    pointArray[index * 3] = world.x;
    pointArray[index * 3 + 1] = world.y;
    pointArray[index * 3 + 2] = world.z;
  }

  let cursor = 0;
  for (const child of rig.segmentJoints) {
    const parentIndex = rig.parentIndices[child] ?? -1;
    const from = parentIndex >= 0 ? parentIndex : child;
    lineArray[cursor] = pointArray[from * 3];
    lineArray[cursor + 1] = pointArray[from * 3 + 1];
    lineArray[cursor + 2] = pointArray[from * 3 + 2];
    lineArray[cursor + 3] = pointArray[child * 3];
    lineArray[cursor + 4] = pointArray[child * 3 + 1];
    lineArray[cursor + 5] = pointArray[child * 3 + 2];
    cursor += 6;
  }

  (overlay.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (overlay.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
}

/**
 * Soma 骨架角色：点 + 线的轻量人形，只能播放 Kimodo 原生 30 关节动作。
 */
export class SomaActor extends MixerActor {
  private rigData: SomaRig | null = null;
  private overlay: SomaOverlay | null = null;
  private legChains: { left: LegChain | null; right: LegChain | null } = { left: null, right: null };
  private skeleton: SomaSkeletonData;
  private loaded = false;

  constructor(def: StageActorDef, skeleton: SomaSkeletonData) {
    super(def);
    this.skeleton = skeleton;
    this.install();
  }

  get ready(): boolean {
    return this.loaded;
  }

  protected get hipsNode(): THREE.Object3D | null {
    return this.rigData?.joints[0] ?? null;
  }

  protected get mixerRoot(): THREE.Object3D | null {
    return this.rigData?.group ?? null;
  }

  protected footNodes(): [THREE.Object3D | null, THREE.Object3D | null] {
    const byName = (name: string): THREE.Object3D | null =>
      this.rigData?.joints.find((joint) => joint.name === name) ?? null;
    return [byName('LeftFoot'), byName('RightFoot')];
  }

  protected legChain(side: 'left' | 'right'): LegChain | null {
    return this.legChains[side];
  }

  private install(): void {
    const rig = buildSomaRig(this.skeleton);
    const overlay = createSomaOverlay(rig, 1);

    this.motion.add(rig.group);
    // 线段与圆点用运动组局部坐标写入，因此挂在 motion 上而不是缩放过的小组上
    this.motion.add(overlay.lines);
    this.motion.add(overlay.points);

    this.rigData = rig;
    this.overlay = overlay;
    this.model = rig.group;
    this.legChains = {
      left: this.buildChain('LeftLeg', 'LeftShin', 'LeftFoot'),
      right: this.buildChain('RightLeg', 'RightShin', 'RightFoot'),
    };

    this.mixer = new THREE.AnimationMixer(rig.group);
    this.loaded = true;
    this.syncVisuals();
  }

  /** Soma 骨架的腿部链：LeftLeg → LeftShin → LeftFoot */
  private buildChain(upperName: string, lowerName: string, footName: string): LegChain | null {
    const find = (name: string): THREE.Object3D | null =>
      this.rigData?.joints.find((joint) => joint.name === name) ?? null;
    const upper = find(upperName);
    const lower = find(lowerName);
    const foot = find(footName);
    return upper && lower && foot ? { upper, lower, foot } : null;
  }

  syncVisuals(): void {
    if (!this.rigData || !this.overlay) return;
    updateSomaBuffers(this.rigData, this.overlay, this.motion);
  }

  createGhost(inputs: readonly ActorClipInput[], options: GhostOptions): ActorGhost | null {
    if (!this.rigData) return null;
    return new SomaGhost(this.skeleton, inputs, options);
  }

  protected override disposeModel(): void {
    if (this.rigData) {
      this.motion.remove(this.rigData.group);
      disposeObject(this.rigData.group);
      this.rigData = null;
    }
    if (this.overlay) {
      this.motion.remove(this.overlay.lines);
      this.motion.remove(this.overlay.points);
      disposeObject(this.overlay.lines);
      disposeObject(this.overlay.points);
      this.overlay = null;
    }
  }
}

/**
 * Soma 角色的洋葱皮残影：另一套关节树 + 独立的点线对象 + 独立 mixer。
 *
 * 残影的 root 直接挂在角色 placement 下，局部空间与本体一致，
 * 因此 setFrame 写段偏移与根对齐偏移后即可与本体对齐。
 */
class SomaGhost implements ActorGhost {
  readonly root = new THREE.Group();

  private readonly rig: SomaRig;
  private readonly overlay: SomaOverlay;
  private readonly mixer: THREE.AnimationMixer;
  private readonly pool: GhostActionPool;
  private readonly proxy: THREE.Mesh | null;

  constructor(skeleton: SomaSkeletonData, inputs: readonly ActorClipInput[], options: GhostOptions) {
    this.rig = buildSomaRig(skeleton);
    this.overlay = createSomaOverlay(this.rig, options.opacity, options.color);
    // 运动残影不参与拾取，避免细线/圆点挡住本体；起始帧残影需要可点击选中
    if (!options.pickable) {
      this.overlay.lines.raycast = () => {};
      this.overlay.points.raycast = () => {};
    }

    this.root.add(this.rig.group);
    this.root.add(this.overlay.lines);
    this.root.add(this.overlay.points);

    // 点线拾取不稳定，给起始帧残影加一个不可见的圆柱命中代理
    if (options.pickable) {
      const proxy = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 2.2, 12),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      proxy.position.y = 1.1;
      this.root.add(proxy);
      this.proxy = proxy;
    } else {
      this.proxy = null;
    }

    this.mixer = new THREE.AnimationMixer(this.rig.group);
    this.pool = buildGhostActions(this.mixer, inputs);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  applySlots(slots: readonly ResolvedSlot[]): void {
    applyGhostSlots(this.mixer, this.pool, slots);
  }

  setFrame(pose: SegmentPose, offsetX: number, offsetZ: number): void {
    const offset = rotateXZ(offsetX, offsetZ, pose.yaw);
    this.root.position.set(pose.x + offset.x, 0, pose.z + offset.z);
    this.root.rotation.y = pose.yaw;
  }

  currentHips(out: THREE.Vector3): boolean {
    const hips = this.rig.joints[0];
    if (!hips) return false;
    hips.getWorldPosition(out);
    this.root.worldToLocal(out);
    return true;
  }

  updateWorld(): void {
    this.root.updateMatrixWorld(true);
  }

  updateVisuals(): void {
    updateSomaBuffers(this.rig, this.overlay, this.root);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig.group);
    disposeObject(this.overlay.lines);
    disposeObject(this.overlay.points);
    if (this.proxy) disposeObject(this.proxy);
    this.pool.actions.length = 0;
  }
}
