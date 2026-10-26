import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import { animationApi } from '@/api/animation';
import { kimodoApi, type SomaSkeleton } from '@/api/kimodo';
import type { AnimationData } from '../FbxPlayer';
import { FbxActor, type FbxSource } from './FbxActor';
import { FootLock } from './FootIK';
import { buildRootAlign, resolveRootOffset, type RootAlignPlan } from './RootAlign';
import { buildTimeline, resolveSegmentPose, resolveTimeline } from './SequenceTimeline';
import { SomaActor, somaClipFromMotion } from './SomaActor';
import { rotateXZ, type ActorClipInput, type ActorGhost, type StageActor } from './StageActor';
import {
  ZERO_SEGMENT_POSE,
  actorSegments,
  sourceKey,
  type ActorTransform,
  type SegmentDef,
  type SegmentPose,
  type StageActorDef,
  type StageDoc,
  type TimelinePlan,
} from './StageTypes';
import { clipsFromAnimationData } from './clipFromAnimationData';

export type GizmoMode = 'translate' | 'rotate';

export interface StageFrameState {
  time: number;
  duration: number;
  playing: boolean;
}

export interface StagePlacementEvent {
  id: string;
  transform: ActorTransform;
}

interface ActorRuntime {
  def: StageActorDef;
  actor: StageActor;
  plan: TimelinePlan;
  align: RootAlignPlan;
  clips: ActorClipInput[];
  poses: SegmentPose[];
  footLock: FootLock;
  ghosts: GhostEntry[];
  path: THREE.Group | null;
}

interface GhostEntry {
  ghost: ActorGhost;
  offset: number;
}

const EMPTY_PLAN: TimelinePlan = { timings: [], total: 0 };
const EMPTY_ALIGN: RootAlignPlan = { frames: [], starts: [] };

/** 洋葱皮：相对当前时刻的采样偏移与不透明度 */
const ONION_OFFSETS = [-0.3, -0.15, 0.15];
const ONION_OPACITY = [0.18, 0.26, 0.12];

/** 路径曲线：每段采样点数与分段的颜色循环 */
const PATH_SAMPLES = 36;
const PATH_COLORS = [0x60a5fa, 0xf472b6, 0x34d399, 0xfbbf24, 0xa78bfa, 0x22d3ee];

/** 舞台播放器：场景、多角色调度、手动权重驱动、根位移对齐与脚步锁定 */
export class StagePlayer {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly transform: TransformControls;
  private readonly selectionRing: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;
  private readonly clock = new THREE.Clock();

  private readonly runtimes = new Map<string, ActorRuntime>();
  private readonly fbxCache = new Map<string, Promise<FbxSource>>();
  private readonly clipCache = new Map<string, Promise<THREE.AnimationClip | null>>();
  private skeletonCache: Promise<SomaSkeleton | null> | null = null;

  private signature = '';
  private token = 0;
  private selectedId: string | null = null;
  private gizmoMode: GizmoMode | null = null;

  private time = 0;
  private durationValue = 0;
  private playing = false;
  private speed = 1;
  private loop = true;
  private onionSkin = false;
  private showPath = false;
  private lastEmit = 0;
  private disposed = false;
  private readonly ikTarget = new THREE.Vector3();

  private frameListeners: ((state: StageFrameState) => void)[] = [];
  private noticeListeners: ((message: string) => void)[] = [];
  private selectListeners: ((id: string | null) => void)[] = [];
  private placementListeners: ((event: StagePlacementEvent) => void)[] = [];

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(this.renderer.domElement);

