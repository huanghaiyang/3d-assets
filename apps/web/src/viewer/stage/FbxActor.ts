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
} from './StageActor';
import type { LegChain } from './FootIK';
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

  createGhost(inputs: readonly ActorClipInput[], opacity: number): ActorGhost | null {
    if (!this.model || !this.hips) return null;
    return new FbxGhost(this.model, this.hips.name, inputs, opacity);
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

  constructor(model: THREE.Object3D, hipsName: string, inputs: readonly ActorClipInput[], opacity: number) {
    const clone = cloneSkeleton(model);
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      const original = mesh.material;
      const list = Array.isArray(original) ? original : [original];
      const copies = list.map((material) => {
        const copy = material.clone();
        copy.transparent = true;
        copy.opacity = opacity;
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
