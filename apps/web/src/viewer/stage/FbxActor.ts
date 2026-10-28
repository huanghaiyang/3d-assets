import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { cleanBoneLabel } from '../SkeletonOverlay';
import { buildBoneNameMap } from './clipFromAnimationData';
import {
  MixerActor,
  applyGhostSlots,
  buildGhostActions,
  rotateXZ,
  type ActorClipInput,
  type ActorGhost,
  type GhostActionPool,
  type GhostOptions,
} from './StageActor';
import type { LegChain } from './FootIK';
import {
  SOMA_HIPS_HEIGHT_M,
  SOMA_JOINT_COUNT,
  SOMA_TO_MIXAMO_LABEL,
  somaLocalsFromGlobals,
  type SomaPoseSample,
} from './somaRetarget';
import type { ResolvedSlot, SegmentPose, StageActorDef } from './StageTypes';

/** FBX 源文件加载后的共享缓存：克隆给各个角色实例，动画片段直接复用 */
export interface FbxSource {
  object: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

/**
 * Mixamo FBX 角色：带网格蒙皮，用 AnimationMixer 驱动。
 *
 * 归一化与 FbxPlayer 一致（缩放到约 2.4 高、水平居中、底面贴地），
 * 但归一化作用在模型容器自身，摆放位置永远写外层的 placement 组，
 * 避免移动角色时把归一化偏移一起改掉。
 */
export class FbxActor extends MixerActor {
  private bones: THREE.Bone[] = [];
  private hips: THREE.Object3D | null = null;
  private leftFoot: THREE.Object3D | null = null;
  private rightFoot: THREE.Object3D | null = null;
  private legChains: { left: LegChain | null; right: LegChain | null } = { left: null, right: null };
  private nameMap: Map<string, string> = new Map();
  /** SOMA 关节索引 → 对应骨骼在静止姿态下的片段空间朝向（重定向用） */
  private readonly somaRestQuats = new Map<number, THREE.Quaternion>();
  /** 片段空间位移（舞台单位）→ SOMA 米制的换算倍率，按静态髋高归一 */
  private somaMetersPerStage = 1;
  private loaded = false;

  constructor(def: StageActorDef) {
    super(def);
  }

  get ready(): boolean {
    return this.loaded;
  }

  protected get hipsNode(): THREE.Object3D | null {
    return this.hips;
  }

  protected get mixerRoot(): THREE.Object3D | null {
    return this.model;
  }

  protected footNodes(): [THREE.Object3D | null, THREE.Object3D | null] {
    return [this.leftFoot, this.rightFoot];
  }

  protected legChain(side: 'left' | 'right'): LegChain | null {
    return this.legChains[side];
  }

  /** 骨骼名别名表：Kimodo retarget JSON 里的关节名靠它对齐到真实骨骼 */
  get boneNameMap(): Map<string, string> {
    return this.nameMap;
  }

  /** 从共享的 FBX 源克隆一份模型并完成归一化 */
  install(source: FbxSource): void {
    const object = cloneSkeleton(source.object);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    });

    this.motion.add(object);
    this.model = object;

    const rawBox = new THREE.Box3().setFromObject(object);
    if (rawBox.isEmpty()) rawBox.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const rawSize = new THREE.Vector3();
    rawBox.getSize(rawSize);
    const maxDimension = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
    object.scale.setScalar(2.4 / maxDimension);
    object.updateMatrixWorld(true);

    const scaledBox = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    scaledBox.getCenter(center);
    object.position.set(-center.x, -scaledBox.min.y, -center.z);
    object.updateMatrixWorld(true);

    this.bones = [];
    object.traverse((child) => {
      const bone = child as THREE.Bone;
      if (!bone.isBone) return;
      this.bones.push(bone);
    });
    this.nameMap = buildBoneNameMap(this.bones);

