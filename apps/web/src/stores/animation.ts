import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { animationApi, type AnimationFile, type AnimationInfoResponse } from '@/api/animation';
import {
  FbxPlayer,
  type BoneTransformState,
  type ClipInfo,
  type ModelStats,
  type ModalTransformState,
  type PoseState,
  type SceneNode,
  type TransformMode,
  type TransformSpace,
} from '@/viewer/FbxPlayer';
import type { BoneDisplayMode, BoneNode, FlatBone } from '@/viewer/SkeletonOverlay';
import { matchToken } from '@/utils/fuzzy';

const THUMB_SIZE = 256;
/** 封面只在内存里保存，绝不写盘（源文件夹必须保持只读） */
const MAX_THUMBNAILS = 300;
const THUMB_HOST_ID = 'anim-thumb-host';
const PAGE_SIZES = [12, 24, 48, 96];
const ALL_FOLDERS = '__all__';

/** 离屏渲染容器：必须挂在 DOM 上且有实际尺寸，否则渲染器尺寸为 1×1 */
function ensureThumbHost(): HTMLDivElement {
  const existing = document.getElementById(THUMB_HOST_ID);
  if (existing instanceof HTMLDivElement) return existing;
  const host = document.createElement('div');
  host.id = THUMB_HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${THUMB_SIZE}px`,
    `height:${THUMB_SIZE}px`,
    'pointer-events:none',
    'opacity:0',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(host);
  return host;
}

export interface AnimationToast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export const useAnimationStore = defineStore('animation', () => {
  const info = ref<AnimationInfoResponse | null>(null);
  const dirs = ref<string[]>([]);
  const missingDirs = ref<string[]>([]);
  const files = ref<AnimationFile[]>([]);
  const truncated = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const keyword = ref('');
  const folderFilter = ref<string>(ALL_FOLDERS);

  // 分页
  const page = ref(1);
  const pageSize = ref(24);

  const selectedPath = ref<string | null>(null);
  const selectedClips = ref<ClipInfo[]>([]);
  const selectedStats = ref<ModelStats | null>(null);
  const activeClipIndex = ref(0);
  const playing = ref(false);
  const speed = ref(1);
  const mirror = ref(false);
  const inPlace = ref(false);
  const showGrid = ref(true);
  const currentTime = ref(0);
  const duration = ref(0);
  const viewLoading = ref(false);
  const viewError = ref<string | null>(null);
  const toasts = ref<AnimationToast[]>([]);

  // 骨骼
  const showSkeleton = ref(false);
  /** 骨骼显示方式：点线 / 八面体 */
  const boneDisplayMode = ref<BoneDisplayMode>('stick');
  const boneTree = ref<BoneNode[]>([]);
  const boneList = ref<FlatBone[]>([]);
  const selectedBones = ref<string[]>([]);
  const boneKeyword = ref('');
  const ignoredBoneNodes = ref(0);
  /** 光标下悬停的骨骼（用于点选前的反馈） */
  const hoveredBoneId = ref<string | null>(null);

  // 姿态模式
  const poseMode = ref(false);
  const transformMode = ref<TransformMode>('rotate');
  const transformSpace = ref<TransformSpace>('local');
  const bonePose = ref<BoneTransformState | null>(null);
  const poseChangedCount = ref(0);
  const poseBoneTotal = ref(0);
  /** 正在进行的 G/R/S 模态变换 */
  const modalTransform = ref<ModalTransformState | null>(null);

  // 场景节点树
  const nodeTree = ref<SceneNode[]>([]);
  const selectedNodeIds = ref<string[]>([]);
  const nodeKeyword = ref('');
  /** 节点树是否包含骨骼节点（骨骼在「骨骼」页签里有更细的界面） */
  const nodeShowBones = ref(false);

  /** 内存封面缓存：key = 文件绝对路径（跨页保留，切回时无需重算） */
  const thumbnails = ref<Record<string, string>>({});
  const thumbBusy = ref(false);

  let player: FbxPlayer | null = null;
  let toastSeq = 0;
  let thumbWorker: FbxPlayer | null = null;
  let thumbQueue: AnimationFile[] = [];
  let thumbRunning = false;
  const thumbRequests = new Set<string>();

  // ===== 列表 / 分页 =====

  /**
   * 模糊搜索：每个关键词依次尝试「文件名 → 文件夹标签」，全部命中才算匹配。
   * 因此 `mixamo walk` 可以一词命中文件夹、一词命中文件名。
   */
  function scoreFile(file: AnimationFile, query: string): { score: number; indices: number[] } | null {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { score: 0, indices: [] };

    let score = 0;
    const indices: number[] = [];
    for (const token of tokens) {
      const byName = matchToken(file.relative, token);
      if (byName) {
        score += byName.score;
        indices.push(...byName.indices);
        continue;
      }
      // 文件名不命中时退回文件夹标签，命中的字符不参与高亮
      const byLabel = matchToken(file.sourceLabel, token);
      if (!byLabel) return null;
      score += byLabel.score - 200;
    }
    return { score, indices: [...new Set(indices)].sort((a, b) => a - b) };
  }

  /** 过滤 + 排序的结果；有关键词时按相关度排序 */
  const rankedFiles = computed<{ file: AnimationFile; indices: number[] }[]>(() => {
    const query = keyword.value.trim();
    const inFolder = files.value.filter(
      (file) => folderFilter.value === ALL_FOLDERS || file.sourceDir === folderFilter.value,
    );
    if (!query) return inFolder.map((file) => ({ file, indices: [] }));

    const scored: { file: AnimationFile; indices: number[]; score: number }[] = [];
    for (const file of inFolder) {
      const result = scoreFile(file, query);
      if (result) scored.push({ file, indices: result.indices, score: result.score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.file.relative.localeCompare(b.file.relative, 'zh-Hans-CN', { numeric: true }),
    );
    return scored.map(({ file, indices }) => ({ file, indices }));
  });

  const filteredFiles = computed(() => rankedFiles.value.map((item) => item.file));

  /** 命中字符下标，供列表高亮 */
  const matchIndices = computed(() => {
    const map = new Map<string, number[]>();
    for (const item of rankedFiles.value) {
      if (item.indices.length > 0) map.set(item.file.path, item.indices);
    }
    return map;
  });

  const totalPages = computed(() => Math.max(1, Math.ceil(filteredFiles.value.length / pageSize.value)));
  const pagedFiles = computed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filteredFiles.value.slice(start, start + pageSize.value);
  });

  const selectedFile = computed(() => files.value.find((file) => file.path === selectedPath.value) ?? null);
  const pageThumbCount = computed(() => pagedFiles.value.filter((file) => thumbnails.value[file.path]).length);

  const folderOptions = computed(() => {
    const map = new Map<string, string>();
    for (const file of files.value) map.set(file.sourceDir, file.sourceLabel);
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  });

  function toast(kind: AnimationToast['kind'], text: string): void {
    const id = ++toastSeq;
    toasts.value.push({ id, kind, text });
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id);
    }, 5000);
  }

  function attachPlayer(next: FbxPlayer): void {
    player = next;
    next.onTick((state) => {
      currentTime.value = state.time;
      duration.value = state.duration;
      // 播放状态以播放器为准（例如进入姿态模式会主动暂停）
      playing.value = state.playing;
    });
    next.onPose((state: PoseState) => {
      bonePose.value = state.bone;
      poseChangedCount.value = state.changedCount;
      poseBoneTotal.value = state.total;
      modalTransform.value = state.modal;
    });
  }

  function detachPlayer(): void {
    player = null;
  }

  function resetSelection(): void {
    selectedClips.value = [];
    selectedStats.value = null;
    activeClipIndex.value = 0;
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
    viewError.value = null;
  }

  /** 只对当前页的卡片生成封面：切页/搜索/切文件夹时丢掉待办队列（已生成的缓存保留） */
  function resetThumbQueue(): void {
    for (const file of thumbQueue) thumbRequests.delete(file.path);
    thumbQueue = [];
    if (!thumbRunning) thumbBusy.value = false;
  }

  function clampPage(): void {
    if (page.value > totalPages.value) page.value = totalPages.value;
    if (page.value < 1) page.value = 1;
  }

  watch([keyword, folderFilter, () => dirs.value.join('|')], () => {
    page.value = 1;
    clampPage();
    resetThumbQueue();
  });

  watch(pageSize, () => {
    page.value = 1;
    resetThumbQueue();
  });

  watch(page, () => {
    clampPage();
    // 关键：切页后只保留当前页的封面任务
    resetThumbQueue();
  });

  // ===== 文件夹管理（持久记录到服务端） =====

  async function loadInfo(): Promise<void> {
    try {
      info.value = await animationApi.info();
      dirs.value = info.value.dirs;
      missingDirs.value = info.value.missing;
    } catch (err) {
      toast('error', (err as Error).message);
    }
  }

  async function persistDirs(next: string[]): Promise<void> {
    try {
      const result = await animationApi.saveDirs(next);
      dirs.value = result.dirs;
      missingDirs.value = result.missing ?? [];
    } catch (err) {
      toast('error', `保存文件夹失败：${(err as Error).message}`);
    }
  }

  async function addDir(dir: string): Promise<void> {
    const target = dir.trim();
    if (!target) return;
    if (dirs.value.includes(target)) {
      toast('info', '该文件夹已经在列表里');
      return;
    }
    await persistDirs([...dirs.value, target]);
    await reload();
  }

  async function removeDir(dir: string): Promise<void> {
    if (dirs.value.length <= 1) {
      toast('error', '至少保留一个文件夹');
      return;
    }
    await persistDirs(dirs.value.filter((item) => item !== dir));
    if (folderFilter.value === dir) folderFilter.value = ALL_FOLDERS;
    await reload();
  }

  /** 扫描所有已记录的文件夹 */
  async function reload(): Promise<void> {
    if (dirs.value.length === 0) await loadInfo();
    loading.value = true;
    loadError.value = null;
    try {
      const previous = selectedPath.value;
      const result = await animationApi.list(dirs.value);
      dirs.value = result.dirs;
      missingDirs.value = result.missing ?? [];
      files.value = result.files;
      truncated.value = result.truncated;
      clampPage();

      const keep = previous ? result.files.find((file) => file.path === previous) : undefined;
      const target = keep ?? pagedFiles.value[0] ?? result.files[0];
      if (target) await select(target);
      else {
        selectedPath.value = null;
        resetSelection();
      }
    } catch (err) {
      loadError.value = (err as Error).message;
      toast('error', loadError.value);
    } finally {
      loading.value = false;
    }
  }

  // ===== 播放 =====

  async function select(file: AnimationFile): Promise<void> {
    if (!player) return;
    selectedPath.value = file.path;
    viewLoading.value = true;
    viewError.value = null;
    try {
      const result = await player.load(animationApi.fileUrl(file.path));
      selectedClips.value = result.clips;
      selectedStats.value = result.stats;
      player.setGrid(showGrid.value);
      player.setMirror(mirror.value);
      player.setInPlace(inPlace.value);
      player.setSpeed(speed.value);
      // 换模型后重建骨骼树，并沿用当前的骨骼显示/选择状态
      syncBones();
      selectedBones.value = [];
      player.setSelectedBones([]);
      player.setSkeletonVisible(showSkeleton.value);
      player.setBoneDisplayMode(boneDisplayMode.value);
      player.setPoseMode(poseMode.value);
      player.setTransformMode(transformMode.value);
      player.setTransformSpace(transformSpace.value);
      // 换模型后重建节点树
      selectedNodeIds.value = [];
      syncNodes();
      activeClipIndex.value = 0;
      if (result.clips.length > 0) {
        player.playClip(0);
        playing.value = true;
        duration.value = result.clips[0]!.duration;
        // 按动画范围取景，避免大动作跑出画面
        player.resetView();
      } else {
        playing.value = false;
        toast('info', '该 FBX 不包含动画片段，只显示静态模型');
      }
    } catch (err) {
      viewError.value = (err as Error).message;
      selectedClips.value = [];
      selectedStats.value = null;
      toast('error', `加载失败：${viewError.value}`);
    } finally {
      viewLoading.value = false;
    }
  }

  function playClipIndex(index: number): void {
    if (!player) return;
    activeClipIndex.value = index;
    player.playClip(index);
    playing.value = true;
  }

  function togglePlay(): void {
    if (!player) return;
    player.togglePlay();
    playing.value = player.isPlaying;
  }

  function setSpeed(value: number): void {
    speed.value = value;
    player?.setSpeed(value);
  }

  function setMirror(value: boolean): void {
    mirror.value = value;
    player?.setMirror(value);
  }

  function setInPlace(value: boolean): void {
    inPlace.value = value;
    if (!player) return;
    player.setInPlace(value);
    playing.value = player.isPlaying;
  }

  function setGridView(value: boolean): void {
    showGrid.value = value;
    player?.setGrid(value);
  }

  function seek(ratio: number): void {
    if (!player || duration.value <= 0) return;
    player.seek(ratio * duration.value);
    currentTime.value = ratio * duration.value;
  }

  function resetView(): void {
    player?.resetView();
  }

  // ===== 骨骼 =====

  function syncBones(): void {
    boneTree.value = player?.boneTree ?? [];
    boneList.value = player?.boneList ?? [];
    ignoredBoneNodes.value = player?.ignoredBoneNodes ?? 0;
  }

  function setSkeletonVisible(on: boolean): void {
    showSkeleton.value = on;
    player?.setSkeletonVisible(on);
  }

  function setBoneDisplayMode(mode: BoneDisplayMode): void {
    boneDisplayMode.value = mode;
    player?.setBoneDisplayMode(mode);
  }

  function setBoneSelection(ids: string[]): void {
    selectedBones.value = ids;
    player?.setSelectedBones(ids);
    // gizmo 挂在"最后选中的那根"上（Blender 的激活骨骼）
    player?.setSelectedBone(ids.length > 0 ? ids[ids.length - 1]! : null);
  }

  // ===== 姿态模式 =====

  function setPoseMode(on: boolean): void {
    poseMode.value = on;
    if (on && !showSkeleton.value) setSkeletonVisible(true);
    player?.setPoseMode(on);
    if (!on) bonePose.value = null;
  }

  function setTransformMode(mode: TransformMode): void {
    transformMode.value = mode;
    player?.setTransformMode(mode);
  }

  function setTransformSpace(space: TransformSpace): void {
    transformSpace.value = space;
    player?.setTransformSpace(space);
  }

  function applyBoneTransform(
    patch: Partial<Pick<BoneTransformState, 'rotation' | 'position' | 'scale'>>,
  ): void {
    const id = bonePose.value?.boneId ?? selectedBones.value[selectedBones.value.length - 1];
    if (!id) return;
    player?.applyBoneTransform(id, patch);
  }

  function resetBonePose(): void {
    const id = bonePose.value?.boneId ?? selectedBones.value[selectedBones.value.length - 1];
    if (!id) return;
    player?.resetBonePose(id);
  }

  function resetAllPoses(): void {
    player?.resetAllPoses();
  }

  /** 回到 FBX 绑定姿态（Blender 里 Alt+G/R/S 的语义） */
  function resetToRestPose(): void {
    player?.resetToRestPose();
  }

  // ===== 模态变换（G / R / S） =====

  /** 按下 G/R/S：开始用鼠标直接驱动骨骼 */
  function beginModalTransform(kind: TransformMode, clientX: number, clientY: number): boolean {
    transformMode.value = kind;
    return player?.beginModalTransform(kind, clientX, clientY) ?? false;
  }

  function updateModalTransform(clientX: number, clientY: number): void {
    player?.updateModalTransform(clientX, clientY);
  }

  function setModalAxis(axis: 'X' | 'Y' | 'Z', plane: boolean): void {
    player?.setModalAxis(axis, plane);
  }

  function pushModalDigit(char: string): void {
    player?.pushModalDigit(char);
  }

  function popModalDigit(): void {
    player?.popModalDigit();
  }

  function confirmModalTransform(): void {
    player?.confirmModalTransform();
  }

  function cancelModalTransform(): void {
    player?.cancelModalTransform();
  }

  /** Alt+G / Alt+R / Alt+S：把该分量清回绑定姿态 */
  function clearPoseComponent(component: 'position' | 'rotation' | 'scale'): void {
    player?.clearPoseComponent(component);
  }

  // ===== 场景节点树 =====

  function syncNodes(): void {
    nodeTree.value = player?.sceneNodes ?? [];
    selectedNodeIds.value = player?.selectedNodeList ?? [];
  }

  /** 点击节点：高亮对应对象（additive = Ctrl/⌘ 加选） */
  function selectNode(id: string | null, additive = false): void {
    let next: string[];
    if (!id) {
      next = additive ? [...selectedNodeIds.value] : [];
    } else if (additive) {
      next = selectedNodeIds.value.includes(id)
        ? selectedNodeIds.value.filter((item) => item !== id)
        : [...selectedNodeIds.value, id];
    } else {
      next = [id];
    }
    selectedNodeIds.value = next;
    player?.setNodeSelection(next);
  }

  function clearNodeSelection(): void {
    selectedNodeIds.value = [];
    player?.clearNodeSelection();
  }

  function toggleBone(id: string): void {
    const next = selectedBones.value.includes(id)
      ? selectedBones.value.filter((item) => item !== id)
      : [...selectedBones.value, id];
    setBoneSelection(next);
  }

  function clearBoneSelection(): void {
    setBoneSelection([]);
  }

  function setHoveredBone(id: string | null): void {
    if (hoveredBoneId.value === id) return;
    hoveredBoneId.value = id;
    player?.setHoveredBone(id);
  }

  /** 光标移动时的悬停检测：命中就提前高亮，让"要点哪根"一目了然 */
  function hoverBoneAt(clientX: number, clientY: number): string | null {
    const id = player?.pickBone(clientX, clientY) ?? null;
    setHoveredBone(id);
    return id;
  }

  /** 在模型上点选骨骼；additive = 按住 Ctrl/Cmd/Shift 时并选 */
  function pickBoneAt(clientX: number, clientY: number, additive: boolean): string | null {
    const id = player?.pickBone(clientX, clientY) ?? null;
    if (!id) return null;
    if (!showSkeleton.value) setSkeletonVisible(true);
    if (additive) toggleBone(id);
    else setBoneSelection([id]);
    return id;
  }

  function setPage(next: number): void {
    page.value = Math.min(Math.max(1, Math.round(next)), totalPages.value);
  }

  function setPageSize(size: number): void {
    pageSize.value = PAGE_SIZES.includes(size) ? size : 24;
  }

  // ===== 封面：只在内存中生成，且只针对当前页 =====

  function requestThumbnail(file: AnimationFile): void {
    if (thumbnails.value[file.path] || thumbRequests.has(file.path)) return;
    thumbRequests.add(file.path);
    thumbQueue.push(file);
    void drainThumbnailQueue();
  }

  /** 为当前页所有缺封面的动画排队 */
  function generatePageThumbnails(): void {
    const pending = pagedFiles.value.filter(
      (file) => !thumbnails.value[file.path] && !thumbRequests.has(file.path),
    );
    if (pending.length === 0) {
      toast('info', '本页封面都已生成');
      return;
    }
    for (const file of pending) thumbRequests.add(file.path);
    thumbQueue.push(...pending);
    void drainThumbnailQueue();
  }

  async function drainThumbnailQueue(): Promise<void> {
    if (thumbRunning) return;
    thumbRunning = true;
    thumbBusy.value = true;
    try {
      while (thumbQueue.length > 0) {
        const file = thumbQueue.shift()!;
        try {
          if (!thumbWorker) thumbWorker = new FbxPlayer(ensureThumbHost());
          const result = await thumbWorker.load(animationApi.fileUrl(file.path));
          if (result.clips.length > 0) {
            thumbWorker.playClip(0);
            thumbWorker.resetView();
            // 取片段 35% 处的姿势，比 T-pose 更能区分不同动作
            thumbWorker.poseAt(0.35);
            await nextFrame();
          }
          const dataUrl = thumbWorker.captureFrame(THUMB_SIZE);
          if (dataUrl) {
            const next = { ...thumbnails.value, [file.path]: dataUrl };
            const keys = Object.keys(next);
            if (keys.length > MAX_THUMBNAILS) {
              for (const key of keys.slice(0, keys.length - MAX_THUMBNAILS)) delete next[key];
            }
            thumbnails.value = next;
          }
        } catch {
          // 单个失败不影响其它；同时允许它以后被重新尝试
          thumbRequests.delete(file.path);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      thumbRunning = false;
      thumbBusy.value = false;
      releaseThumbWorker();
    }
  }

  function releaseThumbWorker(): void {
    if (thumbQueue.length > 0) return;
    thumbWorker?.dispose();
    thumbWorker = null;
    document.getElementById(THUMB_HOST_ID)?.remove();
  }

  function dispose(): void {
    releaseThumbWorker();
    player?.dispose();
    player = null;
  }

  return {
    info,
    dirs,
    missingDirs,
    files,
    truncated,
    loading,
    loadError,
    keyword,
    folderFilter,
    folderOptions,
    page,
    pageSize,
    pageSizes: PAGE_SIZES,
    totalPages,
    filteredFiles,
    matchIndices,
    pagedFiles,
    pageThumbCount,
    selectedPath,
    selectedFile,
    selectedClips,
    selectedStats,
    activeClipIndex,
    playing,
    speed,
    mirror,
    inPlace,
    showGrid,
    currentTime,
    duration,
    viewLoading,
    viewError,
    toasts,
    showSkeleton,
    boneDisplayMode,
    boneTree,
    boneList,
    selectedBones,
    boneKeyword,
    ignoredBoneNodes,
    hoveredBoneId,
    poseMode,
    transformMode,
    transformSpace,
    bonePose,
    poseChangedCount,
    poseBoneTotal,
    modalTransform,
    nodeTree,
    selectedNodeIds,
    nodeKeyword,
    nodeShowBones,
    setSkeletonVisible,
    setBoneDisplayMode,
    setPoseMode,
    setTransformMode,
    setTransformSpace,
    applyBoneTransform,
    resetBonePose,
    resetAllPoses,
    resetToRestPose,
    beginModalTransform,
    updateModalTransform,
    setModalAxis,
    pushModalDigit,
    popModalDigit,
    confirmModalTransform,
    cancelModalTransform,
    clearPoseComponent,
    selectNode,
    clearNodeSelection,
    syncNodes,
    setBoneSelection,
    toggleBone,
    clearBoneSelection,
    setHoveredBone,
    hoverBoneAt,
    pickBoneAt,
    thumbnails,
    thumbBusy,
    attachPlayer,
    detachPlayer,
    loadInfo,
    addDir,
    removeDir,
    reload,
    select,
    playClipIndex,
    togglePlay,
    setSpeed,
    setMirror,
    setInPlace,
    setGridView,
    seek,
    resetView,
    setPage,
    setPageSize,
    requestThumbnail,
    generatePageThumbnails,
    resetThumbQueue,
    dispose,
    toast,
    ALL_FOLDERS,
  };
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
