import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';

import { animationApi, type AnimationFile, type SavedAnimationProject } from '@/api/animation';
import { kimodoApi, type KimodoAnimation, type SomaSkeleton } from '@/api/kimodo';
import {
  StripsPlayer,
  type StripClipEvent,
  type StripsBakeResult,
  type StripsFrameState,
} from '@/viewer/strips/StripsPlayer';
import { createStripId, type BodyPart, type StripDef, type StripSource } from '@/viewer/strips/StripTypes';

export interface StripsToast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

const KIMODO_FPS = 30;
const MIN_STRIP_DURATION = 0.2;
const MAX_STRIP_DURATION = 60;

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return MIN_STRIP_DURATION;
  return Math.min(MAX_STRIP_DURATION, Math.max(MIN_STRIP_DURATION, value));
}

export const useStripsStore = defineStore('strips', () => {
  const files = ref<AnimationFile[]>([]);
  const projects = ref<SavedAnimationProject[]>([]);
  const kimodoJobs = ref<KimodoAnimation[]>([]);
  const somaSkeleton = shallowRef<SomaSkeleton | null>(null);
  const catalogLoading = ref(false);
  const catalogError = ref<string | null>(null);

  const basePath = ref('');
  const loadingBase = ref(false);
  const strips = ref<StripDef[]>([]);
  const selectedId = ref<string | null>(null);
  /** 新增 Strip 的时长在来源片段加载完成后自动补齐 */
  const autoDuration = new Set<string>();
  const clipStates = ref<Record<string, StripClipEvent>>({});

  const time = ref(0);
  const duration = ref(1);
  const playing = ref(false);
  const speed = ref(1);
  const loop = ref(true);

  const baked = shallowRef<StripsBakeResult | null>(null);
  const bakedMode = ref(false);
  const baking = ref(false);
  const saving = ref(false);
  const saveName = ref('');

  const toasts = ref<StripsToast[]>([]);

  let player: StripsPlayer | null = null;
  let toastSeq = 0;
  let bootstrapped = false;

  const baseFile = computed(() => files.value.find((file) => file.path === basePath.value) ?? null);
  const selectedStrip = computed(() => strips.value.find((strip) => strip.id === selectedId.value) ?? null);

  function toast(kind: StripsToast['kind'], text: string): void {
    const item: StripsToast = { id: (toastSeq += 1), kind, text };
    toasts.value = [...toasts.value, item];
    setTimeout(() => {
      toasts.value = toasts.value.filter((entry) => entry.id !== item.id);
    }, 3200);
  }

  // ===== 素材目录 =====

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

  function attachPlayer(next: StripsPlayer): void {
    player = next;
    next.onFrame(onFrame);
    next.onNotice((message) => toast('error', message));
    next.onClipState(onClipState);
    next.setLoop(loop.value);
    next.setSpeed(speed.value);

    if (bootstrapped && basePath.value) {
      void next.loadBase(basePath.value).then(async () => {
        await next.setStrips(strips.value);
        // 重新进入页面时把之前的烘焙结果恢复成预览，避免模式标记与视口不一致
        if (bakedMode.value && baked.value) next.setBakedClip(baked.value.clip);
      });
    }
  }

  function detachPlayer(): void {
    player = null;
  }

  async function bootstrap(): Promise<void> {
    if (bootstrapped) return;
    bootstrapped = true;
    await loadCatalog();
    if (!player) return;
    if (!basePath.value && files.value.length > 0) {
      await selectBase(files.value[0].path);
    }
  }

  function onFrame(state: StripsFrameState): void {
    time.value = state.time;
    duration.value = state.duration;
    playing.value = state.playing;
  }

  function onClipState(event: StripClipEvent): void {
    clipStates.value = { ...clipStates.value, [event.stripId]: event };
    if (event.status !== 'ready' || event.duration === undefined) return;
    if (!autoDuration.has(event.stripId)) return;
    autoDuration.delete(event.stripId);
    const strip = strips.value.find((item) => item.id === event.stripId);
    if (!strip) return;
    strip.duration = clampDuration(event.duration - strip.trimStart);
  }

  async function selectBase(path: string): Promise<void> {
    if (!player) {
      toast('error', '播放器尚未就绪');
      return;
    }
    if (loadingBase.value || path === basePath.value) return;
    loadingBase.value = true;
    baked.value = null;
    bakedMode.value = false;
    try {
      const ok = await player.loadBase(path);
      if (!ok) return;
      basePath.value = path;
      clipStates.value = {};
      saveName.value = '';
      await player.setStrips(strips.value);
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

  function kimodoDuration(animationId: string): number {
    const job = kimodoJobs.value.find((item) => item.id === animationId);
    return job ? Math.max(0.1, job.frames / KIMODO_FPS) : 1;
  }

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

  // ===== Strip 编辑 =====

  function invalidateBake(): void {
    if (!baked.value) return;
    baked.value = null;
    bakedMode.value = false;
    player?.setBakedClip(null);
  }

  function addStrip(source: StripSource, part: BodyPart = 'full'): void {
    if (!basePath.value) {
      toast('info', '请先选择基础模型');
      return;
    }
    const strip: StripDef = {
      id: createStripId(),
      name: sourceLabel(source),
      source,
      part,
      start: 0,
      trimStart: 0,
      duration: 1,
      weight: 1,
      muted: false,
    };
    strips.value = [...strips.value, strip];
    autoDuration.add(strip.id);
    selectedId.value = strip.id;
    clipStates.value = { ...clipStates.value, [strip.id]: { stripId: strip.id, status: 'loading' } };
    invalidateBake();
    void player?.setStrips(strips.value);
    toast('success', `已添加「${strip.name}」`);
  }

  function updateStrip(id: string, patch: Partial<StripDef>): void {
    const strip = strips.value.find((item) => item.id === id);
    if (!strip) return;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name) strip.name = name;
    }
    if (patch.part !== undefined) strip.part = patch.part;
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
    void player?.setStrips(strips.value);
  }

  function removeStrip(id: string): void {
    strips.value = strips.value.filter((item) => item.id !== id);
    autoDuration.delete(id);
    const nextStates = { ...clipStates.value };
    delete nextStates[id];
    clipStates.value = nextStates;
    if (selectedId.value === id) selectedId.value = strips.value[0]?.id ?? null;
    invalidateBake();
    void player?.setStrips(strips.value);
  }

  function duplicateStrip(id: string): void {
    const strip = strips.value.find((item) => item.id === id);
    if (!strip) return;
    const copy: StripDef = {
      ...strip,
      id: createStripId(),
      name: `${strip.name} 副本`,
      start: strip.start + 0.5,
      color: undefined,
    };
    strips.value = [...strips.value, copy];
    selectedId.value = copy.id;
    clipStates.value = { ...clipStates.value, [copy.id]: { stripId: copy.id, status: 'loading' } };
    invalidateBake();
    void player?.setStrips(strips.value);
  }

  function selectStrip(id: string | null): void {
    selectedId.value = id;
  }

  // ===== 播放 =====

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

  function defaultSaveName(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `拼接动画 ${strips.value.length} 段 ${hh}${mm}`;
  }

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

  function setBakedMode(on: boolean): void {
    if (on && !baked.value) {
      toast('info', '请先烘焙');
      return;
    }
    bakedMode.value = on;
    player?.setBakedClip(on ? baked.value?.clip ?? null : null);
  }

  async function saveBaked(): Promise<void> {
    if (!baked.value || !basePath.value) return;
    const name = saveName.value.trim();
    if (!name) {
      toast('info', '请输入动画名称');
      return;
    }
    saving.value = true;
    try {
      const data = baked.value.data;
      const clipData = data.clips[0];
      const id = `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await animationApi.saveProject({
        id,
        name,
        basePath: basePath.value,
        baseName: baseFile.value?.name ?? 'base.fbx',
        data,
        imported: {
          name: `拼接 · ${strips.value.length} 个 Strip`,
          clipCount: data.clips.length,
          trackCount: clipData?.tracks.length ?? 0,
        },
      });
      toast('success', `已保存为新建动画「${name}」`);
      // 左栏「新建动画」来源列表立刻刷新，能马上把它再拼进别的 Strip
      void loadCatalog();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      saving.value = false;
    }
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
    toasts,
    attachPlayer,
    detachPlayer,
    bootstrap,
    loadCatalog,
    selectBase,
    listFbxClips,
    kimodoDuration,
    sourceLabel,
    addStrip,
    updateStrip,
    removeStrip,
    duplicateStrip,
    selectStrip,
    togglePlay,
    seek,
    setSpeed,
    toggleLoop,
    bake,
    setBakedMode,
    saveBaked,
  };
});
