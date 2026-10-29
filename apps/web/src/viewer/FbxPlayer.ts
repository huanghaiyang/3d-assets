import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import {
  SkeletonOverlay,
  cleanBoneLabel,
  filterShadowBones,
  type BoneDisplayMode,
  type BoneNode,
  type FlatBone,
} from './SkeletonOverlay';

export interface ClipInfo {
  name: string;
  duration: number;
  tracks: number;
}

export interface ModelStats {
  meshes: number;
  /** 参与形变的骨骼数（FBX 里的同名包装节点不计入） */
  bones: number;
  /** 场景里的骨骼对象总数，含包装节点 */
  boneNodes: number;
  triangles: number;
  vertices: number;
  materials: number;
  skinned: boolean;
}

export interface LoadResult {
  clips: ClipInfo[];
  stats: ModelStats;
}

/** 导出的动画数据来源（只记录识别信息，不含绝对路径） */
export interface AnimationDataSource {
  name: string;
  /** 相对所属文件夹的路径 */
  relative?: string;
  size?: number;
  mtime?: number;
}

/** 关节（骨骼）层级与绑定姿态；只描述动画所需的变换，不含网格/蒙皮 */
export interface AnimationJointData {
  name: string;
  label: string;
  parent: string | null;
  depth: number;
  rest: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  };
}

/** 单条动画轨迹：一个关节的一个属性（position / quaternion / scale …） */
export interface AnimationTrackData {
  name: string;
  /** 轨迹对应的关节名；无法匹配骨骼时为 null */
  joint: string | null;
  property: string;
  valueType: string;
  valueSize: number;
  keyframes: number;
  timeRange: [number, number];
  /** 等间隔采样间隔（秒）；关键帧不足或间隔不均匀时为 null */
  interval: number | null;
  interpolation: string;
  /** 关键帧时间（秒），includeKeyframes=false 时省略 */
  times?: number[];
  /** 关键帧数值，includeKeyframes=false 时省略 */
  values?: number[];
}

export interface AnimationClipData {
  name: string;
  duration: number;
  /** 从关键帧间隔推断的采样帧率 */
  fps: number | null;
  /** 采样间隔（秒），用于计算时间线 */
  interval: number | null;
  keyframes: number;
  tracks: AnimationTrackData[];
}

/** 模型动画数据：关节 + 轨迹 + 时间线，明确不含蒙皮网格数据 */
export interface AnimationData {
  format: 'fbx-animation-data';
  version: 1;
  generatedAt: string;
  source: AnimationDataSource;
  skeleton: {
    jointCount: number;
    joints: AnimationJointData[];
  };
  timeline: {
    clipCount: number;
    /** 所有片段时长之和（秒） */
    totalDuration: number;
    /** 最长片段时长（秒） */
    longestDuration: number;
    /** 全模型动画采样帧率（由关键帧间隔推断） */
    fps: number | null;
    /** 采样间隔（秒） */
    interval: number | null;
  };
  clips: AnimationClipData[];
  /** 明确声明没有导出的模型数据类别 */
  excluded: string[];
}

export interface AnimationDataOptions {
  /** 是否写出每个关键帧的时间与数值（默认 true） */
  includeKeyframes?: boolean;
  /** 数值保留的小数位（默认 6） */
  precision?: number;
}

export interface PlaybackState {
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
}

/** 模态变换（G/R/S）的实时状态，用于界面提示，类似 Blender 的操作头 */
export interface ModalTransformState {
  kind: TransformMode;
  /** 轴向约束；null 表示自由 */
  axis: 'X' | 'Y' | 'Z' | null;
  /** 平面约束（Shift + 轴） */
  plane: boolean;
  /** 用户正在输入的数字 */
  numeric: string;
  /** 当前量：位移距离 / 角度（度）/ 缩放系数 */
  amount: number;
}

/** 场景节点树的一个节点（对象层级，不含骨骼以外的特殊语义） */
import { NodeHighlighter, type SceneNode } from './sceneNodes';
import { AxisIndicator } from './axisIndicator';
import { buildBoneNameMap, clipsFromAnimationData } from './stage/clipFromAnimationData';

export type { SceneNode };

export interface FbxPlayerOptions {
  /** 是否在右下角显示 XYZ 轴向指示器（离屏封面 / 缩略图渲染会关掉） */
  axisIndicator?: boolean;
  /** 轴向指示器距底边的距离（动画页底部有播放控制条，需要抬高到它上方） */
  axisIndicatorBottom?: number;
}

interface ModalTransform {  kind: TransformMode;
  bone: THREE.Bone;
  startPosition: THREE.Vector3;
  startQuaternion: THREE.Quaternion;
  startScale: THREE.Vector3;
  /** 开始时的世界朝向，用来固定"局部轴"（否则旋转过程中轴会漂） */
  startWorldQuaternion: THREE.Quaternion;
  startPointerX: number;
  startPointerY: number;
  /** 骨骼在屏幕上的位置，缩放时以它为中心算半径 */
  screenX: number;
  screenY: number;
  /** 固定的投影平面锚点（骨骼起始世界位置） */
  anchor: THREE.Vector3;
  startWorld: THREE.Vector3;
  /** 最近一次指针位置：输入数字或切换轴向时要按它重算 */
  lastPointerX: number;
  lastPointerY: number;
  axis: 'X' | 'Y' | 'Z' | null;
  plane: boolean;
  numeric: string;
  amount: number;
}

/** 姿态模式下的 gizmo 操作类型（对应 Blender 的 G / R / S） */
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'world';

export interface BoneTransformState {
  boneId: string;
  /** 欧拉角（度），顺序 XYZ */
  rotation: [number, number, number];
  position: [number, number, number];
  scale: [number, number, number];
  /** 相对静置姿态（FBX 里原始的绑定姿态）是否被改过 */
  modified: boolean;
}

export interface PoseState {
  /** 当前选中骨骼的变换；未选中为 null */
  bone: BoneTransformState | null;
  /** 相对静置姿态被改过的骨骼数 */
  changedCount: number;
  total: number;
  /** 正在进行的模态变换（G/R/S），没有则为 null */
  modal: ModalTransformState | null;
}

