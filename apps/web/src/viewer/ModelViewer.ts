import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { AxisIndicator } from './axisIndicator';
import { NodeHighlighter, type SceneNode } from './sceneNodes';
import {
  autoRigHumanoid,
  buildBoundRig,
  detectOrientation,
  rootHasSkeleton,
  type AutoRigProgress,
  type AutoRigResult,
  type BoundRigResult,
  type OrientationFix,
} from './autorig/autoRig';
import {
  buildManualCapsules,
  buildManualRigState,
  captureManualMarkers,
  clearManualMarkers,
  guessManualMarkers,
  hasRequiredMarkers,
  isFingerJoint,
  manualJointInfos,
  missingManualMarkers,
  mirrorManualJoints,
  moveManualJointTo,
  placeManualMarker,
  resetManualJoints,
  restoreManualMarkers as applyMarkerSnapshot,
  setFingerRadiusScale,
  setManualRigRadius,
  MARKER_JOINTS,
  type ManualRigJointInfo,
  type ManualRigState,
} from './autorig/manualRig';
import { retargetClipToRig } from './autorig/retarget';

export type { SceneNode };
export type { ManualRigJointInfo };

/** 手动绑骨会话快照：侧栏据此渲染标记列表、属性与坐标输入框 */
export interface ManualRigSnapshot {
  active: boolean;
  selected: string | null;
  fingersVisible: boolean;
  /** 是否透视显示关节标记（Auto-Rig Pro 的 X-Ray） */
  xray: boolean;
  /** 是否显示预览骨架连线 */
  bonesVisible: boolean;
  /** 正在等待视口点击落点的标记关节名（ARP 的 Add Markers 添加中） */
  placing: string | null;
  /** 放置左右标记时是否同步镜像对侧（ARP 的 Mirror） */
  mirror: boolean;
  /** 是否按网格深度落点（ARP 的 Use Markers Depth） */
  markerDepth: boolean;
  /** 已放置的标记关节名 */
  placed: string[];
  /** 必需标记是否齐全（Go! 可点） */
  canBuild: boolean;
  /** 还没放置的必需标记（中文名，用于提示） */
  missing: string[];
  /** 手指粗细缩放系数 */
  fingerScale: number;
  /** 模型高度，供侧栏把坐标步长设成合理量级 */
  height: number;
  joints: ManualRigJointInfo[];
}

export interface MeshStats {
  format: string;
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  /** 模型显示名（从 URL 取文件名），供 ARP 面板 Setup 区展示 */
  name: string;
  /** 归一化后包围盒高度（世界单位），供 ARP 面板 Setup 区展示 */
  bboxSize: number;
}

export interface LoadTarget {
  url: string;
  format: string;
  materialUrl?: string | null;
}

export interface ModelViewerOptions {
  /** 是否在右下角显示 XYZ 轴向指示器（离屏缩略图渲染器会关掉） */
  axisIndicator?: boolean;
}

const MAX_WIREFRAME_OVERLAY_TRIANGLES = 150_000;

/** 浏览器可直接预览的格式 */
export const PREVIEWABLE_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'fbx'];

/**
 * 加载 / 绑骨在新请求或播放器销毁后被打断时抛出。
 * 这不是真正的失败，调用方应当静默忽略，不要弹「加载失败」。
 */
export class ViewerCanceledError extends Error {
  constructor() {
    super('操作已被新的请求取代');
    this.name = 'ViewerCanceledError';
  }
}

/**
 * 工作区三维预览器：负责模型加载、取景、线框叠加、网格地面与截图。
 * 只做工作区需要的功能，不含动画/材质编辑等编辑器能力。
 */
