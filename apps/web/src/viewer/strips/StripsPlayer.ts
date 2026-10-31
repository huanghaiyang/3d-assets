/**
 * 拼接工作区播放器（Three.js 封装）。
 *
 * 职责边界：
 *  - 只负责「渲染 + 求值 + 视觉开关」，不含任何业务规则（冲突校验、上限 5 条、命名、保存
 *    都在 stores/strips.ts 里）；对外暴露 setStrips / setSpan / setHighlight 等命令式接口，
 *    通过 onFrame / onNotice / onClipState 三个回调把状态回吐给 store。
 *  - 与 StagePlayer / FbxPlayer 并列，是本项目第 3 套播放器；不复用它们是为了让「多骨架克隆 +
 *    逐部位混合」这条路径保持独立，避免影响原有工作区。
 *
 * 求值路径（live 模式）：
 *  base（基础模型骨架/蒙皮） + entries[]（每条 Strip 一份骨架克隆 + mixer）
 *  → StripBlend.applyStrips 逐骨骼混合 → 写入 base 骨骼 → 更新场景图。
 *
 * 求值路径（baked 模式）：
 *  烘焙结果 AnimationClip 挂到 base.bakedMixer 上单条播放，用于「保存前的最终预览」，
 *  保证预览与落库数据完全一致。
 *
 * 异步与失效：
 *  加载模型 / 片段都是异步的。用 token（换模型）与 stripToken（重建 Strip 集合）两把
 *  「版本号」在 await 之后校验，丢弃过期结果，避免用户快速切换时旧结果覆盖新状态。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { animationApi } from '@/api/animation';
import { kimodoApi } from '@/api/kimodo';
import type { AnimationData } from '@/viewer/FbxPlayer';
import {
  AxisIndicator,
  snapCameraToAxis,
  type AxisName,
  type AxisSign,
} from '@/viewer/axisIndicator';
import { filterShadowBones } from '@/viewer/SkeletonOverlay';
import { FbxActor, type FbxSource } from '@/viewer/stage/FbxActor';
import { disposeObject } from '@/viewer/stage/StageActor';
import { buildBoneNameMap, clipsFromAnimationData } from '@/viewer/stage/clipFromAnimationData';
import { sourceKey, type StageActorDef } from '@/viewer/stage/StageTypes';
import { resolveSegmentColor } from '@/viewer/stage/segmentColors';
import {
  applyStrips,
  bakeStrips,
  bindClipToBones,
  captureRestPose,
  resetToRest,
  type RestPoseMap,
  type StripEntry,
} from './StripBlend';
import { isHipsBone, partOfBone } from './StripParts';
import { stripEnd, type BodyPart, type StripDef, type StripSource } from './StripTypes';

/**
 * 帧状态回吐：驱动时间轴播放头与播放/暂停按钮。
 * 由 tick() 与显式命令（seek/togglePlay）触发，节流到约 60ms 一次（见 emit）。
 */
export interface StripsFrameState {
  /** 当前播放头（秒），范围 [0, duration] */
  time: number;
  /** 当前有效总时长（秒）：live 模式取「时间轴总长 / 最长 Strip / 0.1」的最大值； */
  /** baked 模式取烘焙片段时长 */
  duration: number;
  playing: boolean;
}

/** 烘焙产物：AnimationData 用于保存，AnimationClip 用于立即预览 */
export interface StripsBakeResult {
  data: AnimationData;
  clip: THREE.AnimationClip;
}

/** FBX 源缓存上限：长会话里反复换素材时不能无限堆模型 */
const FBX_CACHE_LIMIT = 16;

/** 单条来源片段的加载状态，供检查器/时间轴显示 loading / 失败 */
export type StripClipStatus = 'loading' | 'ready' | 'error';

export interface StripClipEvent {
  stripId: string;
  status: StripClipStatus;
  /** ready 时为来源片段的真实时长（秒） */
  duration?: number;
  /** error 时的原因文案（片段缺失 / 骨架不匹配等），直接展示给用户 */
  message?: string;
}

/**
 * 基础模型的运行时集合。
 * 一个 StripsPlayer 同一时刻只有一份 base；换模型时整体重建（disposeBase）。
 */
interface BaseRuntime {
  source: FbxSource;
  actor: FbxActor;
  /** 已过滤 shadow 骨骼后的骨骼列表，混合与烘焙都只针对这批骨骼 */
  bones: THREE.Bone[];
  /** 绑定姿态，作为「未被任何 Strip 覆盖」部分的回退 */
  rest: RestPoseMap;
  /** 别名 → 实际骨骼名，用于把来源动画的轨道绑定到本模型 */
  boneNameMap: Map<string, string>;
  /** 只在 baked 模式下使用；播放烘焙片段 */
  bakedMixer: THREE.AnimationMixer;
}

/** 一个蒙皮网格的逐顶点部位信息，用于按部位染色 / 透明度 / 高亮 */
interface MeshPaint {
  mesh: THREE.SkinnedMesh;
  /** 每个顶点归属的部位；null 表示无法识别（始终按未添加处理） */
  partIndex: (BodyPart | null)[];
}

/** 未添加部位的中性色（浅灰蓝） */
const IDLE_COLOR = new THREE.Color('#9aa7bd');
/**
 * 未添加部位的默认透明度。
 * 需求 5：T 字基础模型默认半透明 0.5，便于一眼看出哪些部位已被来源动画占用。
 */