    this.scene.background = null;
    this.scene.fog = new THREE.Fog(0x0b1220, 22, 46);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(5.2, 3.4, 7.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 1, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 30;

    const hemisphere = new THREE.HemisphereLight(0xbfd4ff, 0x1a2130, 1.6);
    this.scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(5, 9, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 32;
    key.shadow.camera.left = -9;
    key.shadow.camera.right = 9;
    key.shadow.camera.top = 9;
    key.shadow.camera.bottom = -9;
    key.shadow.bias = -0.0008;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x93c5fd, 0.9);
    rim.position.set(-6, 4, -5);
    this.scene.add(rim);

    const grid = new THREE.GridHelper(24, 24, 0x3f4d63, 0x232c3a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.7;
    this.scene.add(grid);

    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.ShadowMaterial({ opacity: 0.28 }),
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.receiveShadow = true;
    this.scene.add(shadowPlane);

    this.selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.4, 48),
      new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.85);
    this.transform.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = !(event as unknown as { value: boolean }).value;
    });
    this.transform.addEventListener('objectChange', () => this.emitPlacement());
    this.scene.add(this.transform.getHelper());

    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ===== 对外接口 =====

  onFrame(listener: (state: StageFrameState) => void): void {
    this.frameListeners.push(listener);
  }

  onNotice(listener: (message: string) => void): void {
    this.noticeListeners.push(listener);
  }

  onSelect(listener: (id: string | null) => void): void {
    this.selectListeners.push(listener);
  }

  onPlacement(listener: (event: StagePlacementEvent) => void): void {
    this.placementListeners.push(listener);
  }

  get duration(): number {
    return this.durationValue;
  }

  /** 列出某个 FBX 内嵌片段（供序列编辑器挑选） */
  async listClips(path: string): Promise<{ name: string; duration: number }[]> {
    const source = await this.loadFbx(path);
    return source.clips.map((clip) => ({ name: clip.name, duration: clip.duration }));
  }

  async setDoc(doc: StageDoc | null): Promise<void> {
    this.loop = doc?.loop ?? true;

    if (!doc) {
      this.clearActors();
      this.durationValue = 0;
      this.time = 0;
      this.emit(true);
      return;
    }

    const signature = JSON.stringify([
      doc.actors.map((actor) => [actor.id, actor.kind, actor.modelPath ?? '', actor.name]),
      doc.segments.map((segment) => [
        segment.id,
        segment.actorId,
        segment.source,
        segment.trimStart,
        segment.trimEnd,
        segment.blendIn,
        segment.pose ?? null,
      ]),
    ]);

    // 摆放与可见性直接生效，不需要重建 action
    for (const def of doc.actors) {
      const runtime = this.runtimes.get(def.id);
      if (!runtime) continue;
      runtime.def = def;
      runtime.actor.setPlacement(def.transform);
      runtime.actor.setVisible(def.visible !== false);
    }

    if (signature === this.signature) {
      this.apply(this.time);
      this.emit(true);
      return;
    }
    this.signature = signature;

    const token = (this.token += 1);
    await this.rebuild(doc, token);
  }

  setSelectedActor(id: string | null): void {
    this.selectedId = id;
    this.refreshExtras();
    this.apply(this.time);
    this.attachGizmo();
  }

  /** 洋葱皮开关：只为选中角色生成残影 */
  setOnionSkin(enabled: boolean): void {
    if (this.onionSkin === enabled) return;
    this.onionSkin = enabled;
    this.refreshExtras();
    this.apply(this.time);
  }

  /** 路径曲线开关：只为选中角色绘制整条时间线轨迹 */
  setShowPath(enabled: boolean): void {
    if (this.showPath === enabled) return;
    this.showPath = enabled;
    this.refreshExtras();
    this.apply(this.time);
  }

  setGizmoMode(mode: GizmoMode | null): void {
    this.gizmoMode = mode;
    this.attachGizmo();
  }

  play(): void {
    if (this.durationValue <= 0) return;
    this.playing = true;
    this.emit(true);
  }

  pause(): void {
    this.playing = false;
    this.emit(true);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    this.speed = Math.min(4, Math.max(0.1, speed));
  }

  seek(time: number): void {
    this.time = THREE.MathUtils.clamp(time, 0, this.durationValue);
    this.apply(this.time);
    this.emit(true);
  }

  resetCamera(): void {
    this.camera.position.set(5.2, 3.4, 7.2);
    this.controls.target.set(0, 1, 0);
    this.controls.update();
  }

  getActorTransform(id: string): ActorTransform | null {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    const { position, rotation } = runtime.actor.placement;
    return { x: position.x, z: position.z, yaw: rotation.y };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token += 1;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.transform.detach();
    this.transform.dispose();
    this.controls.dispose();
    this.clearActors();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ===== 文档装配 =====

  private clearActors(): void {
    for (const runtime of this.runtimes.values()) {
      this.disposeExtras(runtime);
      this.scene.remove(runtime.actor.placement);
      runtime.actor.dispose();
    }
    this.runtimes.clear();
    this.selectionRing.visible = false;
    this.transform.detach();
  }

  private async rebuild(doc: StageDoc, token: number): Promise<void> {
    const wanted = new Map(doc.actors.map((actor) => [actor.id, actor]));
    for (const [id, runtime] of this.runtimes) {
      if (wanted.has(id)) continue;
      if (this.selectedId === id) this.selectedId = null;
      this.disposeExtras(runtime);
      this.scene.remove(runtime.actor.placement);
      runtime.actor.dispose();
      this.runtimes.delete(id);
    }

    for (const def of doc.actors) {
      let runtime = this.runtimes.get(def.id);
      if (!runtime) {
        const actor = await this.createActor(def);
        if (token !== this.token) {
          actor?.dispose();
          return;
        }
        if (!actor) {
          this.notify(`角色「${def.name}」加载失败`);
          continue;
        }
        actor.setPlacement(def.transform);
        actor.setVisible(def.visible !== false);
        this.scene.add(actor.placement);
        runtime = {
          def,
          actor,
          plan: EMPTY_PLAN,
          align: EMPTY_ALIGN,
          clips: [],
          poses: [],
          footLock: new FootLock(),
          ghosts: [],
          path: null,
        };
        this.runtimes.set(def.id, runtime);
      }

      const segments = actorSegments(doc, def.id);
      const clips = await this.loadClips(runtime.actor, segments);
      if (token !== this.token) return;

      const plan = buildTimeline(segments);
      runtime.clips = clips;
      runtime.poses = segments.map((segment) => ({ ...(segment.pose ?? ZERO_SEGMENT_POSE) }));
      runtime.plan = plan;
      runtime.actor.buildSequence(clips);
      runtime.align = buildRootAlign(runtime.actor, plan, clips.map((input) => input.clip));
    }

    this.durationValue = Math.max(0, ...[...this.runtimes.values()].map((runtime) => runtime.plan.total));
    this.time = THREE.MathUtils.clamp(this.time, 0, this.durationValue);
    this.refreshExtras();
    this.attachGizmo();
    this.apply(this.time);
    this.emit(true);
  }

  private async createActor(def: StageActorDef): Promise<StageActor | null> {
    if (def.kind === 'soma') {
      const skeleton = await this.loadSkeleton();
      return skeleton ? new SomaActor(def, skeleton) : null;
    }
    if (!def.modelPath) return null;
    const source = await this.loadFbx(def.modelPath);
    const actor = new FbxActor(def);
    actor.install(source);
    return actor;
  }

  private loadFbx(path: string): Promise<FbxSource> {
    const cached = this.fbxCache.get(path);
    if (cached) return cached;
    const promise = new FBXLoader()
      .loadAsync(animationApi.fileUrl(path))
      .then((object) => ({ object, clips: object.animations }))
      .catch((error: unknown) => {
        this.fbxCache.delete(path);
        throw error;
      });
    this.fbxCache.set(path, promise);
    return promise;
  }

  private loadSkeleton(): Promise<SomaSkeleton | null> {
    if (!this.skeletonCache) {
      this.skeletonCache = kimodoApi.skeleton().catch(() => {
        this.skeletonCache = null;
        return null;
      });
    }
    return this.skeletonCache;
  }

  private async loadClips(actor: StageActor, segments: SegmentDef[]): Promise<ActorClipInput[]> {
    const inputs: ActorClipInput[] = [];
    for (const segment of segments) {
      const clip = await this.loadClip(actor, segment);
      if (!clip) {
        inputs.push({ clip: null, trimStart: 0, trimEnd: 0 });
        continue;
      }
      const trimStart = THREE.MathUtils.clamp(segment.trimStart, 0, clip.duration);
      const trimEnd = THREE.MathUtils.clamp(segment.trimEnd > trimStart ? segment.trimEnd : clip.duration, trimStart, clip.duration);
      inputs.push({ clip, trimStart, trimEnd });
    }
    return inputs;
  }

  private loadClip(actor: StageActor, segment: SegmentDef): Promise<THREE.AnimationClip | null> {
    const identity = segment.source.kind === 'fbx-clip'
      ? `${sourceKey(segment.source)}|${segment.source.fbxPath}`
      : `${sourceKey(segment.source)}|${actor.kind}|${actor.kind === 'fbx' ? (actor as FbxActor).boneNameMap.size : 0}`;
    const key = `${identity}|${actor.id}`;
    const cached = this.clipCache.get(key);
    if (cached) return cached;

    const promise = (async (): Promise<THREE.AnimationClip | null> => {
      const source = segment.source;
      if (source.kind === 'fbx-clip') {
        const fbx = await this.loadFbx(source.fbxPath);
        const clip = FbxActor.findClip(fbx.clips, source.clipName);
        if (!clip) this.notify(`片段「${source.clipName}」在 FBX 中不存在`);
        return clip;
      }

      if (source.kind === 'anim-project') {
        if (actor.kind !== 'fbx') {
          this.notify('「新建动画」里的动画只能用于 FBX 角色');
          return null;
        }
        const project = await animationApi.project(source.projectId);
        const converted = clipsFromAnimationData(project.data as AnimationData, (actor as FbxActor).boneNameMap);
        return converted.clips[0] ?? null;
      }

      if (actor.kind === 'soma') {
        const skeleton = await this.loadSkeleton();
        if (!skeleton) return null;
        const motion = await kimodoApi.motion(source.animationId);
        const clip = somaClipFromMotion(motion, skeleton, source.animationId);
        if (!clip) this.notify('Kimodo 动作数据不完整，无法播放');
        return clip;
      }

      const imported = await kimodoApi.importAnimation(source.animationId);
      const converted = clipsFromAnimationData(imported.data as AnimationData, (actor as FbxActor).boneNameMap);
      return converted.clips[0] ?? null;
    })().catch((error: unknown) => {
      this.clipCache.delete(key);
      this.notify(error instanceof Error ? error.message : '片段加载失败');
      return null;
    });

    this.clipCache.set(key, promise);
    return promise;
  }

  // ===== 每帧驱动 =====

  private tick(): void {
    const delta = this.clock.getDelta();
    if (this.playing && this.durationValue > 0) {
      this.time += delta * this.speed;
      if (this.time >= this.durationValue) {
        if (this.loop) this.time %= this.durationValue;
        else {
          this.time = this.durationValue;
          this.playing = false;
          this.emit(true);
        }
      }
      this.apply(this.time);
    }

    this.controls.update();
    this.updateSelectionRing();
    this.renderer.render(this.scene, this.camera);
    if (this.playing && performance.now() - this.lastEmit > 60) this.emit(false);
  }

  private apply(time: number): void {
    const hips = new THREE.Vector3();
    for (const runtime of this.runtimes.values()) {
      if (!runtime.actor.ready || runtime.plan.timings.length === 0) continue;
      const slots = resolveTimeline(runtime.plan, time);
      // 每段独立站位：交叉窗口内按 slot 权重混合，换段时平滑过去
      runtime.actor.setSegmentPose(resolveSegmentPose(runtime.poses, slots));
      runtime.actor.applySlots(slots);
      runtime.actor.updateWorld();

      if (!runtime.actor.currentHips(hips)) hips.set(0, 0, 0);
      const offset = resolveRootOffset(runtime.align, slots, { x: hips.x, z: hips.z });

      // 交叉窗口内锁定支撑脚，消除混合姿势带来的滑步
      const feet = runtime.actor.currentFeet();
      const windowKey = slots.length > 1 ? `${slots[0].index}:${slots[1].index}` : null;
      const compensation = runtime.footLock.update(windowKey, feet, offset);

      // 用 sin 曲线做淡入淡出：窗口两端补偿/IK 强度都为 0，避免边缘跳变
      let strength = 0;
      if (slots.length > 1) {
        const timing = runtime.plan.timings[slots[1].index];
        if (timing && timing.blend > 1e-4) {
          const progress = THREE.MathUtils.clamp((time - timing.start) / timing.blend, 0, 1);
          strength = Math.sin(Math.PI * progress);
        }
      }

      runtime.actor.setMotion(offset.x + compensation.x * strength, offset.z + compensation.z * strength);
      runtime.actor.updateWorld();

      // 第二步两骨 IK：必须在本帧 mixer.update(0) 与 updateMatrixWorld 之后写骨骼
      if (strength > 0.001 && runtime.footLock.hasTarget) {
        this.ikTarget.copy(runtime.footLock.target);
        runtime.actor.segmentPointToWorld(this.ikTarget);
        if (runtime.actor.solveLegIk(runtime.footLock.lockedSide, this.ikTarget, strength)) {
          runtime.actor.updateWorld();
        }
      }

      runtime.actor.syncVisuals();
      this.applyGhosts(runtime, time);
    }
  }

  /** 残影求值：按相邻时刻采样 slot，再写段偏移与根对齐偏移 */
  private applyGhosts(runtime: ActorRuntime, time: number): void {
    if (runtime.ghosts.length === 0 || runtime.plan.timings.length === 0) return;
    const hips = new THREE.Vector3();
    for (const entry of runtime.ghosts) {
      const sampleTime = THREE.MathUtils.clamp(time + entry.offset, 0, runtime.plan.total);
      const slots = resolveTimeline(runtime.plan, sampleTime);
      entry.ghost.applySlots(slots);
      entry.ghost.updateWorld();
      if (!entry.ghost.currentHips(hips)) hips.set(0, 0, 0);
      const offset = resolveRootOffset(runtime.align, slots, { x: hips.x, z: hips.z });
      entry.ghost.setFrame(resolveSegmentPose(runtime.poses, slots), offset.x, offset.z);
      entry.ghost.updateWorld();
      entry.ghost.updateVisuals();
    }
  }

  // ===== 残影与路径 =====

  private refreshExtras(): void {
    for (const runtime of this.runtimes.values()) {
      this.disposeExtras(runtime);
    }
    const runtime = this.selectedId ? this.runtimes.get(this.selectedId) : null;
    if (!runtime) return;
    if (this.onionSkin) this.buildGhosts(runtime);
    if (this.showPath) this.buildPath(runtime);
  }

  private buildGhosts(runtime: ActorRuntime): void {
    if (!runtime.actor.ready || runtime.plan.timings.length === 0) return;
    for (let index = 0; index < ONION_OFFSETS.length; index += 1) {
      const ghost = runtime.actor.createGhost(runtime.clips, ONION_OPACITY[index] ?? 0.15);
      if (!ghost) break;
      runtime.actor.placement.add(ghost.root);
      runtime.ghosts.push({ ghost, offset: ONION_OFFSETS[index] });
    }
  }

  /**
   * 整条时间线的根位移轨迹：逐段用一次性 mixer 采样髋部，
   * 再加上该段的段偏移与根对齐偏移，坐标写在 placement 局部空间，
   * 这样 gizmo 移动角色时路径会一起走。
   */
  private buildPath(runtime: ActorRuntime): void {
    if (!runtime.actor.ready || runtime.plan.timings.length === 0) return;
    const group = new THREE.Group();
    group.name = `path:${runtime.def.id}`;

    runtime.plan.timings.forEach((timing, index) => {
      const clip = runtime.clips[index]?.clip;
      if (!clip) return;
      const pose = runtime.poses[index] ?? ZERO_SEGMENT_POSE;
      const color = PATH_COLORS[index % PATH_COLORS.length] ?? 0x60a5fa;
      const points: THREE.Vector3[] = [];

      for (let sample = 0; sample < PATH_SAMPLES; sample += 1) {
        const local = (timing.length * sample) / Math.max(1, PATH_SAMPLES - 1);
        const hips = runtime.actor.sampleHips(clip, timing.trimStart + local);
        if (!hips) continue;
        const offset = resolveRootOffset(
          runtime.align,
          [{ index, clipTime: timing.trimStart + local, weight: 1 }],
          hips,
        );
        const rotated = rotateXZ(offset.x, offset.z, pose.yaw);
        points.push(new THREE.Vector3(pose.x + rotated.x, 0.02, pose.z + rotated.z));
      }
      if (points.length < 2) return;

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      );
      line.frustumCulled = false;
      group.add(line);

      // 每段起点画圆点，颜色与线段一致
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 12, 10),
        new THREE.MeshBasicMaterial({ color }),
      );
      marker.position.copy(points[0]);
      marker.position.y = 0.04;
      group.add(marker);
    });

    if (group.children.length === 0) return;
    runtime.path = group;
    runtime.actor.placement.add(group);
  }

  private disposeExtras(runtime: ActorRuntime): void {
    for (const entry of runtime.ghosts) entry.ghost.dispose();
    runtime.ghosts = [];
    if (runtime.path) {
      runtime.actor.placement.remove(runtime.path);
      runtime.path.traverse((child) => {
        const object = child as THREE.Mesh & THREE.Line;
        if (!object.isMesh && !object.isLine) return;
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material?.dispose();
      });
      runtime.path = null;
    }
  }

  private updateSelectionRing(): void {
    const runtime = this.selectedId ? this.runtimes.get(this.selectedId) : null;
    if (!runtime || runtime.def.visible === false) {
      this.selectionRing.visible = false;
      return;
    }
    const { placement } = runtime.actor;
    this.selectionRing.visible = true;
    this.selectionRing.position.set(placement.position.x, 0.01, placement.position.z);
  }

  private attachGizmo(): void {
    const runtime = this.selectedId ? this.runtimes.get(this.selectedId) : null;
    if (!runtime || !this.gizmoMode) {
      this.transform.detach();
      return;
    }
    const mode = this.gizmoMode;
    this.transform.setMode(mode);
    this.transform.setSpace(mode === 'rotate' ? 'local' : 'world');
    this.transform.showX = mode === 'translate';
    this.transform.showY = mode === 'rotate';
    this.transform.showZ = mode === 'translate';
    this.transform.attach(runtime.actor.placement);
  }

  private emitPlacement(): void {
    const runtime = this.selectedId ? this.runtimes.get(this.selectedId) : null;
    if (!runtime) return;
    const { position, rotation } = runtime.actor.placement;
    if (position.y !== 0) position.y = 0;
    for (const listener of this.placementListeners) {
      listener({ id: runtime.def.id, transform: { x: position.x, z: position.z, yaw: rotation.y } });
    }
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.transform.dragging) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const targets = [...this.runtimes.values()].map((runtime) => runtime.actor.placement);
    const hits = raycaster.intersectObjects(targets, true);
    if (hits.length === 0) {
      for (const listener of this.selectListeners) listener(null);
      return;
    }

    let node: THREE.Object3D | null = hits[0].object;
    while (node && !node.name.startsWith('actor:')) node = node.parent;
    const id = node?.name.slice('actor:'.length) ?? null;
    for (const listener of this.selectListeners) listener(id);
  };

  private notify(message: string): void {
    for (const listener of this.noticeListeners) listener(message);
  }

  private emit(force: boolean): void {
    if (!force && performance.now() - this.lastEmit < 60) return;
    this.lastEmit = performance.now();
    const state: StageFrameState = { time: this.time, duration: this.durationValue, playing: this.playing };
    for (const listener of this.frameListeners) listener(state);
  }

  private resize(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