const BOUNDS_SAMPLES = 6;

/**
 * FBX 动画播放器。
 *
 * 与工作台的 ModelViewer 分开实现：这里关心 AnimationMixer、播放控制、
 * 原地播放（去掉根节点水平位移）与镜像，而不需要线框/素材库那套逻辑。
 * 所有操作都在内存里完成，不会向源文件夹写入任何文件。
 */
export class FbxPlayer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly grid: THREE.GridHelper;
  private readonly shadowPlane: THREE.Mesh;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly axis: AxisIndicator | null;
  private readonly clock = new THREE.Clock();

  private model: THREE.Object3D | null = null;
  /** 归一化缩放（镜像时为负） */
  private baseScale = 1;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private currentAction: THREE.AnimationAction | null = null;
  private skeleton: SkeletonOverlay | null = null;
  private skeletonOn = false;
  private skeletonMode: BoneDisplayMode = 'stick';

  // ===== 姿态模式 =====
  private transformControls: TransformControls | null = null;
  private transformMode: TransformMode = 'rotate';
  private transformSpace: TransformSpace = 'local';
  private poseMode = false;
  /** 本次指针手势是否作用在 gizmo 上（用于让骨骼点选让路） */
  private transformGesture = false;
  private poseListeners: ((state: PoseState) => void)[] = [];
  private readonly bonesById = new Map<string, THREE.Bone>();
  /** 静置姿态：FBX 原始的绑定姿态，用于「回到绑定姿态」 */
  private readonly restPose = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  /**
   * 进入姿态模式那一刻的姿态快照。
   * "改过哪些骨骼"以它为基准——如果用绑定姿态当基准，动画一播放就会显示"半数骨骼已改"，
   * 那样既没意义也会让人误以为重置会毁掉动画。
   */
  private readonly basePose = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  /** 参与姿态统计的骨骼（真实骨骼，不含 FBX 的包装节点） */
  private poseBoneIds: string[] = [];
  private readonly poseEuler = new THREE.Euler();
  private selectedBoneId: string | null = null;

  // ===== 场景节点树（共用 NodeHighlighter）=====
  private sceneTree: SceneNode[] = [];
  private nodeHighlighter: NodeHighlighter | null = null;

  // 模态变换（Blender 的 G/R/S）用到的临时量
  private modal: ModalTransform | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchC = new THREE.Vector3();
  private readonly scratchQ = new THREE.Quaternion();
  private readonly scratchPlane = new THREE.Plane();
  private disposed = false;
  private gridOn = true;
  private mirrorOn = false;
  private inPlaceOn = false;
  private speed = 1;
  private playing = false;
  /**
   * 是否有待渲染的画面改动。
   * 暂停且相机静止时跳过整帧渲染，避免空闲的预览区一直占用 GPU。
   */
  private renderRequested = true;
  /** 上次向 Vue 推送播放进度的时刻：节流到约 20fps，避免每帧触发响应式更新 */
  private lastEmitAt = 0;
  private listeners: ((state: PlaybackState) => void)[] = [];

  constructor(container: HTMLElement, options: FbxPlayerOptions = {}) {
    this.container = container;

    // 不开启 preserveDrawingBuffer：captureFrame() 是"先 render 再同步读取"，同一任务内读像素即可
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 阴影贴图手动触发更新：只有角色在动或模型变化时才重算
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(this.renderer.domElement);

    // 右下角 XYZ 轴向指示器（与工作台视口一致；离屏封面渲染不需要）
    this.axis =
      options.axisIndicator === false
        ? null
        : new AxisIndicator(container, { bottom: options.axisIndicatorBottom ?? 14 });

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 500);
    this.camera.position.set(2.4, 2.0, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.85;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 40;
    this.controls.target.set(0, 1, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5058, 1.25));

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
    keyLight.position.set(4, 7, 4.5);
    keyLight.castShadow = true;
    // 1024 已足够支撑接触阴影；2048 的填充率是它的 4 倍
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 40;
    Object.assign(keyLight.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xc8d8ff, 0.7);
    rimLight.position.set(-5, 3, -5);
    this.scene.add(rimLight);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.8;

    this.grid = new THREE.GridHelper(20, 40, 0x4a5262, 0x2a2f3a);
    const gridMaterial = this.grid.material as THREE.Material | THREE.Material[];
    for (const material of Array.isArray(gridMaterial) ? gridMaterial : [gridMaterial]) {
      material.transparent = true;
      material.opacity = 0.7;
    }
    this.scene.add(this.grid);

    this.shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.26 }));
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = -0.001;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    // 姿态模式的 gizmo（Blender 的 G/R/S）。r171 起 TransformControls 是 Controls 子类，
    // 需要把 getHelper() 的结果加进场景，而不是控件本身。
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setMode(this.transformMode);
    this.transformControls.setSpace(this.transformSpace);
    this.transformControls.setSize(0.85);
    this.scene.add(this.transformControls.getHelper());
    this.transformControls.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean((event as { value?: unknown }).value);
      // 拖 gizmo 时先关掉轨道控制器，松开再恢复
      this.controls.enabled = !dragging;
      if (dragging) this.transformGesture = true;
    });
    this.transformControls.addEventListener('objectChange', () => this.emitPose());

    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** 标记需要重绘一帧（暂停状态下任何画面变化都要调用） */
  private requestRender(): void {
    this.renderRequested = true;
  }

  /** 重新计算阴影贴图（模型、姿势或朝向变化后调用） */
  private invalidateShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
    this.renderRequested = true;
  }

  private tick(): void {
    if (this.disposed) return;
    const delta = this.clock.getDelta();
    // 只有真正在播放时推进动画：暂停时不再每帧空转 mixer，也不再让动画覆盖手动摆的姿势
    const animating = Boolean(this.currentAction && this.playing && !this.poseMode);
    if (animating) this.mixer?.update(delta * this.speed);

    // update() 返回 true 表示这一帧相机有变化（阻尼、自动旋转、用户拖拽）
    const cameraChanged = this.controls.update();
    // 静止（暂停且相机没动）时直接跳过整帧渲染；姿态模式与显式改动仍会重绘
    if (!animating && !cameraChanged && !this.poseMode && !this.renderRequested) return;
    this.renderRequested = false;

    if (animating || this.poseMode) {
      // 骨骼随动画/手动摆姿移动，刷新叠加层与拾取用的点云，并同步重算阴影
      this.skeleton?.refreshPositions();
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.nodeHighlighter?.refreshBoxes();
    this.axis?.update(this.camera);
    this.renderer.render(this.scene, this.camera);

    // 播放进度推给 Vue：节流到约 20fps，时间轴显示足够顺滑，又不至于每帧触发整页响应式更新
    if (this.currentAction && animating) {
      const now = performance.now();
      if (now - this.lastEmitAt >= 50) {
        this.lastEmitAt = now;
        this.emitPlayback();
      }
    }
  }

  private emit(state: PlaybackState): void {
    for (const listener of this.listeners) listener(state);
  }

  onTick(listener: (state: PlaybackState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  // ===== 姿态模式 =====

  get isPoseMode(): boolean {
    return this.poseMode;
  }

  get isTransformGesture(): boolean {
    return this.transformGesture;
  }

  /** 一次指针手势结束，清掉 gizmo 操作标记 */
  endPointerGesture(): void {
    this.transformGesture = false;
  }

  onPose(listener: (state: PoseState) => void): () => void {
    this.poseListeners.push(listener);
    return () => {
      this.poseListeners = this.poseListeners.filter((item) => item !== listener);
    };
  }

  private emitPose(): void {
    // 骨骼变了：暂停状态下也要重绘一帧，否则画面停在旧姿势
    this.invalidateShadows();
    const bone = this.poseMode ? (this.bonesById.get(this.selectedBoneId ?? '') ?? null) : null;
    let changedCount = 0;
    for (const id of this.poseBoneIds) {
      const target = this.bonesById.get(id);
      const base = this.basePose.get(id);
      if (!target || !base) continue;
      if (!target.position.equals(base.p) || !target.quaternion.equals(base.q) || !target.scale.equals(base.s)) {
        changedCount += 1;
      }
    }
    const state: PoseState = {
      bone: bone ? this.describeBone(bone) : null,
      changedCount,
      total: this.poseBoneIds.length,
      modal: this.modalState,
    };
    for (const listener of this.poseListeners) listener(state);
  }

  get modalState(): ModalTransformState | null {
    const m = this.modal;
    if (!m) return null;
    return { kind: m.kind, axis: m.axis, plane: m.plane, numeric: m.numeric, amount: m.amount };
  }

  get isModalActive(): boolean {
    return this.modal !== null;
  }

  // ===== 场景节点树 =====

  get sceneNodes(): SceneNode[] {
    return this.sceneTree;
  }

  get selectedNodeList(): string[] {
    return this.nodeHighlighter?.selection ?? [];
  }

  /** 重建节点树（加载模型后调用） */
  private rebuildSceneTree(): void {
    if (!this.nodeHighlighter) this.nodeHighlighter = new NodeHighlighter(this.scene);
    this.sceneTree = this.nodeHighlighter.reset(this.model);
  }

  /** 指定要高亮的节点（加选逻辑在上层 store 里） */
  setNodeSelection(ids: readonly string[]): void {
    this.nodeHighlighter?.setSelection(ids);
    this.requestRender();
  }

  clearNodeSelection(): void {
    this.nodeHighlighter?.clear();
    this.requestRender();
  }

  // ===== 模态变换：按 G / R / S 之后鼠标直接驱动骨骼 =====

  /** 把屏幕坐标投到"过 anchor、与相机平行"的平面上，得到世界坐标 */
  private pointerToWorld(clientX: number, clientY: number, anchor: THREE.Vector3): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.camera.getWorldDirection(this.scratchC);
    this.scratchPlane.setFromNormalAndCoplanarPoint(this.scratchC, anchor);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.scratchPlane, hit) ? hit : null;
  }

  /** 约束轴在世界空间的方向；space=local 时用骨骼开始时的朝向固定住 */
  private modalAxisWorld(modal: ModalTransform): THREE.Vector3 | null {
    if (!modal.axis) return null;
    const axis = new THREE.Vector3(
      modal.axis === 'X' ? 1 : 0,
      modal.axis === 'Y' ? 1 : 0,
      modal.axis === 'Z' ? 1 : 0,
    );
    if (this.transformSpace === 'local') axis.applyQuaternion(modal.startWorldQuaternion);
    return axis.normalize();
  }

  beginModalTransform(kind: TransformMode, clientX: number, clientY: number): boolean {
    if (!this.poseMode) return false;
    const bone = this.bonesById.get(this.selectedBoneId ?? '');
    if (!bone) return false;

    const boneWorld = bone.getWorldPosition(new THREE.Vector3());
    const world = this.pointerToWorld(clientX, clientY, boneWorld);
    if (!world) return false;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const projected = boneWorld.clone().project(this.camera);
    const worldQuaternion = new THREE.Quaternion();
    bone.getWorldQuaternion(worldQuaternion);

    this.modal = {
      kind,
      bone,
      startPosition: bone.position.clone(),
      startQuaternion: bone.quaternion.clone(),
      startScale: bone.scale.clone(),
      startWorldQuaternion: worldQuaternion,
      startPointerX: clientX,
      startPointerY: clientY,
      screenX: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      screenY: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      anchor: boneWorld.clone(),
      startWorld: world.clone(),
      lastPointerX: clientX,
      lastPointerY: clientY,
      axis: null,
      plane: false,
      numeric: '',
      amount: 0,
    };
    // 模态期间让 gizmo 让路，免得和鼠标操作抢事件
    if (this.transformControls) this.transformControls.enabled = false;
    this.transformMode = kind;
    this.emitPose();
    return true;
  }

  updateModalTransform(clientX: number, clientY: number): void {
    const m = this.modal;
    if (!m) return;
    const world = this.pointerToWorld(clientX, clientY, m.anchor);
    if (!world) return;
    m.lastPointerX = clientX;
    m.lastPointerY = clientY;

    const numeric = m.numeric === '' ? null : Number(m.numeric);
    const hasNumeric = numeric !== null && Number.isFinite(numeric);
    const axisWorld = this.modalAxisWorld(m);

    if (m.kind === 'translate') {
      const move = this.scratchA.copy(world).sub(m.startWorld);
      if (axisWorld && m.axis) {
        const along = move.dot(axisWorld);
        if (m.plane) {
          move.addScaledVector(axisWorld, -along);
          if (hasNumeric) {
            const length = move.length();
            if (length > 1e-6) move.multiplyScalar(numeric / length);
          }
        } else {
          move.copy(axisWorld).multiplyScalar(hasNumeric ? numeric : along);
        }
      } else if (hasNumeric) {
        const length = move.length();
        if (length > 1e-6) move.multiplyScalar(numeric / length);
      }
      m.amount = move.length();

      // 世界位移 → 父级局部位移：父级带缩放，必须用两个点来换算
      const parent = m.bone.parent;
      if (parent) {
        parent.updateMatrixWorld();
        const from = parent.worldToLocal(m.anchor.clone());
        const to = parent.worldToLocal(m.anchor.clone().add(move));
        m.bone.position.copy(m.startPosition).add(to.sub(from));
      } else {
        m.bone.position.copy(m.startPosition).add(move);
      }
    } else if (m.kind === 'rotate') {
      // 没指定轴时绕视线方向旋转（Blender 的默认行为）
      const axis = axisWorld ?? this.camera.getWorldDirection(this.scratchB).clone().negate();
      const boneWorld = m.bone.getWorldPosition(this.scratchC);
      const from = m.startWorld.clone().sub(boneWorld).projectOnPlane(axis);
      const to = world.clone().sub(boneWorld).projectOnPlane(axis);
      let angle = 0;
      if (from.lengthSq() > 1e-10 && to.lengthSq() > 1e-10) {
        angle = from.angleTo(to);
        if (axis.dot(from.clone().cross(to)) < 0) angle = -angle;
      }
      if (hasNumeric) angle = THREE.MathUtils.degToRad(numeric);
      m.amount = THREE.MathUtils.radToDeg(angle);

      const parentQuaternion = new THREE.Quaternion();
      if (m.bone.parent) m.bone.parent.getWorldQuaternion(parentQuaternion);
      const localAxis = axis.clone().applyQuaternion(parentQuaternion.invert()).normalize();
      this.scratchQ.setFromAxisAngle(localAxis, angle);
      m.bone.quaternion.copy(this.scratchQ).multiply(m.startQuaternion);
    } else {
      let factor = 1;
      if (hasNumeric) {
        factor = numeric;
      } else {
        const distance0 = Math.hypot(m.startPointerX - m.screenX, m.startPointerY - m.screenY);
        const distance1 = Math.hypot(clientX - m.screenX, clientY - m.screenY);
        factor = distance0 > 6 ? distance1 / distance0 : 1;
      }
      factor = Math.min(100, Math.max(0.01, factor));
      m.amount = factor;

      const scale = m.startScale.clone();
      if (m.axis && !m.plane) {
        // 缩放按骨骼自身的局部轴给：世界轴映射到局部缩放分量没有唯一解
        const key = m.axis.toLowerCase() as 'x' | 'y' | 'z';
        scale[key] *= factor;
      } else if (m.axis && m.plane) {
        const skip = m.axis.toLowerCase();
        for (const k of ['x', 'y', 'z'] as const) if (k !== skip) scale[k] *= factor;
      } else {
        scale.multiplyScalar(factor);
      }
      m.bone.scale.copy(scale);
    }

    m.bone.updateMatrixWorld(true);
    this.emitPose();
  }

  /** 输入数字 / 切换轴向之后要立刻按当前指针位置重算，不然要等鼠标再动才生效 */
  private reapplyModal(): void {
    const m = this.modal;
    if (!m) return;
    this.updateModalTransform(m.lastPointerX, m.lastPointerY);
  }

  /** 按 X/Y/Z 设约束轴：同轴再按一次取消，Shift+轴为平面约束 */
  setModalAxis(axis: 'X' | 'Y' | 'Z', plane: boolean): void {
    const m = this.modal;
    if (!m) return;
    if (m.axis === axis) {
      if (plane && !m.plane) m.plane = true;
      else {
        m.axis = null;
        m.plane = false;
      }
    } else {
      m.axis = axis;
      m.plane = plane;
    }
    this.reapplyModal();
  }

  pushModalDigit(char: string): void {
    const m = this.modal;
    if (!m) return;
    if (char === '-' && m.numeric !== '') return;
    if (char === '.' && m.numeric.includes('.')) return;
    if (m.numeric.replace('-', '').length >= 8) return;
    m.numeric += char;
    this.reapplyModal();
  }

  popModalDigit(): void {
    const m = this.modal;
    if (!m) return;
    m.numeric = m.numeric.slice(0, -1);
    this.reapplyModal();
  }

  /** 确认：保留当前变换 */
  confirmModalTransform(): void {
    if (!this.modal) return;
    this.modal = null;
    if (this.transformControls) this.transformControls.enabled = true;
    this.emitPose();
  }

  /** 取消：回到按下 G/R/S 之前 */
  cancelModalTransform(): void {
    const m = this.modal;
    if (!m) return;
    m.bone.position.copy(m.startPosition);
    m.bone.quaternion.copy(m.startQuaternion);
    m.bone.scale.copy(m.startScale);
    m.bone.updateMatrixWorld(true);
    this.modal = null;
    if (this.transformControls) this.transformControls.enabled = true;
    this.emitPose();
  }

  /** Alt+G / Alt+R / Alt+S：把对应分量清回 FBX 绑定姿态 */
  clearPoseComponent(component: 'position' | 'rotation' | 'scale'): void {
    const bone = this.bonesById.get(this.selectedBoneId ?? '');
    const rest = bone ? this.restPose.get(bone.uuid) : undefined;
    if (!bone || !rest) return;
    if (component === 'position') bone.position.copy(rest.p);
    else if (component === 'rotation') bone.quaternion.copy(rest.q);
    else bone.scale.copy(rest.s);
    bone.updateMatrixWorld(true);
    this.emitPose();
  }

  /** 记录当前姿态作为「改动」的基准 */
  private captureBasePose(): void {
    this.basePose.clear();
    for (const id of this.poseBoneIds) {
      const bone = this.bonesById.get(id);
      if (!bone) continue;
      this.basePose.set(id, {
        p: bone.position.clone(),
        q: bone.quaternion.clone(),
        s: bone.scale.clone(),
      });
    }
  }

  private isBoneModified(id: string): boolean {
    const bone = this.bonesById.get(id);
    const base = this.basePose.get(id);
    if (!bone || !base) return false;
    return !bone.position.equals(base.p) || !bone.quaternion.equals(base.q) || !bone.scale.equals(base.s);
  }

  private emitPlayback(): void {
    if (!this.mixer || !this.currentAction) return;
    this.emit({
      time: this.currentAction.time,
      duration: this.currentAction.getClip().duration,
      playing: this.playing,
      speed: this.speed,
    });
  }

  private describeBone(bone: THREE.Bone): BoneTransformState {
    this.poseEuler.setFromQuaternion(bone.quaternion, 'XYZ');
    return {
      boneId: bone.uuid,
      rotation: [
        THREE.MathUtils.radToDeg(this.poseEuler.x),
        THREE.MathUtils.radToDeg(this.poseEuler.y),
        THREE.MathUtils.radToDeg(this.poseEuler.z),
      ],
      position: [bone.position.x, bone.position.y, bone.position.z],
      scale: [bone.scale.x, bone.scale.y, bone.scale.z],
      modified: this.isBoneModified(bone.uuid),
    };
  }

  setSelectedBone(id: string | null): void {
    this.selectedBoneId = id;
    this.syncTransformTarget();
  }

  private syncTransformTarget(): void {
    const controls = this.transformControls;
    if (!controls) return;
    const bone = this.poseMode ? this.bonesById.get(this.selectedBoneId ?? '') : undefined;
    if (bone) controls.attach(bone);
    else controls.detach();
    this.emitPose();
  }

  setPoseMode(on: boolean): void {
    if (this.poseMode === on) return;
    if (!on && this.modal) this.cancelModalTransform();
    this.poseMode = on;
    if (on) {
      // 摆姿势时先把动画停下，否则每帧都会被动画覆盖
      this.playing = false;
      // 镜像会让骨骼的局部变换带负缩放，gizmo 的方向会变得难以预测，这里先关掉
      this.setMirror(false);
      // 以"进入姿态模式那一刻"为基准，之后才知道改了哪几根
      this.captureBasePose();
    } else {
      // 退出时也停下动画，避免手动摆的姿势立刻被动画覆盖、看起来闪一下
      this.playing = false;
    }
    this.emitPlayback();
    this.syncTransformTarget();
  }

  setTransformMode(mode: TransformMode): void {
    this.transformMode = mode;
    this.transformControls?.setMode(mode);
  }

  get currentTransformMode(): TransformMode {
    return this.transformMode;
  }

  setTransformSpace(space: TransformSpace): void {
    this.transformSpace = space;
    this.transformControls?.setSpace(space);
  }

  get currentTransformSpace(): TransformSpace {
    return this.transformSpace;
  }

  /** 还原某根骨骼：回到进入姿态模式时的状态 */
  resetBonePose(id: string): void {
    const bone = this.bonesById.get(id);
    const base = this.basePose.get(id);
    if (!bone || !base) return;
    bone.position.copy(base.p);
    bone.quaternion.copy(base.q);
    bone.scale.copy(base.s);
    bone.updateMatrixWorld(true);
    this.emitPose();
  }

  resetAllPoses(): void {
    for (const [id, base] of this.basePose) {
      const bone = this.bonesById.get(id);
      if (!bone) continue;
      bone.position.copy(base.p);
      bone.quaternion.copy(base.q);
      bone.scale.copy(base.s);
      bone.updateMatrixWorld(true);
    }
    this.emitPose();
  }

  /** 回到 FBX 的绑定姿态（Blender 里 Alt+G/R/S 的语义） */
  resetToRestPose(): void {
    for (const [id, rest] of this.restPose) {
      const bone = this.bonesById.get(id);
      if (!bone) continue;
      bone.position.copy(rest.p);
      bone.quaternion.copy(rest.q);
      bone.scale.copy(rest.s);
      bone.updateMatrixWorld(true);
    }
    this.emitPose();
  }

  /** 面板里直接输数值改骨骼姿态 */
  applyBoneTransform(
    id: string,
    patch: Partial<Pick<BoneTransformState, 'rotation' | 'position' | 'scale'>>,
  ): void {
    const bone = this.bonesById.get(id);
    if (!bone) return;
    if (patch.rotation) {
      this.poseEuler.set(
        THREE.MathUtils.degToRad(patch.rotation[0]),
        THREE.MathUtils.degToRad(patch.rotation[1]),
        THREE.MathUtils.degToRad(patch.rotation[2]),
        'XYZ',
      );
      bone.quaternion.setFromEuler(this.poseEuler);
    }
    if (patch.position) bone.position.set(patch.position[0], patch.position[1], patch.position[2]);
    if (patch.scale) bone.scale.set(patch.scale[0], patch.scale[1], patch.scale[2]);
    bone.updateMatrixWorld(true);
    this.emitPose();
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.requestRender();
  }

  get clipList(): ClipInfo[] {
    return this.clips.map((clip) => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length }));
  }

  /**
   * 提取动画数据：关节层级（含绑定姿态）、每个片段的轨迹与时间线。
   *
   * 只读取已解析的 AnimationClip 与骨骼，不读取也不导出任何网格几何、
   * 蒙皮权重、材质或贴图数据。返回纯数据对象，可直接序列化为 JSON。
   */
  extractAnimationData(source: AnimationDataSource, options: AnimationDataOptions = {}): AnimationData | null {
    if (!this.skeleton) return null;

    const includeKeyframes = options.includeKeyframes ?? true;
    const precision = Math.min(9, Math.max(0, Math.round(options.precision ?? 6)));
    const round = (value: number): number => roundNumber(value, precision);

    const bones = this.skeleton.flatBones;
    const boneById = new Map(bones.map((bone) => [bone.id, bone]));
    // 轨道名里用的是 sanitizeNodeName 之后的名字，两种都登记以便匹配
    const boneByName = new Map<string, FlatBone>();
    for (const bone of bones) {
      boneByName.set(bone.name, bone);
      const sanitized = THREE.PropertyBinding.sanitizeNodeName(bone.name);
      if (!boneByName.has(sanitized)) boneByName.set(sanitized, bone);
    }

    const joints: AnimationJointData[] = bones.map((bone) => {
      const rest = this.restPose.get(bone.id);
      const current = this.bonesById.get(bone.id);
      const position = rest?.p ?? current?.position;
      const rotation = rest?.q ?? current?.quaternion;
      const scale = rest?.s ?? current?.scale;
      return {
        name: bone.name,
        label: bone.label,
        parent: bone.parentId ? (boneById.get(bone.parentId)?.name ?? null) : null,
        depth: bone.depth,
        rest: {
          position: [
            round(position?.x ?? 0),
            round(position?.y ?? 0),
            round(position?.z ?? 0),
          ],
          rotation: [
            round(rotation?.x ?? 0),
            round(rotation?.y ?? 0),
            round(rotation?.z ?? 0),
            round(rotation?.w ?? 1),
          ],
          scale: [round(scale?.x ?? 1), round(scale?.y ?? 1), round(scale?.z ?? 1)],
        },
      };
    });

    const clips: AnimationClipData[] = this.clips.map((clip) => {
      let interval: number | null = null;
      const intervals: number[] = [];
      let keyframes = 0;

      const tracks: AnimationTrackData[] = clip.tracks.map((track) => {
        const times = track.times;
        const count = times.length;
        keyframes += count;

        const dot = track.name.lastIndexOf('.');
        const nodeName = dot > 0 ? track.name.slice(0, dot) : track.name;
        const property = dot > 0 ? track.name.slice(dot + 1) : '';
        const joint = boneByName.get(nodeName) ?? boneByName.get(cleanBoneLabel(nodeName)) ?? null;

        const trackInterval = trackSampleInterval(times);
        if (trackInterval !== null) intervals.push(trackInterval);

        const data: AnimationTrackData = {
          name: track.name,
          joint: joint?.name ?? null,
          property,
          valueType: track.ValueTypeName ?? '',
          valueSize: track.getValueSize(),
          keyframes: count,
          timeRange: count > 0 ? [round(times[0]!), round(times[count - 1]!)] : [0, 0],
          interval: trackInterval === null ? null : round(trackInterval),
          interpolation: interpolationName(track.getInterpolation()),
        };
        if (includeKeyframes) {
          data.times = toNumberArray(times, precision);
          data.values = toNumberArray(track.values, precision);
        }
        return data;
      });

      interval = median(intervals);
      return {
        name: clip.name,
        duration: round(clip.duration),
        fps: interval === null ? null : roundNumber(1 / interval, 3),
        interval,
        keyframes,
        tracks,
      };
    });

    const clipIntervals = clips
      .map((clip) => clip.interval)
      .filter((value): value is number => value !== null);
    const interval = median(clipIntervals);

    return {
      format: 'fbx-animation-data',
      version: 1,
      generatedAt: new Date().toISOString(),
      source,
      skeleton: { jointCount: joints.length, joints },
      timeline: {
        clipCount: clips.length,
        totalDuration: round(clips.reduce((sum, clip) => sum + clip.duration, 0)),
        longestDuration: clips.reduce((max, clip) => Math.max(max, clip.duration), 0),
        fps: interval === null ? null : roundNumber(1 / interval, 3),
        interval,
      },
      clips,
      excluded: ['mesh', 'skin', 'material', 'texture'],
    };
  }

  // ===== 骨骼 =====

  get boneTree(): BoneNode[] {
    return this.skeleton?.boneTree ?? [];
  }

  get boneList(): FlatBone[] {
    return this.skeleton?.flatBones ?? [];
  }

  get skeletonVisible(): boolean {
    return this.skeletonOn;
  }

  /** 被忽略的同名 FBX 包装节点数 */
  get ignoredBoneNodes(): number {
    return this.skeleton?.ignoredBoneNodes ?? 0;
  }

  setSkeletonVisible(on: boolean): void {
    this.skeletonOn = on;
    this.skeleton?.setVisible(on);
    this.requestRender();
  }

  get boneDisplayMode(): BoneDisplayMode {
    return this.skeletonMode;
  }

  /** 切换骨骼显示方式：点线 / 八面体 */
  setBoneDisplayMode(mode: BoneDisplayMode): void {
    this.skeletonMode = mode;
    this.skeleton?.setDisplayMode(mode);
    this.requestRender();
  }

  setSelectedBones(ids: readonly string[]): void {
    this.skeleton?.setSelection(ids);
    this.requestRender();
  }

  setHoveredBone(id: string | null): void {
    this.skeleton?.setHovered(id);
    this.requestRender();
  }

  /** 在模型上用屏幕坐标点选骨骼；返回骨骼 id，未命中为 null */
  pickBone(clientX: number, clientY: number): string | null {
    if (!this.skeleton) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return this.skeleton.pick(this.camera, rect.width, rect.height, clientX - rect.left, clientY - rect.top);
  }

  /** 加载 FBX（只读读取，加载完成后源文件不再被占用） */
  async load(url: string): Promise<LoadResult> {
    const loader = new FBXLoader();
    const object = await loader.loadAsync(url);
    return this.installModel(object, object.animations ?? []);
  }

  /** 把模型装进场景：归一化、记录绑定姿态、建立骨骼叠加层与节点树 */
  private installModel(object: THREE.Object3D, animations: THREE.AnimationClip[]): LoadResult {
    this.clear();

    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // 蒙皮后包围盒不随动画更新，避免被误剔除
    });

    this.model = object;
    this.scene.add(object);

    // Mixamo 的 FBX 以厘米为单位（角色约 180 单位高），先归一化到约 2.4 单位，
    // 否则轨道控制器的距离范围会把相机钳制到模型内部。
    const rawBox = new THREE.Box3().setFromObject(object);
    if (rawBox.isEmpty()) rawBox.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const rawSize = new THREE.Vector3();
    rawBox.getSize(rawSize);
    const maxDimension = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
    this.baseScale = 2.4 / maxDimension;

    object.scale.setScalar(this.baseScale);
    object.updateMatrixWorld(true);

    const scaledBox = new THREE.Box3().setFromObject(object);
    const scaledCenter = new THREE.Vector3();
    scaledBox.getCenter(scaledCenter);
    // 水平居中、底面贴地
    object.position.set(-scaledCenter.x, -scaledBox.min.y, -scaledCenter.z);
    object.updateMatrixWorld(true);

    // 过滤掉 FBXLoader 产生的空片段（时长为 0 或没有轨道）
    this.clips = animations.filter((clip) => clip.duration > 0 && clip.tracks.length > 0);

    this.mixer = new THREE.AnimationMixer(object);
    this.applyMirror();

    // 记录 FBX 原始的绑定姿态，作为「清空变换」的还原目标
    this.bonesById.clear();
    this.restPose.clear();
    object.traverse((child) => {
      const bone = child as THREE.Bone;
      if (!bone.isBone) return;
      this.bonesById.set(bone.uuid, bone);
      this.restPose.set(bone.uuid, {
        p: bone.position.clone(),
        q: bone.quaternion.clone(),
        s: bone.scale.clone(),
      });
    });

    // 骨骼叠加层挂在场景根上（世界坐标），因此自动跟随模型的归一化缩放与镜像
    this.skeleton = new SkeletonOverlay(object);
    this.skeleton.calibrate(maxDimension * this.baseScale);
    this.skeleton.setDisplayMode(this.skeletonMode);
    this.skeleton.setVisible(this.skeletonOn);
    this.scene.add(this.skeleton.root);
    // 姿态统计只看真实骨骼（65 根），不算 FBX 的同名包装节点
    this.poseBoneIds = this.skeleton.flatBones.map((bone) => bone.id);
    this.captureBasePose();
    // 节点树：对象层级（含骨骼节点），供「节点」面板展示与高亮
    this.rebuildSceneTree();

    this.frameModel();
    this.currentAction = null;
    this.playing = false;

    // 新模型：重算阴影并重绘一帧
    this.invalidateShadows();
    return { clips: this.clipList, stats: collectStats(object) };
  }

  /** 播放第 index 个动画片段 */
  playClip(index = 0): ClipInfo | null {
    if (!this.mixer || this.clips.length === 0) return null;
    const source = this.clips[Math.max(0, Math.min(index, this.clips.length - 1))]!;
    const clip = this.effectiveClip(source);

    // 原地播放开关会改变片段内容，因此每次都重建 action 以保证一致
    this.currentAction?.stop();
    if (this.currentAction) this.mixer.uncacheClip(this.currentAction.getClip());

    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();
    this.currentAction = action;
    this.playing = true;
    return { name: clip.name, duration: clip.duration, tracks: clip.tracks.length };
  }

  /** 停止并清空当前片段（新建动画时只保留模型） */
  clearAnimationClips(): void {
    if (this.currentAction && this.mixer) {
      this.currentAction.stop();
      this.mixer.uncacheClip(this.currentAction.getClip());
    }
    this.currentAction = null;
    this.clips = [];
    this.playing = false;
    this.emitPlayback();
    this.invalidateShadows();
  }

  /**
   * 把导出的动画数据（仅关节轨迹与关键帧）重新绑定为 AnimationClip。
   * 不读取网格、蒙皮、材质或贴图；轨道名与当前模型的骨骼名不匹配时会报错。
   */
  applyAnimationData(data: AnimationData): ClipInfo[] {
    if (!this.model || !this.mixer || !this.skeleton) throw new Error('模型尚未加载完成');

    const boneNameMap = buildBoneNameMap(this.skeleton.flatBones);
    const { clips, matchedTracks } = clipsFromAnimationData(data, boneNameMap);
    if (matchedTracks === 0) throw new Error('JSON 中的关节名与当前模型不匹配，无法绑定动画');

    this.clearAnimationClips();
    this.clips = clips;
    this.playClip(0);
    return this.clipList;
  }

  /** 原地播放：去掉根骨骼水平位移后重新播放当前片段 */
  setInPlace(on: boolean): void {
    if (this.inPlaceOn === on) return;
    this.inPlaceOn = on;
    const index = this.currentClipIndex();
    if (index >= 0) this.playClip(index);
  }

  private currentClipIndex(): number {
    const current = this.currentAction?.getClip();
    if (!current) return -1;
    const base = current.name.replace(/^\[inplace\]\s*/, '');
    return this.clips.findIndex((clip) => clip.name === base || clip.name === current.name);
  }

  private effectiveClip(clip: THREE.AnimationClip): THREE.AnimationClip {
    if (!this.inPlaceOn) return clip;
    const processed = stripRootMotion(clip);
    processed.name = `[inplace] ${clip.name}`;
    return processed;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing && this.currentAction && !this.currentAction.isRunning()) this.currentAction.play();
    // 暂停时按需渲染，因此播放状态变化后主动重绘并同步一次进度
    this.requestRender();
    this.emitPlayback();
  }

  togglePlay(): void {
    this.setPlaying(!this.playing);
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.05, Math.min(4, speed));
    this.emitPlayback();
  }

  seek(time: number): void {
    if (!this.currentAction) return;
    const duration = this.currentAction.getClip().duration;
    this.currentAction.time = Math.max(0, Math.min(time, duration));
    this.mixer?.update(0);
    // 暂停状态下拖动时间轴：立即求值并重绘
    this.invalidateShadows();
    this.emitPlayback();
  }

  setGrid(on: boolean): void {
    this.gridOn = on;
    this.grid.visible = on;
    this.shadowPlane.visible = on;
    this.requestRender();
  }

  /** 镜像：把模型整体沿 X 轴翻转（正面朝向不变，左右互换） */
  setMirror(on: boolean): void {
    this.mirrorOn = on;
    this.applyMirror();
  }

  private applyMirror(): void {
    if (!this.model) return;
    this.model.scale.x = this.baseScale * (this.mirrorOn ? -1 : 1);
    this.model.scale.y = this.baseScale;
    this.model.scale.z = this.baseScale;
    // 负缩放会翻转三角形绕序，镜像时用双面渲染避免模型看起来被掏空
    this.model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material && 'side' in material) {
          (material as THREE.MeshStandardMaterial).side = this.mirrorOn ? THREE.DoubleSide : THREE.FrontSide;
        }
      }
    });
    // 镜像改变了模型整体变换，阴影与画面都要重算
    this.invalidateShadows();
  }

  get inPlace(): boolean {
    return this.inPlaceOn;
  }

  get mirror(): boolean {
    return this.mirrorOn;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get gridVisible(): boolean {
    return this.gridOn;
  }

  resetView(): void {
    this.frameModel();
  }

  /** 让相机框住模型（按动画多个时间点采样，避免运动幅度大时出画） */
  private frameModel(): void {
    if (!this.model) return;
    const box = new THREE.Box3();
    const point = new THREE.Vector3();

    if (this.mixer && this.clips.length > 0) {
      const duration = this.clips[0]!.duration;
      for (let index = 0; index < BOUNDS_SAMPLES; index += 1) {
        this.mixer.setTime((duration * index) / BOUNDS_SAMPLES);
        this.model.updateMatrixWorld(true);
        this.model.traverse((child) => {
          if ((child as THREE.Bone).isBone) {
            child.getWorldPosition(point);
            box.expandByPoint(point);
          }
        });
      }
      this.mixer.setTime(0);
      this.model.updateMatrixWorld(true);
    }

    if (box.isEmpty()) box.setFromObject(this.model);

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const height = Math.max(size.y, 0.5);
    const radius = Math.max(size.x, size.y, size.z) || 1;

    this.controls.target.set(center.x, center.y, center.z);
    const distance = Math.max(1.8, radius * 1.95);
    this.camera.position.set(center.x + distance * 0.5, center.y + height * 0.12, center.z + distance * 0.92);
    this.camera.near = Math.max(0.02, distance / 200);
    this.camera.far = distance * 40;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** 把动画定位到某个比例处（用于生成缩略图） */
  poseAt(ratio: number): void {
    if (!this.mixer || !this.currentAction) return;
    const duration = this.currentAction.getClip().duration;
    this.currentAction.time = Math.max(0, Math.min(duration * ratio, duration));
    this.mixer.update(0);
    this.invalidateShadows();
  }

  captureFrame(size = 256): string | null {
    // 缩略图不要画上骨骼叠加层
    const skeletonWasVisible = this.skeleton?.isVisible ?? false;
    if (skeletonWasVisible) this.skeleton?.setVisible(false);
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const side = Math.min(source.width, source.height);
    if (side <= 0) {
      if (skeletonWasVisible) this.skeleton?.setVisible(true);
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (skeletonWasVisible) this.skeleton?.setVisible(true);
      return null;
    }
    ctx.fillStyle = '#1b1e25';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, size, size);
    if (skeletonWasVisible) this.skeleton?.setVisible(true);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  clear(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
      this.mixer = null;
    }
    this.currentAction = null;
    this.clips = [];
    this.transformControls?.detach();
    this.selectedBoneId = null;
    this.modal = null;
    this.clearNodeSelection();
    this.sceneTree = [];
    this.bonesById.clear();
    this.restPose.clear();
    this.poseMode = false;
    if (this.skeleton) {
      this.scene.remove(this.skeleton.root);
      this.skeleton.dispose();
      this.skeleton = null;
    }
    if (this.model) {
      this.scene.remove(this.model);
      disposeObject(this.model);
      this.model = null;
    }
    this.playing = false;
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.axis?.dispose();
    this.clear();
    this.transformControls?.detach();
    this.transformControls?.dispose();
    this.transformControls = null;
    this.controls.dispose();
    this.pmrem.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.listeners = [];
  }
}