const IDLE_ALPHA = 0.5;
/** 外发光强度倍数：乘到 totalEmissiveRadiance 上，值越大辉光越强 */
const GLOW_STRENGTH = 1.4;

/** 判定一份未知数据是否为可用的动画数据（跨接口反序列化时的类型守卫） */
function isAnimationData(value: unknown): value is AnimationData {
  return !!value && typeof value === 'object' && (value as { format?: unknown }).format === 'fbx-animation-data';
}

/**
 * 拼接工作区播放器：
 * 基础模型（Mixamo FBX）负责骨架与蒙皮，每条 Strip 用独立骨架克隆 + 独立 mixer 求值，
 * 再逐骨骼按部位掩码与权重混合。烘焙结果复用同一条路径反向还原，保证预览与保存一致。
 *
 * 视觉层：
 *  - 绑定姿态整体半透明，已分配部位的顶点按来源动画染色并变为不透明；
 *  - 支持「仅显示已添加部位」、部位外发光高亮、骨骼叠加、下肢运动轨迹。
 */
export class StripsPlayer {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  /** 右下角 XYZ 轴向指示器（抬到播放控制条上方，可调整 / 锁定） */
  private readonly axis: AxisIndicator;
  /** 每帧取 delta；暂停时也用它推进 OrbitControls 阻尼 */
  private readonly clock = new THREE.Clock();

  /** 按路径缓存 FBX 解析结果，避免同一模型被重复请求（含基础模型与 FBX 来源） */
  private readonly fbxCache = new Map<string, Promise<FbxSource>>();
  /** 按「来源 key + 基础模型」缓存已绑定好的片段；换基础模型时整体清空 */
  private readonly clipCache = new Map<string, Promise<THREE.AnimationClip | null>>();

  private base: BaseRuntime | null = null;
  private basePath = '';
  /** 每条 Strip 的求值环境，与 strips 一一对应（加载失败的来源不产生 entry） */
  private entries: StripEntry[] = [];
  private strips: readonly StripDef[] = [];
  /** 当前 Strip 集合的指纹（basePath + id:source）；不变则复用 entries，不重建 mixer */
  private stripSignature = '';
  /** Strip 集合的版本号：重建期间若有新请求，旧循环会在 await 后自行退出 */
  private stripToken = 0;
  /** 换模型/重建时让旧的异步结果失效 */
  private token = 0;

  private time = 0;
  /** 源动画里最长一段的时长，作为时间轴默认总长 */
  private span = 0;
  /** live 模式的时长（与 span / Strip 末尾取最大），烘焙时以它作为采样总长 */
  private liveDuration = 1;
  /** 对外暴露的时长：baked 模式下为烘焙片段时长，否则等于 liveDuration */
  private duration = 1;
  private playing = false;
  /** 播放倍速，范围 [0.1, 4]（见 setSpeed） */
  private speed = 1;
  private loop = true;

  /** 当前求值模式：live = 逐条混合；baked = 播放烘焙片段 */
  private mode: 'live' | 'baked' = 'live';
  private bakedClip: THREE.AnimationClip | null = null;
  private bakedAction: THREE.AnimationAction | null = null;

  private paints: MeshPaint[] = [];
  private skeletonLines: THREE.LineSegments | null = null;
  /** 骨骼父子对，供每帧更新骨骼线端点 */
  private skeletonPairs: [THREE.Bone, THREE.Bone][] = [];
  private trajectory: THREE.Line | null = null;
  private showSkeleton = false;
  private showOnlyAdded = false;
  /** 需要外发光高亮的部位（来自 store：悬停部位或选中 Strip 的全部部位） */
  private highlightParts: BodyPart[] = [];
  private highlightColor = '#ffffff';

  /** emit 节流时间戳（毫秒），避免每帧都触发 Vue 更新 */
  private lastEmit = 0;
  /** 上一次真正渲染的时刻：暂停且相机静止时用它在空闲帧上限流 */
  private lastRenderAt = 0;
  /** 有显式改动（求值、开关切换）时置位，保证空闲限流下也能立刻重绘 */
  private renderRequested = true;
  /** 滚轮累计量：平滑滚轮/触控板一次只上报几像素，攒够一档再缩放，和带刻度滚轮手感一致 */
  private wheelAccum = 0;
  private disposed = false;

  /** 三个回调：帧状态、一次性通知（用于 toast）、片段加载状态 */
  private frameListeners: ((state: StripsFrameState) => void)[] = [];
  private noticeListeners: ((message: string) => void)[] = [];
  private clipListeners: ((event: StripClipEvent) => void)[] = [];

  /**
   * 创建播放器并挂载 canvas。
   * 场景构成：雾 + 网格地平面 + 阴影承托面 + 三盏灯（半球环境光 / 主平行光带阴影 / 冷色轮廓光）。
   * 相机与 OrbitControls 做限制（俯仰 <= 89.1°、缩放 1.2–30），避免转到地面以下或穿模。
   *
   * @param container 承放 canvas 的 DOM 容器；尺寸变化由 ResizeObserver 自动跟随
   */
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

    // 滚轮缩放自己接管：OrbitControls 直接拿 deltaY 原始值算缩放，鼠标驱动 / 触控板平滑滚动
    // 上报的增量常常只有几像素，一格换算下来不到 1%，看起来就是「滚轮放大缩小失效」。
    // 监听器必须早于 OrbitControls 注册（它构造时就挂到同一个 canvas 上），才能拦掉它自带的滚轮处理。
    this.renderer.domElement.addEventListener('wheel', this.onWheelZoom, { passive: false });