export class ModelViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly grid: THREE.GridHelper;
  private readonly shadowPlane: THREE.Mesh;
  private readonly pmrem: THREE.PMREMGenerator;
  /** PMREM 生成的环境贴图（fromScene 返回的 RenderTarget，dispose 时要单独释放） */
  private readonly envTarget: THREE.WebGLRenderTarget;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly axis: AxisIndicator | null;

  /**
   * 是否有待渲染的画面改动。
   * 静止（没有相机阻尼、没有自动旋转、没有模型/选择变化）时不再逐帧渲染，
   * 空闲的预览区几乎不占 GPU —— 页面上同时挂着多个 3D 预览时这一项收益最大。
   */
  private renderRequested = true;
  /** 滚轮累计量：平滑滚轮/触控板一次只上报几像素，攒够一档再缩放，和带刻度滚轮手感一致 */
  private wheelAccum = 0;

  private modelRoot: THREE.Object3D | null = null;
  private wireOverlay: THREE.Group | null = null;
  private stats: MeshStats | null = null;
  private disposed = false;
  /** 递增令牌：切换素材 / 清空后丢弃在途的模型加载结果 */
  private loadToken = 0;
  /** 递增令牌：切换素材 / 清空后丢弃在途的自动绑骨结果 */
  private autoRigToken = 0;
  private wireframeOn = false;
  private gridOn = true;

  // ===== 自动绑骨（T-pose 人形） =====
  /** 骨骼可视化助手；挂在场景而不是 modelRoot 上，避免被 GLTF 导出带出去 */
  private skeletonHelper: THREE.SkeletonHelper | null = null;
  /** 当前模型是否已通过 autoRig() 绑定骨架 */
  private rigged = false;

  // ===== 手动绑骨（参考关节拖拽） =====
  /** 手动绑骨会话；null 表示不在编辑状态 */
  private manualRig: ManualRigState | null = null;
  /** 关节标记球（场景根下的独立对象，不随 modelRoot 缩放走） */
  private manualRigMarkers = new Map<string, THREE.Mesh>();
  private manualRigGroup: THREE.Group | null = null;
  /** 编辑期间临时挂在 modelRoot 下的预览骨骼（只用于画 SkeletonHelper） */
  private manualRigRootBone: THREE.Bone | null = null;
  private manualRigHelper: THREE.SkeletonHelper | null = null;
  private manualRigSelected: string | null = null;
  private manualRigFingersVisible = true;
  /** X-Ray：关节标记始终画在模型前面（Auto-Rig Pro 的同名显示选项） */
  private manualRigXRay = true;
  /** 预览骨架连线显示开关 */
  private manualRigBonesVisible = true;
  /** 正在等待落点的标记（ARP Add Markers：点「添加」后下一次视口点击即为落点） */
  private manualRigPlacing: string | null = null;
  /** 落点时是否按网格深度（开启后标记贴到模型表面，关闭则保持标记当前深度） */
  private manualRigMarkerDepth = false;
  /** 放置左右标记时是否镜像对侧（ARP 的 Mirror） */
  private manualRigMirror = true;
  /** 上一局的标记位置（「恢复上局标记」用） */
  private manualRigLastMarkers: Map<string, THREE.Vector3> | null = null;
  /** 正在拖拽的关节与拖拽平面（平面法线 = 相机朝向，保证关节跟手） */
  private manualRigDrag: { name: string; plane: THREE.Plane } | null = null;
  private manualRigAbort: AbortController | null = null;
  private readonly manualRigRaycaster = new THREE.Raycaster();
  private readonly manualRigPointer = new THREE.Vector2();
  /** UI 订阅：选中关节 / 拖动坐标 / 会话开始结束时回调 */
  onManualRigChange: ((snapshot: ManualRigSnapshot) => void) | null = null;

  // ===== 绑骨后的动画预览 =====
  /** 驱动绑骨骨架的混音器；null 表示当前没有挂载动画 */
  private rigMixer: THREE.AnimationMixer | null = null;
  private rigAction: THREE.AnimationAction | null = null;
  /** 绑定姿态（骨骼局部变换），停止动画时还原 */
  private rigRestPose: Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }> | null =
    null;
  private rigPlaying = false;
  /** 递增令牌：切换素材 / 连续选择动画时丢弃过期的加载结果 */
  private rigLoadToken = 0;
  /** 动画播放期间线框叠加层需让位（叠加层是绑定姿态的静态副本，不会跟随蒙皮形变） */
  private rigAnimationActive = false;
  /** 上一帧时间戳，用于计算 AnimationMixer 的步长 */
  private lastTickTime = 0;

  // ===== 场景节点树（与动画页共用 NodeHighlighter）=====
  private sceneTree: SceneNode[] = [];
  private nodeHighlighter: NodeHighlighter | null = null;

  constructor(container: HTMLElement, options: ModelViewerOptions = {}) {
    this.container = container;

    // 不开启 preserveDrawingBuffer：它会强制浏览器每帧保留缓冲区，是一直开着的高额显存/带宽开销。
    // captureThumbnail() 里先 render 再同步 drawImage，同一任务内读像素，无需保留缓冲区。
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 阴影贴图只在模型/灯光变化后重算：静止预览不做"从光源再渲一遍场景"的无用功
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // 滚轮缩放自己接管：OrbitControls 直接拿 deltaY 原始值算缩放，鼠标驱动 / 触控板平滑滚动
    // 上报的增量常常只有几像素，一格换算下来不到 1%，看起来就是「滚轮放大缩小失效」。
    // 监听器必须早于 OrbitControls 注册（它构造时就挂到同一个 canvas 上），才能拦掉它自带的滚轮处理。
    this.renderer.domElement.addEventListener('wheel', this.onWheelZoom, { passive: false });

    // 右下角 XYZ 轴向指示器（离屏缩略图渲染时不需要）；设置按工作台单独记忆
    this.axis =
      options.axisIndicator === false
        ? null
        : new AxisIndicator(container, { storageKey: 'axis-indicator:workbench' });

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
    this.camera.position.set(2.6, 2.1, 3.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.85;
    this.controls.panSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 40;
    this.controls.autoRotateSpeed = 1.6;
    this.controls.target.set(0, 1, 0);

    // 光照：半球环境光 + 主光 + 补光，尽量还原 Tripo 的柔和工作台观感
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x404652, 1.15);
    this.scene.add(hemisphere);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    keyLight.position.set(4, 6.5, 4.5);
    keyLight.castShadow = true;
    // 1024 对单个模型的接触阴影已经足够，2048 的填充率是它的 4 倍
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 30;
    keyLight.shadow.camera.left = -6;
    keyLight.shadow.camera.right = 6;
    keyLight.shadow.camera.top = 6;
    keyLight.shadow.camera.bottom = -6;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xbcd0ff, 0.75);
    rimLight.position.set(-5, 3, -5);
    this.scene.add(rimLight);

    // PBR 反射环境
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = this.pmrem.fromScene(room, 0.04);
    this.scene.environment = this.envTarget.texture;
    // RoomEnvironment 的几何体/材质只在生成 PMREM 时用到，用完立刻释放
    room.dispose();
    this.scene.environmentIntensity = 0.85;

    // 地面网格（工作台感）
    this.grid = new THREE.GridHelper(20, 40, 0x4a5262, 0x2a2f3a);
    const gridMaterial = this.grid.material as THREE.Material | THREE.Material[];
    for (const material of Array.isArray(gridMaterial) ? gridMaterial : [gridMaterial]) {
      material.transparent = true;
      material.opacity = 0.75;
    }
    this.grid.position.y = 0;
    this.scene.add(this.grid);

    // 承接阴影的透明地面
    this.shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ opacity: 0.28 }),
    );
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = -0.001;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /**
   * 标记需要重绘一帧。
   * 任何不经过相机交互的画面变化（加载模型、切换线框/骨骼、节点选择、取景）都要调用，
   * 否则按需渲染的画面会停留在上一帧。
   */
  private requestRender(): void {
    this.renderRequested = true;
  }

  /** 重新计算阴影贴图（模型位置、朝向或网格变化后调用） */
  private invalidateShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
    this.renderRequested = true;
  }

  private tick(): void {
    if (this.disposed) return;

    // 动画预览：只有播放中才推进混音器；暂停时保持当前姿势不再消耗 CPU
    const now = performance.now();
    const delta = this.lastTickTime > 0 ? Math.min((now - this.lastTickTime) / 1000, 0.1) : 0;
    this.lastTickTime = now;
    if (this.rigPlaying && this.rigMixer) {
      this.rigMixer.update(delta);
      // 蒙皮网格每帧都在形变，阴影贴图也要跟着重算
      this.renderer.shadowMap.needsUpdate = true;
      this.renderRequested = true;
    }

    // OrbitControls 的阻尼与自动旋转会让相机持续变化；update() 返回 true 表示这一帧相机动了
    const cameraChanged = this.controls.update();
    if (!cameraChanged && !this.renderRequested) return;
    this.renderRequested = false;
    // 高亮包围盒跟着自动旋转/模型动作刷新
    this.nodeHighlighter?.refreshBoxes();
    this.axis?.update(this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.requestRender();
  }

  get currentStats(): MeshStats | null {
    return this.stats;
  }

  /** 加载并自动取景；返回网格统计信息 */
  async load(target: LoadTarget): Promise<MeshStats> {
    const token = ++this.loadToken;
    const object = await this.loadObject(target);
    // 加载期间切换了素材 / 播放器已销毁：本次结果已过期，释放后丢弃，
    // 否则过期模型会装上画面并覆盖新素材的状态
    if (this.disposed || token !== this.loadToken) {
      disposeObject(object);
      throw new ViewerCanceledError();
    }
    this.clear();

    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (material && 'side' in material) material.side = THREE.FrontSide;
        }
      }
    });

    const stats = collectStats(object, target.format);
    const root = new THREE.Group();
    root.add(object);

    // 归一化：居中 + 缩放到合适尺寸 + 落在网格上
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDimension = Math.max(size.x, size.y, size.z) || 1;
    const scale = 2.4 / maxDimension;
    object.position.sub(center);
    root.scale.setScalar(scale);
    root.position.y = (size.y / 2) * scale;
    root.updateMatrixWorld(true);

    // 供 ARP 面板 Setup 区展示：从 URL 取文件名、归一化后包围盒高度
    const urlName = target.url.split('/').pop() ?? target.url;
    stats.name = decodeURIComponent(urlName.split('?')[0] || urlName);
    stats.bboxSize = size.y * scale;

    this.modelRoot = root;
    this.scene.add(root);
    this.stats = stats;
    // 节点树：展示模型的对象层级，并支持点击高亮
    if (!this.nodeHighlighter) this.nodeHighlighter = new NodeHighlighter(this.scene);
    this.sceneTree = this.nodeHighlighter.reset(root);
    this.applyWireframeState();
    this.frameCamera(size.y * scale);
    // 新模型可能换了尺寸/位置，阴影贴图必须重算
    this.invalidateShadows();
    return stats;
  }

  // ===== 场景节点树 =====

  get sceneNodes(): SceneNode[] {
    return this.sceneTree;
  }

  get selectedNodeList(): string[] {
    return this.nodeHighlighter?.selection ?? [];
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

  private async loadObject(target: LoadTarget): Promise<THREE.Object3D> {
    const format = target.format.toLowerCase();
    switch (format) {
      case 'glb':
      case 'gltf': {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(target.url);
        return gltf.scene ?? gltf.scenes[0]!;
      }
      case 'obj': {
        const loader = new OBJLoader();
        let materialCreator: MTLLoader.MaterialCreator | null = null;
        if (target.materialUrl) {
          try {
            const mtlLoader = new MTLLoader();
            materialCreator = await mtlLoader.loadAsync(target.materialUrl);
            materialCreator.preload();
            loader.setMaterials(materialCreator);
          } catch {
            // 材质加载失败时退化为默认材质
          }
        }
        try {
          return await loader.loadAsync(target.url);
        } catch (err) {
          // 模型解析失败时材质已经建好但不会有人用了，就地释放，避免一次失败泄漏一批贴图
          if (materialCreator) disposeMaterialCreator(materialCreator);
          throw err;
        }
      }
      case 'stl': {
        const geometry = await new STLLoader().loadAsync(target.url);
        geometry.computeVertexNormals();
        return new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: 0xd6d9e0, metalness: 0.05, roughness: 0.5 }),
        );
      }
      case 'fbx': {
        return await new FBXLoader().loadAsync(target.url);
      }
      default:
        throw new Error(`浏览器不支持预览 ${format.toUpperCase()} 格式，请下载文件后用本地软件打开`);
    }
  }

  /** 让相机框住模型 */
  private frameCamera(modelHeight: number): void {
    const distance = Math.max(2.6, modelHeight * 2.1);
    this.controls.target.set(0, Math.max(0.6, modelHeight * 0.5), 0);
    this.camera.position.set(distance * 0.72, modelHeight * 0.68 + 0.9, distance * 0.9);
    this.camera.near = Math.max(0.02, distance / 200);
    this.camera.far = distance * 40;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  resetView(): void {
    if (!this.modelRoot) return;
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const size = new THREE.Vector3();
    box.getSize(size);
    this.frameCamera(size.y);
  }

  clear(): void {
    // 让在途的加载 / 绑骨结果作废：它们返回时模型已经不是当前这一份
    this.loadToken += 1;
    this.autoRigToken += 1;
    // 手动绑骨的标记 / 预览骨架挂在场景根，必须先拆掉，否则会留在画面上
    this.endManualRig();
    this.clearNodeSelection();
    this.sceneTree = [];
    // 先停动画（此时 modelRoot 还在，可还原姿态、解绑混音器），再拆场景对象
    this.rigAnimationActive = false;
    this.stopRigAnimation();
    this.rigRestPose = null;
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose();
      this.skeletonHelper = null;
    }
    if (this.wireOverlay) {
      this.scene.remove(this.wireOverlay);
      disposeObject(this.wireOverlay);
      this.wireOverlay = null;
    }
    if (this.modelRoot) {
      this.scene.remove(this.modelRoot);
      disposeObject(this.modelRoot);
      this.modelRoot = null;
    }
    this.stats = null;
    this.rigged = false;
    this.invalidateShadows();
  }

  // ===== 自动绑骨 =====

  /** 模型是否自带骨架（含已蒙皮的 SkinnedMesh） */
  get hasSkeleton(): boolean {
    return this.modelRoot ? rootHasSkeleton(this.modelRoot) : false;
  }

  /** 是否已通过 autoRig() 完成自动绑骨 */
  get isRigged(): boolean {
    return this.rigged;
  }

  get isSkeletonVisible(): boolean {
    return this.skeletonHelper?.visible ?? false;
  }

  /** 当前模型是否已被手动或绑骨流程纠正过朝向（modelRoot.rotation.y 不为 0） */
  get isOrientationCorrected(): boolean {
    return this.modelRoot !== null && Math.abs(this.modelRoot.rotation.y) > 1e-4;
  }

  /**
   * 旋转模型朝向（对应 ARP Smart 面板的 Turn 按钮，绕 Y 轴转指定角度）。
   * 已绑骨时同步刷新骨架辅助线与阴影。
   */
  turnModel(degrees: number): void {
    if (!this.modelRoot) return;
    this.modelRoot.rotation.y += (degrees * Math.PI) / 180;
    this.modelRoot.updateMatrixWorld(true);
    if (this.rigged && this.skeletonHelper) this.skeletonHelper.updateMatrixWorld(true);
    this.invalidateShadows();
    this.requestRender();
  }

  /**
   * 单独纠正模型朝向（不依赖绑骨）。
   * 检测当前模型的水平朝向，若偏离 glTF 约定的 +Z 正面，把 modelRoot 绕 Y 轴旋转回来。
   * 已纠正时再点一次会还原到原始朝向（toggle），方便对比效果。
   *
   * @returns 实际施加的旋转量；yaw 为 0 表示无需纠正
   */
  correctOrientation(): OrientationFix {
    if (!this.modelRoot) throw new Error('当前没有已加载的模型');

    // 如果已经纠正过，先还原到 0 再重新检测，避免 detectOrientation 在旋转后的模型上再转一遍
    if (this.isOrientationCorrected) {
      this.modelRoot.rotation.y = 0;
      this.modelRoot.updateMatrixWorld(true);
      if (this.rigged) {
        // 已绑骨时，骨架层是 modelRoot 的子节点，还原旋转后也要把 skeletonHelper 刷新一下
        if (this.skeletonHelper) this.skeletonHelper.updateMatrixWorld(true);
      }
      this.invalidateShadows();
      return { yaw: 0, note: '已还原模型原始朝向' };
    }

    const meshes: THREE.Mesh[] = [];
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry?.getAttribute('position')) meshes.push(mesh);
    });
    if (meshes.length === 0) return { yaw: 0, note: '' };

    const fix = detectOrientation(this.modelRoot, meshes);
    if (fix.yaw !== 0) {
      this.modelRoot.rotation.y += fix.yaw;
      this.modelRoot.updateMatrixWorld(true);
      if (this.rigged && this.skeletonHelper) this.skeletonHelper.updateMatrixWorld(true);
      this.invalidateShadows();
    }
    return fix;
  }

  /**
   * 对当前模型做人形 T-pose 自动绑骨（模板骨架拟合 + 胶囊距离蒙皮）。
   * 绑定后模型外观不变，但每个网格变成 SkinnedMesh，可显示骨骼并导出 GLB。
   */
  async autoRig(onProgress?: AutoRigProgress): Promise<AutoRigResult> {
    if (!this.modelRoot) throw new Error('当前没有已加载的模型');
    if (this.hasSkeleton) throw new Error('模型已包含骨架，无需自动绑定');
    const token = ++this.autoRigToken;
    const root = this.modelRoot;
    const result = await autoRigHumanoid(root, onProgress);
    // 绑骨期间切换了素材 / 播放器已销毁：不能把骨架状态记到新的模型上
    if (this.disposed || token !== this.autoRigToken || this.modelRoot !== root) {
      throw new ViewerCanceledError();
    }
    this.rigged = true;
    // 记录绑定姿态：播放 / 停止动画时都从它出发，保证预览不会污染原始姿势
    this.captureRigRestPose();
    // 节点树与线框叠加都按绑骨后的新结构重建
    if (this.nodeHighlighter) this.sceneTree = this.nodeHighlighter.reset(this.modelRoot);
    this.applyWireframeState();
    this.setSkeletonVisible(true);
    this.invalidateShadows();
    return result;
  }

  // ===== 手动绑骨（参考关节拖拽） =====

  /** 是否处于手动绑骨编辑状态 */
  get isManualRigActive(): boolean {
    return this.manualRig !== null;
  }

  /** 供侧栏渲染的快照（标记状态 + 关节列表 + 选中项 + 坐标） */
  private manualRigSnapshot(): ManualRigSnapshot {
    const state = this.manualRig;
    return {
      active: state !== null,
      selected: this.manualRigSelected,
      fingersVisible: this.manualRigFingersVisible,
      xray: this.manualRigXRay,
      bonesVisible: this.manualRigBonesVisible,
      placing: this.manualRigPlacing,
      mirror: this.manualRigMirror,
      markerDepth: this.manualRigMarkerDepth,
      placed: state ? [...state.placed] : [],
      canBuild: state ? hasRequiredMarkers(state) : false,
      missing: state ? missingManualMarkers(state).map((marker) => marker.label) : [],
      fingerScale: state?.fingerScale ?? 1,
      height: state?.metrics.height ?? 0,
      joints: state ? manualJointInfos(state) : [],
    };
  }

  /**
   * 建参考骨架（ARP 的 Add Armature）。
   * 默认生成预览骨骼并放置全部标记（Guess Markers）；用户逐个「添加」标记时
   * 传 createBones=false，只建标记、不生成骨骼，避免骨架挡住标记操作。
   */
  startManualRig(options: { guessMarkers?: boolean; createBones?: boolean } = {}): ManualRigSnapshot {
    if (!this.modelRoot) throw new Error('当前没有已加载的模型');
    if (this.hasSkeleton) throw new Error('模型已包含骨架，无需手动绑定');
    const meshes = this.collectBindableMeshes();
    if (meshes.length === 0) throw new Error('模型里没有可绑定的网格');

    this.cancelManualRig();
    this.stopRigAnimation();

    this.manualRig = buildManualRigState(this.modelRoot, meshes, options);
    this.manualRigSelected = null;
    this.manualRigPlacing = null;
    this.manualRigFingersVisible = true;
    // createBones=false：只进入标记编辑，不生成预览骨骼
    this.manualRigBonesVisible = options.createBones !== false;
    this.manualRigAbort = new AbortController();
    // 编辑期间先隐藏自动绑骨留下的骨骼连线，避免两套骨架叠在一起看不清
    if (this.skeletonHelper) this.skeletonHelper.visible = false;

    this.buildManualRigMarkers();
    if (this.manualRigBonesVisible) this.attachManualRigBones();
    this.attachManualRigPointer();
    this.emitManualRig();
    return this.manualRigSnapshot();
  }

  /** 一次性按几何拟合放置全部标记（ARP 的 Guess Markers） */
  guessManualRigMarkers(): ManualRigSnapshot {
    const state = this.manualRig;
    if (!state) return this.startManualRig({ guessMarkers: true });
    guessManualMarkers(state);
    this.refreshManualRig();
    return this.manualRigSnapshot();
  }

  /**
   * 开始在视口放置某个标记（ARP 的 Add Markers）：
   * 下一次左键点击模型即为落点，Esc 取消。
   */
  beginManualMarkerPlacement(name: string | null): void {
    const state = this.manualRig;
    if (!state) return;
    this.manualRigPlacing = name && state.joints.has(name) ? name : null;
    this.renderer.domElement.style.cursor = this.manualRigPlacing ? 'crosshair' : '';
    if (this.manualRigPlacing) this.manualRigSelected = this.manualRigPlacing;
    this.updateManualRigSelection();
    this.requestRender();
    this.emitManualRig();
  }

  /** 镜像开关：放置左右标记时对侧一起落位 */
  setManualRigMirror(on: boolean): void {
    if (!this.manualRig || this.manualRigMirror === on) return;
    this.manualRigMirror = on;
    this.emitManualRig();
  }

  /** 「使用标记深度」开关 */
  setManualRigMarkerDepth(on: boolean): void {
    if (!this.manualRig || this.manualRigMarkerDepth === on) return;
    this.manualRigMarkerDepth = on;
    this.emitManualRig();
  }

  /** 手指粗细缩放（按拟合半径的比例） */
  setManualRigFingerScale(scale: number): void {
    const state = this.manualRig;
    if (!state) return;
    setFingerRadiusScale(state, scale);
    this.emitManualRig();
  }

  /** 取消和删除标记：先记录这一局的落点，再清空标记 */
  removeManualMarkers(): void {
    const state = this.manualRig;
    if (!state) return;
    this.manualRigLastMarkers = captureManualMarkers(state);
    clearManualMarkers(state);
    this.manualRigPlacing = null;
    this.renderer.domElement.style.cursor = '';
    this.refreshManualRig();
  }

  /** 恢复上局标记（没有会话时只进入标记编辑，不生成骨骼） */
  restoreManualMarkers(): ManualRigSnapshot {
    if (!this.manualRig) this.startManualRig({ createBones: false });
    const state = this.manualRig;
    if (state && this.manualRigLastMarkers) applyMarkerSnapshot(state, this.manualRigLastMarkers);
    if (state) this.refreshManualRig();
    return this.manualRigSnapshot();
  }

  /** 选中某个关节（侧栏点击关节名时调用） */
  selectManualRigJoint(name: string | null): void {
    if (!this.manualRig) return;
    this.manualRigSelected = name && this.manualRig.joints.has(name) ? name : null;
    this.updateManualRigSelection();
    this.requestRender();
    this.emitManualRig();
  }

  /** 侧栏输入坐标：直接改写关节位置（世界坐标） */
  moveManualRigJoint(name: string, position: readonly [number, number, number]): void {
    const state = this.manualRig;
    if (!state) return;
    const point = state.joints.get(name);
    if (!point) return;
    if (!position.every((value) => Number.isFinite(value))) return;
    moveManualJointTo(state, name, new THREE.Vector3(position[0], position[1], position[2]));
    this.refreshManualRig();
  }

  /** 关节 / 标记变化后的统一刷新：预览骨架、标记球、选中态与侧栏快照 */
  private refreshManualRig(): void {
    this.syncManualRigBones();
    this.syncManualRigMarkers();
    this.updateManualRigSelection();
    this.emitManualRig();
  }

  /** 以模型中线为对称面，把左侧关节镜像到右侧 */
  mirrorManualRig(): void {
    if (!this.manualRig) return;
    mirrorManualJoints(this.manualRig);
    this.syncManualRigBones();
    this.syncManualRigMarkers();
    this.emitManualRig();
  }

  /** 恢复到进入手动绑骨时的初始关节位置 */
  resetManualRig(): void {
    if (!this.manualRig) return;
    resetManualJoints(this.manualRig);
    this.syncManualRigBones();
    this.syncManualRigMarkers();
    this.emitManualRig();
  }

  /** 手指关节标记显示开关（只影响标记，绑定仍包含手指骨） */
  setManualRigFingersVisible(on: boolean): void {
    if (!this.manualRig || this.manualRigFingersVisible === on) return;
    this.manualRigFingersVisible = on;
    this.updateManualRigSelection();
    this.requestRender();
    this.emitManualRig();
  }

  /** 修改某根参考骨的胶囊半径（Auto-Rig Pro 的参考骨 radius） */
  setManualRigRadius(name: string, radius: number): void {
    const state = this.manualRig;
    if (!state) return;
    setManualRigRadius(state, name, radius);
    this.emitManualRig();
  }

  /** X-Ray 开关：关闭后关节标记会被模型遮挡 */
  setManualRigXRay(on: boolean): void {
    if (!this.manualRig || this.manualRigXRay === on) return;
    this.manualRigXRay = on;
    this.applyManualRigMarkerDepth();
    this.requestRender();
    this.emitManualRig();
  }

  /** 预览骨架连线显示开关；没有骨架时先按需生成（ARP 的 Add Armature 可随时补上） */
  setManualRigBonesVisible(on: boolean): void {
    if (!this.manualRig) return;
    if (on && !this.manualRigHelper) {
      this.showManualRigBones();
      return;
    }
    if (this.manualRigBonesVisible === on) return;
    this.manualRigBonesVisible = on;
    if (this.manualRigHelper) this.manualRigHelper.visible = on;
    this.requestRender();
    this.emitManualRig();
  }

  /**
   * 生成参考骨架预览（ARP 的 Add Armature）。
   * 逐个添加标记时不会建骨；用户显式点 Add Armature / Bones 开关时才走到这里，
   * 已放置的标记位置会保留。
   */
  showManualRigBones(): ManualRigSnapshot {
    if (!this.manualRig) return this.startManualRig();
    this.manualRigBonesVisible = true;
    if (!this.manualRigHelper) this.attachManualRigBones();
    this.refreshManualRig();
    return this.manualRigSnapshot();
  }

  /**
   * 按当前关节坐标完成绑定：重建胶囊 → 算权重 → 换绑 SkinnedMesh。
   *
   * @returns 建骨 / 换绑结果；被新素材取代时抛 ViewerCanceledError
   */
  async applyManualRig(onProgress?: AutoRigProgress): Promise<BoundRigResult> {
    const state = this.manualRig;
    const root = this.modelRoot;
    if (!state || !root) throw new Error('当前不在手动绑骨状态');
    this.onManualRigPointerUp();
    this.manualRigPlacing = null;
    this.renderer.domElement.style.cursor = '';

    // 必需标记不齐就建骨会得到错位的胶囊，先拦住并提示缺哪几个
    const missing = missingManualMarkers(state);
    if (missing.length > 0) {
      throw new Error(`还有 ${missing.length} 个必需标记没有放置：${missing.map((item) => item.label).join('、')}`);
    }

    const token = ++this.autoRigToken;
    const meshes = this.collectBindableMeshes();
    if (meshes.length === 0) throw new Error('模型里没有可绑定的网格');
    const capsules = buildManualCapsules(state);
    const joints = new Map<string, THREE.Vector3>();
    for (const [name, point] of state.joints) joints.set(name, point.clone());

    const bound = await buildBoundRig(
      root,
      meshes,
      state.boneDefs,
      joints,
      capsules,
      state.metrics.height,
      state.metrics.centerX,
      onProgress,
    );
    // 绑骨期间切换了素材 / 播放器已销毁：骨架不能记到新模型上
    if (this.disposed || token !== this.autoRigToken || this.modelRoot !== root) {
      throw new ViewerCanceledError();
    }

    // 预览骨架必须先摘掉：它的骨名与真实骨架重名，会污染绑定姿态记录
    this.endManualRig();
    this.rigged = true;
    this.captureRigRestPose();
    if (this.nodeHighlighter) this.sceneTree = this.nodeHighlighter.reset(this.modelRoot);
    this.applyWireframeState();
    this.setSkeletonVisible(true);
    this.invalidateShadows();
    return bound;
  }

  /** 放弃手动绑骨（关节改动不生效） */
  cancelManualRig(): void {
    if (!this.manualRig) return;
    this.endManualRig();
  }

  private endManualRig(): void {
    // 会话结束前记下落点，供「恢复上局标记」使用
    if (this.manualRig) this.manualRigLastMarkers = captureManualMarkers(this.manualRig);
    this.releaseManualRigPointer();
    this.disposeManualRigMarkers();
    this.detachManualRigBones();
    this.manualRigDrag = null;
    this.manualRigPlacing = null;
    this.renderer.domElement.style.cursor = '';
    this.manualRig = null;
    this.manualRigSelected = null;
    this.controls.enabled = true;
    this.requestRender();
    this.emitManualRig();
  }

  private collectBindableMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    this.modelRoot?.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (!mesh.geometry?.getAttribute('position')) return;
      meshes.push(mesh);
    });
    return meshes;
  }

  private buildManualRigMarkers(): void {
    const state = this.manualRig;
    if (!state) return;
    this.disposeManualRigMarkers();

    const group = new THREE.Group();
    group.name = 'manual-rig-markers';
    // 标记球尺寸按身高取，缩放过的模型与原始尺寸模型都保持同样的视觉大小
    const radius = Math.max(0.008, Math.min(0.05, state.metrics.height * 0.013));
    const geometry = new THREE.SphereGeometry(radius, 16, 12);
    const boneNames = new Set(state.boneDefs.map((def) => def.name));

    for (const name of state.jointOrder) {
      const point = state.joints.get(name);
      if (!point) continue;
      const marker = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: 0x4da3ff,
          depthTest: false,
          transparent: true,
          opacity: 0.92,
        }),
      );
      marker.name = name;
      marker.position.copy(point);
      // X-Ray 开启时永远画在模型前面：被关节埋在网格里也能看见、可点中
      marker.userData.kind = boneNames.has(name) ? 'bone' : 'tip';
      marker.userData.finger = isFingerJoint(name);
      group.add(marker);
      this.manualRigMarkers.set(name, marker);
    }

    this.manualRigGroup = group;
    this.scene.add(group);
    this.applyManualRigMarkerDepth();
    this.updateManualRigSelection();
    this.syncManualRigMarkers();
  }

  /** 按 X-Ray 状态设置标记的绘制深度：关闭后标记会被模型遮挡，便于确认关节是否埋进网格 */
  private applyManualRigMarkerDepth(): void {
    for (const marker of this.manualRigMarkers.values()) {
      const material = marker.material as THREE.MeshBasicMaterial;
      material.depthTest = this.manualRigXRay;
      material.transparent = this.manualRigXRay;
      material.opacity = this.manualRigXRay ? 0.92 : 1;
      material.needsUpdate = true;
      marker.renderOrder = this.manualRigXRay ? 1000 : 0;
    }
  }

  private disposeManualRigMarkers(): void {
    const group = this.manualRigGroup;
    if (group) {
      this.scene.remove(group);
      const geometries = new Set<THREE.BufferGeometry>();
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        (mesh.material as THREE.Material).dispose();
      });
      for (const geometry of geometries) geometry.dispose();
      this.manualRigGroup = null;
    }
    this.manualRigMarkers.clear();
  }

  /** 标记的颜色 / 选中放大 / 手指与未放置标记的显隐 */
  private updateManualRigSelection(): void {
    const state = this.manualRig;
    for (const [name, marker] of this.manualRigMarkers) {
      const material = marker.material as THREE.MeshBasicMaterial;
      const selected = name === this.manualRigSelected;
      const finger = marker.userData.finger === true;
      // 未放置的 Smart 标记不显示：必须先在面板里「添加」再点模型落点
      const isMarker = MARKER_JOINTS.has(name);
      const placed = !isMarker || state?.placed.has(name) === true;
      marker.visible = placed && (this.manualRigFingersVisible || !finger);
      marker.scale.setScalar(selected ? 1.7 : 1);
      material.color.setHex(
        selected
          ? 0xff4d6d
          : isMarker
            ? 0x39d98a
            : finger
              ? 0x9d7bff
              : marker.userData.kind === 'tip'
                ? 0xffa94d
                : 0x4da3ff,
      );
    }
  }

  private syncManualRigMarkers(): void {
    const state = this.manualRig;
    if (!state) return;
    for (const [name, marker] of this.manualRigMarkers) {
      const point = state.joints.get(name);
      if (point) marker.position.copy(point);
    }
    this.requestRender();
  }

  /** 建立预览骨架（挂在 modelRoot 下的 Bone 层级，只用于画 SkeletonHelper） */
  private attachManualRigBones(): void {
    const root = this.modelRoot;
    const state = this.manualRig;
    if (!root || !state) return;
    this.detachManualRigBones();
    root.updateMatrixWorld(true);

    const boneMap = new Map<string, THREE.Bone>();
    for (const def of state.boneDefs) {
      const bone = new THREE.Bone();
      bone.name = def.name;
      boneMap.set(def.name, bone);
    }
    for (const def of state.boneDefs) {
      if (!def.parent) continue;
      const parent = boneMap.get(def.parent);
      const child = boneMap.get(def.name);
      if (parent && child) parent.add(child);
    }
    const rootBone = boneMap.get(state.boneDefs[0]?.name ?? '');
    if (!rootBone) return;

    root.add(rootBone);
    this.manualRigRootBone = rootBone;
    this.applyManualBonePositions(boneMap, state, root);

    const helper = new THREE.SkeletonHelper(rootBone);
    (helper.material as THREE.LineBasicMaterial).depthTest = false;
    helper.renderOrder = 999;
    helper.visible = this.manualRigBonesVisible;
    this.manualRigHelper = helper;
    this.scene.add(helper);
    this.requestRender();
  }

  /** 关节位置变化后重算预览骨骼的局部坐标并刷新连线 */
  private syncManualRigBones(): void {
    const root = this.modelRoot;
    const state = this.manualRig;
    if (!root || !state || !this.manualRigRootBone) return;
    const boneMap = new Map<string, THREE.Bone>();
    this.manualRigRootBone.traverse((child) => {
      const bone = child as THREE.Bone;
      if (bone.isBone) boneMap.set(bone.name, bone);
    });
    this.applyManualBonePositions(boneMap, state, root);
  }

  /**
   * 把世界坐标关节换算成骨骼局部坐标。
   * boneDefs 已按「父先子后」排列，逐根更新父骨骼世界矩阵后 worldToLocal 才是准的。
   */
  private applyManualBonePositions(
    boneMap: Map<string, THREE.Bone>,
    state: ManualRigState,
    root: THREE.Object3D,
  ): void {
    for (const def of state.boneDefs) {
      const joint = state.joints.get(def.name);
      const bone = boneMap.get(def.name);
      const container = bone?.parent;
      if (!joint || !bone || !container) continue;
      container.updateWorldMatrix(true, false);
      bone.position.copy(container.worldToLocal(joint.clone()));
    }
    root.updateMatrixWorld(true);
    // three r171 的 SkeletonHelper 把绘制逻辑挂在 updateMatrixWorld 上（没有 update()）
    this.manualRigHelper?.updateMatrixWorld(true);
    this.requestRender();
  }

  private detachManualRigBones(): void {
    if (this.manualRigHelper) {
      this.scene.remove(this.manualRigHelper);
      this.manualRigHelper.dispose();
      this.manualRigHelper = null;
    }
    if (this.manualRigRootBone) {
      this.manualRigRootBone.removeFromParent();
      this.manualRigRootBone = null;
    }
  }

  /**
   * 在容器上以 capture 阶段监听 pointerdown：
   * 只有命中关节标记时才 stopPropagation，让 OrbitControls 收不到这次按下，
   * 从而把这一次拖拽让给关节；没命中时照常旋转视角。
   */
  private attachManualRigPointer(): void {
    const signal = this.manualRigAbort?.signal;
    if (!signal) return;
    this.container.addEventListener('pointerdown', this.onManualRigPointerDown, { capture: true, signal });
    // 兜底：个别指针设备 / 自动化只派发 click 不派发 pointerdown，这里再补一次落点
    window.addEventListener('click', this.onManualRigPlaceClick, { capture: true, signal });
    // Esc 取消正在进行的标记放置
    window.addEventListener('keydown', this.onManualRigKeyDown, { signal });
  }

  private releaseManualRigPointer(): void {
    this.manualRigAbort?.abort();
    this.manualRigAbort = null;
    window.removeEventListener('pointermove', this.onManualRigPointerMove, true);
    window.removeEventListener('pointerup', this.onManualRigPointerUp, true);
    window.removeEventListener('pointercancel', this.onManualRigPointerUp, true);
  }

  private onManualRigKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.manualRigPlacing) return;
    this.manualRigPlacing = null;
    this.renderer.domElement.style.cursor = '';
    this.emitManualRig();
  };

  private onManualRigPointerDown = (event: PointerEvent): void => {
    if (!this.manualRig || event.button !== 0) return;

    // 标记添加中：这一下就是落点，不能同时触发视角旋转
    if (this.manualRigPlacing) {
      event.stopPropagation();
      event.preventDefault();
      this.placeManualMarkerAt(event);
      return;
    }

    const marker = this.pickManualRigMarker(event);
    if (!marker) return;

    // 命中关节：这一下交给拖拽，不要再让 OrbitControls 开始旋转
    event.stopPropagation();
    event.preventDefault();
    this.manualRigSelected = marker.name;
    this.updateManualRigSelection();
    this.manualRigDrag = {
      name: marker.name,
      // 拖拽平面过关节、法线朝相机：屏幕上的位移直接映射成关节位移
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(
        this.camera.getWorldDirection(new THREE.Vector3()),
        marker.position,
      ),
    };
    this.controls.enabled = false;
    window.addEventListener('pointermove', this.onManualRigPointerMove, true);
    window.addEventListener('pointerup', this.onManualRigPointerUp, true);
    window.addEventListener('pointercancel', this.onManualRigPointerUp, true);
    this.emitManualRig();
  };

  private onManualRigPointerMove = (event: PointerEvent): void => {
    const drag = this.manualRigDrag;
    const state = this.manualRig;
    if (!drag || !state) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();

    this.manualRigPointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.manualRigRaycaster.setFromCamera(this.manualRigPointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.manualRigRaycaster.ray.intersectPlane(drag.plane, hit)) return;
    if (!state.joints.has(drag.name)) return;

    // 用 moveManualJointTo 而不是直接 copy：移动手腕时手指、手尖一起跟随
    moveManualJointTo(state, drag.name, hit);
    this.syncManualRigBones();
    this.syncManualRigMarkers();
    this.emitManualRig();
  };

  private onManualRigPointerUp = (): void => {
    if (!this.manualRigDrag) return;
    this.manualRigDrag = null;
    this.controls.enabled = true;
    window.removeEventListener('pointermove', this.onManualRigPointerMove, true);
    window.removeEventListener('pointerup', this.onManualRigPointerUp, true);
    window.removeEventListener('pointercancel', this.onManualRigPointerUp, true);
    this.emitManualRig();
  };

  private pickManualRigMarker(event: PointerEvent): THREE.Mesh | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.manualRigPointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.manualRigRaycaster.setFromCamera(this.manualRigPointer, this.camera);
    const candidates = [...this.manualRigMarkers.values()].filter((marker) => marker.visible);
    const hits = this.manualRigRaycaster.intersectObjects(candidates, false);
    const hit = hits[0]?.object as THREE.Mesh | undefined;
    return hit && hit.isMesh ? hit : null;
  }

  /** click 兜底：pointerdown 已经把落点处理掉时 placing 已清空，不会重复放置 */
  private onManualRigPlaceClick = (event: MouseEvent): void => {
    if (!this.manualRigPlacing) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) return;
    event.stopPropagation();
    event.preventDefault();
    this.placeManualMarkerAt(event);
  };

  /**
   * 把当前「添加中」的标记落到点击位置。
   * 落点写进关节后立刻退出添加模式，选中新标记便于继续微调。
   */
  private placeManualMarkerAt(event: { clientX: number; clientY: number }): void {
    const state = this.manualRig;
    const name = this.manualRigPlacing;
    if (!state || !name) return;
    const point = this.resolveMarkerPlacement(state, name, event);
    // 点在空白处（射线既没打到模型也没打中深度平面）：保持添加模式，等下一次点击
    if (!point) return;

    const changed = placeManualMarker(state, name, point, this.manualRigMirror);
    this.manualRigPlacing = null;
    this.renderer.domElement.style.cursor = '';
    this.manualRigSelected = changed[0] ?? name;
    this.refreshManualRig();
  }

  /**
   * 计算标记落点：
   *  - 开启「使用标记深度」时贴到网格表面（ARP 的 Use Markers Depth）；
   *  - 关闭时保持标记当前深度，只按屏幕位置移动（过标记且朝向相机的平面）。
   */
  private resolveMarkerPlacement(
    state: ManualRigState,
    name: string,
    event: { clientX: number; clientY: number },
  ): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.manualRigPointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.manualRigRaycaster.setFromCamera(this.manualRigPointer, this.camera);

    if (this.manualRigMarkerDepth) {
      const hits = this.manualRigRaycaster.intersectObjects(this.collectBindableMeshes(), false);
      if (hits[0]) return hits[0].point.clone();
    }

    const current =
      state.joints.get(name) ??
      new THREE.Vector3(
        state.metrics.centerX,
        state.metrics.baseY + state.metrics.height * 0.5,
        state.metrics.centerZ,
      );
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(new THREE.Vector3()),
      current,
    );
    const hit = new THREE.Vector3();
    return this.manualRigRaycaster.ray.intersectPlane(plane, hit) ? hit : null;
  }

  private emitManualRig(): void {
    this.onManualRigChange?.(this.manualRigSnapshot());
    this.requestRender();
  }

  // ===== 绑骨后的动画预览 =====

  /** 是否已挂载预览动画（暂停也算） */
  get hasRigAnimation(): boolean {
    return this.rigAction !== null;
  }

  get isRigAnimationPlaying(): boolean {
    return this.rigPlaying;
  }

  /**
   * 加载动画库里的一段 FBX 动画，重定向到自动绑骨骨架并循环播放。
   *
   * 重定向前会先停止当前动画、把骨架还原成绑定姿态 —— 重定向以「绑定姿态」
   * 作为参考姿态，若骨架还停在上一条动画的姿势里，结果会叠加两次偏移。
   *
   * @param url 动画取流地址（animationApi.fileUrl）
   * @returns 是否成功挂载；连续切换时被更新的一次选择会返回 false
   */
  async playRigAnimation(url: string): Promise<boolean> {
    if (!this.modelRoot || !this.rigged) throw new Error('请先完成自动绑骨');
    const token = ++this.rigLoadToken;
    const source = await new FBXLoader().loadAsync(url);

    try {
      if (this.disposed || token !== this.rigLoadToken || !this.modelRoot) return false;

      const sourceClip = (source.animations ?? []).find(
        (clip) => clip.duration > 1e-3 && clip.tracks.length > 0,
      );
      if (!sourceClip) throw new Error('该动画文件里没有可播放的片段');

      // 先回到绑定姿态，再以它作为重定向的参考
      this.stopRigAnimation();
      const retargeted = retargetClipToRig(this.modelRoot, source, sourceClip);
      if (!retargeted) throw new Error('该动画的骨架与自动绑骨的骨骼无法匹配');

      this.rigMixer = new THREE.AnimationMixer(this.modelRoot);
      this.rigAction = this.rigMixer.clipAction(retargeted.clip);
      this.rigAction.setLoop(THREE.LoopRepeat, Infinity);
      this.rigAction.play();
      this.rigPlaying = true;
      this.lastTickTime = performance.now();

      // 静态线框叠加层不会跟随蒙皮形变，播放期间切回材质自带线框
      this.setRigAnimationActive(true);
      this.invalidateShadows();
      return true;
    } finally {
      // 源 FBX 只用于采样动画，骨骼数据已经转成关键帧轨道，可以整个释放
      disposeObject(source);
    }
  }

  /** 播放 / 暂停当前预览动画（暂停时保留当前姿势） */
  setRigAnimationPlaying(on: boolean): void {
    if (!this.rigMixer) return;
    this.rigPlaying = on;
    this.lastTickTime = performance.now();
    this.requestRender();
  }

  /** 停止预览动画并还原绑定姿态（同时让在途的动画加载结果作废） */
  stopRigAnimation(): void {
    this.rigLoadToken += 1;
    if (this.rigMixer) {
      this.rigMixer.stopAllAction();
      if (this.modelRoot) this.rigMixer.uncacheRoot(this.modelRoot);
      this.rigMixer = null;
    }
    this.rigAction = null;
    this.rigPlaying = false;
    this.resetRigPose();
    this.setRigAnimationActive(false);
    this.requestRender();
  }

  /** 抓取当前骨骼的局部变换作为绑定姿态 */
  private captureRigRestPose(): void {
    const pose = new Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
    this.modelRoot?.traverse((child) => {
      const bone = child as THREE.Bone;
      if (!bone.isBone) return;
      pose.set(bone.name, {
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone(),
      });
    });
    this.rigRestPose = pose;
  }

  private resetRigPose(): void {
    if (!this.modelRoot || !this.rigRestPose) return;
    const pose = this.rigRestPose;
    this.modelRoot.traverse((child) => {
      const bone = child as THREE.Bone;
      if (!bone.isBone) return;
      const rest = pose.get(bone.name);
      if (!rest) return;
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
      bone.scale.copy(rest.scale);
    });
    this.modelRoot.updateMatrixWorld(true);
    this.invalidateShadows();
  }

  /** 播放状态变化时重建线框表现（绑定姿态的静态叠加层在动画中会穿帮） */
  private setRigAnimationActive(active: boolean): void {
    if (this.rigAnimationActive === active) return;
    this.rigAnimationActive = active;
    this.applyWireframeState();
  }

  /** 骨骼连线显示开关（对绑骨后的模型或自带骨架的模型都有效） */
  setSkeletonVisible(on: boolean): void {
    if (!this.modelRoot || !this.hasSkeleton) {
      this.skeletonHelper?.dispose();
      if (this.skeletonHelper) this.scene.remove(this.skeletonHelper);
      this.skeletonHelper = null;
      this.requestRender();
      return;
    }
    if (!this.skeletonHelper) {
      const helper = new THREE.SkeletonHelper(this.modelRoot);
      (helper.material as THREE.LineBasicMaterial).depthTest = false;
      helper.renderOrder = 999;
      this.skeletonHelper = helper;
      this.scene.add(helper);
    }
    this.skeletonHelper.visible = on;
    this.requestRender();
  }

  /** 把当前模型（含绑骨结果）导出为 GLB 并触发浏览器下载 */
  async exportGlb(filename: string): Promise<void> {
    if (!this.modelRoot) throw new Error('当前没有已加载的模型');
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(this.modelRoot, { binary: true });
    const blob =
      result instanceof ArrayBuffer
        ? new Blob([result], { type: 'model/gltf-binary' })
        : new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename.endsWith('.glb') ? filename : `${filename}.glb`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  setWireframe(on: boolean): void {
    this.wireframeOn = on;
    this.applyWireframeState();
  }

  private applyWireframeState(): void {
    if (!this.modelRoot) return;

    // 移除旧的叠加线框
    if (this.wireOverlay) {
      this.scene.remove(this.wireOverlay);
      disposeObject(this.wireOverlay);
      this.wireOverlay = null;
    }

    // 动画播放中线框叠加层是绑定姿态的静态副本，会与形变后的表面错位，改用材质线框
    const useOverlay =
      !this.rigAnimationActive && (this.stats?.triangles ?? 0) <= MAX_WIREFRAME_OVERLAY_TRIANGLES;
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material && 'wireframe' in material) {
          (material as THREE.MeshStandardMaterial).wireframe = this.wireframeOn && !useOverlay;
        }
      }
    });

    if (!this.wireframeOn || !useOverlay) {
      this.requestRender();
      return;
    }

    // 低面数模型使用独立线框叠加层，保留表面着色同时清晰展示拓扑
    this.modelRoot.updateMatrixWorld(true);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const lines = new THREE.LineSegments(
        new THREE.WireframeGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0x0f1116, transparent: true, opacity: 0.42 }),
      );
      lines.matrixAutoUpdate = false;
      lines.matrix.copy(mesh.matrixWorld); // 叠加层挂在场景根（单位矩阵），直接用世界矩阵
      group.add(lines);
    });
    this.wireOverlay = group;
    this.scene.add(group);
    this.requestRender();
  }

  setGrid(on: boolean): void {
    this.gridOn = on;
    this.grid.visible = on;
    this.shadowPlane.visible = on;
    this.requestRender();
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
    this.requestRender();
  }

  get isGridVisible(): boolean {
    return this.gridOn;
  }

  /** 截取当前视图的方形缩略图（PNG data URL） */
  captureThumbnail(size = 512): string | null {
    if (!this.modelRoot) return null;
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const side = Math.min(source.width, source.height);
    if (side <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // 视口背景是透明的，缩略图补一层深色底
    ctx.fillStyle = '#1b1e25';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(
      source,
      (source.width - side) / 2,
      (source.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    return canvas.toDataURL('image/png');
  }

  /**
   * 滚轮缩放：把各平台的 delta 统一折算成像素后累计，攒够一档才缩放。
   * 这样既能让平滑滚轮/触控板的几像素增量正常缩放，也能让带刻度滚轮保持原来的手感。
   */
  private onWheelZoom = (event: WheelEvent): void => {
    if (this.disposed || !this.controls.enabled) return;
    // Ctrl/⌘/Alt/Shift + 滚轮留给浏览器与其它面板的快捷操作
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    // deltaMode：0=像素 1=行 2=页，统一折算成像素
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.container.clientHeight || 400 : 1;
    const pixels = event.deltaY * unit;
    if (pixels === 0) return;
    event.preventDefault();
    // 拦住 OrbitControls 自带的滚轮缩放，避免同一格被缩放两次
    event.stopImmediatePropagation();
    this.wheelAccum += pixels;
    if (Math.abs(this.wheelAccum) < 48) return;
    // 单次最多 2.4 档，避免高分辨率滚轮 / 快速滑动一下跳太远
    const step = THREE.MathUtils.clamp(this.wheelAccum, -240, 240);
    this.wheelAccum = 0;
    this.zoomBy(Math.pow(0.95, -step / 100));
  };

  /** 沿视线方向推拉相机，等价于 OrbitControls 的 dolly，但缩放量由自己归一化 */
  private zoomBy(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    if (!Number.isFinite(distance) || distance <= 0) return;
    offset.setLength(distance);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('wheel', this.onWheelZoom);
    this.axis?.dispose();
    this.clear();
    this.controls.dispose();
    this.envTarget.dispose();
    this.pmrem.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    // 主动丢弃 WebGL 上下文：切换页签会反复重建播放器，靠浏览器 GC 回收太慢，容易撞上下文上限
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

function collectStats(object: THREE.Object3D, format: string): MeshStats {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  const materials = new Set<THREE.Material>();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshes += 1;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    if (position) vertices += position.count;
    if (geometry.index) triangles += geometry.index.count / 3;
    else if (position) triangles += position.count / 3;
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) if (material) materials.add(material);
  });

  return { format, meshes, triangles: Math.round(triangles), vertices, materials: materials.size, name: '', bboxSize: 0 };
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    // 骨骼贴图由渲染器首次绘制蒙皮网格时创建，挂在 skeleton 上，材质遍历拿不到它
    const skinned = child as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton?.boneTexture) skinned.skeleton.boneTexture.dispose();
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
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

/** 释放 MTL 解析出的材质与贴图（MaterialCreator 没有 dispose，只能逐个释放） */
function disposeMaterialCreator(creator: MTLLoader.MaterialCreator): void {
  for (const material of creator.getAsArray()) {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    material.dispose();
  }
}