function collectStats(object: THREE.Object3D): ModelStats {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  let skinned = false;
  const materials = new Set<THREE.Material>();
  const boneNodes: THREE.Bone[] = [];

  object.traverse((child) => {
    if ((child as THREE.Bone).isBone) boneNodes.push(child as THREE.Bone);
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshes += 1;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    if (position) vertices += position.count;
    if (geometry.index) triangles += geometry.index.count / 3;
    else if (position) triangles += position.count / 3;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) if (material) materials.add(material);
  });

  const shadows = filterShadowBones(boneNodes);
  return {
    meshes,
    bones: shadows.kept.length,
    boneNodes: boneNodes.length,
    triangles: Math.round(triangles),
    vertices,
    materials: materials.size,
    skinned,
  };
}

/** 去掉根骨骼的水平位移（Mixamo 的髋部节点） */
function stripRootMotion(clip: THREE.AnimationClip): THREE.AnimationClip {
  const copy = clip.clone();
  for (const track of copy.tracks) {
    if (!track.name.endsWith('.position')) continue;
    if (!/hips/i.test(track.name)) continue;
    const values = track.values;
    if (values.length < 3) continue;
    const baseX = values[0]!;
    const baseZ = values[2]!;
    for (let index = 0; index + 2 < values.length; index += 3) {
      values[index] = baseX;
      values[index + 2] = baseZ;
    }
  }
  return copy;
}

function roundNumber(value: number, precision: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toNumberArray(values: ArrayLike<number>, precision: number): number[] {
  const out = new Array<number>(values.length);
  for (let index = 0; index < values.length; index += 1) out[index] = roundNumber(values[index]!, precision);
  return out;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * 关键帧的采样间隔：只有间隔基本均匀时才返回（允许 1% 误差）。
 * 非均匀轨迹（例如手工改过个别关键帧）返回 null，避免给出错误帧率。
 */
function trackSampleInterval(times: ArrayLike<number>): number | null {
  if (times.length < 2) return null;
  const diffs: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const diff = times[index]! - times[index - 1]!;
    if (diff > 1e-6) diffs.push(diff);
  }
  const base = median(diffs);
  if (base === null) return null;
  const tolerance = base * 0.01 + 1e-9;
  return diffs.every((diff) => Math.abs(diff - base) <= tolerance) ? base : null;
}

function interpolationName(mode: number): string {
  if (mode === THREE.InterpolateDiscrete) return 'step';
  if (mode === THREE.InterpolateSmooth) return 'smooth';
  return 'linear';
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