    // 右下角 XYZ 轴向指示器；底部是播放控制条，所以抬高放置。设置按拼接工作区单独记忆
    this.axis = new AxisIndicator(container, {
      bottom: 70,
      storageKey: 'axis-indicator:strips',
      // 点击轴端点：把相机切到该轴向视角（±方向）
      onAxisSelect: (axis, sign) => this.snapToAxis(axis, sign),
    });

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

  /** 订阅帧状态（每个播放器可挂多个；store 只挂一个） */
  onFrame(listener: (state: StripsFrameState) => void): void {
    this.frameListeners.push(listener);
  }

  /** 订阅一次性错误通知，store 侧转成 toast 展示 */
  onNotice(listener: (message: string) => void): void {
    this.noticeListeners.push(listener);
  }

  /** 订阅单条来源片段的加载状态，store 侧据此维护 clipStates / clipDurations */
  onClipState(listener: (event: StripClipEvent) => void): void {
    this.clipListeners.push(listener);
  }

  /**
   * 列出某个 FBX 里可用的片段（供「来源选择」弹窗按需展开 FBX 的多个 clip）。
   * @param path FBX 的存储路径
   * @returns 片段名与真实时长（秒）；加载失败会向上抛出，由调用方兜底
   */
  async listClips(path: string): Promise<{ name: string; duration: number }[]> {
    const source = await this.loadFbx(path);
    return source.clips.map((clip) => ({ name: clip.name, duration: clip.duration }));
  }

  /** 当前基础模型路径；空串表示尚未选择模型 */
  get baseModelPath(): string {
    return this.basePath;
  }

  /**
   * 设置时间轴默认总长（需求 8：取源动画里最长的一段）。
   * 该值只影响时间轴标尺与烘焙采样总长，不会裁剪 Strip；实际时长还会与 Strip 末尾取最大值。
   *
   * @param seconds 目标秒数；非有限值按 0 处理，负值夹到 0
   * @sideEffect 若数值变化会重算时长、刷新下肢轨迹并广播帧状态
   */
  setSpan(seconds: number): void {
    const next = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (Math.abs(next - this.span) < 1e-4) return;
    this.span = next;
    this.recomputeDuration();
    if (this.base) this.updateTrajectory();
    this.emit(true);
  }

  /** 只要显示已添加部位的开关（需求 4）：开启后未分配部位 alpha 置 0，隐藏掉 T 字躯体 */
  setShowOnlyAdded(value: boolean): void {
    this.showOnlyAdded = value;
    this.refreshPaint();
  }

  /**
   * 高亮某些身体部位（外发光，需求 3）。
   * 实现方式为逐顶点 aGlow 属性 + 材质注入，见 refreshGlow / paintMaterials。
   *
   * @param parts 要高亮的部位；空数组表示取消高亮
   * @param color 发光色，通常取该 Strip 的标识色；空值时用白色
   */
  setHighlight(parts: readonly BodyPart[], color?: string | null): void {
    this.highlightParts = [...parts];
    this.highlightColor = color || '#ffffff';
    this.refreshGlow();
  }

  /** 骨骼叠加层开关（需求 12） */
  setShowSkeleton(value: boolean): void {
    this.showSkeleton = value;
    if (this.skeletonLines) this.skeletonLines.visible = value;
  }