    const byLabel = (label: string): THREE.Object3D | null =>
      this.bones.find((bone) => cleanBoneLabel(bone.name).toLowerCase() === label) ?? null;
    this.hips = byLabel('hips');
    this.leftFoot = byLabel('leftfoot');
    this.rightFoot = byLabel('rightfoot');
    this.legChains = {
      left: this.buildChain('leftupleg', 'leftleg', this.leftFoot),
      right: this.buildChain('rightupleg', 'rightleg', this.rightFoot),
    };

    this.mixer = new THREE.AnimationMixer(object);
    this.loaded = true;

    // 此时模型仍是 bind pose（还没播任何片段），正好用来记录重定向所需的静止朝向
    this.captureSomaRest();
  }

  /** SOMA 关节 → 该模型里对应骨骼；标签匹配忽略 mixamorig 前缀与大小写 */
  private findBone(label: string): THREE.Object3D | null {
    return this.bones.find((bone) => cleanBoneLabel(bone.name).toLowerCase() === label) ?? null;
  }

  /**
   * 记录 SOMA 各关节对应骨骼的静止朝向（片段空间）与髋高换算倍率。
   *
   * 片段空间 = 去掉 placement / 段偏移的舞台旋转后的空间，也就是动画轨道所在的坐标；
   * 采样姿态时用同样的空间做差，得到「相对静止姿态的世界增量」。
   */
  private captureSomaRest(): void {
    this.updateWorld();
    const motionQ = new THREE.Quaternion();
    this.motion.getWorldQuaternion(motionQ).invert();

    this.somaRestQuats.clear();
    for (const [index, label] of SOMA_TO_MIXAMO_LABEL) {
      const bone = this.findBone(label);
      if (!bone) continue;
      const quaternion = new THREE.Quaternion();
      bone.getWorldQuaternion(quaternion);
      quaternion.premultiply(motionQ);
      this.somaRestQuats.set(index, quaternion);
    }

    const hips = this.hips;
    if (hips) {
      const position = new THREE.Vector3();
      hips.getWorldPosition(position);
      this.motion.worldToLocal(position);
      // 把不同身高的 FBX 角色的髋高归一到 SOMA 标准，约束与 SOMA 空间才对得上
      this.somaMetersPerStage = SOMA_HIPS_HEIGHT_M / Math.max(0.001, Math.abs(position.y));
    }
  }

  /**
   * 把当前片段在 time 时刻的姿态重定向成一帧 SOMA 姿势。
   *
   * 骨骼换算沿用 to_mixamo.py 的逆变换（详见 somaRetarget.ts 顶部说明）：
   * 先求每根骨骼相对静止姿态的世界增量，再逐级反解出 SOMA 的局部旋转。
   */
  sampleSomaPose(clip: THREE.AnimationClip, time: number): SomaPoseSample | null {
    if (!this.model || this.somaRestQuats.size === 0) return null;

    return this.withClipSample(clip, time, () => {
      const motionQ = new THREE.Quaternion();
      this.motion.getWorldQuaternion(motionQ).invert();

      const globals: (THREE.Quaternion | null)[] = new Array(SOMA_JOINT_COUNT).fill(null);
      for (const [index, label] of SOMA_TO_MIXAMO_LABEL) {
        const rest = this.somaRestQuats.get(index);
        const bone = this.findBone(label);
        if (!rest || !bone) continue;
        const pose = new THREE.Quaternion();
        bone.getWorldQuaternion(pose);
        // 去掉舞台旋转 → 片段空间的世界朝向，再乘静止朝向的逆 → 相对静止的世界增量
        globals[index] = pose.premultiply(motionQ).multiply(rest.clone().invert()).normalize();
      }

      const root = new THREE.Vector3();
      const hips = this.hips;
      if (hips) {
        hips.getWorldPosition(root);
        this.motion.worldToLocal(root);
      }
      root.multiplyScalar(this.somaMetersPerStage);

      return {
        root: new Float32Array([root.x, root.y, root.z]),
        rotations: somaLocalsFromGlobals(globals),
      };
    });
  }

  /** Mixamo 的腿部链：*UpLeg → *Leg → *Foot */
  private buildChain(upperLabel: string, lowerLabel: string, foot: THREE.Object3D | null): LegChain | null {
    const find = (label: string): THREE.Object3D | null =>
      this.bones.find((bone) => cleanBoneLabel(bone.name).toLowerCase() === label) ?? null;
    const upper = find(upperLabel);
    const lower = find(lowerLabel);
    return upper && lower && foot ? { upper, lower, foot } : null;
  }

  /** 从 FBX 源里按名字找片段（FBXLoader 可能给重名片段加后缀） */
  static findClip(clips: readonly THREE.AnimationClip[], name: string): THREE.AnimationClip | null {
    const exact = clips.find((clip) => clip.name === name);
    if (exact) return exact;
    const loose = clips.find((clip) => clip.name.startsWith(name));
    return loose ?? null;
  }

  createGhost(inputs: readonly ActorClipInput[], options: GhostOptions): ActorGhost | null {
    if (!this.model || !this.hips) return null;
    return new FbxGhost(this.model, this.hips.name, inputs, options);
  }

  /** 骨骼连线：每根骨骼连到它的父节点（Mixamo 的包裹节点也在同一位置，视觉上等价） */
  boneSegments(): { parent: THREE.Object3D; child: THREE.Object3D }[] {
    const pairs: { parent: THREE.Object3D; child: THREE.Object3D }[] = [];
    for (const bone of this.bones) {
      if (bone.parent) pairs.push({ parent: bone.parent, child: bone });
    }
    return pairs;
  }

  /** FBX 克隆共享几何体与材质，释放会误伤其他角色，交给源缓存统一管理 */
  protected override disposeModel(): void {
    this.motion.remove(this.model as THREE.Object3D);
  }
}

