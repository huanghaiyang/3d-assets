import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { animationApi } from '@/api/animation';
import { kimodoApi } from '@/api/kimodo';
import type { AnimationData } from '@/viewer/FbxPlayer';
import { filterShadowBones } from '@/viewer/SkeletonOverlay';
import { FbxActor, type FbxSource } from '@/viewer/stage/FbxActor';
import { buildBoneNameMap, clipsFromAnimationData } from '@/viewer/stage/clipFromAnimationData';
import { sourceKey, type StageActorDef } from '@/viewer/stage/StageTypes';
import {
  applyStrips,
  bakeStrips,
  bindClipToBones,
  captureRestPose,
  resetToRest,
  type RestPoseMap,
  type StripEntry,
} from './StripBlend';
import { stripEnd, type StripDef, type StripSource } from './StripTypes';

export interface StripsFrameState {
  time: number;
  duration: number;
  playing: boolean;
}

/** 烘焙产物：AnimationData 用于保存，AnimationClip 用于立即预览 */
export interface StripsBakeResult {
  data: AnimationData;
  clip: THREE.AnimationClip;
}

export type StripClipStatus = 'loading' | 'ready' | 'error';

export interface StripClipEvent {
  stripId: string;
  status: StripClipStatus;
  /** ready 时为来源片段的真实时长（秒） */
  duration?: number;
  message?: string;
}

interface BaseRuntime {
  source: FbxSource;
  actor: FbxActor;
  bones: THREE.Bone[];
  rest: RestPoseMap;
  boneNameMap: Map<string, string>;
  bakedMixer: THREE.AnimationMixer;
}

function isAnimationData(value: unknown): value is AnimationData {
  return !!value && typeof value === 'object' && (value as { format?: unknown }).format === 'fbx-animation-data';
}

/**
 * 拼接工作区播放器：
 * 基础模型（Mixamo FBX）负责骨架与蒙皮，每条 Strip 用独立骨架克隆 + 独立 mixer 求值，
 * 再逐骨骼按部位掩码与权重混合。烘焙结果复用同一条路径反向还原，保证预览与保存一致。
 */
export class StripsPlayer {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly clock = new THREE.Clock();

  private readonly fbxCache = new Map<string, Promise<FbxSource>>();
  private readonly clipCache = new Map<string, Promise<THREE.AnimationClip | null>>();

  private base: BaseRuntime | null = null;
  private basePath = '';
  private entries: StripEntry[] = [];
  private strips: readonly StripDef[] = [];
  private stripSignature = '';
  private stripToken = 0;
  /** 换模型/重建时让旧的异步结果失效 */
  private token = 0;

  private time = 0;
  private liveDuration = 1;
  private duration = 1;
  private playing = false;
  private speed = 1;
  private loop = true;

  private mode: 'live' | 'baked' = 'live';
  private bakedClip: THREE.AnimationClip | null = null;
  private bakedAction: THREE.AnimationAction | null = null;

  private lastEmit = 0;
  private disposed = false;

  private frameListeners: ((state: StripsFrameState) => void)[] = [];
  private noticeListeners: ((message: string) => void)[] = [];
  private clipListeners: ((event: StripClipEvent) => void)[] = [];

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
    this.camera.position.set(4.6, 3.1, 6.6);

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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ===== 对外接口 =====

  onFrame(listener: (state: StripsFrameState) => void): void {
    this.frameListeners.push(listener);
  }

  onNotice(listener: (message: string) => void): void {
    this.noticeListeners.push(listener);
  }

  onClipState(listener: (event: StripClipEvent) => void): void {
    this.clipListeners.push(listener);
  }

  async listClips(path: string): Promise<{ name: string; duration: number }[]> {
    const source = await this.loadFbx(path);
    return source.clips.map((clip) => ({ name: clip.name, duration: clip.duration }));
  }

  get baseModelPath(): string {
    return this.basePath;
  }

