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
  detectOrientation,
  rootHasSkeleton,
  type AutoRigProgress,
  type AutoRigResult,
  type OrientationFix,
} from './autorig/autoRig';

export type { SceneNode };

export interface MeshStats {
  format: string;
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
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
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly axis: AxisIndicator | null;

  /**
   * 是否有待渲染的画面改动。
   * 静止（没有相机阻尼、没有自动旋转、没有模型/选择变化）时不再逐帧渲染，
   * 空闲的预览区几乎不占 GPU —— 页面上同时挂着多个 3D 预览时这一项收益最大。
   */
  private renderRequested = true;

  private modelRoot: THREE.Object3D | null = null;
  private wireOverlay: THREE.Group | null = null;
  private stats: MeshStats | null = null;
  private disposed = false;
  private wireframeOn = false;
  private gridOn = true;

  // ===== 自动绑骨（T-pose 人形） =====
  /** 骨骼可视化助手；挂在场景而不是 modelRoot 上，避免被 GLTF 导出带出去 */
  private skeletonHelper: THREE.SkeletonHelper | null = null;
  /** 当前模型是否已通过 autoRig() 绑定骨架 */
  private rigged = false;

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

    // 右下角 XYZ 轴向指示器（离屏缩略图渲染时不需要）
    this.axis = options.axisIndicator === false ? null : new AxisIndicator(container);

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
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
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
    const object = await this.loadObject(target);
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
        if (target.materialUrl) {
          try {
            const mtlLoader = new MTLLoader();
            const materials = await mtlLoader.loadAsync(target.materialUrl);
            materials.preload();
            loader.setMaterials(materials);
          } catch {
            // 材质加载失败时退化为默认材质
          }
        }
        return await loader.loadAsync(target.url);
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
    this.clearNodeSelection();
    this.sceneTree = [];
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
        if (this.skeletonHelper) this.skeletonHelper.update();
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
      if (this.rigged && this.skeletonHelper) this.skeletonHelper.update();
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
    const result = await autoRigHumanoid(this.modelRoot, onProgress);
    this.rigged = true;
    // 节点树与线框叠加都按绑骨后的新结构重建
    if (this.nodeHighlighter) this.sceneTree = this.nodeHighlighter.reset(this.modelRoot);
    this.applyWireframeState();
    this.setSkeletonVisible(true);
    this.invalidateShadows();
    return result;
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

    const useOverlay = (this.stats?.triangles ?? 0) <= MAX_WIREFRAME_OVERLAY_TRIANGLES;
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

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.axis?.dispose();
    this.clear();
    this.controls.dispose();
    this.pmrem.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
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

  return { format, meshes, triangles: Math.round(triangles), vertices, materials: materials.size };
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
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