  /**
   * 加载基础模型（T 字 FBX）。
   *
   * 流程：解析 FBX → disposeBase 清掉旧模型 → 建 FbxActor 入场景 → 采集静置姿态与骨骼别名表
   * → 重建染色 / 轨迹 / 骨骼线 → 复位相机。任意一步失败都会通知调用方并返回 false。
   *
   * @param path 模型存储路径（相对项目存储根）
   * @returns 成功 true；失败 false（同时通过 notify 上报原因）
   * @sideEffect 会清空近似所有运行时状态（entries / 顶点色 / 缓存），并让进行中的旧加载作废
   */
  async loadBase(path: string): Promise<boolean> {
    const token = ++this.token;
    this.basePath = path;
    this.clipCache.clear();
    this.stripSignature = '';
    this.stripToken += 1;
    try {
      const source = await this.loadFbx(path);
      // await 期间若又发起了新的 loadBase，则本次结果已过期，直接丢弃
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
      this.recomputeDuration();
      this.buildPaints();
      this.buildTrajectory();
      this.buildSkeletonLines();
      this.resetCamera();
      // 换模型后旧 base 已销毁，可以回收不再引用的源
      this.pruneFbxCache();
      this.emit(true);
      return true;
    } catch (error) {
      // 只有仍是最新一次加载时才提示，避免旧请求报错干扰当前状态
      if (token === this.token) {
        this.notify(`模型加载失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
      return false;
    }
  }

  /**
   * 更新 Strip 列表；只有来源集合变化时才重建求值环境。
   *
   * 设计理由（性能）：
   *  改部位分配 / 颜色 / 权重 / 静音都只需刷新顶点外观，不需要重新加载来源动画；
   *  只有「集合变化」（增删轨道、换来源）才重新克隆骨架并绑定动画，代价高但频率低。
   *  指纹 stripSignature 用于识别这种差异。
   *
   * @param strips 最新轨道数组（store 持有，player 只读快照）
   * @sideEffect 可能重建 entries；会广播帧状态与每个来源的加载状态
   */
  async setStrips(strips: readonly StripDef[]): Promise<void> {
    this.strips = strips;
    this.recomputeDuration();
    this.emit(true);
    if (!this.base) return;

    // 部位分配、颜色、权重的变化不需要重建 mixer，但要立刻反映到模型外观
    this.refreshPaint();
    this.refreshGlow();
    this.updateTrajectory();

    const signature = `${this.basePath}|${strips.map((strip) => `${strip.id}:${sourceKey(strip.source)}`).join(',')}`;
    if (signature === this.stripSignature) {
      this.apply(this.time);
      return;
    }
    this.stripSignature = signature;

    const token = ++this.stripToken;
    for (const entry of this.entries) this.disposeEntry(entry);
    this.entries = [];

    for (const strip of strips) {
      const base = this.base;
      if (!base) return;
      this.emitClip({ stripId: strip.id, status: 'loading' });
      const clip = await this.loadClip(strip.source);
      // await 期间若集合又被更新（token 变化）或基础模型被换掉，本次循环作废
      if (token !== this.stripToken || !this.base) return;
      if (!clip) {
        this.emitClip({ stripId: strip.id, status: 'error', message: '来源片段加载失败' });
        continue;
      }
      // 把来源片段重绑定到本模型骨骼；绑不上说明骨架不兼容，跳过该条
      const prepared = bindClipToBones(clip, base.boneNameMap);
      if (!prepared) {
        this.emitClip({ stripId: strip.id, status: 'error', message: '骨架不匹配，无法绑定到当前模型' });
        continue;
      }

      // 每条 Strip 克隆一份独立骨架：互不干扰地用自己的 mixer 求值
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
      // 暂停 + 权重 0：实际求值由 applyStrips 按需设置 action.time 并 update(0)，
      // 不让 mixer 自己推进时间，避免与时间轴拖动冲突。
      action.paused = true;
      action.setEffectiveWeight(0);
      action.enabled = false;

      this.entries.push({ strip, rig, mixer, action, bones, clipDuration: prepared.duration });
      this.emitClip({ stripId: strip.id, status: 'ready', duration: prepared.duration });
    }

    this.apply(this.time);
    this.updateTrajectory();
    // 新的来源集合都装好了，回收不再引用的旧源
    this.pruneFbxCache();
    this.emit(true);
  }

  /** 循环播放开关：关闭时播到 duration 自动停住（时间轴停在末尾） */
  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  /**
   * 设置播放倍速。
   * @param speed 期望倍速；内部夹到 [0.1, 4]，防止 0 导致时间不前进或过大跳帧
   */
  setSpeed(speed: number): void {
    this.speed = Math.min(4, Math.max(0.1, speed));
  }

  /**
   * 播放 / 暂停。
   * 若当前已停在末尾（非循环播放结束的状态），再次播放会从头开始。
   */
  togglePlay(): void {
    if (this.duration <= 0) return;
    if (!this.playing && this.time >= this.duration - 1e-3) this.time = 0;
    this.playing = !this.playing;
    // 清掉暂停期间累计的 delta，避免恢复时瞬间跳一大段
    this.clock.getDelta();
    this.emit(true);
  }

  /**
   * 跳转到指定时刻并立即求值。
   * @param time 目标秒数；会被夹到 [0, duration]
   */
  seek(time: number): void {
    this.time = THREE.MathUtils.clamp(time, 0, this.duration);
    this.apply(this.time);
    this.emit(true);
  }

  /** 相机复位到默认观察位（侧前方 45°、略高于角色），不改变当前播放状态 */
  resetCamera(): void {
    this.camera.position.set(4.6, 3.1, 6.6);
    this.controls.target.set(0, 1, 0);
    this.controls.update();
  }

  /** 点击轴向指示器的轴端点：把相机切到该轴 ± 方向视角（保持当前距离） */
  private snapToAxis(axis: AxisName, sign: AxisSign): void {
    if (this.disposed) return;
    snapCameraToAxis(this.camera, this.controls, axis, sign);
    this.renderRequested = true;
  }

  /**
   * 切换烘焙预览：传 null 回到实时混合。
   *
   * 进入 baked 时先 resetToRest 清场，再挂一条独立 Action（paused，由 apply 设置 time），
   * 因此 baked 预览与最终保存的关键帧严格一致；退出时恢复 live 混合。
   *
   * @param clip 烘焙得到的片段；null 表示回到 live
   * @sideEffect 切换 mode、重置骨架姿态、重算时长并广播状态
   */
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
    // baked 片段可能比 live 编排短，夹一下播放头防止越界
    this.time = Math.min(this.time, this.duration);
    this.apply(this.time);
    this.emit(true);
  }

  /**
   * 逐帧烘焙：返回可直接保存的 AnimationData 与用于预览的 AnimationClip。
   *
   * 采样总长使用 liveDuration 而非当前 duration —— 若此刻正处于 baked 预览，
   * duration 是旧片段的长度，用它会把新编排裁短。
   *
   * @param fps 采样帧率，默认 30（与 Kimodo 来源一致）
   * @returns 烘焙结果；无基础模型 / 无 Strip / 生成不出关键帧 / 抛错时返回 null
   * @sideEffect 烘焙会反复覆写 base 骨骼姿态，但不恢复播放头所在帧；
   *             调用方（store.bake）紧接着会 setBakedClip 恢复正确姿态。
   */
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
    const stepPixels = 48;
    if (Math.abs(this.wheelAccum) < stepPixels) return;
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
    this.renderRequested = true;
  }

  /**
   * 销毁播放器：停止渲染循环、断开尺寸监听、释放模型与 GPU 资源。
   * 幂等：重复调用直接返回（组件卸载 + 路由切换可能触发两次）。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 递增版本号，让所有进行中的异步加载结果作废
    this.token += 1;
    this.stripToken += 1;
    this.renderer.setAnimationLoop(null);
    this.renderer.domElement.removeEventListener('wheel', this.onWheelZoom);
    this.resizeObserver.disconnect();
    this.axis.dispose();
    this.disposeBase();
    this.disposeFbxSources();
    this.controls.dispose();
    // 网格地面 / 阴影承托面等场景自带对象也要释放，避免每次重建播放器都留一份显存
    disposeObject(this.scene);
    this.renderer.dispose();
    // 主动丢弃 WebGL 上下文：切换页签会反复重建播放器，靠浏览器 GC 回收太慢，容易撞上下文上限
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // ===== 内部实现 =====

  /** 跟随容器尺寸调整渲染缓冲与相机宽高比（DPR 已在构造时限制到 2） */
  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 每帧循环：推进时间 → 求值 → 更新辅助线 → 渲染。
   *
   * 暂停时也要执行 controls.update()，否则 OrbitControls 的阻尼会在暂停后僵住。
   * 循环播放用取模而非归零，避免 time 恰好超过 duration 时丢一帧。
   */
  private tick(): void {
    if (this.disposed) return;
    const delta = this.clock.getDelta();
    // 容器隐藏（切到其它页面 / 折叠）时宽度为 0：不吃 GPU、也不推进时间
    if (this.container.clientWidth === 0) return;
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
    // update() 返回 true 表示这一帧相机有变化（阻尼、用户拖拽）
    const cameraChanged = this.controls.update();
    this.axis.update(this.camera);
    const now = performance.now();
    // 暂停且相机静止时把渲染降到约 20fps：多个预览区同时挂载时空闲常渲非常吃 GPU
    if (!this.playing && !cameraChanged && !this.renderRequested && now - this.lastRenderAt < 50) return;
    this.renderRequested = false;
    this.lastRenderAt = now;
    if (this.showSkeleton) this.updateSkeletonLines();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 按当前模式求值一帧并刷新世界矩阵。
   *
   * baked：设置 action.time 后 update(0) 求值（末尾留 1e-4 余量防止回绕到首帧）；
   * live ：调用 StripBlend.applyStrips 逐骨骼混合。
   */
  private apply(time: number): void {
    // 时间轴求值属于显式改动：请求立即重绘
    this.renderRequested = true;
    if (!this.base) return;
    if (this.mode === 'baked' && this.bakedAction && this.bakedClip) {
      this.bakedAction.time = Math.min(Math.max(time, 0), Math.max(0, this.bakedClip.duration - 1e-4));
      this.base.bakedMixer.update(0);
    } else {
      applyStrips(this.entries, this.base.bones, this.base.rest, time);
    }
    // 骨骼改了 local 变换，需要手动刷新一次世界矩阵，后续世界坐标采样（轨迹/骨骼线）才准确
    this.base.actor.placement.updateMatrixWorld(true);
  }

  /**
   * 重算时长。
   * liveDuration = max(0.1, span, 所有 Strip 的末尾)；duration 再按模式取烘焙片段时长。
   * 保留 0.1 的下限，避免空编排时时间轴长度为 0 导致除零。
   */
  private recomputeDuration(): void {
    let end = 0;
    for (const strip of this.strips) end = Math.max(end, stripEnd(strip));
    this.liveDuration = Math.max(0.1, this.span, end);
    this.duration =
      this.mode === 'baked' && this.bakedClip ? Math.max(0.1, this.bakedClip.duration) : this.liveDuration;
    this.time = THREE.MathUtils.clamp(this.time, 0, this.duration);
  }

  /**
   * 广播帧状态。
   * @param force true 表示关键操作（seek/切模型/切 Strip），必须立刻通知；
   *              否则按 60ms 节流，避免播放时每帧触发 Vue 响应式更新造成掉帧
   */
  private emit(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastEmit < 60) return;
    this.lastEmit = now;
    const state: StripsFrameState = { time: this.time, duration: this.duration, playing: this.playing };
    for (const listener of this.frameListeners) listener(state);
  }

  /** 一次性错误提示（store 会包成 toast） */
  private notify(message: string): void {
    for (const listener of this.noticeListeners) listener(message);
  }

  /** 广播单条来源片段的加载状态 */
  private emitClip(event: StripClipEvent): void {
    for (const listener of this.clipListeners) listener(event);
  }

  /** 当前正在使用的 FBX 路径：base 与各 fb-clip 来源，这些源被角色/片段引用，不能提前释放 */
  private usedFbxPaths(): Set<string> {
    const used = new Set<string>();
    if (this.basePath) used.add(this.basePath);
    for (const strip of this.strips) {
      if (strip.source.kind === 'fbx-clip') used.add(strip.source.fbxPath);
    }
    return used;
  }

  /**
   * 缓存超出上限时回收不再引用的 FBX 源（按加入顺序，先回收最旧的）。
   * base 与条目骨架都是克隆体、与源共享几何体 / 材质 / 贴图，只动确定不再使用的源。
   */
  private pruneFbxCache(): void {
    if (this.fbxCache.size <= FBX_CACHE_LIMIT) return;
    const used = this.usedFbxPaths();
    for (const [path, pending] of this.fbxCache) {
      if (this.fbxCache.size <= FBX_CACHE_LIMIT) break;
      if (used.has(path)) continue;
      this.fbxCache.delete(path);
      // 仍在加载的源：等它落地后立刻释放，避免刚回收又泄漏一个完整模型
      void pending.then(
        (source) => disposeObject(source.object),
        () => undefined,
      );
    }
  }

  /**
   * 按路径加载并缓存 FBX。
   * 失败时移除缓存项，允许下次重试（否则一次网络抖动会让该模型永久不可用）。
   */
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

  /**
   * 按来源类型加载片段（三种来源统一转成 AnimationClip）。
   *
   *  - fbx-clip    ：从 FBX 的 animations 里按名字找；
   *  - anim-project：读取已保存动画项目的 data（fbx-animation-data）；
   *  - kimodo      ：导入 Kimodo 生成的动画数据。
   * 缓存键包含 basePath，因为同一份 data 绑定到不同基础模型需要不同的轨道名。
   *
   * @returns 片段；任何失败都返回 null（同时 notify 原因），由调用方标记该 Strip 为 error
   */
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
      // 失败结果不缓存，允许重试
      this.clipCache.delete(key);
      this.notify(error instanceof Error ? error.message : '片段加载失败');
      return null;
    });

    this.clipCache.set(key, promise);
    return promise;
  }

  /** 释放单条 Strip 的 mixer 与克隆骨架引用 */
  private disposeEntry(entry: StripEntry): void {
    entry.mixer.stopAllAction();
    entry.mixer.uncacheRoot(entry.rig);
  }

  /**
   * 释放基础模型及其派生的所有运行时对象（Strip entries、顶点属性、骨骼线、轨迹）。
   * 顺序：先释放依赖 base 的对象，再移除/销毁 actor 本身。
   */
  private disposeBase(): void {
    for (const entry of this.entries) this.disposeEntry(entry);
    this.entries = [];
    this.clearPaints();
    this.clearSkeletonLines();
    this.clearTrajectory();
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

  /**
   * 释放 FBX 源缓存。
   * base 角色是 SkeletonUtils 克隆出来的，几何体 / 材质 / 贴图与源对象共享，
   * 必须等角色销毁之后再释放源，否则会误伤还在用的模型。
   */
  private disposeFbxSources(): void {
    this.clipCache.clear();
    for (const pending of this.fbxCache.values()) {
      // 仍在加载中的源：等它落地后立刻释放，避免销毁后又泄漏一个完整模型
      void pending.then(
        (source) => disposeObject(source.object),
        () => undefined,
      );
    }
    this.fbxCache.clear();
  }

  // ===== 部位染色 / 半透明 / 外发光 =====

  /**
   * 构建「部位 → 占用者 + 颜色」映射。
   * 冲突已在 store 层拦掉，这里遇到重复占用时保留先出现的 Strip（防御性处理）。
   * 颜色优先用 Strip 自定义色，缺省按索引从调色板取（resolveSegmentColor）。
   */
  private trackByPart(): Map<BodyPart, { strip: StripDef; color: string }> {
    const map = new Map<BodyPart, { strip: StripDef; color: string }>();
    this.strips.forEach((strip, index) => {
      const color = resolveSegmentColor(index, strip.color ?? null);
      for (const part of strip.parts) {
        if (!map.has(part)) map.set(part, { strip, color });
      }
    });
    return map;
  }

  /**
   * 为所有蒙皮网格建立逐顶点部位索引，并注入顶点色 / 外发光属性。
   *
   * 逐顶点部位判定：取该顶点 4 个骨骼影响里权重最大的那根骨骼，用 partOfBone 反查部位。
   * 这比「按骨骼分组后整体染色」更贴合蒙皮权重过渡区，避免关节处出现硬边。
   *
   * 每个网格会新增两个 attribute：
   *  - `color`（vec4）：RGBA 顶点色，alpha 承担「未添加部位半透明」的语义；
   *  - `aGlow`（float）：0/1 高亮遮罩，供片元着色器加自发光。
   */
  private buildPaints(): void {
    this.clearPaints();
    const base = this.base;
    if (!base) return;

    base.actor.placement.traverse((child) => {
      const mesh = child as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const geometry = mesh.geometry as THREE.BufferGeometry;
      const position = geometry.getAttribute('position');
      const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
      const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
      const count = position?.count ?? 0;
      if (!skinIndex || !skinWeight || count === 0) return;

      const skeletonBones = mesh.skeleton?.bones ?? base.bones;
      const partIndex: (BodyPart | null)[] = new Array(count);
      for (let vertex = 0; vertex < count; vertex += 1) {
        // 在 4 个骨骼槽位里找权重最大的槽位（Mixamo 的 skinWeight 固定 4 槽）
        let bestSlot = 0;
        let bestWeight = -1;
        for (let slot = 0; slot < 4; slot += 1) {
          const weight =
            slot === 0 ? skinWeight.getX(vertex)
              : slot === 1 ? skinWeight.getY(vertex)
                : slot === 2 ? skinWeight.getZ(vertex)
                  : skinWeight.getW(vertex);
          if (weight > bestWeight) {
            bestWeight = weight;
            bestSlot = slot;
          }
        }
        const boneIndex =
          bestSlot === 0 ? skinIndex.getX(vertex)
            : bestSlot === 1 ? skinIndex.getY(vertex)
              : bestSlot === 2 ? skinIndex.getZ(vertex)
                : skinIndex.getW(vertex);
        const bone = skeletonBones[boneIndex];
        partIndex[vertex] = bone ? partOfBone(bone.name) : null;
      }

      // vec4 顶点色：rgb 是部位/中性色，a 是透明度（未添加部位 0.5 / 已添加 1 / 仅显示已添加时 0）
      const color = new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4);
      geometry.setAttribute('color', color);
      // 外发光遮罩，逐顶点 0/1
      const glow = new THREE.Float32BufferAttribute(new Float32Array(count), 1);
      geometry.setAttribute('aGlow', glow);

      this.paintMaterials(mesh);
      this.paints.push({ mesh, partIndex });
    });

    this.refreshPaint();
    this.refreshGlow();
  }

  /**
   * 让材质支持顶点色（含逐顶点 alpha）与外发光注入。
   *
   * 通过 onBeforeCompile 向 Three.js 内置 MeshStandardMaterial 注入两段代码：
   *  - 顶点着色器：把 aGlow 传到 varying vGlow；
   *  - 片元着色器：在 emissive 计算后叠加 uGlowColor * vGlow * GLOW_STRENGTH，
   *    形成「外发光」观感（自发光项不受光照影响，看起来像一圈辉光）。
   *
   * 其它关键设置：
   *  - transparent + depthWrite=false：半透明部位之间不互相遮挡，避免排序闪烁；
   *  - customProgramCacheKey 固定字符串：保证同款着色器被复用，不会因函数引用不同而重新编译。
   *
   * @param mesh 需要染色的蒙皮网格；多材质时逐个处理
   */
  private paintMaterials(mesh: THREE.SkinnedMesh): void {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      standard.transparent = true;
      standard.vertexColors = true;
      standard.depthWrite = false;
      standard.needsUpdate = true;
      standard.onBeforeCompile = (shader) => {
        shader.vertexShader = `attribute float aGlow;\nvarying float vGlow;\n${shader.vertexShader}`.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vGlow = aGlow;',
        );
        shader.fragmentShader =
          `varying float vGlow;\nuniform vec3 uGlowColor;\n${shader.fragmentShader}`.replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow * ${GLOW_STRENGTH.toFixed(2)};`,
          );
        shader.uniforms.uGlowColor = { value: new THREE.Color(this.highlightColor) };
        // 保存 shader 引用，供 refreshGlow 在运行期改发光色（无需重新编译）
        standard.userData.stripsShader = shader;
      };
      standard.customProgramCacheKey = () => 'strips-part-paint-v1';
    }
  }