  async loadBase(path: string): Promise<boolean> {
    const token = ++this.token;
    this.basePath = path;
    this.clipCache.clear();
    this.stripSignature = '';
    this.stripToken += 1;
    try {
      const source = await this.loadFbx(path);
      if (token !== this.token) return false;
      this.disposeBase();

      const def: StageActorDef = {
        id: 'strips-base',
        name: '拼接模型',
        kind: 'fbx',
        modelPath: path,
        transform: { x: 0, z: 0, yaw: 0 },
        visible: true,
      };
      const actor = new FbxActor(def);
      actor.install(source);
      this.scene.add(actor.placement);

      const allBones = actor.boneSegments().map((pair) => pair.child as THREE.Bone);
      const bones = filterShadowBones(allBones).kept;
      this.base = {
        source,
        actor,
        bones,
        rest: captureRestPose(bones),
        boneNameMap: buildBoneNameMap(bones),
        bakedMixer: new THREE.AnimationMixer(actor.placement),
      };
      this.entries = [];
      this.mode = 'live';
      this.bakedClip = null;
      this.bakedAction = null;
      this.time = 0;
      this.liveDuration = 1;
      this.duration = 1;
      this.resetCamera();
      this.emit(true);
      return true;
    } catch (error) {
      if (token === this.token) {
        this.notify(`模型加载失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
      return false;
    }
  }

  /** 更新 Strip 列表；只有来源集合变化时才重建求值环境 */
  async setStrips(strips: readonly StripDef[]): Promise<void> {
    this.strips = strips;
    this.recomputeDuration();
    this.emit(true);
    if (!this.base) return;

    const signature = `${this.basePath}|${strips.map((strip) => `${strip.id}:${sourceKey(strip.source)}`).join(',')}`;
    if (signature === this.stripSignature) return;
    this.stripSignature = signature;

    const token = ++this.stripToken;
    for (const entry of this.entries) this.disposeEntry(entry);
    this.entries = [];

    for (const strip of strips) {
      const base = this.base;
      if (!base) return;
      this.emitClip({ stripId: strip.id, status: 'loading' });
      const clip = await this.loadClip(strip.source);
      if (token !== this.stripToken || !this.base) return;
      if (!clip) {
        this.emitClip({ stripId: strip.id, status: 'error', message: '来源片段加载失败' });
        continue;
      }
      const prepared = bindClipToBones(clip, base.boneNameMap);
      if (!prepared) {
        this.emitClip({ stripId: strip.id, status: 'error', message: '骨架不匹配，无法绑定到当前模型' });
        continue;
      }

      const rig = cloneSkeleton(base.source.object);
      const boneList: THREE.Bone[] = [];
      rig.traverse((child) => {
        if ((child as THREE.Bone).isBone) boneList.push(child as THREE.Bone);
      });
      const bones = new Map<string, THREE.Bone>();
      for (const bone of filterShadowBones(boneList).kept) bones.set(bone.name, bone);
      const mixer = new THREE.AnimationMixer(rig);
      const action = mixer.clipAction(prepared);
      action.reset();
      action.play();
      action.paused = true;
      action.setEffectiveWeight(0);
      action.enabled = false;

      this.entries.push({ strip, rig, mixer, action, bones, clipDuration: prepared.duration });
      this.emitClip({ stripId: strip.id, status: 'ready', duration: prepared.duration });
    }

    this.apply(this.time);
    this.emit(true);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  setSpeed(speed: number): void {
    this.speed = Math.min(4, Math.max(0.1, speed));
  }

  togglePlay(): void {
    if (this.duration <= 0) return;
    if (!this.playing && this.time >= this.duration - 1e-3) this.time = 0;
    this.playing = !this.playing;
    this.clock.getDelta();
    this.emit(true);
  }

  seek(time: number): void {
    this.time = THREE.MathUtils.clamp(time, 0, this.duration);
    this.apply(this.time);
    this.emit(true);
  }

  resetCamera(): void {
    this.camera.position.set(4.6, 3.1, 6.6);
    this.controls.target.set(0, 1, 0);
    this.controls.update();
  }

  /** 切换烘焙预览：传 null 回到实时混合 */
  setBakedClip(clip: THREE.AnimationClip | null): void {
    if (!this.base) return;
    if (this.bakedAction) {
      this.bakedAction.stop();
      this.base.bakedMixer.uncacheAction(this.bakedAction.getClip());
      this.bakedAction = null;
    }
    this.base.bakedMixer.stopAllAction();
    resetToRest(this.base.bones, this.base.rest);

    this.bakedClip = clip;
    if (!clip) {
      this.mode = 'live';
    } else {
      this.mode = 'baked';
      const action = this.base.bakedMixer.clipAction(clip);
      action.reset();
      action.play();
      action.paused = true;
      action.setEffectiveWeight(1);
      this.bakedAction = action;
    }
    this.recomputeDuration();
    this.time = Math.min(this.time, this.duration);
    this.apply(this.time);
    this.emit(true);
  }

  /** 逐帧烘焙：返回可直接保存的 AnimationData 与用于预览的 AnimationClip */
  bake(fps = 30): StripsBakeResult | null {
    if (!this.base || this.entries.length === 0) return null;
    try {
      const data = bakeStrips(
        this.entries,
        this.base.bones,
        this.base.rest,
        this.liveDuration,
        fps,
        '拼接动画',
      );
      const converted = clipsFromAnimationData(data, this.base.boneNameMap);
      const clip = converted.clips[0] ?? null;
      if (!clip) {
        this.notify('烘焙结果没有可用的关键帧');
        return null;
      }
      return { data, clip };
    } catch (error) {
      this.notify(error instanceof Error ? error.message : '烘焙失败');
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token += 1;
    this.stripToken += 1;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.disposeBase();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ===== 内部实现 =====

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private tick(): void {
    if (this.disposed) return;
    const delta = this.clock.getDelta();
    if (this.playing && this.duration > 0) {
      this.time += delta * this.speed;
      if (this.time >= this.duration) {
        if (this.loop) {
          this.time %= this.duration;
        } else {
          this.time = this.duration;
          this.playing = false;
        }
      }
      this.apply(this.time);
      this.emit();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private apply(time: number): void {
    if (!this.base) return;
    if (this.mode === 'baked' && this.bakedAction && this.bakedClip) {
      this.bakedAction.time = Math.min(Math.max(time, 0), Math.max(0, this.bakedClip.duration - 1e-4));
      this.base.bakedMixer.update(0);
    } else {
      applyStrips(this.entries, this.base.bones, this.base.rest, time);
    }
    this.base.actor.placement.updateMatrixWorld(true);
  }

  private recomputeDuration(): void {
    let end = 0;
    for (const strip of this.strips) end = Math.max(end, stripEnd(strip));
    this.liveDuration = Math.max(1, end);
    this.duration =
      this.mode === 'baked' && this.bakedClip ? Math.max(0.1, this.bakedClip.duration) : this.liveDuration;
    this.time = THREE.MathUtils.clamp(this.time, 0, this.duration);
  }

  private emit(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastEmit < 60) return;
    this.lastEmit = now;
    const state: StripsFrameState = { time: this.time, duration: this.duration, playing: this.playing };
    for (const listener of this.frameListeners) listener(state);
  }

  private notify(message: string): void {
    for (const listener of this.noticeListeners) listener(message);
  }

  private emitClip(event: StripClipEvent): void {
    for (const listener of this.clipListeners) listener(event);
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

  private loadClip(source: StripSource): Promise<THREE.AnimationClip | null> {
    const base = this.base;
    if (!base) return Promise.resolve(null);
    const key = `${sourceKey(source)}|${this.basePath}`;
    const cached = this.clipCache.get(key);
    if (cached) return cached;

    const promise = (async (): Promise<THREE.AnimationClip | null> => {
      if (source.kind === 'fbx-clip') {
        const fbx = await this.loadFbx(source.fbxPath);
        const clip = FbxActor.findClip(fbx.clips, source.clipName);
        if (!clip) throw new Error(`片段「${source.clipName}」在 FBX 中不存在`);
        return clip;
      }
      if (source.kind === 'anim-project') {
        const project = await animationApi.project(source.projectId);
        if (!isAnimationData(project.data)) throw new Error('项目动画数据格式不正确');
        return clipsFromAnimationData(project.data, base.boneNameMap).clips[0] ?? null;
      }
      const imported = await kimodoApi.importAnimation(source.animationId);
      if (!isAnimationData(imported.data)) throw new Error('Kimodo 动画数据格式不正确');
      return clipsFromAnimationData(imported.data, base.boneNameMap).clips[0] ?? null;
    })().catch((error: unknown) => {
      this.clipCache.delete(key);
      this.notify(error instanceof Error ? error.message : '片段加载失败');
      return null;
    });

    this.clipCache.set(key, promise);
    return promise;
  }

  private disposeEntry(entry: StripEntry): void {
    entry.mixer.stopAllAction();
    entry.mixer.uncacheRoot(entry.rig);
  }

  private disposeBase(): void {
    for (const entry of this.entries) this.disposeEntry(entry);
    this.entries = [];
    if (!this.base) return;
    this.base.bakedMixer.stopAllAction();
    this.base.bakedMixer.uncacheRoot(this.base.actor.placement);
    this.scene.remove(this.base.actor.placement);
    this.base.actor.dispose();
    this.base = null;
    this.bakedAction = null;
    this.bakedClip = null;
    this.mode = 'live';
  }
}
