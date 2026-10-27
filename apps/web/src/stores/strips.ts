/**
 * 拼接（Strips）工作区的状态中心。
 *
 * 职责：
 *  - 素材目录：三种来源（FBX 片段 / Kimodo 动画 / 已保存动画项目）统一加载，供左栏展示；
 *  - 编排状态：strips（轨道数组）、选中项、部位占用关系、时间轴默认总长 span；
 *  - 视觉开关：仅显示已添加部位、显示骨骼、悬停高亮部位；
 *  - 与播放器协作：创建/附着 StripsPlayer，把播放器事件转成响应式状态与 toast；
 *  - 保存链路：烘焙 → 生成 composition 快照 → 调 API 保存（新建 or 同 id 更新）。
 *
 * 状态机（与 dirty / bakedMode 相关，文档里也有图）：
 *  idle（空编排） → editing（有 Strip 但未烘焙，dirty=true）
 *  → baked（烘焙完成、bakedMode=true，可保存）→ saved（保存成功，dirty=false）
 *  任意编辑动作都会 invalidateBake() 回到 editing 并重新标 dirty。
 *
 * 设计要点：
 *  - 「最多 5 个源动画」不是额外规则，而是 5 个互不重叠部位的直接推论（MAX_STRIP_TRACKS）；
 *  - 部位冲突校验放在这里（setStripParts），而不是渲染层，保证 UI 任何入口都走同一套规则；
 *  - 播放器是命令式对象，不放进 ref（避免 Vue 深度代理 Three.js 对象导致性能与语义问题）。
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';

import { animationApi, type AnimationFile, type SavedAnimationProject } from '@/api/animation';
import { kimodoApi, type KimodoAnimation, type SomaSkeleton } from '@/api/kimodo';
import {
  StripsPlayer,
  type StripClipEvent,
  type StripsBakeResult,
  type StripsFrameState,
} from '@/viewer/strips/StripsPlayer';
import { BODY_PARTS } from '@/viewer/strips/StripParts';
import {
  BODY_PART_IDS,
  createStripId,
  type BodyPart,
  type StripDef,
  type StripSource,
  type StripsComposition,
} from '@/viewer/strips/StripTypes';
import { sourceKey } from '@/viewer/stage/StageTypes';
import { resolveSegmentColor } from '@/viewer/stage/segmentColors';

/** 轻量 toast：由 StripsPage 统一渲染，3.2 秒后自动消失 */
export interface StripsToast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

/** 5 个身体部位 → 最多 5 个源动画 */
export const MAX_STRIP_TRACKS = BODY_PART_IDS.length;

/** Kimodo 的帧率假定为 30fps，用于把 job.frames 换算成秒 */
const KIMODO_FPS = 30;
/** 单条 Strip 的最短时长（秒）：再短已经没有可辨别的动作，且不利于拖动 */
const MIN_STRIP_DURATION = 0.2;
/** 单条 Strip 的最长时长上限（秒）：防止误输入造成超大烘焙与时间轴不可用 */
const MAX_STRIP_DURATION = 60;

/**
 * 把时长夹到合法范围。
 * @param value 任意输入秒数；NaN / Infinity 一律回落到最短时长
 * @returns [MIN_STRIP_DURATION, MAX_STRIP_DURATION] 之间的秒数
 */
function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return MIN_STRIP_DURATION;
  return Math.min(MAX_STRIP_DURATION, Math.max(MIN_STRIP_DURATION, value));
}

/** 部位 id → 中文名（用于 toast / 冲突提示）；未知 id 原样返回 */
function partText(part: BodyPart): string {
  return BODY_PARTS.find((item) => item.id === part)?.label ?? part;
}