/**
 * FBX 角色的洋葱皮残影：克隆一份蒙皮模型 + 独立 mixer。
 *
 * 与主角色共享几何体（不释放），但材质克隆成半透明，避免影响本体；
 * 残影不参与射线拾取，点击视口仍然只会选中本体。
 */
class FbxGhost implements ActorGhost {
  readonly root = new THREE.Group();

  private readonly clone: THREE.Object3D;
  private readonly hips: THREE.Object3D | null;
  private readonly mixer: THREE.AnimationMixer;
  private readonly pool: GhostActionPool;
  private readonly materials: THREE.Material[] = [];

  constructor(model: THREE.Object3D, hipsName: string, inputs: readonly ActorClipInput[], options: GhostOptions) {
    const clone = cloneSkeleton(model);
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      // 运动残影不参与拾取，避免挡住本体；起始帧残影需要可点击选中
      if (!options.pickable) mesh.raycast = () => {};
      const original = mesh.material;
      const list = Array.isArray(original) ? original : [original];
      const copies = options.color
        ? list.map(() => {
            const copy = new THREE.MeshBasicMaterial({
              color: options.color,
              transparent: true,
              opacity: options.opacity,
              depthWrite: false,
            });
            this.materials.push(copy);
            return copy;
          })
        : list.map((material) => {
            const copy = material.clone();
            copy.transparent = true;
            copy.opacity = options.opacity;
            copy.depthWrite = false;
            this.materials.push(copy);
            return copy;
          });
      mesh.material = Array.isArray(original) ? copies : copies[0] ?? original;
    });

    this.clone = clone;
    this.hips = clone.getObjectByName(hipsName) ?? null;
    this.root.add(clone);
    this.mixer = new THREE.AnimationMixer(clone);
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
    if (!this.hips) return false;
    this.hips.getWorldPosition(out);
    this.root.worldToLocal(out);
    return true;
  }

  updateWorld(): void {
    this.root.updateMatrixWorld(true);
  }

  updateVisuals(): void {
    // 网格自动跟随骨骼，无需手动刷新
  }

  dispose(): void {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.clone);
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.pool.actions.length = 0;
  }
}
