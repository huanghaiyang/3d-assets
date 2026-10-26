import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import {
  animationApi,
  type AnimationFile,
  type SavedAnimationProject,
  type SavedAnimationProjectDetail,
} from '@/api/animation';
import { kimodoApi, type KimodoAnimation } from '@/api/kimodo';
import { stageApi } from '@/api/stage';
import type { StagePlayer } from '@/viewer/stage/StagePlayer';
import type {
  ActorKind,
  ActorTransform,
  SegmentDef,
  SegmentPose,
  SegmentSource,
  StageActorDef,
  StageDoc,
  StageSummary,
} from '@/viewer/stage/StageTypes';

export interface StageToast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Kimodo 动作按 30fps 生成，用于估算片段时长 */
const SOMA_FPS = 30;

export const useStageStore = defineStore('stage', () => {
  const docs = ref<StageSummary[]>([]);
  const doc = ref<StageDoc | null>(null);
  const selectedActorId = ref<string | null>(null);
  const selectedSegmentId = ref<string | null>(null);

  const files = ref<AnimationFile[]>([]);
  const kimodoJobs = ref<KimodoAnimation[]>([]);
  const animationProjects = ref<SavedAnimationProject[]>([]);
  const catalogLoading = ref(false);
  const catalogError = ref<string | null>(null);

  const onionSkin = ref(false);
  const showPath = ref(false);

  const time = ref(0);
  const duration = ref(0);
  const playing = ref(false);
  const speed = ref(1);
  const gizmoMode = ref<'translate' | 'rotate'>('translate');
  const saving = ref(false);
  const loading = ref(false);
  const toasts = ref<StageToast[]>([]);
  const canUndo = ref(false);
  const canRedo = ref(false);

  let player: StagePlayer | null = null;
  let toastSeq = 0;
  /** 舞台页初始化只做一次，重进页面时保留当前文档 */
  let bootstrapped = false;
  /** 新建动画详情缓存：挑选片段时按需拉取，避免每次点选都请求 */
  const projectCache = new Map<string, Promise<SavedAnimationProjectDetail | null>>();

  const selectedActor = computed(
    () => doc.value?.actors.find((actor) => actor.id === selectedActorId.value) ?? null,
  );

  const actorSegmentsList = computed(() =>
    doc.value && selectedActorId.value
      ? doc.value.segments.filter((segment) => segment.actorId === selectedActorId.value)
      : [],
  );

  function toast(kind: StageToast['kind'], text: string): void {
    const id = ++toastSeq;
    toasts.value.push({ id, kind, text });
    setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id);
    }, 3200);
  }

  // ===== 播放器接入 =====

  function attachPlayer(instance: StagePlayer): void {
    player = instance;
    instance.onFrame((state) => {
      time.value = state.time;
      duration.value = state.duration;
      playing.value = state.playing;
    });
    instance.onNotice((message) => toast('error', message));
    instance.onSelect((id) => {
      const changed = selectedActorId.value !== id;
      selectedActorId.value = id;
      selectedSegmentId.value = null;
      if (changed) instance.setSelectedActor(id);
    });
    instance.onPlacement((event) => updateActorTransform(event.id, event.transform));
    // 点中起始帧残影：选中该段；拖动结束后回写该段站位
    instance.onSelectSegment((actorId, segmentId) => {
      selectedActorId.value = actorId;
      selectedSegmentId.value = segmentId;
    });
    instance.onSegmentPose((segmentId, pose) => updateSegmentPose(segmentId, pose));
    instance.setOnionSkin(onionSkin.value);
    instance.setShowPath(showPath.value);
    // 重进舞台页时恢复当前选中角色（选中环与 gizmo 依赖它）
    instance.setSelectedActor(selectedActorId.value);
    void instance.setDoc(doc.value);
  }

  function detachPlayer(): void {
    player = null;
  }

  function syncPlayer(): void {
    void player?.setDoc(doc.value);
  }

  // ===== 撤销 / 重做 =====

  const HISTORY_LIMIT = 60;
  const past: StageDoc[] = [];
  const future: StageDoc[] = [];
  let historyKey = '';
  let historyAt = 0;

  function cloneDoc(source: StageDoc): StageDoc {
    return JSON.parse(JSON.stringify(source)) as StageDoc;
  }

  function syncHistoryFlags(): void {
    canUndo.value = past.length > 0;
    canRedo.value = future.length > 0;
  }

  function resetHistory(): void {
    past.length = 0;
    future.length = 0;
    historyKey = '';
    syncHistoryFlags();
  }

  /** 记录一次可撤销改动；同 key 的连续操作（拖 gizmo、连续输入）在 800ms 内合并成一步 */
  function recordHistory(key: string, coalesce = true): void {
    if (!doc.value) return;
    const now = performance.now();
    if (coalesce && key === historyKey && now - historyAt < 800) {
      historyAt = now;
      return;
    }
    past.push(cloneDoc(doc.value));
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
    historyKey = key;
    historyAt = now;
    syncHistoryFlags();
  }

  function applySnapshot(snapshot: StageDoc): void {
    const next = cloneDoc(snapshot);
    doc.value = next;
    if (selectedActorId.value && !next.actors.some((actor) => actor.id === selectedActorId.value)) {
      selectedActorId.value = next.actors[0]?.id ?? null;
    }
    if (selectedSegmentId.value && !next.segments.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = null;
    }
    historyKey = '';
    syncPlayer();
    player?.setSelectedActor(selectedActorId.value);
  }

  function undo(): void {
    if (!doc.value) return;
    const previous = past.pop();
    if (!previous) return;
    future.push(cloneDoc(doc.value));
    applySnapshot(previous);
    syncHistoryFlags();
  }

  function redo(): void {
    if (!doc.value) return;
    const next = future.pop();
    if (!next) return;
    past.push(cloneDoc(doc.value));
    applySnapshot(next);
    syncHistoryFlags();
  }

  // ===== 文档 =====

  function newStage(name = '新舞台'): void {
    doc.value = {
      id: '',
      name,
      actors: [],
      segments: [],
      loop: true,
      updatedAt: new Date().toISOString(),
    };
    selectedActorId.value = null;
    selectedSegmentId.value = null;
    resetHistory();
    void player?.setDoc(doc.value);
  }

  async function loadStages(): Promise<void> {
    try {
      const response = await stageApi.list();
      docs.value = response.stages;
    } catch (error) {
      docs.value = [];
      catalogError.value = (error as Error).message;
    }
  }

  async function openStage(id: string): Promise<void> {
    loading.value = true;
    try {
      const loaded = await stageApi.get(id);
      doc.value = { ...loaded, actors: loaded.actors ?? [], segments: loaded.segments ?? [] };
      selectedActorId.value = doc.value.actors[0]?.id ?? null;
      selectedSegmentId.value = null;
      time.value = 0;
      resetHistory();
      await player?.setDoc(doc.value);
      player?.setSelectedActor(selectedActorId.value);
    } catch (error) {
      toast('error', `打开舞台失败：${(error as Error).message}`);
    } finally {
      loading.value = false;
    }
  }

  async function saveStage(): Promise<void> {
    if (!doc.value) return;
    saving.value = true;
    try {
      if (!doc.value.id) {
        const summary = await stageApi.create(doc.value);
        doc.value.id = summary.id;
      } else {
        await stageApi.save(doc.value);
      }
      doc.value.updatedAt = new Date().toISOString();
      await loadStages();
      toast('success', `已保存「${doc.value.name}」`);
    } catch (error) {
      toast('error', `保存失败：${(error as Error).message}`);
    } finally {
      saving.value = false;
    }
  }

  async function removeStage(id: string): Promise<void> {
    try {
      await stageApi.remove(id);
      await loadStages();
      if (doc.value?.id === id) newStage();
      toast('info', '舞台已删除');
    } catch (error) {
      toast('error', `删除失败：${(error as Error).message}`);
    }
  }

  function renameStage(name: string): void {
    if (!doc.value) return;
    const next = name.trim().slice(0, 80);
    if (!next || next === doc.value.name) return;
    recordHistory('rename-stage', false);
    doc.value.name = next;
  }

  /** 舞台列表里就地重命名已保存的舞台（会直接落盘） */
  async function renameStageById(id: string, name: string): Promise<void> {
    const next = name.trim().slice(0, 80);
    if (!id || !next) return;
    const summary = docs.value.find((item) => item.id === id);
    if (summary) summary.name = next;
    const isCurrent = doc.value?.id === id;
    if (isCurrent) {
      recordHistory('rename-stage', false);
      doc.value!.name = next;
    }
    try {
      if (isCurrent) {
        await stageApi.save(doc.value!);
      } else {
        const loaded = await stageApi.get(id);
        loaded.name = next;
        await stageApi.save(loaded);
      }
      await loadStages();
      toast('success', `已重命名为「${next}」`);
    } catch (error) {
      toast('error', `重命名失败：${(error as Error).message}`);
    }
  }

  // ===== 角色 =====

  function addActor(kind: ActorKind, modelPath?: string): StageActorDef | null {
    if (!doc.value) return null;
    const path = kind === 'fbx' ? modelPath ?? files.value[0]?.path : undefined;
    if (kind === 'fbx' && !path) {
      toast(
        'info',
        catalogLoading.value
          ? '动画库还在加载，请稍候再添加 FBX 角色'
          : '还没有可用的 FBX，请先在设置里添加动画文件夹',
      );
      return null;
    }
    recordHistory('add-actor', false);
    const index = doc.value.actors.length + 1;
    const actor: StageActorDef = {
      id: createId(),
      name: kind === 'fbx' ? `FBX 角色 ${index}` : `Soma 角色 ${index}`,
      kind,
      ...(path ? { modelPath: path } : {}),
      transform: { x: 0, z: 0, yaw: 0 },
      visible: true,
    };
    doc.value.actors.push(actor);
    selectedActorId.value = actor.id;
    selectedSegmentId.value = null;
    syncPlayer();
    return actor;
  }

  function removeActor(id: string): void {
    if (!doc.value) return;
    const exists = doc.value.actors.some((actor) => actor.id === id);
    if (!exists) return;
    recordHistory('remove-actor', false);
    doc.value.actors = doc.value.actors.filter((actor) => actor.id !== id);
    doc.value.segments = doc.value.segments.filter((segment) => segment.actorId !== id);
    if (selectedActorId.value === id) {
      selectedActorId.value = doc.value.actors[0]?.id ?? null;
      selectedSegmentId.value = null;
    }
    syncPlayer();
  }

  function updateActorTransform(id: string, transform: ActorTransform): void {
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor) return;
    recordHistory(`transform:${id}`);
    actor.transform = { x: transform.x, z: transform.z, yaw: transform.yaw };
    syncPlayer();
  }

  function updateActorName(id: string, name: string): void {
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor) return;
    const next = name.trim().slice(0, 80);
    if (!next || next === actor.name) return;
    recordHistory(`actor-name:${id}`, false);
    actor.name = next;
  }

  function updateActorModel(id: string, modelPath: string): void {
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor || actor.kind !== 'fbx' || !modelPath) return;
    recordHistory(`actor-model:${id}`, false);
    actor.modelPath = modelPath;
    // 换模型后原 FBX 片段可能不再匹配，清空该角色的序列避免播出空白
    doc.value!.segments = doc.value!.segments.filter((segment) => segment.actorId !== id);
    syncPlayer();
  }

  function toggleActorVisible(id: string): void {
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor) return;
    recordHistory(`actor-visible:${id}`, false);
    actor.visible = !actor.visible;
    syncPlayer();
  }

  // ===== 片段序列 =====

  function addSegment(actorId: string, source: SegmentSource, clipDuration: number): void {
    if (!doc.value) return;
    recordHistory('add-segment', false);
    const length = Math.max(0.05, clipDuration || 1);
    const segment: SegmentDef = {
      id: createId(),
      actorId,
      source,
      trimStart: 0,
      trimEnd: length,
      blendIn: Math.min(0.3, length / 4),
    };
    doc.value.segments.push(segment);
    selectedSegmentId.value = segment.id;
    syncPlayer();
  }

  function updateSegment(id: string, patch: Partial<Pick<SegmentDef, 'trimStart' | 'trimEnd' | 'blendIn'>>): void {
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    recordHistory(`segment:${id}:${Object.keys(patch).join(',')}`);
    if (patch.trimStart !== undefined) segment.trimStart = Math.max(0, patch.trimStart);
    if (patch.trimEnd !== undefined) segment.trimEnd = Math.max(segment.trimStart + 0.05, patch.trimEnd);
    if (patch.blendIn !== undefined) segment.blendIn = Math.max(0, Math.min(2, patch.blendIn));
    syncPlayer();
  }

  function removeSegment(id: string): void {
    if (!doc.value) return;
    const exists = doc.value.segments.some((item) => item.id === id);
    if (!exists) return;
    recordHistory('remove-segment', false);
    doc.value.segments = doc.value.segments.filter((item) => item.id !== id);
    if (selectedSegmentId.value === id) selectedSegmentId.value = null;
    syncPlayer();
  }

  /** 改某段的独立站位（相对角色摆放的偏移） */
  function updateSegmentPose(id: string, patch: Partial<SegmentPose>): void {
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    recordHistory(`pose:${id}`);
    const base = segment.pose ?? { x: 0, z: 0, yaw: 0 };
    segment.pose = {
      x: patch.x ?? base.x,
      z: patch.z ?? base.z,
      yaw: patch.yaw ?? base.yaw,
    };
    syncPlayer();
  }

  function resetSegmentPose(id: string): void {
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    recordHistory(`pose-reset:${id}`, false);
    segment.pose = { x: 0, z: 0, yaw: 0 };
    syncPlayer();
  }

  /** 在同一角色的序列里移动一段（-1 上移，+1 下移） */
  function moveSegment(id: string, delta: number): void {
    if (!doc.value) return;
    const segment = doc.value.segments.find((item) => item.id === id);
    if (!segment) return;
    const indexes = doc.value.segments
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.actorId === segment.actorId);
    const position = indexes.findIndex((entry) => entry.item.id === id);
    const target = indexes[position + delta];
    if (!target) return;
    recordHistory('move-segment', false);
    const origin = indexes[position];
    const segments = doc.value.segments;
    [segments[origin.index], segments[target.index]] = [segments[target.index], segments[origin.index]];
    syncPlayer();
  }

  // ===== 播放控制 =====

  function seek(next: number): void {
    time.value = Math.max(0, Math.min(duration.value, next));
    player?.seek(time.value);
  }

  function togglePlay(): void {
    player?.toggle();
  }

  function setSpeed(next: number): void {
    speed.value = next;
    player?.setSpeed(next);
  }

  function setLoop(on: boolean): void {
    if (!doc.value) return;
    recordHistory('loop', false);
    doc.value.loop = on;
    syncPlayer();
  }

  function setGizmoMode(mode: 'translate' | 'rotate'): void {
    gizmoMode.value = mode;
    player?.setGizmoMode(mode);
  }

  function setOnionSkin(on: boolean): void {
    onionSkin.value = on;
    player?.setOnionSkin(on);
  }

  function setShowPath(on: boolean): void {
    showPath.value = on;
    player?.setShowPath(on);
  }

  function selectActor(id: string | null): void {
    selectedActorId.value = id;
    selectedSegmentId.value = null;
    player?.setSelectedActor(id);
  }

  /** 右侧面板选中某段：联动选中角色，并在舞台上激活该段起始帧残影的移动句柄 */
  function selectSegment(id: string | null): void {
    selectedSegmentId.value = id;
    if (!id) return;
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    if (selectedActorId.value !== segment.actorId) {
      selectedActorId.value = segment.actorId;
      player?.setSelectedActor(segment.actorId);
    }
    // 起始帧残影就是拖动的对象，没开洋葱皮时先打开
    if (!onionSkin.value) setOnionSkin(true);
    player?.selectSegment(id);
  }

  // ===== 素材目录 =====

  async function loadCatalog(): Promise<void> {
    catalogLoading.value = true;
    catalogError.value = null;
    projectCache.clear();
    try {
      const [list, jobs, projects] = await Promise.all([
        animationApi.list().catch(() => null),
        kimodoApi.animations().catch(() => [] as KimodoAnimation[]),
        animationApi.projects().catch(() => null),
      ]);
      files.value = list?.files ?? [];
      kimodoJobs.value = jobs.filter((job) => job.status === 'ready');
      animationProjects.value = projects?.projects ?? [];
    } catch (error) {
      catalogError.value = (error as Error).message;
    } finally {
      catalogLoading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    // 舞台页每次切回来都会重新挂载，但这里只能初始化一次：
    // 否则会重新打开第一个已保存舞台，覆盖掉用户刚点「新建」的空白舞台
    if (bootstrapped) return;
    bootstrapped = true;
    await Promise.all([loadCatalog(), loadStages()]);
    if (docs.value.length > 0) await openStage(docs.value[0].id);
    else newStage();
  }

  /** 片段来源的可读名称 */
  function sourceLabel(source: SegmentSource): string {
    if (source.kind === 'kimodo') {
      const job = kimodoJobs.value.find((item) => item.id === source.animationId);
      const title = job?.note?.trim() || job?.prompt?.trim();
      return title ? title.slice(0, 32) : `Kimodo ${source.animationId.slice(0, 6)}`;
    }
    if (source.kind === 'anim-project') {
      return source.projectName || `新建动画 ${source.projectId.slice(0, 6)}`;
    }
    const file = files.value.find((item) => item.path === source.fbxPath);
    const fileName = file?.name ?? source.fbxPath.split(/[\\/]/).pop() ?? 'FBX';
    return `${fileName} · ${source.clipName}`;
  }

  /** 读新建动画项目详情（带缓存）；失败返回 null */
  function projectDetail(id: string): Promise<SavedAnimationProjectDetail | null> {
    const cached = projectCache.get(id);
    if (cached) return cached;
    const promise = animationApi.project(id).catch(() => null);
    projectCache.set(id, promise);
    return promise;
  }

  /** 从动画 JSON 里取片段时长（关键帧末尾时间与 clip.duration 取大） */
  function animationDataDuration(data: unknown): number {
    const clips = (data as { clips?: unknown } | null)?.clips;
    if (!Array.isArray(clips)) return 0;
    let longest = 0;
    for (const clip of clips) {
      const duration = Number((clip as { duration?: unknown } | null)?.duration);
      if (Number.isFinite(duration)) longest = Math.max(longest, duration);
      const tracks = (clip as { tracks?: unknown } | null)?.tracks;
      if (!Array.isArray(tracks)) continue;
      for (const track of tracks) {
        const times = (track as { times?: unknown } | null)?.times;
        if (!Array.isArray(times) || times.length === 0) continue;
        const last = Number(times[times.length - 1]);
        if (Number.isFinite(last)) longest = Math.max(longest, last);
      }
    }
    return longest;
  }

  /** 把「新建动画」里的项目作为片段加入当前角色 */
  async function addAnimationProjectSegment(projectId: string, projectName: string): Promise<void> {
    if (!doc.value || !selectedActorId.value) return;
    const detail = await projectDetail(projectId);
    if (!detail) {
      toast('error', '读取新建动画失败');
      return;
    }
    const length = animationDataDuration(detail.data);
    if (length <= 0) {
      toast('error', `「${detail.name}」里还没有可用的关键帧`);
      return;
    }
    addSegment(selectedActorId.value, { kind: 'anim-project', projectId, projectName }, length);
  }

  /** Kimodo 动作的估算时长（秒） */
  function kimodoDuration(animationId: string): number {
    const job = kimodoJobs.value.find((item) => item.id === animationId);
    return job ? Math.max(0.1, job.frames / SOMA_FPS) : 1;
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

  return {
    docs,
    doc,
    selectedActorId,
    selectedSegmentId,
    selectedActor,
    actorSegmentsList,
    files,
    kimodoJobs,
    animationProjects,
    catalogLoading,
    catalogError,
    onionSkin,
    showPath,
    time,
    duration,
    playing,
    speed,
    gizmoMode,
    saving,
    loading,
    toasts,
    canUndo,
    canRedo,
    undo,
    redo,
    attachPlayer,
    detachPlayer,
    bootstrap,
    loadCatalog,
    loadStages,
    newStage,
    openStage,
    saveStage,
    removeStage,
    renameStage,
    renameStageById,
    addActor,
    removeActor,
    updateActorTransform,
    updateActorName,
    updateActorModel,
    toggleActorVisible,
    addSegment,
    updateSegment,
    updateSegmentPose,
    resetSegmentPose,
    removeSegment,
    moveSegment,
    seek,
    togglePlay,
    setSpeed,
    setLoop,
    setGizmoMode,
    setOnionSkin,
    setShowPath,
    selectActor,
    selectSegment,
    sourceLabel,
    addAnimationProjectSegment,
    kimodoDuration,
    listFbxClips,
  };
});