export const useStripsStore = defineStore('strips', () => {
  // ===== 素材目录（左栏三种来源） =====
  const files = ref<AnimationFile[]>([]);
  const projects = ref<SavedAnimationProject[]>([]);
  const kimodoJobs = ref<KimodoAnimation[]>([]);
  const somaSkeleton = shallowRef<SomaSkeleton | null>(null);
  const catalogLoading = ref(false);
  const catalogError = ref<string | null>(null);

  // ===== 编排状态 =====
  /** 基础模型（T 字 FBX）路径；空串表示尚未选择 */
  const basePath = ref('');
  /** 基础模型加载中（切换模型期间禁用重复点击） */
  const loadingBase = ref(false);
  /** 轨道数组，长度上限 MAX_STRIP_TRACKS；顺序决定调色板取色顺序 */
  const strips = ref<StripDef[]>([]);
  const selectedId = ref<string | null>(null);
  /** 新增 Strip 的时长在来源片段加载完成后自动补齐 */
  const autoDuration = new Set<string>();
  /** 每条 Strip 的来源加载状态（loading / ready / error） */
  const clipStates = ref<Record<string, StripClipEvent>>({});
  /** 每个来源片段的真实时长，决定时间轴默认总长 */
  const clipDurations = ref<Record<string, number>>({});

  // ===== 播放状态（由播放器回吐，不是命令源） =====
  const time = ref(0);
  const duration = ref(1);
  const playing = ref(false);
  const speed = ref(1);
  const loop = ref(true);

  // ===== 烘焙与保存 =====
  const baked = shallowRef<StripsBakeResult | null>(null);
  /** true 时预览播放的是烘焙片段（而非实时混合） */
  const bakedMode = ref(false);
  const baking = ref(false);
  /** 保存请求进行中，防止重复提交 */
  const saving = ref(false);
  const saveName = ref('');

  /** 当前编排对应的已保存项目（支持多次修改） */
  const projectId = ref<string | null>(null);
  const projectName = ref('');
  /** 是否有未保存的编排修改；离开拼接区 / 关闭浏览器据此提示（需求 18） */
  const dirty = ref(false);

  // ===== 视觉开关 =====
  /** 鼠标悬停的部位（优先于选中 Strip 的部位高亮） */
  const hoverPart = ref<BodyPart | null>(null);
  /** 仅显示已添加部位（需求 4） */
  const showOnlyAdded = ref(false);
  /** 显示骨骼线（需求 12） */
  const showBones = ref(false);

  const toasts = ref<StripsToast[]>([]);

  /** 播放器实例：刻意不入响应式，见模块头注释 */
  let player: StripsPlayer | null = null;
  let toastSeq = 0;
  /** 目录是否已加载过；用于区分「首次进入」与「重新进入恢复现场」 */
  let bootstrapped = false;
  /** 从动画工作区「编辑拼接」带过来的编排，等页面挂载后应用 */
  let pendingComposition: { composition: StripsComposition; projectId: string; projectName: string } | null = null;

  /** 当前基础模型对应的目录项（用于取展示名） */
  const baseFile = computed(() => files.value.find((file) => file.path === basePath.value) ?? null);
  const selectedStrip = computed(() => strips.value.find((strip) => strip.id === selectedId.value) ?? null);
  /** 已加入时间轴的来源（源动画列表据此高亮，需求 10） */
  const addedSourceKeys = computed(() => new Set(strips.value.map((strip) => sourceKey(strip.source))));
  /**
   * 时间轴默认总长：源动画里最长的一段（需求 8）。
   * 只取来源片段真实时长（clipDurations），不看 Strip 的裁切时长，
   * 因此调整裁剪不会缩短时间轴，用户总能拖回完整长度。
   */
  const span = computed(() => {
    let longest = 0;
    for (const strip of strips.value) {
      const value = clipDurations.value[strip.id];
      if (value && Number.isFinite(value)) longest = Math.max(longest, value);
    }
    return longest;
  });
  /** 正在高亮的部位：悬停优先，否则取选中 Strip 的全部部位（需求 3） */
  const highlightParts = computed<BodyPart[]>(() =>
    hoverPart.value ? [hoverPart.value] : (selectedStrip.value?.parts ?? []),
  );
  /** 有未保存的编排修改（切换工作区 / 关闭浏览器时需要提示） */
  const hasUnsavedChanges = computed(() => dirty.value);
  /** 是否还能再加一个来源（受 5 个部位上限约束，需求 11） */
  const canAddSource = computed(() => strips.value.length < MAX_STRIP_TRACKS);

  /**
   * 弹出一条 toast，并自动在 3.2 秒后移除。
   * @param kind info | success | error，仅影响配色与图标
   * @param text 展示文案（中文，需自带信息量）
   */
  function toast(kind: StripsToast['kind'], text: string): void {
    const item: StripsToast = { id: (toastSeq += 1), kind, text };
    toasts.value = [...toasts.value, item];
    setTimeout(() => {
      toasts.value = toasts.value.filter((entry) => entry.id !== item.id);
    }, 3200);
  }

  /** 标记有未保存改动（所有编辑动作的统一出口） */
  function markDirty(): void {
    dirty.value = true;
  }

  /**
   * 把「当前该高亮什么」同步给播放器。
   * 高亮色取选中 Strip 的标识色，让模型外发光与时间轴/来源列表颜色一致。
   */
  function syncHighlight(): void {
    player?.setHighlight(highlightParts.value, selectedStrip.value?.color ?? null);
  }

  // ===== 素材目录 =====

  /**
   * 并行加载四类素材（任一失败不影响其它）：
   *  - animationApi.list()   ：可用的 FBX 模型/片段；
   *  - kimodoApi.animations()：Kimodo 生成任务（只保留 status=ready 的，未完成的不能播放）；
   *  - animationApi.projects()：已保存动画项目（可作为来源再次拼接）；
   *  - kimodoApi.skeleton()  ：Soma 骨架，用于 Kimodo 来源的缩略图。
   * 单项失败用 catch 兜底成空值，避免「一个接口挂了整页空白」。
   */
  async function loadCatalog(): Promise<void> {
    catalogLoading.value = true;
    catalogError.value = null;
    try {
      const [list, jobs, saved, skeleton] = await Promise.all([
        animationApi.list().catch(() => null),
        kimodoApi.animations().catch(() => [] as KimodoAnimation[]),
        animationApi.projects().catch(() => null),
        kimodoApi.skeleton().catch(() => null),
      ]);
      files.value = list?.files ?? [];
      kimodoJobs.value = jobs.filter((job) => job.status === 'ready');
      projects.value = saved?.projects ?? [];
      somaSkeleton.value = skeleton;
    } catch (error) {
      catalogError.value = error instanceof Error ? error.message : '素材目录加载失败';
    } finally {
      catalogLoading.value = false;
    }
  }

  /**
   * 附着播放器实例并接线回调（由 StripsViewport 在挂载时调用）。
   *
   * 两种情况：
   *  1. 首次进入（bootstrapped=false）：只接线，等 bootstrap() 决定加载哪个基础模型；
   *  2. 重新进入（bootstrapped=true，如从别的页面切回）：需要把「离开前的现场」整体恢复
   *     ——基础模型、Strip 集合、视觉开关、高亮、以及烘焙预览模式。
   *     这正是需求 18「切换页面不丢编排」的实现点：编排数据一直在 store 里，播放器只是重挂。
   */
  function attachPlayer(next: StripsPlayer): void {
    player = next;
    next.onFrame(onFrame);
    next.onNotice((message) => toast('error', message));
    next.onClipState(onClipState);
    next.setLoop(loop.value);
    next.setSpeed(speed.value);
    next.setSpan(span.value);

    if (bootstrapped && basePath.value) {
      void next.loadBase(basePath.value).then(async () => {
        await next.setStrips(strips.value);
        next.setShowOnlyAdded(showOnlyAdded.value);
        next.setShowSkeleton(showBones.value);
        next.setHighlight(highlightParts.value, selectedStrip.value?.color ?? null);
        // 重新进入页面时把之前的烘焙结果恢复成预览，避免模式标记与视口不一致
        if (bakedMode.value && baked.value) next.setBakedClip(baked.value.clip);
      });
    }
  }

  /** 解除播放器引用（组件卸载时调用）；不销毁实例，销毁由 Viewport 负责 */
  function detachPlayer(): void {
    player = null;
  }

  /**
   * 页面启动时的编排初始化。
   *
   * 三种分支：
   *  1. 有 pendingComposition（从动画工作区「编辑拼接」跳转而来）→ 应用该编排；
   *  2. 非首次进入 → 现场已由 attachPlayer 恢复，直接返回；
   *  3. 首次进入 → 自动选中第一个可用模型，并填好默认保存名。
   *
   * 注意 bootstrapped 在函数开头就置 true，即使中途 return 也不会重复加载目录。
   */
  async function bootstrap(): Promise<void> {
    const alreadyBootstrapped = bootstrapped;
    bootstrapped = true;
    if (!alreadyBootstrapped) await loadCatalog();
    if (!player) return;

    if (pendingComposition) {
      const pending = pendingComposition;
      pendingComposition = null;
      await applyComposition(pending.composition, pending.projectId, pending.projectName);
      return;
    }
    // 重新进入页面时 attachPlayer 已经恢复了现场
    if (alreadyBootstrapped) return;

    if (!basePath.value && files.value.length > 0) {
      await selectBase(files.value[0].path);
      saveName.value = defaultSaveName();
    }
  }

  /** 播放器帧状态 → 响应式（时间轴播放头 / 总长 / 播放按钮） */
  function onFrame(state: StripsFrameState): void {
    time.value = state.time;
    duration.value = state.duration;
    playing.value = state.playing;
  }

  /**
   * 来源片段加载状态回调。
   *
   * 两件事：
   *  1. 记录状态供 UI 显示；
   *  2. ready 时记录真实时长（驱动 span = 时间轴默认总长）；
   *  3. 若是「新增且尚未手动改过时长」的 Strip（autoDuration），把时长自动设为
   *     「片段时长 - 裁剪起点」，让新加入的轨道一出现就覆盖完整片段（需求 7/8 的体验基础）。
   */
  function onClipState(event: StripClipEvent): void {
    clipStates.value = { ...clipStates.value, [event.stripId]: event };
    if (event.status !== 'ready' || event.duration === undefined) return;
    clipDurations.value = { ...clipDurations.value, [event.stripId]: event.duration };
    if (!autoDuration.has(event.stripId)) return;
    autoDuration.delete(event.stripId);
    const strip = strips.value.find((item) => item.id === event.stripId);
    if (!strip) return;
    strip.duration = clampDuration(event.duration - strip.trimStart);
  }

  // 时间轴默认总长：源动画里最长的一段
  watch(span, (value) => player?.setSpan(value));

  /**
   * 切换基础模型。
   *
   * 会清空烘焙结果与来源加载状态，并让已有 Strip 重新绑定到新骨架（骨架不匹配的来源会报错）；
   * 若已有编排，切换模型被视为一次编辑（标 dirty）。
   *
   * @param path 模型路径；与当前相同或正在加载时直接忽略
   */
  async function selectBase(path: string): Promise<void> {
    if (!player) {
      toast('error', '播放器尚未就绪');
      return;
    }
    if (loadingBase.value || path === basePath.value) return;
    loadingBase.value = true;
    // 换模型后旧烘焙失效（骨架不同，关键帧不再对应）
    baked.value = null;
    bakedMode.value = false;
    try {
      const ok = await player.loadBase(path);
      if (!ok) return;
      basePath.value = path;
      clipStates.value = {};
      if (strips.value.length > 0) markDirty();
      await player.setStrips(strips.value);
      player.setShowOnlyAdded(showOnlyAdded.value);
      player.setShowSkeleton(showBones.value);
      syncHighlight();
      toast('success', `基础模型已切换：${baseFile.value?.name ?? path}`);
    } finally {
      loadingBase.value = false;
    }
  }

  /** 列出某个 FBX 里的片段（按需加载，失败返回空） */
  async function listFbxClips(path: string): Promise<{ name: string; duration: number }[]> {
    try {
      return (await player?.listClips(path)) ?? [];
    } catch {
      toast('error', '读取 FBX 片段失败');
      return [];
    }
  }

  /**
   * Kimodo 动画时长（秒）：job.frames / 30。
   * 找不到任务时返回 1 秒兜底，保证时间轴宽度计算不会出现 0。
   */
  function kimodoDuration(animationId: string): number {
    const job = kimodoJobs.value.find((item) => item.id === animationId);
    return job ? Math.max(0.1, job.frames / KIMODO_FPS) : 1;
  }

  /**
   * 来源的展示名（用于默认 Strip 名 / 左栏列表）。
   *  - fbx-clip    ：「模型名 · 片段名」；
   *  - kimodo      ：优先 note，其次 prompt，最后用 id 前 6 位；
   *  - anim-project：项目名。
   */
  function sourceLabel(source: StripSource): string {
    if (source.kind === 'fbx-clip') {
      const file = files.value.find((item) => item.path === source.fbxPath);
      const base = file?.name.replace(/\.fbx$/i, '') ?? 'FBX';
      return `${base} · ${source.clipName}`;
    }
    if (source.kind === 'kimodo') {
      const job = kimodoJobs.value.find((item) => item.id === source.animationId);
      return job?.note?.trim() || job?.prompt?.trim() || `Kimodo ${source.animationId.slice(0, 6)}`;
    }
    return source.projectName;
  }

  /** 该来源是否已在时间轴上（左栏高亮 + 阻止重复添加同一条） */
  function isSourceAdded(source: StripSource): boolean {
    return addedSourceKeys.value.has(sourceKey(source));
  }

  // ===== Strip 编辑 =====

  /**
   * 让烘焙结果失效并回到实时混合。
   * 任何会改变最终动画的编辑动作（部位/裁剪/权重/静音/增删轨道/换模型）都必须调用它，
   * 否则会出现「界面上改了但预览还是旧烘焙」的错觉。
   */
  function invalidateBake(): void {
    if (!baked.value) return;
    baked.value = null;
    bakedMode.value = false;
    player?.setBakedClip(null);
  }

  /**
   * 某个部位当前被哪条 Strip 占用。
   * @param part 要查询的部位
   * @param exceptId 排除某条 Strip（用于「自己改自己」时不把自己算成冲突）
   * @returns 占用者；无人占用返回 null
   */
  function ownerOfPart(part: BodyPart, exceptId?: string): StripDef | null {
    return (
      strips.value.find((strip) => strip.id !== exceptId && strip.parts.includes(part)) ?? null
    );
  }

  /**
   * 当前空闲的部位列表（按 BODY_PART_IDS 的固定顺序）。
   * @param exceptId 排除某条 Strip 后计算（编辑它的部位分配时用）
   */
  function freeParts(exceptId?: string): BodyPart[] {
    return BODY_PART_IDS.filter((part) => !ownerOfPart(part, exceptId));
  }

  /**
   * 添加一个源动画。
   * 最多 5 个源动画；默认占用第一个空闲部位，之后可在检查器里多选部位。
   *
   * 失败路径（全部以 toast 提示，不抛异常）：
   *  - 未选基础模型 → 「请先选择基础模型」；
   *  - 已有 5 条轨道 → 提示最多 5 个源动画（需求 11）；
   *  - 该来源已在时间轴上 → 提示去检查器勾选更多部位（同一来源不允许重复建轨）；
   *  - 5 个部位都被占用 → 提示先取消某个部位。
   *
   * @param source 三种来源之一（FBX 片段 / Kimodo / 已保存项目）
   * @param parts  可选：希望占用的部位；其中已被占用的会被过滤，剩余为空则取第一个空闲部位
   */
  function addStrip(source: StripSource, parts?: readonly BodyPart[]): void {
    if (!basePath.value) {
      toast('info', '请先选择基础模型');
      return;
    }
    if (strips.value.length >= MAX_STRIP_TRACKS) {
      toast('error', `最多从 ${MAX_STRIP_TRACKS} 个源动画拼接（身体部位只有 ${MAX_STRIP_TRACKS} 个）`);
      return;
    }
    if (isSourceAdded(source)) {
      toast('info', '这个动画已在时间轴上，请在右侧检查器里勾选更多身体部位');
      return;
    }
    const free = freeParts();
    if (free.length === 0) {
      toast('error', '5 个身体部位都已被其他动画占用，请先取消某个部位');
      return;
    }
    const chosen = (parts ?? []).filter((part) => free.includes(part));
    const initial = chosen.length > 0 ? chosen : free.slice(0, 1);

    const index = strips.value.length;
    const strip: StripDef = {
      id: createStripId(),
      name: sourceLabel(source),
      source,
      parts: initial,
      start: 0,
      trimStart: 0,
      // 先给 1 秒占位，来源加载完成后由 autoDuration 修正为真实时长
      duration: 1,
      weight: 1,
      muted: false,
      color: resolveSegmentColor(index),
    };
    strips.value = [...strips.value, strip];
    autoDuration.add(strip.id);
    selectedId.value = strip.id;
    // 先标记 loading，避免检查器/时间轴在加载完成前显示错误状态
    clipStates.value = { ...clipStates.value, [strip.id]: { stripId: strip.id, status: 'loading' } };
    if (!saveName.value.trim()) saveName.value = defaultSaveName();
    // 新增轨道会改变最终动画：旧烘焙必须作废
    invalidateBake();
    markDirty();
    void player?.setStrips(strips.value);
    syncHighlight();
    toast('success', `已添加「${strip.name}」 · ${strip.parts.map(partText).join('、')}`);
  }

  /**
   * 设置某条 Strip 的占用部位（可多选）。
   * 跨动画重复占用同一部位会被拦下并提示冲突（需求 1）。
   *
   * @param id   目标 Strip
   * @param next 期望的部位集合；内部会按 BODY_PART_IDS 去重并排序
   * @returns 是否设置成功（false 时界面保持原样，用户能看到 toast 原因）
   */
  function setStripParts(id: string, next: readonly BodyPart[]): boolean {
    const strip = strips.value.find((item) => item.id === id);
    if (!strip) return false;
    const unique = BODY_PART_IDS.filter((part) => next.includes(part));
    if (unique.length === 0) {
      toast('info', '至少保留一个身体部位');
      return false;
    }
    const conflicts = unique.filter((part) => ownerOfPart(part, id));
    if (conflicts.length > 0) {
      const detail = conflicts
        .map((part) => `${partText(part)}（已被「${ownerOfPart(part, id)?.name ?? '其他动画'}」使用）`)
        .join('、');
      toast('error', `部位冲突：${detail}`);
      return false;
    }
    strip.parts = unique;
    invalidateBake();
    markDirty();
    void player?.setStrips(strips.value);
    syncHighlight();
    return true;
  }

  /** 勾选/取消某个部位（检查器里的一次点击）；校验逻辑统一走 setStripParts */
  function toggleStripPart(id: string, part: BodyPart): void {
    const strip = strips.value.find((item) => item.id === id);
    if (!strip) return;
    const next = strip.parts.includes(part)
      ? strip.parts.filter((item) => item !== part)
      : [...strip.parts, part];
    setStripParts(id, next);
  }

  /**
   * 按字段增量更新一条 Strip（检查器的统一入口）。
   *
   * 各字段的边界处理：
   *  - name      ：trim 后为空则忽略（不允许空名）；
   *  - parts     ：交给 setStripParts 做去重 + 冲突校验；
   *  - start     ：>= 0；
   *  - trimStart ：>= 0，并取消 autoDuration（用户已明确控制时长语义）；
   *  - duration  ：夹到 [MIN, MAX]，同样取消 autoDuration；
   *  - weight    ：夹到 [0, 1]；
   *  - muted / color：原样写入。
   */
  function updateStrip(id: string, patch: Partial<StripDef>): void {
    const strip = strips.value.find((item) => item.id === id);
    if (!strip) return;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name) strip.name = name;
    }
    if (patch.parts !== undefined) {
      setStripParts(id, patch.parts);
    }
    if (patch.start !== undefined) strip.start = Math.max(0, patch.start);
    if (patch.trimStart !== undefined) {
      strip.trimStart = Math.max(0, patch.trimStart);
      autoDuration.delete(id);
    }
    if (patch.duration !== undefined) {
      strip.duration = clampDuration(patch.duration);
      autoDuration.delete(id);
    }
    if (patch.weight !== undefined) strip.weight = Math.min(1, Math.max(0, patch.weight));
    if (patch.muted !== undefined) strip.muted = patch.muted;
    if (patch.color !== undefined) strip.color = patch.color;
    invalidateBake();
    markDirty();
    void player?.setStrips(strips.value);
  }

  /**
   * 删除一条 Strip。
   * 会同步清理该轨道的加载状态与时长缓存（否则 span 仍会被已删除来源撑大），
   * 若删的是当前选中项则自动选中第一条。
   */
  function removeStrip(id: string): void {
    strips.value = strips.value.filter((item) => item.id !== id);
    autoDuration.delete(id);
    const nextStates = { ...clipStates.value };
    delete nextStates[id];
    clipStates.value = nextStates;
    const nextDurations = { ...clipDurations.value };
    delete nextDurations[id];
    clipDurations.value = nextDurations;
    if (selectedId.value === id) selectedId.value = strips.value[0]?.id ?? null;
    invalidateBake();
    markDirty();
    void player?.setStrips(strips.value);
    syncHighlight();
  }

  /**
   * 复制一条 Strip。
   * 复制体只占用一个空闲部位（原部位已被源占用，不能再给同一来源的副本占用），
   * 起点右移 0.5 秒，便于直接看到两条轨道的叠加效果。
   * 超出 5 条或没有空闲部位时提示并放弃。
   */
  function duplicateStrip(id: string): void {
    const strip = strips.value.find((item) => item.id === id);
    if (!strip) return;
    if (strips.value.length >= MAX_STRIP_TRACKS) {
      toast('error', `最多 ${MAX_STRIP_TRACKS} 条源动画轨道`);
      return;
    }
    const free = freeParts();
    if (free.length === 0) {
      toast('error', '没有空闲部位可以复制');
      return;
    }
    const copy: StripDef = {
      ...strip,
      id: createStripId(),
      name: `${strip.name} 副本`,
      parts: [free[0]],
      start: strip.start + 0.5,
      color: resolveSegmentColor(strips.value.length),
    };
    strips.value = [...strips.value, copy];
    selectedId.value = copy.id;
    clipStates.value = { ...clipStates.value, [copy.id]: { stripId: copy.id, status: 'loading' } };
    invalidateBake();
    markDirty();
    void player?.setStrips(strips.value);
    syncHighlight();
  }

  /** 选中一条 Strip（null 表示取消选中）；选中项决定检查器内容与部位高亮范围 */
  function selectStrip(id: string | null): void {
    selectedId.value = id;
    syncHighlight();
  }

  /**
   * 设置悬停部位（来自左栏来源列表或检查器部位项的 hover）。
   * 悬停优先于选中项高亮：鼠标指哪儿亮哪儿（需求 3 的交互细节）。
   */
  function setHoverPart(part: BodyPart | null): void {
    hoverPart.value = part;
    syncHighlight();
  }

  // ===== 视觉开关 =====

  /** 切换「仅显示已添加部位」（需求 4） */
  function toggleShowOnlyAdded(): void {
    showOnlyAdded.value = !showOnlyAdded.value;
    player?.setShowOnlyAdded(showOnlyAdded.value);
  }

  /** 切换骨骼线显示（需求 12） */
  function toggleBones(): void {
    showBones.value = !showBones.value;
    player?.setShowSkeleton(showBones.value);
  }

  // ===== 播放（全部委托给播放器，store 只存回吐值） =====

  function togglePlay(): void {
    player?.togglePlay();
  }

  function seek(value: number): void {
    player?.seek(value);
  }

  function setSpeed(value: number): void {
    speed.value = value;
    player?.setSpeed(value);
  }

  function toggleLoop(): void {
    loop.value = !loop.value;
    player?.setLoop(loop.value);
  }

  // ===== 烘焙与保存 =====

  /**
   * 默认名称：动画自由拼-年-月-日-时-分-秒（需求 13）。
   * 月份从 0 开始，因此 +1；不做补零，保持与需求文案一致（如 2026-3-5-9-7-4）。
   */
  function defaultSaveName(): string {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    ].join('-');
    return `动画自由拼-${stamp}`;
  }

  /**
   * 烘焙当前编排（需求 7/8：以时间轴总长采样，30fps）。
   *
   * 烘焙成功后立即切到 baked 预览，让用户看到「将要保存的」结果；
   * 失败时保持实时混合并提示（不会留下半成品状态）。
   */
  function bake(): void {
    if (!player) return;
    if (strips.value.length === 0) {
      toast('info', '请先添加至少一个 Strip');
      return;
    }
    baking.value = true;
    try {
      const result = player.bake(30);
      if (!result) {
        toast('error', '没有可烘焙的内容');
        return;
      }
      baked.value = result;
      bakedMode.value = true;
      player.setBakedClip(result.clip);
      if (!saveName.value.trim()) saveName.value = defaultSaveName();
      const tracks = result.data.clips[0]?.tracks.length ?? 0;
      toast('success', `烘焙完成：${tracks} 条轨道`);
    } finally {
      baking.value = false;
    }
  }

  /**
   * 在「实时混合」与「烘焙预览」之间切换。
   * @param on true 需要已有烘焙结果；否则提示「请先烘焙」并保持现状
   */
  function setBakedMode(on: boolean): void {
    if (on && !baked.value) {
      toast('info', '请先烘焙');
      return;
    }
    bakedMode.value = on;
    player?.setBakedClip(on ? baked.value?.clip ?? null : null);
  }

  /**
   * 生成可再次编辑的编排快照（与烘焙数据一起保存）。
   *
   * 注意 tracks 做了浅拷贝 + parts 深拷贝：
   *  - 浅拷贝避免把响应式对象引用直接交给网络层 / 序列化；
   *  - parts 单独复制，防止之后在界面上改部位时把已提交的快照也改掉。
   * duration 记录的是「时间轴默认总长」（span），不是某条轨道的时长。
   */
  function compositionSnapshot(): StripsComposition {
    return {
      version: 1,
      basePath: basePath.value,
      baseName: baseFile.value?.name ?? 'base.fbx',
      duration: span.value,
      savedName: saveName.value.trim() || projectName.value,
      tracks: strips.value.map((strip) => ({ ...strip, parts: [...strip.parts] })),
    };
  }

  /**
   * 保存烘焙后的拼接动画（需求 14/17：新建与多次更新）。
   *
   * 行为：
   *  - 未烘焙或没有基础模型 → 提示先烘焙；
   *  - 名称为空 → 提示输入名称；
   *  - projectId 为 null → 生成新 id（新建）；否则沿用原 id（覆盖更新）。
   * 保存成功后清零 dirty，并刷新素材目录与动画工作区列表，
   * 这样新保存的项目能立刻作为「已保存项目」来源再次参与拼接。
   *
   * 失败路径：API 抛错时保留 dirty（用户仍可重试），并 toast 具体原因。
   */
  async function saveBaked(): Promise<void> {
    if (!baked.value || !basePath.value) {
      toast('info', '请先烘焙再保存');
      return;
    }
    const name = saveName.value.trim();
    if (!name) {
      toast('info', '请输入动画名称');
      return;
    }
    saving.value = true;
    try {
      const data = baked.value.data;
      const clipData = data.clips[0];
      const id =
        projectId.value ??
        `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await animationApi.saveProject({
        id,
        name,
        basePath: basePath.value,
        baseName: baseFile.value?.name ?? 'base.fbx',
        data,
        imported: {
          name: `拼接 · ${strips.value.length} 个源动画`,
          clipCount: data.clips.length,
          trackCount: clipData?.tracks.length ?? 0,
        },
        composition: compositionSnapshot(),
      });
      const updated = projectId.value !== null;
      projectId.value = id;
      projectName.value = name;
      saveName.value = name;
      dirty.value = false;
      toast('success', updated ? `已更新拼接动画「${name}」` : `已保存为拼接动画「${name}」`);
      // 左栏来源列表立刻刷新，能马上把它再拼进别的 Strip
      void loadCatalog();
      // 动画工作区下次打开时直接能看到新条目
      const { useAnimationStore } = await import('./animation');
      void useAnimationStore().loadProjects();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      saving.value = false;
    }
  }

  // ===== 拼接编排的新建 / 打开 =====

  /**
   * 清空编排相关状态（保留素材目录、基础模型路径与视觉开关）。
   * 用于「新建」（newComposition）与「打开已保存编排」（applyComposition）前的复位。
   */
  function resetState(): void {
    strips.value = [];
    selectedId.value = null;
    clipStates.value = {};
    clipDurations.value = {};
    autoDuration.clear();
    hoverPart.value = null;
    baked.value = null;
    bakedMode.value = false;
    player?.setBakedClip(null);
    void player?.setStrips([]);
    syncHighlight();
  }

  /** 新建一个空编排（保留当前基础模型，需求 14）；projectId 置空表示下次保存会新建项目 */
  function newComposition(): void {
    resetState();
    projectId.value = null;
    projectName.value = '';
    saveName.value = defaultSaveName();
    dirty.value = false;
    toast('success', '已新建拼接动画');
  }

  /**
   * 从动画工作区打开一个已保存的拼接编排，继续修改（需求 17）。
   *
   * 为什么有 pendingComposition 分支：
   *  按钮点击发生在动画工作区，此时拼接页面的播放器尚未挂载；先把编排暂存，
   *  等 StripsViewport 挂载并 attachPlayer 后，bootstrap() 再消费它。
   *
   * @param id 已保存项目的 id
   * @returns 是否成功打开（读取失败 / 该项目没有 composition 时返回 false 并提示）
   */
  async function openComposition(id: string): Promise<boolean> {
    try {
      const project = await animationApi.project(id);
      const composition = project.composition;
      if (!composition || !Array.isArray(composition.tracks)) {
        toast('error', '这个动画没有可编辑的拼接编排');
        return false;
      }
      if (player) {
        await applyComposition(composition, project.id, project.name);
      } else {
        pendingComposition = { composition, projectId: project.id, projectName: project.name };
      }
      return true;
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '打开拼接编排失败');
      return false;
    }
  }

  /**
   * 把一段来自磁盘（可能被手改脏 / 旧版本）的轨道数据修成合法 StripDef。
   *
   * 容错点：
   *  - parts 过滤掉非法 id；为空时按索引轮流分配一个部位（保证与「至少一个部位」的约束一致）；
   *  - color / weight / start / trimStart / duration 全部夹到合法范围；
   *  - muted 强制转布尔。
   *
   * @param track 原始轨道数据
   * @param index 轨道索引，用于补默认部位与调色板取色
   */
  function normalizeTrack(track: StripDef, index: number): StripDef {
    const parts = (Array.isArray(track.parts) ? track.parts : []).filter((part) =>
      BODY_PART_IDS.includes(part),
    );
    return {
      ...track,
      parts: parts.length > 0 ? parts : [BODY_PART_IDS[index % BODY_PART_IDS.length]],
      color: track.color ?? resolveSegmentColor(index),
      weight: Number.isFinite(track.weight) ? Math.min(1, Math.max(0, track.weight)) : 1,
      muted: Boolean(track.muted),
      start: Math.max(0, Number.isFinite(track.start) ? track.start : 0),
      trimStart: Math.max(0, Number.isFinite(track.trimStart) ? track.trimStart : 0),
      duration: clampDuration(track.duration),
    };
  }

  /**
   * 应用一份编排（打开已保存项目或消费 pendingComposition）。
   *
   * 流程：复位 → 写入规范化后的轨道 → 回填项目 id/名称/保存名 → 清 dirty
   * → 必要时切换基础模型 → 重新绑定 Strip 与视觉开关。
   * 基础模型切换失败时保留原有模型（不会让页面空掉）。
   *
   * @param composition 编排快照
   * @param nextProjectId 对应项目 id（后续保存走更新而非新建）
   * @param nextProjectName 项目名（回填保存名输入框）
   */
  async function applyComposition(
    composition: StripsComposition,
    nextProjectId: string,
    nextProjectName: string,
  ): Promise<void> {
    resetState();
    strips.value = composition.tracks.map((track, index) => normalizeTrack(track, index));
    selectedId.value = strips.value[0]?.id ?? null;
    projectId.value = nextProjectId;
    projectName.value = nextProjectName;
    saveName.value = nextProjectName;
    dirty.value = false;

    if (!player) return;
    if (composition.basePath && composition.basePath !== basePath.value) {
      loadingBase.value = true;
      try {
        const ok = await player.loadBase(composition.basePath);
        if (ok) basePath.value = composition.basePath;
      } finally {
        loadingBase.value = false;
      }
    }
    await player.setStrips(strips.value);
    player.setShowOnlyAdded(showOnlyAdded.value);
    player.setShowSkeleton(showBones.value);
    syncHighlight();
  }

  return {
    files,
    projects,
    kimodoJobs,
    somaSkeleton,
    catalogLoading,
    catalogError,
    basePath,
    baseFile,
    loadingBase,
    strips,
    selectedId,
    selectedStrip,
    addedSourceKeys,
    span,
    highlightParts,
    hasUnsavedChanges,
    canAddSource,
    clipStates,
    time,
    duration,
    playing,
    speed,
    loop,
    baked,
    bakedMode,
    baking,
    saving,
    saveName,
    projectId,
    projectName,
    dirty,
    hoverPart,
    showOnlyAdded,
    showBones,
    toasts,
    attachPlayer,
    detachPlayer,
    toast,
    bootstrap,
    loadCatalog,
    selectBase,
    listFbxClips,
    kimodoDuration,
    sourceLabel,
    isSourceAdded,
    addStrip,
    setStripParts,
    toggleStripPart,
    ownerOfPart,
    freeParts,
    updateStrip,
    removeStrip,
    duplicateStrip,
    selectStrip,
    setHoverPart,
    toggleShowOnlyAdded,
    toggleBones,
    togglePlay,
    seek,
    setSpeed,
    toggleLoop,
    defaultSaveName,
    bake,
    setBakedMode,
    saveBaked,
    newComposition,
    openComposition,
  };
});
