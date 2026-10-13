import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { SkeletonOverlay, filterShadowBones, type BoneNode, type FlatBone } from './SkeletonOverlay';

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

export interface PlaybackState {
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
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
  private readonly clock = new THREE.Clock();

  private model: THREE.Object3D | null = null;
  /** 归一化缩放（镜像时为负） */
  private baseScale = 1;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private currentAction: THREE.AnimationAction | null = null;
  private skeleton: SkeletonOverlay | null = null;
  private skeletonOn = false;
  private disposed = false;
  private gridOn = true;
  private mirrorOn = false;
  private inPlaceOn = false;
  private speed = 1;
  private playing = false;
  private listeners: ((state: PlaybackState) => void)[] = [];

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(this.renderer.domElement);

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
    keyLight.shadow.mapSize.set(2048, 2048);
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
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private tick(): void {
    if (this.disposed) return;
    const delta = this.clock.getDelta();
    if (this.mixer) {
      this.mixer.update(delta * this.speed * (this.playing ? 1 : 0));
    }
    this.controls.update();
    // 骨骼随动画移动，逐帧刷新叠加层与拾取用的点云
    this.skeleton?.refreshPositions();
    this.renderer.render(this.scene, this.camera);
    if (this.mixer && this.currentAction) {
      this.emit({
        time: this.currentAction.time,
        duration: this.currentAction.getClip().duration,
        playing: this.playing,
        speed: this.speed,
      });
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

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  get clipList(): ClipInfo[] {
    return this.clips.map((clip) => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length }));
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
  }

  setSelectedBones(ids: readonly string[]): void {
    this.skeleton?.setSelection(ids);
  }

  setHoveredBone(id: string | null): void {
    this.skeleton?.setHovered(id);
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
    this.clips = (object.animations ?? []).filter((clip) => clip.duration > 0 && clip.tracks.length > 0);

    this.mixer = new THREE.AnimationMixer(object);
    this.applyMirror();

    // 骨骼叠加层挂在场景根上（世界坐标），因此自动跟随模型的归一化缩放与镜像
    this.skeleton = new SkeletonOverlay(object);
    this.skeleton.calibrate(maxDimension * this.baseScale);
    this.skeleton.setVisible(this.skeletonOn);
    this.scene.add(this.skeleton.root);

    this.frameModel();
    this.currentAction = null;
    this.playing = false;

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
  }

  togglePlay(): void {
    this.setPlaying(!this.playing);
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.05, Math.min(4, speed));
  }

  seek(time: number): void {
    if (!this.currentAction) return;
    const duration = this.currentAction.getClip().duration;
    this.currentAction.time = Math.max(0, Math.min(time, duration));
    this.mixer?.update(0);
  }

  setGrid(on: boolean): void {
    this.gridOn = on;
    this.grid.visible = on;
    this.shadowPlane.visible = on;
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
  }

  /** 把动画定位到某个比例处（用于生成缩略图） */
  poseAt(ratio: number): void {
    if (!this.mixer || !this.currentAction) return;
    const duration = this.currentAction.getClip().duration;
    this.currentAction.time = Math.max(0, Math.min(duration * ratio, duration));
    this.mixer.update(0);
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
    this.clear();
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
