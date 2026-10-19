import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { NodeHighlighter, type SceneNode } from './sceneNodes';

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

  private modelRoot: THREE.Object3D | null = null;
  private wireOverlay: THREE.Group | null = null;
  private stats: MeshStats | null = null;
  private disposed = false;
  private wireframeOn = false;
  private gridOn = true;

  // ===== 场景节点树（与动画页共用 NodeHighlighter）=====
  private sceneTree: SceneNode[] = [];
  private nodeHighlighter: NodeHighlighter | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true, // 便于随时截取缩略图
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

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
    keyLight.shadow.mapSize.set(2048, 2048);
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

  private tick(): void {
    if (this.disposed) return;
    this.controls.update();
    // 高亮包围盒跟着自动旋转/模型动作刷新
    this.nodeHighlighter?.refreshBoxes();
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
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
  }

  clearNodeSelection(): void {
    this.nodeHighlighter?.clear();
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

    if (!this.wireframeOn || !useOverlay) return;

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
  }

  setGrid(on: boolean): void {
    this.gridOn = on;
    this.grid.visible = on;
    this.shadowPlane.visible = on;
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
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
