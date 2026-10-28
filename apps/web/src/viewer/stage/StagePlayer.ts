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
import { SomaActor, somaClipFromMotion, SOMA_FPS } from './SomaActor';
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
import type { SomaPoseSample } from './somaRetarget';
import { segmentColorNumber } from './segmentColors';

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

/** 一段起始帧残影：常驻舞台、带段标识色、可点击拖动改该段站位 */
interface StartGhostEntry {
  ghost: ActorGhost;
  actorId: string;
  segmentId: string;
  index: number;
  /** 该段起始帧的根对齐偏移（段局部空间），拖动后反算 pose 用 */
  offsetX: number;
  offsetZ: number;
}

interface ActorRuntime {
  def: StageActorDef;
  actor: StageActor;
  plan: TimelinePlan;
  align: RootAlignPlan;
  clips: ActorClipInput[];
  poses: SegmentPose[];
  /** 与 plan.timings 同序的段 id */
  segmentIds: string[];
  /** 与 plan.timings 同序的段标识色（自定义色或按序号生成） */
  colors: number[];
  footLock: FootLock;
  /** 每段动画起始帧的洋葱皮残影（常驻，不随时间变化） */
  startGhosts: StartGhostEntry[];
  /** 每段动画结尾帧的洋葱皮残影（常驻，不随时间变化，与起始帧同色但不可拾取） */
  endGhosts: ActorGhost[];
  /** 运动过程残影：随播放时间前后偏移，不可拾取 */
  motionGhosts: ActorGhost[];
  path: THREE.Group | null;
}

const EMPTY_PLAN: TimelinePlan = { timings: [], total: 0 };
const EMPTY_ALIGN: RootAlignPlan = { frames: [], starts: [] };

/** 起始帧洋葱皮的不透明度 */
const START_GHOST_OPACITY = 0.42;

/** 运动残影：前后时间偏移（秒）与对应不透明度 */
const ONION_OFFSETS = [-0.3, -0.15, 0.15];
const ONION_OPACITY = [0.18, 0.26, 0.12];

/** 路径曲线：每段采样点数；每段起始帧残影与路径共用同一套分段色 */
const PATH_SAMPLES = 36;

/** 段间站位差超过该值即视为换位过渡 */
const TRAVEL_EPSILON = 0.05;