  /**
   * 按部位占用关系刷新逐顶点颜色与透明度。
   *
   * 配色规则（需求 6）：
   *  - 被某条 Strip 占用（且未静音）的部位 → 该 Strip 的颜色，alpha = 1（完全不透明）；
   *  - 其余部位 → 中性色，alpha = 0.5（需求 5）；当「仅显示已添加部位」开启时 alpha = 0（需求 4）。
   *
   * @sideEffect 直接写 geometry 的 color attribute 并标记 needsUpdate
   */
  private refreshPaint(): void {
    if (!this.base) return;
    const parts = this.trackByPart();
    for (const paint of this.paints) {
      const attribute = paint.mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attribute) continue;
      const array = attribute.array as Float32Array;
      const color = new THREE.Color();
      paint.partIndex.forEach((part, vertex) => {
        const owner = part ? parts.get(part) : undefined;
        if (owner && !owner.strip.muted) {
          color.set(owner.color);
          array[vertex * 4] = color.r;
          array[vertex * 4 + 1] = color.g;
          array[vertex * 4 + 2] = color.b;
          array[vertex * 4 + 3] = 1;
        } else {
          array[vertex * 4] = IDLE_COLOR.r;
          array[vertex * 4 + 1] = IDLE_COLOR.g;
          array[vertex * 4 + 2] = IDLE_COLOR.b;
          // 仅显示已添加部位时把未添加部分完全隐藏（alpha 0），否则保持 0.5 半透明
          array[vertex * 4 + 3] = this.showOnlyAdded ? 0 : IDLE_ALPHA;
        }
      });
      attribute.needsUpdate = true;
    }
  }

  /**
   * 刷新部位外发光遮罩与发光色（需求 3）。
   *
   * 顶点层面只写 0/1；颜色统一通过 uGlowColor uniform 控制，
   * 因此切换高亮色不需要重建几何属性，只需更新 uniform。
   *
   * @sideEffect 写 aGlow attribute、更新各材质 shader 的 uGlowColor
   */
  private refreshGlow(): void {
    for (const paint of this.paints) {
      const attribute = paint.mesh.geometry.getAttribute('aGlow') as THREE.BufferAttribute | undefined;
      if (!attribute) continue;
      const array = attribute.array as Float32Array;
      paint.partIndex.forEach((part, vertex) => {
        array[vertex] = part && this.highlightParts.includes(part) ? 1 : 0;
      });
      attribute.needsUpdate = true;

      const materials = Array.isArray(paint.mesh.material) ? paint.mesh.material : [paint.mesh.material];
      for (const material of materials) {
        const shader = (material as THREE.MeshStandardMaterial).userData.stripsShader as
          | { uniforms: Record<string, { value: unknown }> }
          | undefined;
        if (shader?.uniforms.uGlowColor) {
          (shader.uniforms.uGlowColor.value as THREE.Color).set(this.highlightColor);
        }
      }
    }
  }

  /**
   * 清空染色索引。
   * 注意：不销毁 geometry 上的 color / aGlow 属性 —— 它们随模型一起释放（disposeBase 里 actor.dispose），
   * 这里只是断开 player 对网格的引用。
   */
  private clearPaints(): void {
    this.paints = [];
  }

  // ===== 骨骼叠加 =====

  /**
   * 构建骨骼线几何（需求 12）。
   *
   * 每根骨骼与其「最近的骨骼祖先」连成一条线段；使用 LineSegments 一次性提交，
   * 比逐骨骼建 Object3D 更省 draw call。depthTest=false + 高 renderOrder 让骨骼线始终可见，
   * 不被半透明的躯体遮挡。
   */
  private buildSkeletonLines(): void {
    this.clearSkeletonLines();
    const base = this.base;
    if (!base) return;

    const indexOf = new Map<THREE.Object3D, number>();
    base.bones.forEach((bone, index) => indexOf.set(bone, index));
    const pairs: [THREE.Bone, THREE.Bone][] = [];
    for (const bone of base.bones) {
      // 向上穿透非骨骼节点，找到最近的、也属于 base.bones 的祖先
      let ancestor = bone.parent;
      while (ancestor && !indexOf.has(ancestor)) ancestor = ancestor.parent;
      if (ancestor) pairs.push([ancestor as THREE.Bone, bone]);
    }
    this.skeletonPairs = pairs;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 30;
    lines.frustumCulled = false;
    lines.visible = this.showSkeleton;
    this.skeletonLines = lines;
    this.scene.add(lines);
    this.updateSkeletonLines();
  }

  /**
   * 按骨骼世界坐标更新骨骼线端点。
   * 只在 showSkeleton 为真时由 tick() 调用，避免隐藏状态下白算。
   * 每帧都要 computeBoundingSphere，否则视锥裁剪会用旧包围球把线裁掉。
   */
  private updateSkeletonLines(): void {
    const base = this.base;
    const lines = this.skeletonLines;
    if (!base || !lines) return;
    base.actor.placement.updateMatrixWorld(true);
    const attribute = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    this.skeletonPairs.forEach(([parent, child], index) => {
      parent.getWorldPosition(from);
      child.getWorldPosition(to);
      array[index * 6] = from.x;
      array[index * 6 + 1] = from.y;
      array[index * 6 + 2] = from.z;
      array[index * 6 + 3] = to.x;
      array[index * 6 + 4] = to.y;
      array[index * 6 + 5] = to.z;
    });
    attribute.needsUpdate = true;
    lines.geometry.computeBoundingSphere();
  }

  /** 移除并释放骨骼线（几何 + 材质），同时清空父子对照表 */
  private clearSkeletonLines(): void {
    if (!this.skeletonLines) return;
    this.scene.remove(this.skeletonLines);
    this.skeletonLines.geometry.dispose();
    (this.skeletonLines.material as THREE.Material).dispose();
    this.skeletonLines = null;
    this.skeletonPairs = [];
  }

  // ===== 下肢（髋部）运动轨迹 =====

  /**
   * 创建下肢轨迹线（需求 16）。
   *
   * 用固定 64 个点的折线表示整段编排内髋部的水平投影路径；
   * 高度统一压到 0.015（贴地），避免竖直起伏让轨迹在 3D 视角里难以判读。
   * depthTest=false + renderOrder=20 保证轨迹在地面/模型之后绘制始终可见。
   */
  private buildTrajectory(): void {
    this.clearTrajectory();
    if (!this.base) return;
    const points = 64;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 3), 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 20;
    line.frustumCulled = false;
    this.trajectory = line;
    this.scene.add(line);
  }

  /**
   * 采样髋部世界坐标，画出下肢运动轨迹。
   *
   * 采样方式：沿 [0, liveDuration] 均匀取 64 个时间点，逐个 applyStrips 求值后取髋部世界位置。
   * 采样结束后必须把骨架恢复到当前播放头时刻（saved），否则画面会停在最后一个采样点。
   * 找不到髋部骨骼时隐藏轨迹（非标准骨架没有根位移，画出来也没有意义）。
   *
   * @sideEffect 会临时改写骨架姿态，然后恢复；重算轨迹几何与包围球
   */
  private updateTrajectory(): void {
    const base = this.base;
    const line = this.trajectory;
    if (!base || !line) return;
    const hips = base.bones.find((bone) => isHipsBone(bone.name));
    const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!hips) {
      line.visible = false;
      return;
    }

    const count = attribute.count;
    const array = attribute.array as Float32Array;
    const saved = this.time;
    const total = Math.max(0.1, this.liveDuration);
    const point = new THREE.Vector3();
    for (let index = 0; index < count; index += 1) {
      const time = (index / (count - 1)) * total;
      applyStrips(this.entries, base.bones, base.rest, time);
      base.actor.placement.updateMatrixWorld(true);
      hips.getWorldPosition(point);
      array[index * 3] = point.x;
      // 固定贴地高度：轨迹只表达水平位移，不表达跳跃/下蹲的竖直分量
      array[index * 3 + 1] = 0.015;
      array[index * 3 + 2] = point.z;
    }
    // 恢复播放头所在帧的姿态，避免采样影响当前画面
    applyStrips(this.entries, base.bones, base.rest, saved);
    base.actor.placement.updateMatrixWorld(true);
    attribute.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.visible = true;
  }

  /** 移除并释放轨迹线（几何 + 材质） */
  private clearTrajectory(): void {
    if (!this.trajectory) return;
    this.scene.remove(this.trajectory);
    this.trajectory.geometry.dispose();
    (this.trajectory.material as THREE.Material).dispose();
    this.trajectory = null;
  }
}
