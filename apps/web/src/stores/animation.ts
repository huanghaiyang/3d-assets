import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  animationApi,
  type AnimationFile,
  type AnimationInfoResponse,
  type FingerPoseLibrary,
  type FingerPosePreset,
  type FingerSide,
  type SavedAnimationProject,
} from '@/api/animation';
import {
  FbxPlayer,
  type AnimationData,
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
import { applyFingerPoses, type FingerApplyResult, type FingerApplyTarget } from '@/utils/fingerPose';

/** 封面尺寸：由后端 worker 子线程渲染，浏览器只负责 <img> 显示 */
const THUMB_SIZE = 192;
/** 取片段 35% 处的姿势，比 T-pose 更能区分不同动作 */
const THUMB_POSE = 0.35;
const PAGE_SIZES = [12, 24, 48, 96];
const ALL_FOLDERS = '__all__';

export interface AnimationToast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

/** 新建动画：使用动画库里选中的 Mixamo 模型（去掉动画），动画数据来自导入的 JSON，可保存 */
export interface NewAnimationProject {
  id: string;
  name: string;
  /** 基础模型：来自动画库的 FBX，只保留模型本身与绑定姿态 */
  basePath: string;
  baseName: string;
  data: AnimationData | null;
  imported: { name: string; clipCount: number; trackCount: number } | null;
  /** 已经保存到服务端 */
  saved: boolean;
  /** 保存后又有改动（需要再次保存） */
  dirty: boolean;
  createdAt: string;
  updatedAt: string | null;
  /** 服务端存有动画数据，但本地还没取回来 */
  hasData: boolean;
  /** 进入回收站的时间（只有回收站里的项目才有） */
  deletedAt?: string;
}

/** 舞台「去编辑」：把一个还没转成项目的 FBX 动画片段拿来编辑 */
export interface StageClipEditRequest {
  /** 舞台里的段 id，编辑保存后由舞台按它回填 */
  segmentId: string;
  /** 动画库里的 FBX 文件绝对路径 */
  fbxPath: string;
  /** 要编辑的动画片段名 */
  clipName: string;
  /** 舞台角色的模型路径（优先拿它当编辑基础模型） */
  basePath: string;
  /** 新建项目的显示名 */
  projectName: string;
}

/** 编辑完成后回传给舞台的信息 */
export interface StageClipEditResult {
  segmentId: string;
  projectId: string;
  projectName: string;
  duration: number;
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

  // 动画数据提取与 JSON 预览
  const dataDialogOpen = ref(false);
  const dataExtracting = ref(false);
  const dataError = ref<string | null>(null);
  const extractedData = shallowRef<AnimationData | null>(null);

  // 新建动画：内置白模（T 字姿态），可导入 JSON 绑定动画并保存
  const newAnimations = shallowRef<NewAnimationProject[]>([]);
  const activeNewAnimationId = ref<string | null>(null);
  const newAnimationMode = computed(() => activeNewAnimationId.value !== null);
  const activeNewAnimation = computed(
    () => newAnimations.value.find((item) => item.id === activeNewAnimationId.value) ?? null,
  );
  const importingAnimation = ref(false);
  const savingAnimation = ref(false);
  const projectsLoading = ref(false);
  const importedAnimation = ref<{ name: string; clipCount: number; trackCount: number } | null>(null);

  // 手指形态库（仅新建动画使用）：从现有 Mixamo 动画缓存采样，左右手分别可选
  const fingerPoses = shallowRef<FingerPoseLibrary | null>(null);
  const fingerPosesLoading = ref(false);
  const fingerPosesError = ref<string | null>(null);
  /** 回收站里的新建动画（软删除，可恢复或彻底删除） */
  const trashProjects = shallowRef<NewAnimationProject[]>([]);
  const trashLoading = ref(false);
  /** 左侧列表是否正在展示回收站 */
  const trashOpen = ref(false);
  /** 正在 3D 视口里只读预览的回收站项目（不进入编辑，不影响 newAnimations） */
  const trashPreviewId = ref<string | null>(null);
  const previewingTrash = computed(() => trashPreviewId.value !== null);
  /** 进入新建动画之前选中的 FBX，退出编辑时回到它 */
  const previousFile = ref<AnimationFile | null>(null);

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

  /** 封面 URL 缓存：key = 文件绝对路径（后端渲染 + 浏览器 HTTP 缓存，跨页保留） */
  const thumbnails = ref<Record<string, string>>({});

  let player: FbxPlayer | null = null;
  let toastSeq = 0;

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
  /** 兼容旧接口：封面现在是后端渲染的 URL，没有待办队列需要清空 */
  function resetThumbQueue(): void {}


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
    if (poseMode.value) setPoseMode(false);
    closeAnimationData();
    activeNewAnimationId.value = null;
    trashPreviewId.value = null;
    importedAnimation.value = null;
    previousFile.value = file;
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

  // ===== 动画数据提取（关节 + 轨迹 + 时间线，不含蒙皮数据） =====

  /**
   * 提取当前模型的动画数据并打开 JSON 预览。
   * 只读取已解析的 AnimationClip 与骨骼，不包含网格几何、蒙皮权重、材质或贴图。
   */
  function openAnimationData(): void {
    const file = selectedFile.value;
    if (!player || !file) {
      toast('error', '请先选择一个动画');
      return;
    }
    dataDialogOpen.value = true;
    dataExtracting.value = true;
    dataError.value = null;
    extractedData.value = null;
    // 提取是同步的；放到下一帧执行，让弹窗的加载状态先渲染出来
    window.setTimeout(() => {
      try {
        extractedData.value =
          player?.extractAnimationData({
            name: file.name,
            relative: file.relative,
            size: file.size,
            mtime: file.mtime,
          }) ?? null;
        if (!extractedData.value) dataError.value = '模型尚未加载完成，请稍后重试';
      } catch (err) {
        dataError.value = (err as Error).message;
      } finally {
        dataExtracting.value = false;
      }
    }, 16);
  }

  function closeAnimationData(): void {
    dataDialogOpen.value = false;
    dataExtracting.value = false;
    dataError.value = null;
    extractedData.value = null;
  }

  // ===== 新建动画（内置白模 + 导入/保存动画 JSON） =====

  function isAnimationData(value: unknown): value is AnimationData {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<AnimationData>;
    return (
      data.format === 'fbx-animation-data' &&
      data.version === 1 &&
      Array.isArray(data.clips) &&
      data.clips.length > 0 &&
      data.clips.every((clip) => !!clip && Array.isArray(clip.tracks)) &&
      !!data.skeleton &&
      Array.isArray(data.skeleton.joints)
    );
  }

  /** 项目名按序号递增，避开已保存项目用掉的名字（大小写不敏感） */
  function nextProjectName(): string {
    const used = new Set(newAnimations.value.map((item) => item.name.toLowerCase()));
    let index = 1;
    while (used.has(`新建动画 ${index}`.toLowerCase())) index += 1;
    return `新建动画 ${index}`;
  }

  function updateProject(id: string, patch: Partial<NewAnimationProject>): void {
    newAnimations.value = newAnimations.value.map((item) =>
      item.id === id ? { ...item, ...patch } : item,
    );
  }

  /** 按路径找到基础模型（模型可能已从动画库移除） */
  function resolveBase(project: NewAnimationProject): AnimationFile | null {
    return files.value.find((file) => file.path === project.basePath) ?? null;
  }

  /**
   * 新建动画：以动画库里的 Mixamo 模型为基础，加载后清空动画片段并回到绑定姿态，
   * 得到"不带动画的模型"。优先用当前选中的模型，否则取列表里的第一个。
   */
  async function createNewAnimation(): Promise<void> {
    if (!player) {
      toast('error', '视图尚未准备好，请稍候');
      return;
    }
    if (viewLoading.value) {
      toast('info', '模型正在加载，请稍候');
      return;
    }
    const base = selectedFile.value ?? files.value[0] ?? null;
    if (!base) {
      toast('error', '动画库里还没有可用的 FBX 模型');
      return;
    }
    if (!newAnimationMode.value) previousFile.value = selectedFile.value;

    const project: NewAnimationProject = {
      id: `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: nextProjectName(),
      basePath: base.path,
      baseName: base.relative,
      data: null,
      imported: null,
      saved: false,
      dirty: true,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      hasData: false,
    };
    newAnimations.value = [...newAnimations.value, project];
    await activateProject(project);
    toast('info', `已新建「${project.name}」：模型「${base.name}」已去掉动画，导入 JSON 即可绑定`);
  }

  /** 选中一个新建动画：加载基础模型并恢复已导入的动画 */
  async function selectNewAnimation(id: string): Promise<void> {
    const project = newAnimations.value.find((item) => item.id === id);
    if (!project || !player) return;
    if (!newAnimationMode.value) previousFile.value = selectedFile.value;
    await loadProjectData(project);
    const fresh = newAnimations.value.find((item) => item.id === id) ?? project;
    await activateProject(fresh);
  }

  /** 已保存的项目按需取回动画数据（列表接口只带摘要） */
  async function loadProjectData(project: NewAnimationProject): Promise<void> {
    if (!project.saved || project.data !== null || !project.hasData) return;
    try {
      const detail = await animationApi.project(project.id);
      const data = isAnimationData(detail.data) ? detail.data : null;
      updateProject(project.id, { data, hasData: data !== null });
    } catch (err) {
      toast('error', `读取已保存的动画失败：${(err as Error).message}`);
    }
  }

  /** 加载基础模型、清掉自带动画，再应用项目里的动画数据 */
  async function activateProject(project: NewAnimationProject): Promise<void> {
    if (!player) return;
    const base = resolveBase(project);
    if (!base) {
      toast('error', `基础模型「${project.baseName}」不在当前动画库里，无法打开`);
      return;
    }
    if (poseMode.value) setPoseMode(false);
    closeAnimationData();

    // 同一个模型已经加载过就直接复用，避免重复解析 FBX
    const sameModel =
      selectedPath.value === base.path && !viewLoading.value && !viewError.value;
    if (!sameModel) {
      await select(base);
      if (!player) return;
    }

    player.clearAnimationClips();
    player.resetToRestPose();
    selectedClips.value = [];
    activeClipIndex.value = 0;
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
    trashPreviewId.value = null;
    activeNewAnimationId.value = project.id;
    importedAnimation.value = project.imported;

    if (project.data) {
      try {
        const clips = player.applyAnimationData(project.data);
        selectedClips.value = clips;
        duration.value = clips[0]?.duration ?? 0;
        playing.value = true;
        player.resetView();
        return;
      } catch (err) {
        toast('error', `恢复动画数据失败：${(err as Error).message}`);
      }
    }
    player.resetView();
  }

  /** 退出编辑但保留新建动画；回到之前选中的 FBX（没有就清空视图） */
  function exitNewAnimation(): void {
    if (!newAnimationMode.value) return;
    const project = activeNewAnimation.value;
    if (poseMode.value) setPoseMode(false);
    closeAnimationData();
    activeNewAnimationId.value = null;
    importedAnimation.value = null;
    const target = previousFile.value ?? files.value[0] ?? null;
    if (target) {
      void select(target);
    } else {
      player?.clear();
      selectedPath.value = null;
      resetSelection();
      syncBones();
      syncNodes();
    }
    if (project?.dirty) {
      toast('info', `已退出编辑。注意「${project.name}」还有未保存的修改，重新打开项目后需要再次保存`);
    } else if (project) {
      toast('info', `已退出编辑：「${project.name}」仍保留在左侧「新建动画」中，视图切回了原动画`);
    }
  }

  /** 删除新建动画 = 移入回收站；原有 FBX 动画没有删除入口 */
  function deleteNewAnimation(id: string): void {
    const project = newAnimations.value.find((item) => item.id === id);
    if (!project) return;
    const wasActive = activeNewAnimationId.value === id;
    newAnimations.value = newAnimations.value.filter((item) => item.id !== id);
    if (project.saved) {
      void animationApi
        .deleteProject(id)
        .then(() => {
          toast('info', `「${project.name}」已移入回收站，可在回收站恢复`);
          void loadTrash();
        })
        .catch((err) => {
          toast('error', `移入回收站失败：${(err as Error).message}`);
        });
    } else {
      toast('info', `已移除未保存的「${project.name}」`);
    }
    if (!wasActive) return;

    activeNewAnimationId.value = null;
    importedAnimation.value = null;
    const next = newAnimations.value[newAnimations.value.length - 1];
    if (next) {
      void selectNewAnimation(next.id);
      return;
    }
    const target = previousFile.value ?? files.value[0] ?? null;
    if (target) {
      void select(target);
      return;
    }
    player?.clear();
    selectedPath.value = null;
    resetSelection();
    syncBones();
    syncNodes();
  }

  /** 读取并绑定导出的动画 JSON（关节轨迹 + 关键帧） */
  async function importAnimationJson(file: File): Promise<void> {
    if (!player || !newAnimationMode.value) {
      toast('error', '请先新建动画');
      return;
    }
    importingAnimation.value = true;
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('JSON 解析失败，请检查文件内容');
      }
      if (!isAnimationData(parsed)) {
        throw new Error('不是有效的动画数据（需包含 format=fbx-animation-data、version=1 与 clips）');
      }
      const clips = player.applyAnimationData(parsed);
      const trackCount = parsed.clips.reduce((sum, clip) => sum + clip.tracks.length, 0);
      const summary = { name: file.name, clipCount: clips.length, trackCount };
      const activeId = activeNewAnimationId.value;
      if (activeId) {
        updateProject(activeId, { data: parsed, imported: summary, dirty: true, hasData: true });
      }
      selectedClips.value = clips;
      activeClipIndex.value = 0;
      currentTime.value = 0;
      duration.value = clips[0]?.duration ?? 0;
      playing.value = true;
      importedAnimation.value = summary;
      player.resetView();
      toast('success', `已绑定动画：${clips.length} 个片段、${trackCount} 条轨迹（记得保存）`);
    } catch (err) {
      toast('error', `导入失败：${(err as Error).message}`);
    } finally {
      importingAnimation.value = false;
    }
  }

  /** 把外部拿到的动画数据（已解析为对象）直接绑定到当前新建动画（供 kimodo 导入使用） */
  async function applyImportedData(data: unknown, name = 'kimodo 动画'): Promise<void> {
    if (!player || !newAnimationMode.value) {
      toast('error', '请先新建动画');
      return;
    }
    if (!isAnimationData(data)) {
      throw new Error('不是有效的动画数据（需包含 format=fbx-animation-data、version=1 与 clips）');
    }
    const clips = player.applyAnimationData(data);
    const trackCount = data.clips.reduce((sum, clip) => sum + clip.tracks.length, 0);
    const summary = { name, clipCount: clips.length, trackCount };
    const activeId = activeNewAnimationId.value;
    if (activeId) {
      updateProject(activeId, { data, imported: summary, dirty: true, hasData: true });
    }
    selectedClips.value = clips;
    activeClipIndex.value = 0;
    currentTime.value = 0;
    duration.value = clips[0]?.duration ?? 0;
    playing.value = true;
    importedAnimation.value = summary;
    player.resetView();
    toast('success', `已绑定 kimodo 动画：${clips.length} 个片段、${trackCount} 条轨迹`);
  }

  // ===== 舞台「去编辑」闭环 =====

  const pendingStageClipEdit = ref<StageClipEditRequest | null>(null);
  const stageClipEditResult = ref<StageClipEditResult | null>(null);

  /** 舞台点击「去编辑」时调用（随后由 App 切到动画页） */
  function requestStageClipEdit(request: StageClipEditRequest): void {
    pendingStageClipEdit.value = request;
    // 上一次没消费掉的结果作废，避免回填到错误的段
    stageClipEditResult.value = null;
  }

  /**
   * 动画页挂载后消费待编辑请求：
   * 载入该 FBX → 提取指定片段的动画数据 → 建成新建动画项目（只保留这一条片段）并保存。
   * 保存后舞台才能用 projectId 引用它，所以这里自动落盘一次。
   */
  async function consumeStageClipEdit(): Promise<void> {
    const request = pendingStageClipEdit.value;
    if (!request) return;
    pendingStageClipEdit.value = null;
    if (!player) return;

    const file = files.value.find((item) => item.path === request.fbxPath);
    if (!file) {
      toast('error', '动画库里找不到该 FBX 文件，无法去编辑');
      return;
    }

    await select(file);
    if (!player) return;
    const data = player.extractAnimationData({
      name: file.name,
      relative: file.relative,
      size: file.size,
      mtime: file.mtime,
    });
    if (!data) {
      toast('error', '模型尚未加载完成，请稍后重试');
      return;
    }
    const clip = data.clips.find((item) => item.name === request.clipName) ?? data.clips[0];
    if (!clip) {
      toast('error', '该 FBX 没有可编辑的动画片段');
      return;
    }
    const single = {
      ...data,
      clips: [clip],
      timeline: {
        ...data.timeline,
        clipCount: 1,
        totalDuration: clip.duration,
        longestDuration: clip.duration,
      },
    };

    // 基础模型优先用舞台角色自己的模型；它不在动画库时退回动画片段所在文件
    const base = files.value.find((item) => item.path === request.basePath) ?? file;
    const project: NewAnimationProject = {
      id: `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: request.projectName,
      basePath: base.path,
      baseName: base.name,
      data: single,
      imported: { name: clip.name, clipCount: 1, trackCount: clip.tracks.length },
      saved: false,
      dirty: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasData: true,
    };
    newAnimations.value = [project, ...newAnimations.value];
    await activateProject(project);
    await saveNewAnimation();
    // 保存失败（例如重名）时不回填，否则舞台会引用一个不存在的项目
    if (!newAnimations.value.find((item) => item.id === project.id)?.saved) return;
    stageClipEditResult.value = {
      segmentId: request.segmentId,
      projectId: project.id,
      projectName: project.name,
      duration: clip.duration,
    };
    toast('success', '已建好可编辑项目，修改后点保存即可');
  }

  /** 舞台返回时读取编辑结果（读完即清空） */
  function consumeStageClipEditResult(): StageClipEditResult | null {
    const result = stageClipEditResult.value;
    stageClipEditResult.value = null;
    return result;
  }

  // ===== 手指形态（仅新建动画）=====

  /** 读取手指形态库；已加载时直接复用，refresh=true 让服务端重新采样 */
  async function loadFingerPoses(refresh = false): Promise<void> {
    if (fingerPosesLoading.value) return;
    if (!refresh && fingerPoses.value) return;
    fingerPosesLoading.value = true;
    fingerPosesError.value = null;
    try {
      fingerPoses.value = await animationApi.fingerPoses(refresh);
    } catch (err) {
      fingerPosesError.value = (err as Error).message;
    } finally {
      fingerPosesLoading.value = false;
    }
  }

  /**
   * 把选中的左右手形态写入当前片段的手指骨轨道。
   * 只替换 [from,to] 区间；其它骨骼、腕关节以及 kimodo 生成的动画数据都不动。
   */
  function applyFingerPoseSelection(
    selections: { side: FingerSide; preset: FingerPosePreset }[],
    from: number,
    to: number,
  ): boolean {
    const project = activeNewAnimation.value;
    if (!project?.data) {
      toast('error', '当前新建动画还没有动画数据，请先导入 JSON 或生成 kimodo 动画');
      return false;
    }
    if (!player) {
      toast('error', '视图尚未准备好，请稍候');
      return false;
    }
    if (selections.length === 0) {
      toast('error', '请先选择左手或右手的手指形态');
      return false;
    }

    const clipIndex = Math.min(activeClipIndex.value, project.data.clips.length - 1);
    if (clipIndex < 0) {
      toast('error', '当前没有可编辑的动画片段');
      return false;
    }

    if (poseMode.value) setPoseMode(false);
    const resumeTime = currentTime.value;
    const wasPlaying = playing.value;

    let result: FingerApplyResult;
    try {
      const targets: FingerApplyTarget[] = selections.map((item) => ({
        side: item.side,
        preset: item.preset,
      }));
      result = applyFingerPoses(project.data, clipIndex, targets, from, to);
      if (!player) throw new Error('视图尚未准备好，请稍候');
    } catch (err) {
      toast('error', (err as Error).message);
      return false;
    }

    try {
      const clips = player.applyAnimationData(result.data);
      selectedClips.value = clips;
      const nextIndex = Math.min(clipIndex, Math.max(0, clips.length - 1));
      activeClipIndex.value = nextIndex;
      if (clips[nextIndex]) {
        player.playClip(nextIndex);
        const at = Math.min(resumeTime, clips[nextIndex]!.duration);
        player.seek(at);
        currentTime.value = at;
        duration.value = clips[nextIndex]!.duration;
        player.setPlaying(wasPlaying);
        playing.value = wasPlaying;
      }
    } catch (err) {
      toast('error', `应用手型后刷新视图失败：${(err as Error).message}`);
      return false;
    }

    const summary = project.imported
      ? {
          ...project.imported,
          clipCount: result.data.clips.length,
          trackCount: result.trackCount,
        }
      : {
          name: `${project.name} 动画`,
          clipCount: result.data.clips.length,
          trackCount: result.trackCount,
        };
    updateProject(project.id, {
      data: result.data,
      imported: summary,
      dirty: true,
      hasData: true,
    });
    importedAnimation.value = summary;

    const names = selections
      .map((item) => `${item.side === 'left' ? '左手' : '右手'}「${item.preset.name}」`)
      .join(' + ');
    toast(
      'success',
      `已在 ${from.toFixed(2)}–${to.toFixed(2)} 秒替换 ${names}：写入 ${result.bones} 根手指骨（记得保存）`,
    );
    return true;
  }

  /** 把当前新建动画保存到服务端（写入项目自己的数据目录，不碰 FBX 源文件夹） */
  async function saveNewAnimation(): Promise<void> {
    const project = activeNewAnimation.value;
    if (!project) {
      toast('error', '请先新建动画');
      return;
    }
    if (!project.data) {
      toast('error', '请先导入动画 JSON 再保存');
      return;
    }
    savingAnimation.value = true;
    try {
      const saved = await animationApi.saveProject({
        id: project.id,
        name: project.name,
        basePath: project.basePath,
        baseName: project.baseName,
        data: project.data,
        imported: project.imported,
      });
      updateProject(project.id, {
        saved: true,
        dirty: false,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        imported: saved.imported,
        hasData: saved.hasData,
      });
      toast('success', `已保存「${saved.name}」`);
    } catch (err) {
      toast('error', `保存失败：${(err as Error).message}`);
    } finally {
      savingAnimation.value = false;
    }
  }

  /** 服务端摘要 → 本地项目（动画数据选中时再按需拉取） */
  function projectFromSaved(item: SavedAnimationProject): NewAnimationProject {
    return {
      id: item.id,
      name: item.name,
      basePath: item.basePath,
      baseName: item.baseName,
      data: null,
      imported: item.imported,
      saved: true,
      dirty: false,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      hasData: item.hasData,
      deletedAt: item.deletedAt,
    };
  }

  /** 改名：本地先查重（大小写不敏感），已保存的项目交给服务端落盘 */
  async function renameNewAnimation(id: string, rawName: string): Promise<boolean> {
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) {
      toast('error', '名称不能为空');
      return false;
    }
    const project = newAnimations.value.find((item) => item.id === id);
    if (!project) return false;
    if (project.name === name) return true;

    const key = name.toLowerCase();
    if (newAnimations.value.some((item) => item.id !== id && item.name.toLowerCase() === key)) {
      toast('error', `名称「${name}」已被使用`);
      return false;
    }

    if (!project.saved) {
      updateProject(id, { name });
      return true;
    }
    try {
      const saved = await animationApi.renameProject(id, name);
      updateProject(id, { name: saved.name, updatedAt: saved.updatedAt });
      toast('success', `已重命名为「${saved.name}」`);
      return true;
    } catch (err) {
      toast('error', (err as Error).message);
      return false;
    }
  }

  /** 读取回收站项目 */
  async function loadTrash(): Promise<void> {
    trashLoading.value = true;
    try {
      const result = await animationApi.trash();
      trashProjects.value = result.projects.map(projectFromSaved);
    } catch (err) {
      toast('error', `读取回收站失败：${(err as Error).message}`);
    } finally {
      trashLoading.value = false;
    }
  }

  /** 打开/关闭回收站视图（打开时重新读取，保证列表是最新的） */
  async function toggleTrash(): Promise<void> {
    trashOpen.value = !trashOpen.value;
    if (trashOpen.value) await loadTrash();
  }

  /** 从回收站恢复；重名时服务端会自动加后缀 */
  async function restoreFromTrash(id: string): Promise<void> {
    try {
      const result = await animationApi.restoreProject(id);
      trashProjects.value = trashProjects.value.filter((item) => item.id !== id);
      if (!newAnimations.value.some((item) => item.id === result.project.id)) {
        newAnimations.value = [...newAnimations.value, projectFromSaved(result.project)];
      }
      // 恢复后它就回到可编辑列表，不再是「回收站预览」状态
      if (trashPreviewId.value === id) trashPreviewId.value = null;
      toast(
        'success',
        result.renamed
          ? `已恢复，因重名自动改名为「${result.project.name}」`
          : `已恢复「${result.project.name}」`,
      );
    } catch (err) {
      toast('error', `恢复失败：${(err as Error).message}`);
    }
  }

  /** 彻底删除回收站项目（不可恢复） */
  async function purgeFromTrash(id: string): Promise<void> {
    try {
      await animationApi.purgeProject(id);
      trashProjects.value = trashProjects.value.filter((item) => item.id !== id);
      if (trashPreviewId.value === id) trashPreviewId.value = null;
      toast('success', '已彻底删除');
    } catch (err) {
      toast('error', `删除失败：${(err as Error).message}`);
    }
  }

  /**
   * 只读预览回收站里的动画：
   * 用它的基础模型载入视口、清空原动画后应用回收站里保存的动画数据。
   * 不写入 newAnimations、不点亮 activeNewAnimationId，避免出现保存/删除等编辑入口。
   */
  async function previewTrashProject(id: string): Promise<void> {
    const item = trashProjects.value.find((project) => project.id === id);
    if (!item) return;
    if (!player) {
      toast('error', '3D 视图尚未准备好，请稍候再试');
      return;
    }
    if (viewLoading.value) {
      toast('info', '模型正在加载，请稍候');
      return;
    }
    // 基础模型可能因为切换了文件夹而不在当前列表里，这里退化成用项目里记录的绝对路径
    const base: AnimationFile =
      resolveBase(item) ?? {
        name: item.baseName || item.basePath,
        relative: item.baseName || item.basePath,
        path: item.basePath,
        sourceDir: '',
        sourceLabel: '',
        size: 0,
        mtime: 0,
      };

    // 列表接口只有摘要，动画数据按需从服务端取（回收站有独立详情接口）
    let data = item.data;
    if (!data) {
      try {
        const detail = await animationApi.trashProject(id);
        data = isAnimationData(detail.data) ? detail.data : null;
      } catch (err) {
        toast('error', `读取回收站动画失败：${(err as Error).message}`);
        return;
      }
    }

    await select(base);
    if (!player) return;
    // select 内部已 toast 过错误；载入失败就不要再往空场景里套动画数据
    if (viewError.value) return;
    player.clearAnimationClips();
    player.resetToRestPose();
    selectedClips.value = [];
    activeClipIndex.value = 0;
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
    activeNewAnimationId.value = null;
    trashPreviewId.value = id;
    importedAnimation.value = item.imported;
    if (data) {
      try {
        const clips = player.applyAnimationData(data);
        selectedClips.value = clips;
        duration.value = clips[0]?.duration ?? 0;
        playing.value = true;
      } catch (err) {
        toast('error', `预览失败：${(err as Error).message}`);
      }
    }
    player.resetView();
    toast('info', `只读预览回收站中的「${item.name}」`);
  }

  /** 读取服务端已保存的新建动画（只取摘要，选中时再拉动画数据） */
  async function loadProjects(): Promise<void> {
    projectsLoading.value = true;
    try {
      const result = await animationApi.projects();
      const existing = new Set(newAnimations.value.map((item) => item.id));
      const loaded = result.projects
        .filter((item) => !existing.has(item.id))
        .map(projectFromSaved);
      newAnimations.value = [...newAnimations.value, ...loaded];
    } catch (err) {
      toast('error', `读取已保存的动画失败：${(err as Error).message}`);
    } finally {
      projectsLoading.value = false;
    }
    // 顺带刷新回收站，让列表上的入口能显示数量
    if (!trashOpen.value) void loadTrash();
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
  // ===== 封面：由后端 worker 子线程渲染，浏览器只加载 URL =====

  /** 正在强制重渲染当前页封面（按钮 loading 状态） */
  const refreshingCovers = ref(false);
  /** 单张封面正在重渲染的模型路径（卡片上的 loading 状态） */
  const refreshingCoverPaths = ref<string[]>([]);

  function isRefreshingCover(path: string): boolean {
    return refreshingCoverPaths.value.includes(path);
  }

  /**
   * 重新生成封面：让服务端强制重渲染并覆盖磁盘缓存，
   * 再用带版本号的 URL 顶掉浏览器里的旧图。
   * key 由调用方给（原始 FBX 用路径，新建动画用 project:<id>）。
   */
  async function runCoverRefresh(
    key: string,
    buildUrl: (options: { refresh?: boolean; version: string }) => string,
  ): Promise<void> {
    if (!key || isRefreshingCover(key)) return;
    refreshingCoverPaths.value = [...refreshingCoverPaths.value, key];
    const version = Date.now().toString(36);
    try {
      const response = await fetch(buildUrl({ refresh: true, version }));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      thumbnails.value = { ...thumbnails.value, [key]: buildUrl({ version }) };
      toast('success', '封面已重新生成');
    } catch (err) {
      toast('error', `封面生成失败：${(err as Error).message}`);
    } finally {
      refreshingCoverPaths.value = refreshingCoverPaths.value.filter((item) => item !== key);
    }
  }

  /** 动画库里原始 FBX 的封面（按文件自带动画取帧） */
  async function refreshCover(filePath: string): Promise<void> {
    await runCoverRefresh(filePath, (options) =>
      animationApi.animationCoverUrl(filePath, THUMB_SIZE, THUMB_POSE, options),
    );
  }

  /**
   * 新建动画卡片的封面 key：
   * - 已保存 → project:<id>（后端按项目里保存的动画数据取姿势）
   * - 未保存 → 基础模型路径（服务端没有项目数据，只能看基础模型）
   */
  function projectCoverKey(project: NewAnimationProject): string {
    return project.saved ? `project:${project.id}` : project.basePath;
  }

  function projectCoverUrl(
    project: NewAnimationProject,
    options: { refresh?: boolean; version?: string } = {},
  ): string {
    if (!project.saved) {
      return animationApi.animationCoverUrl(project.basePath, THUMB_SIZE, THUMB_POSE, options);
    }
    return animationApi.animationCoverUrl('', THUMB_SIZE, THUMB_POSE, {
      ...options,
      project: project.id,
    });
  }

  /** 重新生成某个新建动画的封面（按项目动画数据重新取姿势） */
  async function refreshProjectCover(project: NewAnimationProject): Promise<void> {
    await runCoverRefresh(projectCoverKey(project), (options) => projectCoverUrl(project, options));
  }

  function coverUrl(file: AnimationFile): string {
    return animationApi.animationCoverUrl(file.path, THUMB_SIZE, THUMB_POSE);
  }

  function requestThumbnail(file: AnimationFile): void {
    if (thumbnails.value[file.path]) return;
    thumbnails.value = { ...thumbnails.value, [file.path]: coverUrl(file) };
  }

  /**
   * 按封面 key 请求图片：动画库卡片传文件路径，新建动画卡片传 projectCoverKey()。
   * 卡片进入视口时调用（IntersectionObserver），避免一次性渲染所有封面。
   */
  function requestCover(key: string): void {
    if (!key || thumbnails.value[key]) return;
    if (key.startsWith('project:')) {
      const project = newAnimations.value.find((item) => projectCoverKey(item) === key);
      if (!project) return;
      thumbnails.value = { ...thumbnails.value, [key]: projectCoverUrl(project) };
      return;
    }
    const file = files.value.find((item) => item.path === key);
    if (file) requestThumbnail(file);
  }

  /** 提前给当前页所有卡片挂上封面 URL（图片由浏览器并发加载） */
  function generatePageThumbnails(): void {
    const next = { ...thumbnails.value };
    let added = 0;
    for (const file of pagedFiles.value) {
      if (next[file.path]) continue;
      next[file.path] = coverUrl(file);
      added += 1;
    }
    if (added === 0) {
      toast('info', '本页封面都已加载');
      return;
    }
    thumbnails.value = next;
  }

  /**
   * 重新生成本页封面：先让服务端强制重渲染（覆盖磁盘缓存），
   * 再用带版本号的 URL 让浏览器丢掉旧图。
   */
  async function refreshPageCovers(): Promise<void> {
    if (refreshingCovers.value) return;
    const files = pagedFiles.value;
    if (files.length === 0) return;
    refreshingCovers.value = true;
    const version = Date.now().toString(36);
    try {
      await Promise.all(
        files.map((file) =>
          fetch(animationApi.animationCoverUrl(file.path, THUMB_SIZE, THUMB_POSE, { refresh: true, version })).catch(
            () => undefined,
          ),
        ),
      );
      const next = { ...thumbnails.value };
      for (const file of files) {
        next[file.path] = animationApi.animationCoverUrl(file.path, THUMB_SIZE, THUMB_POSE, { version });
      }
      thumbnails.value = next;
      toast('success', `已重新生成本页 ${files.length} 张封面`);
    } finally {
      refreshingCovers.value = false;
    }
  }

  function dispose(): void {
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
    dataDialogOpen,
    dataExtracting,
    dataError,
    extractedData,
    openAnimationData,
    closeAnimationData,
    newAnimationMode,
    newAnimations,
    activeNewAnimationId,
    activeNewAnimation,
    importingAnimation,
    savingAnimation,
    projectsLoading,
    importedAnimation,
    fingerPoses,
    fingerPosesLoading,
    fingerPosesError,
    loadFingerPoses,
    applyFingerPoseSelection,
    createNewAnimation,
    selectNewAnimation,
    exitNewAnimation,
    deleteNewAnimation,
    importAnimationJson,
    applyImportedData,
    requestStageClipEdit,
    consumeStageClipEdit,
    consumeStageClipEditResult,
    saveNewAnimation,
    loadProjects,
    renameNewAnimation,
    trashProjects,
    trashLoading,
    trashOpen,
    trashPreviewId,
    previewingTrash,
    previewTrashProject,
    loadTrash,
    toggleTrash,
    restoreFromTrash,
    purgeFromTrash,
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
    requestCover,
    generatePageThumbnails,
    refreshPageCovers,
    refreshingCovers,
    refreshCover,
    projectCoverKey,
    refreshProjectCover,
    isRefreshingCover,
    resetThumbQueue,
    dispose,
    toast,
    ALL_FOLDERS,
  };
});