/** 交叉窗口内两段站位不同：正在走过去，不能锁脚，否则补偿会把位移抵消掉 */
function isTravelWindow(poses: readonly SegmentPose[], slots: readonly { index: number }[]): boolean {
  if (slots.length < 2) return false;
  const from = poses[slots[0].index] ?? ZERO_SEGMENT_POSE;
  const to = poses[slots[1].index] ?? ZERO_SEGMENT_POSE;
  return Math.hypot(to.x - from.x, to.z - from.z) > TRAVEL_EPSILON;
}

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
  /** 只在片段起点变化时更新：时间轴拖动不必重建 action / 残影 */
  private timingSignature = '';
  private token = 0;
  private selectedId: string | null = null;
  private gizmoMode: GizmoMode | null = null;
  /** 当前文档：过渡段根位移拉伸需要按前后段站位取目标位移 */
  private doc: StageDoc | null = null;
  /** 过渡动画生成期间冻结的段与角色 */
  private readonly lockedSegments = new Set<string>();
  private readonly lockedActors = new Set<string>();

  private time = 0;
  private durationValue = 0;
  private playing = false;
  private speed = 1;
  private loop = true;
  private onionSkin = false;
  /** 结尾帧残影开关：独立于运动残影，默认开启 */
  private showEndGhosts = false;
  private showPath = false;
  /** 在起始/结尾残影头顶标注动画序号 */
  private showNumbers = false;
  /** 渲染骨架连线 */
  private showSkeleton = false;
  /** 骨骼连线覆盖层：按角色 id 索引 */
  private readonly skeletonOverlays = new Map<
    string,
    { line: THREE.LineSegments; pairs: { parent: THREE.Object3D; child: THREE.Object3D }[] }
  >();
  private lastEmit = 0;
  private disposed = false;
  private readonly ikTarget = new THREE.Vector3();
  /** 骨骼连线采样用的临时点 */
  private readonly skeletonPoint = new THREE.Vector3();

  private frameListeners: ((state: StageFrameState) => void)[] = [];
  private noticeListeners: ((message: string) => void)[] = [];
  private selectListeners: ((id: string | null) => void)[] = [];
  private segmentListeners: ((actorId: string, segmentId: string) => void)[] = [];
  private poseListeners: ((segmentId: string, pose: SegmentPose) => void)[] = [];
  private placementListeners: ((event: StagePlacementEvent) => void)[] = [];

  /** 当前 gizmo 拖动的起始帧残影（为 null 时拖动角色摆放） */
  private poseTarget: StartGhostEntry | null = null;
  /** 左键按下位置：用于区分「点选」与「拖拽旋转视角」 */
  private pointerDownX = 0;
  private pointerDownY = 0;

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

    this.buildRuler();

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
      const dragging = (event as unknown as { value: boolean }).value;
      this.controls.enabled = !dragging;
      if (!dragging) this.commitPoseDrag();
    });
    this.transform.addEventListener('objectChange', () => {
      // 起始帧残影拖动只改残影根节点，拖拽结束才回写段站位
      if (!this.poseTarget) this.emitPlacement();
    });
    this.scene.add(this.transform.getHelper());

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
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

  /** 点中起始帧残影：选中该段（同时会选中所属角色） */
  onSelectSegment(listener: (actorId: string, segmentId: string) => void): void {
    this.segmentListeners.push(listener);
  }

  /** 拖动起始帧残影结束：回写该段站位 */
  onSegmentPose(listener: (segmentId: string, pose: SegmentPose) => void): void {
    this.poseListeners.push(listener);
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
    this.doc = doc;

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
        segment.pose ?? null,
        segment.transition ?? null,
        segment.color ?? null,
      ]),
    ]);
    // 起点只影响时序，不触发重建；单独比较即可低成本拖动时间轴
    const timingSignature = JSON.stringify(doc.segments.map((segment) => segment.start ?? null));

    // 摆放与可见性直接生效，不需要重建 action
    for (const def of doc.actors) {
      const runtime = this.runtimes.get(def.id);
      if (!runtime) continue;
      runtime.def = def;
      runtime.actor.setPlacement(def.transform);
      runtime.actor.setVisible(def.visible !== false);
    }

    if (signature === this.signature) {
      if (timingSignature !== this.timingSignature) {
        this.timingSignature = timingSignature;
        this.refreshTimings(doc);
      }
      this.apply(this.time);
      this.emit(true);
      return;
    }
    this.signature = signature;
    this.timingSignature = timingSignature;

    const token = (this.token += 1);
    await this.rebuild(doc, token);
  }

  /** 只重算每段时序与总时长（时间轴拖动/插入对齐后调用），不重建 action 与残影 */
  private refreshTimings(doc: StageDoc): void {
    for (const [id, runtime] of this.runtimes) {
      runtime.plan = buildTimeline(actorSegments(doc, id));
    }
    this.durationValue = Math.max(0, ...[...this.runtimes.values()].map((runtime) => runtime.plan.total));
    this.time = THREE.MathUtils.clamp(this.time, 0, this.durationValue);
  }

  setSelectedActor(id: string | null): void {
    this.selectedId = id;
    // 选中角色变化后不再拖动该角色的段残影
    if (this.poseTarget && this.poseTarget.actorId !== id) this.poseTarget = null;
    this.refreshPath();
    this.apply(this.time);
    this.attachGizmo();
  }

  /** 起始帧洋葱皮开关：为每个角色的每段动画各生成一个残影 */
  setOnionSkin(enabled: boolean): void {
    if (this.onionSkin === enabled) return;
    this.onionSkin = enabled;
    this.refreshGhosts();
    this.apply(this.time);
    // 残影销毁后 gizmo 可能挂在已移除的节点上，重新挂一次
    this.attachGizmo();
  }

  /** 结尾帧残影开关：重建残影，而不是只切 visible——关掉时要把已建好的移除，打开时要重新创建 */
  setShowEndGhosts(enabled: boolean): void {
    if (this.showEndGhosts === enabled) return;
    this.showEndGhosts = enabled;
    this.refreshGhosts();
  }

  /** 路径曲线开关：只为选中角色绘制整条时间线轨迹 */
  setShowPath(enabled: boolean): void {
    if (this.showPath === enabled) return;
    this.showPath = enabled;
    this.refreshPath();
    this.apply(this.time);
  }

  /** 残影头顶的动画序号开关：重建残影即可（标签挂在残影根节点上） */
  setShowNumbers(enabled: boolean): void {
    if (this.showNumbers === enabled) return;
    this.showNumbers = enabled;
    this.refreshGhosts();
    this.apply(this.time);
  }

  /** 骨骼连线开关：按当前角色建/销毁覆盖层 */
  setShowSkeleton(enabled: boolean): void {
    if (this.showSkeleton === enabled) return;
    this.showSkeleton = enabled;
    this.refreshSkeletons();
    this.apply(this.time);
  }

  /**
   * 某段片段自身根运动带来的实际水平位移（米，舞台单位）。
   * 按裁剪区间首尾各采样一次双脚中点，取两点直线距离。
   */
  measureTravel(actorId: string, segmentId: string): number | null {
    const runtime = this.runtimes.get(actorId);
    if (!runtime || !runtime.actor.ready) return null;
    const index = runtime.segmentIds.indexOf(segmentId);
    const timing = runtime.plan.timings[index];
    const clip = runtime.clips[index]?.clip;
    if (index < 0 || !timing || !clip) return null;
    const start = runtime.actor.sampleFeetCenter(clip, timing.trimStart);
    const end = runtime.actor.sampleFeetCenter(clip, timing.trimStart + timing.length);
    if (!start || !end) return null;
    return Math.hypot(end.x - start.x, end.z - start.z);
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

  /**
   * 冻结若干段与角色：过渡动画生成期间禁止拖动站位/角色摆放。
   * 段 id 对应起始帧残影的 gizmo，角色 id 对应角色摆放 gizmo。
   */
  setLocked(segmentIds: string[], actorIds: string[]): void {
    this.lockedSegments.clear();
    for (const id of segmentIds) this.lockedSegments.add(id);
    this.lockedActors.clear();
    for (const id of actorIds) this.lockedActors.add(id);
    if (this.poseTarget && this.lockedSegments.has(this.poseTarget.segmentId)) this.poseTarget = null;
    this.attachGizmo();
  }

  /**
   * 某段播放到尾部时角色所在的位置与朝向（相对角色摆放的段站位坐标）。
   * 过渡动画用它作为生成起点，保证新过渡段从上一段的落地位置开始。
   */
  segmentEndPose(actorId: string, segmentId: string): SegmentPose | null {
    const runtime = this.runtimes.get(actorId);
    if (!runtime || !runtime.actor.ready) return null;
    const index = runtime.segmentIds.indexOf(segmentId);
    const timing = runtime.plan.timings[index];
    const clip = runtime.clips[index]?.clip;
    if (index < 0 || !timing || !clip) return null;
    const pose = runtime.poses[index] ?? ZERO_SEGMENT_POSE;
    const start = runtime.actor.sampleFeetCenter(clip, timing.trimStart);
    const end = runtime.actor.sampleFeetCenter(clip, timing.trimStart + timing.length);
    if (!start || !end) return { ...pose };
    const delta = rotateXZ(end.x - start.x, end.z - start.z, pose.yaw);
    return { x: pose.x + delta.x, z: pose.z + delta.z, yaw: pose.yaw };
  }

  /**
   * 采样某一段边界处的 SOMA 姿势窗口（根位置 + 30 关节局部四元数）。
   *
   * `side='end'` 取该段最后 count 帧（末帧在最后，供 prev 约束），
   * `'start'` 取该段最前 count 帧（首帧在最前，供 next 约束）。
   * 多帧窗口让 Kimodo 看到真实的进入/退出速度与朝向，而不是只有一帧静态姿态；
   * 生成段交付时会把这 count 帧从首尾剪掉（见 stage.ts completeTransition）。
   */
  sampleSegmentBoundarySoma(
    actorId: string,
    segmentId: string,
    side: 'start' | 'end',
    count = 1,
  ): SomaPoseSample[] | null {
    const runtime = this.runtimes.get(actorId);
    if (!runtime || !runtime.actor.ready) return null;
    const index = runtime.segmentIds.indexOf(segmentId);
    const timing = runtime.plan.timings[index];
    const clip = runtime.clips[index]?.clip;
    if (index < 0 || !timing || !clip) return null;
    const start = timing.trimStart;
    const end = timing.trimStart + timing.length;
    const frames = Math.max(1, Math.round(count));
    const samples: SomaPoseSample[] = [];
    for (let offset = 0; offset < frames; offset += 1) {
      // end：从末帧往前取，保证最后一帧正好是段末；start：从首帧往后取
      const raw = side === 'end'
        ? end - (frames - 1 - offset) / SOMA_FPS
        : start + offset / SOMA_FPS;
      const time = Math.min(end, Math.max(start, raw));
      const sample = runtime.actor.sampleSomaPose(clip, time);
      if (!sample) return null;
      samples.push(sample);
    }
    return samples;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token += 1;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.transform.detach();
    this.transform.dispose();
    this.controls.dispose();
    this.clearActors();
    this.disposeSkeletonOverlays();
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
    this.disposeSkeletonOverlays();
    this.poseTarget = null;
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
          segmentIds: [],
          colors: [],
          footLock: new FootLock(),
          startGhosts: [],
          endGhosts: [],
          motionGhosts: [],
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
      runtime.segmentIds = segments.map((segment) => segment.id);
      // 颜色只跟序号与自定义色有关，重建时一起算好，残影/路径共用
      runtime.colors = segments.map((segment, index) => segmentColorNumber(index, segment.color));
      runtime.plan = plan;
      runtime.actor.buildSequence(clips);
      // pose 显式设置过 = 用户手动摆过该段站位，位置以 pose 为准，不再累加前序根位移
      runtime.align = buildRootAlign(
        runtime.actor,
        plan,
        clips.map((input) => input.clip),
        segments.map((segment) => segment.pose !== undefined),
      );
    }

    this.durationValue = Math.max(0, ...[...this.runtimes.values()].map((runtime) => runtime.plan.total));
    this.time = THREE.MathUtils.clamp(this.time, 0, this.durationValue);
    this.refreshSkeletons();
    this.refreshGhosts();
    this.refreshPath();
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
    const target = this.transitionTarget(segment);
    const yaw = segment.pose?.yaw ?? 0;
    const targetKey = target
      ? `|move:${target.dx.toFixed(3)}:${target.dz.toFixed(3)}:${yaw.toFixed(3)}`
      : '';
    const key = `${identity}|${actor.id}${targetKey}`;
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
        const clip = converted.clips[0] ?? null;
        if (clip && target) this.stretchRootMotion(clip, segment, target);
        return clip;
      }

      if (actor.kind === 'soma') {
        const skeleton = await this.loadSkeleton();
        if (!skeleton) return null;
        const motion = await kimodoApi.motion(source.animationId);
        const clip = somaClipFromMotion(motion, skeleton, source.animationId);
        if (!clip) this.notify('Kimodo 动作数据不完整，无法播放');
        else if (target) this.stretchRootMotion(clip, segment, target, actor.clipUnitScale);
        return clip;
      }

      const imported = await kimodoApi.importAnimation(source.animationId);
      const converted = clipsFromAnimationData(imported.data as AnimationData, (actor as FbxActor).boneNameMap);
      const clip = converted.clips[0] ?? null;
      // FBX 的根轨写的是厘米级模型局部坐标，必须按模型缩放换算成舞台单位
      if (clip && target) this.stretchRootMotion(clip, segment, target, actor.clipUnitScale);
      return clip;
    })().catch((error: unknown) => {
      this.clipCache.delete(key);
      this.notify(error instanceof Error ? error.message : '片段加载失败');
      return null;
    });

    this.clipCache.set(key, promise);
    return promise;
  }

  /** 过渡段的根位移目标：从过渡段站位到下一段站位的水平位移 */
  private transitionTarget(segment: SegmentDef): { dx: number; dz: number } | null {
    if (!segment.transition || !this.doc) return null;
    const next = this.doc.segments.find((item) => item.id === segment.transition!.nextId);
    if (!next) return null;
    const pose = segment.pose ?? ZERO_SEGMENT_POSE;
    const nextPose = next.pose ?? ZERO_SEGMENT_POSE;
    return { dx: nextPose.x - pose.x, dz: nextPose.z - pose.z };
  }

  /**
   * 把 Kimodo 生成过渡段的根位移缩放到「过渡段站位 → 下一段站位」的实际距离：
   * 保留原动作形态与节奏，只调整根节点的水平位移方向与长度，
   * 让过渡动画正好把角色送到下一段的起始位置。
   *
   * unitScale：舞台米 → clip 根轨单位 的换算倍率，取自 actor.clipUnitScale。
   *   Soma 骨架约 0.7（按身高放大 1.4 倍），Mixamo FBX 约 75（厘米骨架缩到 2.4 高）。
   *   少了这层换算，FBX 上的位移会被压缩几十倍，看起来就像原地踏步。
   */
  private stretchRootMotion(
    clip: THREE.AnimationClip,
    segment: SegmentDef,
    target: { dx: number; dz: number },
    unitScale = 1,
  ): void {
    if (target.dx * target.dx + target.dz * target.dz < 1e-6) return;
    const tracks = clip.tracks.filter((track) => track.name.endsWith('.position') && track.values.length >= 6);
    if (tracks.length === 0) return;
    const track = tracks.find((item) => /(hips|root)/i.test(item.name)) ?? tracks[0];
    const values = track.values;
    const size = track.getValueSize();
    const keys = Math.floor(values.length / size);
    if (keys < 2) return;

    const x0 = values[0];
    const z0 = values[2];

    // 在根轨上按时间线性取样（x/z），用于取「裁剪窗口」两端的实际位移。
    // 过渡段首尾各有一段锚点窗口会被 trimStart/trimEnd 剪掉，
    // 如果仍按整条轨道的首尾帧算，缩放后的可见位移就对不上舞台距离。
    const sampleAt = (time: number): { x: number; z: number } => {
      let lo = 0;
      let hi = keys - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((track.times[mid] ?? 0) <= time) lo = mid;
        else hi = mid;
      }
      const t0 = track.times[lo] ?? 0;
      const t1 = track.times[hi] ?? 0;
      const k = t1 - t0 > 1e-6 ? THREE.MathUtils.clamp((time - t0) / (t1 - t0), 0, 1) : 0;
      return {
        x: (values[lo * size] ?? 0) + ((values[hi * size] ?? 0) - (values[lo * size] ?? 0)) * k,
        z: (values[lo * size + 2] ?? 0) + ((values[hi * size + 2] ?? 0) - (values[lo * size + 2] ?? 0)) * k,
      };
    };
    const from = sampleAt(segment.trimStart);
    const to = sampleAt(segment.trimEnd);
    const clipDx = to.x - from.x;
    const clipDz = to.z - from.z;
    const clipLength = Math.hypot(clipDx, clipDz);

    // 目标位移转到片段局部空间，并换成 clip 自身的长度单位
    const pose = segment.pose ?? ZERO_SEGMENT_POSE;
    const local = rotateXZ(target.dx * unitScale, target.dz * unitScale, -pose.yaw);
    const targetLength = Math.hypot(local.x, local.z);
    if (clipLength < 1e-3 || targetLength < 1e-3) return;

    const turn = Math.atan2(local.x, local.z) - Math.atan2(clipDx, clipDz);
    const scale = targetLength / clipLength;
    for (let index = 0; index < keys; index += 1) {
      const offset = index * size;
      const moved = rotateXZ((values[offset] - x0) * scale, (values[offset + 2] - z0) * scale, turn);
      values[offset] = x0 + moved.x;
      values[offset + 2] = z0 + moved.z;
    }
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
    for (const runtime of this.runtimes.values()) {
      if (!runtime.actor.ready || runtime.plan.timings.length === 0) continue;
      const slots = resolveTimeline(runtime.plan, time);
      // 每段独立站位：交叉窗口内按 slot 权重混合，换段时平滑过去
      runtime.actor.setSegmentPose(resolveSegmentPose(runtime.poses, slots));
      runtime.actor.applySlots(slots);
      runtime.actor.updateWorld();

      const offset = resolveRootOffset(runtime.align, slots);

      // 交叉窗口内锁定支撑脚，消除混合姿势带来的滑步；
      // 但两段站位不同时是在走过去，锁脚会抵消位移，此时放开
      const feet = runtime.actor.currentFeet();
      const travelling = isTravelWindow(runtime.poses, slots);
      const windowKey = slots.length > 1 && !travelling ? `${slots[0].index}:${slots[1].index}` : null;
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
      this.updateSkeletonOverlay(runtime);
      this.applyMotionGhosts(runtime, time);
    }
  }

  // ===== 起始帧洋葱皮与路径 =====

  /** 残影只跟文档结构走，切换选中角色不必重建 */
  private refreshGhosts(): void {
    for (const runtime of this.runtimes.values()) {
      this.disposeGhosts(runtime);
      // 结尾帧残影有自己的开关，必须先于 onionSkin 的判断构建
      this.buildEndGhosts(runtime);
      if (!this.onionSkin) continue;
      this.buildStartGhosts(runtime);
      this.buildMotionGhosts(runtime);
    }
    this.remapPoseTarget();
  }

  /**
   * 路径只画在选中角色上。每次都先彻底释放旧路径再重建：
   * 否则站点/站位一变，旧位置的曲线会残留在场景里。
   */
  private refreshPath(): void {
    for (const item of this.runtimes.values()) this.disposePath(item);
    const runtime = this.selectedId ? this.runtimes.get(this.selectedId) : null;
    if (runtime && this.showPath) this.buildPath(runtime);
  }

  /**
   * 每段动画的起始帧残影：常驻在舞台上，不随播放时间变化。
   *
   * 取该段自身的第一帧（trimStart）按其段站位摆放，并叠加根位移对齐偏移，
   * 这样一眼就能看出每段从哪个位置、哪个朝向开始。每段用不同的标识色，
   * 且可被点击选中后拖动改该段站位。只为每个角色的每段各建一个。
   */
  private buildStartGhosts(runtime: ActorRuntime): void {
    if (!runtime.actor.ready || runtime.plan.timings.length === 0) return;
    runtime.plan.timings.forEach((timing, index) => {
      const slots = [{ index, clipTime: timing.trimStart, weight: 1 }];
      const color = runtime.colors[index] ?? 0x60a5fa;
      const ghost = runtime.actor.createGhost(runtime.clips, {
        opacity: START_GHOST_OPACITY,
        color,
        pickable: true,
      });
      if (!ghost) return;
      ghost.applySlots(slots);
      ghost.updateWorld();
      const offset = resolveRootOffset(runtime.align, slots);
      ghost.setFrame(runtime.poses[index] ?? ZERO_SEGMENT_POSE, offset.x, offset.z);
      ghost.updateWorld();
      ghost.updateVisuals();
      this.addGhostLabel(ghost, index, color);
      // 残影根节点打标记，射线命中后往上找即可知道是哪一段
      ghost.root.name = 'segmentghost';
      ghost.root.userData.segment = { actorId: runtime.def.id, segmentId: runtime.segmentIds[index] ?? '' };
      runtime.actor.placement.add(ghost.root);
      runtime.startGhosts.push({
        ghost,
        actorId: runtime.def.id,
        segmentId: runtime.segmentIds[index] ?? '',
        index,
        offsetX: offset.x,
        offsetZ: offset.z,
      });
    });
  }

  /**
   * 每段动画的结尾帧残影：常驻展示该段「走完时的样子」，颜色与起始帧残影一致。
   *
   * 独立于 startGhosts / motionGhosts 构建，因为它有自己的开关（showEndGhosts），
   * 不能被运动残影的 onionSkin 开关挡住——否则 onionSkin 关闭时这些残影从未被创建，
   * 再点开关也只会切一个不存在的对象的 visible，表现为「点了没反应」。
   * 不可拾取，避免和起始帧残影的拖拽改站位冲突。
   */
  private buildEndGhosts(runtime: ActorRuntime): void {
    if (!this.showEndGhosts) return;
    if (!runtime.actor.ready || runtime.plan.timings.length === 0) return;
    runtime.plan.timings.forEach((timing, index) => {
      const color = runtime.colors[index] ?? 0x60a5fa;
      // 取该段最后一帧，按段站位 + 根对齐偏移摆放，位置即该段结束时刻的真实位置
      const slots = [{ index, clipTime: timing.trimStart + timing.length, weight: 1 }];
      const ghost = runtime.actor.createGhost(runtime.clips, {
        opacity: START_GHOST_OPACITY,
        color,
        pickable: false,
      });
      if (!ghost) return;
      ghost.applySlots(slots);
      ghost.updateWorld();
      const offset = resolveRootOffset(runtime.align, slots);
      ghost.setFrame(runtime.poses[index] ?? ZERO_SEGMENT_POSE, offset.x, offset.z);
      ghost.updateWorld();
      ghost.updateVisuals();
      this.addGhostLabel(ghost, index, color);
      runtime.actor.placement.add(ghost.root);
      runtime.endGhosts.push(ghost);
    });
  }

  /** 运动过程残影：前后偏移几帧的残影，随播放时间在 apply 里逐帧求值 */
  private buildMotionGhosts(runtime: ActorRuntime): void {
    if (!runtime.actor.ready || runtime.plan.timings.length === 0) return;
    ONION_OFFSETS.forEach((_, slot) => {
      const ghost = runtime.actor.createGhost(runtime.clips, { opacity: ONION_OPACITY[slot] ?? 0.18 });
      if (!ghost) return;
      ghost.setVisible(false);
      runtime.actor.placement.add(ghost.root);
      runtime.motionGhosts.push(ghost);
    });
  }

  /** 把每个运动残影求值到 time + 偏移 的时刻；越界时隐藏 */
  private applyMotionGhosts(runtime: ActorRuntime, time: number): void {
    if (runtime.motionGhosts.length === 0) return;
    ONION_OFFSETS.forEach((delta, slot) => {
      const ghost = runtime.motionGhosts[slot];
      if (!ghost) return;
      const sampleTime = time + delta;
      if (sampleTime < 0 || sampleTime > runtime.plan.total) {
        ghost.setVisible(false);
        return;
      }
      const slots = resolveTimeline(runtime.plan, sampleTime);
      if (slots.length === 0) {
        ghost.setVisible(false);
        return;
      }
      const pose = resolveSegmentPose(runtime.poses, slots);
      ghost.applySlots(slots);
      ghost.updateWorld();
      const offset = resolveRootOffset(runtime.align, slots);
      ghost.setFrame(pose, offset.x, offset.z);
      ghost.updateWorld();
      ghost.updateVisuals();
      ghost.setVisible(true);
    });
  }

  /**
   * 地面标尺：沿 X / Z 两条轴线铺 1m 刻度线 + 每 2m 一个距离数字。
   *
   * 只贴着两条轴线铺，是因为场景里已有 24×24 的均匀网格，再往四个方向撒数字
   * 会和网格线糊成一片；5m 处刻度加长，方便快速数出大距离。
   * X / Z 用不同颜色区分，看一眼就知道位移是横向还是纵深方向。
   */
  private buildRuler(): void {
    const half = 12; // 与 GridHelper 的 24 单位对齐
    const ticks: number[] = [];

    for (let distance = -half; distance <= half; distance += 1) {
      if (distance === 0) continue;
      // 5m 处刻度加长，起视觉分档作用
      const length = distance % 5 === 0 ? 0.3 : 0.14;
      // 沿 X 轴排布：刻度垂直于 X 轴，落在 Z 方向上
      ticks.push(distance, 0, -length, distance, 0, length);
      // 沿 Z 轴排布：刻度垂直于 Z 轴，落在 X 方向上
      ticks.push(-length, 0, distance, length, 0, distance);
    }

    const tickGeometry = new THREE.BufferGeometry();
    tickGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ticks, 3));
    const tickLines = new THREE.LineSegments(
      tickGeometry,
      new THREE.LineBasicMaterial({ color: 0x7c8ea8, transparent: true, opacity: 0.9 }),
    );
    this.scene.add(tickLines);

    const labels = new THREE.Group();
    // Sprite 是以中心为锚点的，贴片高 0.4、半高 0.2。若把中心放在地面(y≈0)，
    // 下半截就会沉到地板下面被裁掉；抬到半高以上才能整块浮在地面之上。
    const labelY = 0.26;
    for (let distance = -half; distance <= half; distance += 2) {
      if (distance === 0) {
        // 原点只标一次，避免两条轴的 0 重叠
        const origin = this.makeRulerLabel('0', 0xd8e2f0);
        origin.position.set(-0.62, labelY, -0.62);
        labels.add(origin);
        continue;
      }
      // X 轴数字（偏蓝）摆在轴线一侧，避免压在网格线上
      const xLabel = this.makeRulerLabel(`${distance}m`, 0x8fb4ff);
      xLabel.position.set(distance, labelY, -0.62);
      labels.add(xLabel);
      // Z 轴数字（偏绿）
      const zLabel = this.makeRulerLabel(`${distance}m`, 0x8ee0c0);
      zLabel.position.set(-0.62, labelY, distance);
      labels.add(zLabel);
    }
    this.scene.add(labels);
  }

  /** 用 canvas 画一个距离数字贴片，避免引入字体资源；Sprite 始终朝向相机 */
  private makeRulerLabel(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = 'bold 40px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 先描深色外轮廓，保证在浅色地板上也读得清
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(8, 12, 18, 0.85)';
      ctx.strokeText(text, 64, 34);
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.fillText(text, 64, 34);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    sprite.scale.set(0.8, 0.4, 1);
    return sprite;
  }

  /**
   * 整条时间线的根位移轨迹：逐段用一次性 mixer 采样双脚中点，
   * 以该段起始帧的脚底正中为基准，叠加该段的根对齐偏移与段站位，
   * 让曲线始终贴着角色的脚底走，坐标写在 placement 局部空间。
   */
  private buildPath(runtime: ActorRuntime): void {
    if (!runtime.actor.ready || runtime.plan.timings.length === 0) return;
    const group = new THREE.Group();
    group.name = `path:${runtime.def.id}`;

    runtime.plan.timings.forEach((timing, index) => {
      const clip = runtime.clips[index]?.clip;
      if (!clip) return;
      const pose = runtime.poses[index] ?? ZERO_SEGMENT_POSE;
      const color = runtime.colors[index] ?? 0x60a5fa;
      // 该段起始帧的脚底正中：后面所有采样都相对它取增量，路径起点正好落在段站位上
      const start = runtime.actor.sampleFeetCenter(clip, timing.trimStart);
      if (!start) return;
      const frame = runtime.align.frames[index] ?? { x: 0, z: 0 };
      const points: THREE.Vector3[] = [];

      for (let sample = 0; sample < PATH_SAMPLES; sample += 1) {
        const local = (timing.length * sample) / Math.max(1, PATH_SAMPLES - 1);
        const center = runtime.actor.sampleFeetCenter(clip, timing.trimStart + local);
        if (!center) continue;
        const rotated = rotateXZ(frame.x + center.x - start.x, frame.z + center.z - start.z, pose.yaw);
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

  private disposeGhosts(runtime: ActorRuntime): void {
    for (const entry of runtime.startGhosts) {
      this.disposeGhostLabel(entry.ghost.root);
      entry.ghost.dispose();
    }
    runtime.startGhosts = [];
    for (const ghost of runtime.endGhosts) {
      this.disposeGhostLabel(ghost.root);
      ghost.dispose();
    }
    runtime.endGhosts = [];
    for (const ghost of runtime.motionGhosts) ghost.dispose();
    runtime.motionGhosts = [];
  }

  /** 残影根节点上的序号贴片是 Sprite，材质/贴图需要单独释放 */
  private disposeGhostLabel(root: THREE.Object3D): void {
    root.traverse((child) => {
      const sprite = child as THREE.Sprite;
      if (!sprite.isSprite) return;
      sprite.material.map?.dispose();
      sprite.material.dispose();
    });
  }

  /** 在残影头顶挂一个动画序号贴片（显示编号开关打开时） */
  private addGhostLabel(ghost: ActorGhost, index: number, color: number): void {
    if (!this.showNumbers) return;
    const sprite = this.makeGhostLabel(String(index + 1), color);
    // 角色被归一化到约 2.4 高，抬到头顶上方一点，避免和头发穿插
    sprite.position.set(0, 2.62, 0);
    ghost.root.add(sprite);
  }

  private makeGhostLabel(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const hex = `#${color.toString(16).padStart(6, '0')}`;
      ctx.beginPath();
      ctx.arc(48, 48, 34, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(9, 13, 20, 0.84)';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = hex;
      ctx.stroke();
      ctx.font = 'bold 46px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hex;
      ctx.fillText(text, 48, 50);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    sprite.scale.set(0.46, 0.46, 1);
    sprite.renderOrder = 6;
    return sprite;
  }

  /** 骨骼连线覆盖层：按当前角色重建（开关切换/角色重建时调用） */
  private refreshSkeletons(): void {
    this.disposeSkeletonOverlays();
    if (!this.showSkeleton) return;
    for (const [id, runtime] of this.runtimes) {
      if (!runtime.actor.ready) continue;
      const pairs = runtime.actor.boneSegments();
      if (pairs.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
      const line = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.9, depthTest: false }),
      );
      line.frustumCulled = false;
      line.renderOrder = 4;
      this.scene.add(line);
      this.skeletonOverlays.set(id, { line, pairs });
    }
  }

  private disposeSkeletonOverlays(): void {
    for (const { line } of this.skeletonOverlays.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.skeletonOverlays.clear();
  }

  /** 每帧把骨骼世界坐标写进连线缓冲（覆盖层挂在场景里，直接用世界坐标即可） */
  private updateSkeletonOverlay(runtime: ActorRuntime): void {
    const overlay = this.skeletonOverlays.get(runtime.def.id);
    if (!overlay) return;
    overlay.line.visible = runtime.def.visible !== false;
    if (!overlay.line.visible) return;
    const attribute = overlay.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    overlay.pairs.forEach((pair, index) => {
      pair.parent.getWorldPosition(this.skeletonPoint);
      attribute.setXYZ(index * 2, this.skeletonPoint.x, this.skeletonPoint.y, this.skeletonPoint.z);
      pair.child.getWorldPosition(this.skeletonPoint);
      attribute.setXYZ(index * 2 + 1, this.skeletonPoint.x, this.skeletonPoint.y, this.skeletonPoint.z);
    });
    attribute.needsUpdate = true;
  }

  /** 重建残影后把 gizmo 目标换到新的残影上；找不到则退回角色摆放 */
  private remapPoseTarget(): void {
    if (!this.poseTarget) return;
    const { actorId, segmentId } = this.poseTarget;
    this.poseTarget = this.findStartGhost(actorId, segmentId);
  }

  private findStartGhost(actorId: string, segmentId: string): StartGhostEntry | null {
    for (const entry of this.runtimes.get(actorId)?.startGhosts ?? []) {
      if (entry.segmentId === segmentId) return entry;
    }
    return null;
  }

  private disposePath(runtime: ActorRuntime): void {
    if (!runtime.path) return;
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

  private disposeExtras(runtime: ActorRuntime): void {
    this.disposeGhosts(runtime);
    this.disposePath(runtime);
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
    if (!this.gizmoMode) {
      this.transform.detach();
      return;
    }
    // 过渡动画生成期间：被冻结的段/角色不挂句柄，避免拖出与生成结果冲突的位置
    if (this.poseTarget && this.lockedSegments.has(this.poseTarget.segmentId)) {
      this.transform.detach();
      return;
    }
    if (!this.poseTarget && this.selectedId && this.lockedActors.has(this.selectedId)) {
      this.transform.detach();
      return;
    }
    const mode = this.gizmoMode;
    this.transform.setMode(mode);
    this.transform.setSpace(mode === 'rotate' ? 'local' : 'world');
    this.transform.showX = mode === 'translate';
    this.transform.showY = mode === 'rotate';
    this.transform.showZ = mode === 'translate';
    // 选中了起始帧残影时拖动它改该段站位，否则拖动角色摆放
    const target = this.poseTarget?.ghost.root
      ?? (this.selectedId ? this.runtimes.get(this.selectedId)?.actor.placement : null)
      ?? null;
    if (target) this.transform.attach(target);
    else this.transform.detach();
  }

  /** 拖动起始帧残影结束：把残影根节点位置反算成该段站位并回写 */
  private commitPoseDrag(): void {
    const entry = this.poseTarget;
    if (!entry) return;
    if (this.lockedSegments.has(entry.segmentId)) return;
    const runtime = this.runtimes.get(entry.actorId);
    if (!runtime) return;
    const root = entry.ghost.root;
    const world = new THREE.Vector3();
    root.getWorldPosition(world);
    const local = runtime.actor.placement.worldToLocal(world);
    const yaw = Math.atan2(Math.sin(root.rotation.y), Math.cos(root.rotation.y));
    // 残影根节点 = 段站位 + 绕朝向旋转后的根对齐偏移
    const offset = rotateXZ(entry.offsetX, entry.offsetZ, yaw);
    const round = (value: number): number => Number(value.toFixed(3));
    const pose: SegmentPose = { x: round(local.x - offset.x), z: round(local.z - offset.z), yaw: round(yaw) };
    for (const listener of this.poseListeners) listener(entry.segmentId, pose);
  }

  private emitPlacement(): void {
    const runtime = this.selectedId ? this.runtimes.get(this.selectedId) : null;
    if (!runtime) return;
    if (this.lockedActors.has(runtime.def.id)) {
      // 冻结期间被拖动的角色立刻回到文档里的摆放
      runtime.actor.setPlacement(runtime.def.transform);
      runtime.actor.updateWorld();
      return;
    }
    const { position, rotation } = runtime.actor.placement;
    if (position.y !== 0) position.y = 0;
    for (const listener of this.placementListeners) {
      listener({ id: runtime.def.id, transform: { x: position.x, z: position.z, yaw: rotation.y } });
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.transform.dragging) return;
    // 拖动左键旋转/平移视角后抬起：只结束相机操作，不改变角色、残影或洋葱皮的选中状态
    const moved = Math.hypot(event.clientX - this.pointerDownX, event.clientY - this.pointerDownY);
    if (moved > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);

    // 优先命中起始帧残影（可点击选中该段站位）
    const ghostTargets = [...this.runtimes.values()].flatMap((runtime) =>
      runtime.startGhosts.map((entry) => entry.ghost.root),
    );
    const ghostHits = raycaster.intersectObjects(ghostTargets, true);
    if (ghostHits.length > 0 && this.selectStartGhost(ghostHits[0].object)) return;

    const targets = [...this.runtimes.values()].map((runtime) => runtime.actor.placement);
    const hits = raycaster.intersectObjects(targets, true);
    if (hits.length === 0) {
      this.poseTarget = null;
      this.attachGizmo();
      for (const listener of this.selectListeners) listener(null);
      return;
    }

    let node: THREE.Object3D | null = hits[0].object;
    while (node && !node.name.startsWith('actor:')) node = node.parent;
    const id = node?.name.slice('actor:'.length) ?? null;
    if (id !== this.selectedId) {
      this.poseTarget = null;
      this.attachGizmo();
    }
    for (const listener of this.selectListeners) listener(id);
  };

  /**
   * 右侧面板选中某段：定位到该段的起始帧残影并激活 gizmo。
   * 洋葱皮关闭时没有残影，退回选中所属角色。
   */
  selectSegment(segmentId: string): void {
    for (const runtime of this.runtimes.values()) {
      const entry = runtime.startGhosts.find((item) => item.segmentId === segmentId);
      if (entry) {
        this.activateStartGhost(entry);
        return;
      }
      if (!runtime.segmentIds.includes(segmentId)) continue;
      this.poseTarget = null;
      this.selectedId = runtime.def.id;
      this.refreshPath();
      this.attachGizmo();
      for (const listener of this.selectListeners) listener(runtime.def.id);
      for (const listener of this.segmentListeners) listener(runtime.def.id, segmentId);
      return;
    }
  }

  /** 选中一段起始帧残影：同时选中角色、重建路径、把 gizmo 挂到残影上 */
  private activateStartGhost(entry: StartGhostEntry): void {
    this.poseTarget = entry;
    this.selectedId = entry.actorId;
    this.refreshPath();
    for (const listener of this.selectListeners) listener(entry.actorId);
    for (const listener of this.segmentListeners) listener(entry.actorId, entry.segmentId);
    this.attachGizmo();
  }

  /** 由射线命中的下层对象向上找起始帧残影；命中则选中该段并把 gizmo 挂到残影上 */
  private selectStartGhost(object: THREE.Object3D): boolean {
    let node: THREE.Object3D | null = object;
    while (node && node.name !== 'segmentghost') node = node.parent;
    if (!node) return false;
    const data = node.userData.segment as { actorId: string; segmentId: string } | undefined;
    if (!data?.segmentId) return false;
    const entry = this.findStartGhost(data.actorId, data.segmentId);
    if (!entry) return false;
    this.activateStartGhost(entry);
    return true;
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
