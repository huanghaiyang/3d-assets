import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { api, ApiError } from '@/api/client';
import type { SceneNode } from '@/viewer/sceneNodes';
import type {
  GenerateType,
  GenerationParams,
  InputMode,
  Job,
  PolygonType,
  ProviderCapabilities,
  ProviderId,
  ProviderSummary,
  QueueSummary,
  ResultFormat,
  SettingsSummary,
  ViewType,
} from '@/api/types';
import type { PreparedImage } from '@/utils/image';
import { isPreviewable } from '@/viewer/assetTarget';
import { releaseThumbnailRenderer, renderAssetThumbnail } from '@/viewer/thumbnailRenderer';

const DRAFT_KEY = 'h3d.workbench.draft.v1';
const POLL_INTERVAL_MS = 2000;

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

/** 与后端 /api/library/upload-info 的兜底值保持一致 */
const FALLBACK_UPLOAD_EXTENSIONS = [
  'glb',
  'gltf',
  'obj',
  'mtl',
  'stl',
  'fbx',
  'usdz',
  'zip',
  'bin',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'tga',
  'bmp',
];
const FALLBACK_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** 判断任务是否仍在推进中 */
export function isActive(phase: Job['phase']): boolean {
  return phase === 'queued' || phase === 'submitting' || phase === 'running' || phase === 'downloading';
}

interface Draft {
  mode: InputMode;
  prompt: string;
  params: GenerationParams;
}

/** 设置接口不可用时的兜底引擎能力（按混元的能力渲染表单） */
const FALLBACK_CAPABILITIES: ProviderCapabilities = {
  modes: ['text', 'image', 'multiview'],
  generateTypes: ['Normal', 'LowPoly', 'Geometry', 'Sketch'],
  pbr: true,
  faceCount: true,
  multiview: true,
  formats: ['OBJ', 'GLB', 'STL', 'FBX', 'USDZ'],
};

const FALLBACK_PARAMS: GenerationParams = {
  provider: 'hunyuan3d',
  model: '3.0',
  generateType: 'Normal',
  faceCount: 100_000,
  enablePbr: false,
  polygonType: 'triangle',
  resultFormat: 'GLB',
};

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Draft>;
      return {
        mode: parsed.mode === 'image' || parsed.mode === 'multiview' ? parsed.mode : 'text',
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
        params: { ...FALLBACK_PARAMS, ...(parsed.params ?? {}) },
      };
    }
  } catch {
    /* 忽略损坏的草稿 */
  }
  return { mode: 'text', prompt: '', params: { ...FALLBACK_PARAMS } };
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const draft = loadDraft();

  const jobs = ref<Job[]>([]);
  const settings = ref<SettingsSummary | null>(null);
  const queue = ref<QueueSummary>({ active: 0, pending: 0, maxConcurrency: 3, running: 0 });
  const totalJobs = ref(0);
  const loading = ref(true);
  const offline = ref(false);
  const selectedId = ref<string | null>(null);
  const toasts = ref<Toast[]>([]);

  // ===== 生成面板草稿 =====
  const mode = ref<InputMode>(draft.mode);
  const prompt = ref(draft.prompt);
  const image = ref<PreparedImage | null>(null);
  const views = ref<Partial<Record<ViewType, PreparedImage>>>({});
  const params = ref<GenerationParams>({ ...draft.params });
  const submitting = ref(false);

  /** 设置只应用一次；之后的引擎切换由用户显式触发 */
  let providerApplied = false;

  // ===== 生成引擎（provider）=====
  const providers = computed<ProviderSummary[]>(() => settings.value?.providers ?? []);
  /** 表单当前使用的引擎（params.provider 是唯一来源，切换时会同步给服务端作为默认引擎） */
  const activeProviderInfo = computed<ProviderSummary | null>(() => {
    const list = providers.value;
    return list.find((item) => item.id === params.value.provider) ?? list.find((item) => item.id === settings.value?.activeProvider) ?? null;
  });
  const providerCapabilities = computed<ProviderCapabilities>(
    () => activeProviderInfo.value?.capabilities ?? FALLBACK_CAPABILITIES,
  );
  const providerModels = computed(() => activeProviderInfo.value?.models ?? [{ value: '3.0', label: '3.0' }]);

  /** 按引擎能力把参数裁剪到合法值（切换引擎 / 引擎模型变化时调用） */
  function applyProviderDefaults(info: ProviderSummary): void {
    const caps = info.capabilities;
    const defaults = info.defaults;
    const min = settings.value?.limits.faceCount.min ?? 3_000;
    const max = settings.value?.limits.faceCount.max ?? 1_500_000;
    const generateType = caps.generateTypes.includes(params.value.generateType)
      ? params.value.generateType
      : defaults.generateType;
    const faceCount = Math.min(max, Math.max(min, params.value.faceCount || defaults.faceCount));
    const resultFormat =
      params.value.resultFormat && caps.formats.includes(params.value.resultFormat)
        ? params.value.resultFormat
        : defaults.resultFormat;
    params.value = {
      ...defaults,
      provider: info.id,
      model: defaults.model,
      generateType,
      faceCount,
      enablePbr: caps.pbr ? defaults.enablePbr : false,
      resultFormat,
    };
    if (!caps.modes.includes(mode.value as Exclude<InputMode, 'upload'>)) {
      mode.value = caps.modes.includes('text') ? 'text' : (caps.modes[0] ?? 'text');
    }
  }

  /** 切换生成引擎：更新表单参数，并把选择持久化为服务端默认引擎 */
  async function setProvider(id: ProviderId): Promise<void> {
    if (params.value.provider === id) return;
    const info = providers.value.find((item) => item.id === id);
    if (!info) return;
    applyProviderDefaults(info);
    try {
      settings.value = await api.setActiveProvider(id);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '切换生成引擎失败');
    }
  }

  /** 生成引擎的展示名（素材库用） */
  function providerLabel(id: ProviderId): string {
    return providers.value.find((item) => item.id === id)?.label ?? id;
  }

  /** 按当前引擎能力纠正参数（模型、生成类型、输出格式） */
  function sanitizeParams(info: ProviderSummary): void {
    const caps = info.capabilities;
    const defaults = info.defaults;
    const range = caps.faceCountRange;
    const min = Math.max(settings.value?.limits.faceCount.min ?? 3_000, range?.min ?? 0);
    const max = Math.min(settings.value?.limits.faceCount.max ?? 1_500_000, range?.max ?? Number.POSITIVE_INFINITY);
    const next: GenerationParams = { ...params.value, provider: info.id };

    if (!caps.generateTypes.includes(next.generateType)) next.generateType = defaults.generateType;
    if (info.models.length > 0 && !info.models.some((model) => model.value === next.model)) {
      next.model = defaults.model;
    }
    if (next.resultFormat && !caps.formats.includes(next.resultFormat)) next.resultFormat = defaults.resultFormat;
    if (!caps.pbr) next.enablePbr = false;
    if (next.generateType === 'Geometry') next.enablePbr = false;
    // 混元 3.1 不支持智能拓扑 / 草图（服务端也会再校验一次）
    if (info.id === 'hunyuan3d' && next.model === '3.1' && (next.generateType === 'LowPoly' || next.generateType === 'Sketch')) {
      next.generateType = 'Normal';
    }
    next.faceCount = Math.min(max, Math.max(min, Math.round(next.faceCount)));
    params.value = next;
  }

  // 视口状态
  const wireframe = ref(false);
  const showGrid = ref(true);
  const autoRotate = ref(false);

  // 场景节点树（由视口加载完模型后回填）
  const nodeTree = ref<SceneNode[]>([]);
  const selectedNodeIds = ref<string[]>([]);
  const nodeKeyword = ref('');
  const nodeShowBones = ref(false);

  function setNodeTree(tree: SceneNode[]): void {
    nodeTree.value = tree;
    selectedNodeIds.value = [];
  }

  /** 点击节点：additive = Ctrl/⌘ 加选/取消 */
  function selectNode(id: string, additive = false): void {
    if (additive) {
      selectedNodeIds.value = selectedNodeIds.value.includes(id)
        ? selectedNodeIds.value.filter((item) => item !== id)
        : [...selectedNodeIds.value, id];
    } else {
      selectedNodeIds.value = [id];
    }
  }

  function clearNodeSelection(): void {
    selectedNodeIds.value = [];
  }

  // ===== 素材上传 =====
  const uploadQueue = ref<UploadItem[]>([]);
  const uploading = ref(false);
  const uploadInfo = ref<{ acceptedExtensions: string[]; maxBytes: number; hint: string }>({
    acceptedExtensions: FALLBACK_UPLOAD_EXTENSIONS,
    maxBytes: FALLBACK_UPLOAD_MAX_BYTES,
    hint: '',
  });

  // ===== 缩略图补全（上传的模型没有接口预览图，需要在浏览器里渲染）=====
  const thumbnailTask = ref<{ done: number; total: number; current: string | null } | null>(null);
  let thumbnailRunning = false;
  let bootThumbnailScanDone = false;

  let pollTimer: number | null = null;
  let followJobId: string | null = null;
  let toastSeq = 0;

  const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedId.value) ?? null);
  const selectedAsset = computed(() => selectedJob.value?.asset ?? null);
  const activeJobs = computed(() => jobs.value.filter((job) => isActive(job.phase)));
  const viewCount = computed(() => Object.keys(views.value).length);

  const canSubmit = computed(() => {
    if (submitting.value) return false;
    if (!activeProviderInfo.value?.apiKeyConfigured) return false;
    const supportedModes = providerCapabilities.value.modes;
    if (mode.value !== 'upload' && !supportedModes.includes(mode.value)) return false;
    if (mode.value === 'text') return prompt.value.trim().length > 0;
    if (mode.value === 'image') return Boolean(image.value);
    return viewCount.value > 0;
  });

  /** 还没有缩略图、且浏览器能渲染的素材 */
  const thumbnailsMissing = computed(() =>
    jobs.value.filter((job) => job.asset && !job.asset.thumbnailUrl && isPreviewable(job.asset)),
  );

  function toast(kind: Toast['kind'], text: string): void {    const id = ++toastSeq;
    toasts.value.push({ id, kind, text });
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id);
    }, kind === 'error' ? 8000 : 4000);
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  async function refresh(): Promise<void> {
    try {
      const state = await api.state();
      jobs.value = state.jobs;
      settings.value = state.api;
      queue.value = state.queue;
      totalJobs.value = state.totalJobs;
      offline.value = false;

      // 首次拿到设置时确定当前引擎：草稿里的引擎有效就沿用，否则用服务端默认引擎
      if (!providerApplied) {
        providerApplied = true;
        const chosen =
          state.api.providers.find((item) => item.id === params.value.provider) ?? state.api.active;
        if (chosen) {
          const keep = draft.params.provider === chosen.id ? draft.params : null;
          params.value = { ...chosen.defaults, ...(keep ?? {}), provider: chosen.id };
          sanitizeParams(chosen);
        }
      }

      // 自动把刚完成的任务切到视口
      if (followJobId) {
        const followed = state.jobs.find((job) => job.id === followJobId);
        if (followed && followed.phase === 'done') {
          selectedId.value = followed.id;
          followJobId = null;
        } else if (followed && (followed.phase === 'failed' || followed.phase === 'canceled')) {
          followJobId = null;
        }
      }
      if (!selectedId.value && state.jobs.length > 0) {
        selectedId.value = state.jobs.find((job) => job.asset)?.id ?? state.jobs[0]!.id;
      }

      // 首次进入时补全历史素材缺失的缩略图（上限 30 个，避免一次拉取过多模型）
      if (!bootThumbnailScanDone && !loading.value) {
        bootThumbnailScanDone = true;
        if (thumbnailsMissing.value.length > 0) {
          void fillMissingThumbnails({ max: 30 });
        }
      }
    } catch (err) {
      offline.value = true;
      if (!(err instanceof ApiError) || err.status === 0) {
        // 后端未启动时静默重试，避免刷屏
      } else {
        toast('error', err.message);
      }
    } finally {
      loading.value = false;
    }
  }

  function startPolling(): void {
    if (pollTimer !== null) return;
    void refresh();
    void loadUploadInfo();
    pollTimer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refresh();
    });
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function select(jobId: string | null): void {
    selectedId.value = jobId;
  }

  function setMode(next: InputMode): void {
    mode.value = next;
  }

  function setParams(patch: Partial<GenerationParams>): void {
    params.value = { ...params.value, ...patch };
    if (activeProviderInfo.value) sanitizeParams(activeProviderInfo.value);
  }

  function setModel(model: string): void {
    setParams({ model });
  }

  function setGenerateType(generateType: GenerateType): void {
    setParams({ generateType });
  }

  function setPolygonType(polygonType: PolygonType): void {
    setParams({ polygonType });
  }

  function setResultFormat(resultFormat: ResultFormat | null): void {
    setParams({ resultFormat });
  }

  function setImage(next: PreparedImage | null): void {
    image.value = next;
  }

  function setView(viewType: ViewType, next: PreparedImage | null): void {
    const copy = { ...views.value };
    if (next) copy[viewType] = next;
    else delete copy[viewType];
    views.value = copy;
  }

  function clearViews(): void {
    views.value = {};
  }

  /** 用某个历史素材的参数回填生成面板（“复用参数”） */
  function reuseParams(job: Job): void {
    if (job.origin === 'uploaded') {
      toast('info', '上传的素材没有生成参数可复用');
      return;
    }
    const info = providers.value.find((item) => item.id === job.params.provider);
    if (!info) {
      toast('error', '该素材使用的生成引擎已不可用');
      return;
    }
    mode.value = job.input.mode === 'upload' ? 'text' : job.input.mode;
    if (!info.capabilities.modes.includes(mode.value as Exclude<InputMode, 'upload'>)) {
      mode.value = info.capabilities.modes.includes('text') ? 'text' : (info.capabilities.modes[0] ?? 'text');
    }
    prompt.value = job.input.prompt;
    params.value = { ...job.params };
    sanitizeParams(info);
    toast('info', `已载入「${job.name}」的生成参数（${info.label}）`);
  }

  // ===== 素材上传 =====

  async function loadUploadInfo(): Promise<void> {
    try {
      uploadInfo.value = await api.uploadInfo();
    } catch {
      /* 使用兜底常量 */
    }
  }

  function extensionOf(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  }

  /**
   * 上传本地模型到素材库（一次选择多个文件即批量上传）。
   * 逐个文件暂存 → 服务端按批次分组提交；同批次的 `.obj/.gltf` 与材质、贴图会合并成一个素材。
   */
  async function uploadFiles(files: File[]): Promise<void> {
    if (files.length === 0 || uploading.value) return;

    const batchId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    uploadQueue.value = files.map((file, index) => ({
      key: `${index}-${file.name}`,
      name: file.name,
      size: file.size,
      status: 'pending' as const,
    }));
    uploading.value = true;

    const failures: string[] = [];
    let staged = 0;

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const item = uploadQueue.value[index]!;
        const ext = extensionOf(file.name);

        if (!uploadInfo.value.acceptedExtensions.includes(ext)) {
          item.status = 'error';
          item.error = `不支持 .${ext || '(无扩展名)'}`;
          failures.push(`${file.name}：${item.error}`);
          continue;
        }
        if (file.size > uploadInfo.value.maxBytes) {
          item.status = 'error';
          item.error = `超过 ${(uploadInfo.value.maxBytes / 1024 / 1024).toFixed(0)}MB`;
          failures.push(`${file.name}：${item.error}`);
          continue;
        }
        if (file.size === 0) {
          item.status = 'error';
          item.error = '空文件';
          failures.push(`${file.name}：空文件`);
          continue;
        }

        item.status = 'uploading';
        try {
          await api.stageFile(batchId, file);
          item.status = 'done';
          staged += 1;
        } catch (err) {
          item.status = 'error';
          item.error = err instanceof Error ? err.message : '上传失败';
          failures.push(`${file.name}：${item.error}`);
        }
      }

      if (staged === 0) {
        await api.abortUpload(batchId).catch(() => undefined);
        toast('error', failures[0] ?? '没有可上传的文件');
        return;
      }

      const result = await api.commitUpload(batchId);
      if (result.warnings.length > 0) toast('error', result.warnings[0]!);
      toast('success', `已导入 ${result.created.length} 个模型到素材库`);
      // 自动选中第一个导入的模型，视口立即展示
      if (result.created[0]) selectedId.value = result.created[0].id;
      await refresh();
      // 上传的模型没有接口预览图，逐个离屏渲染缩略图
      void fillMissingThumbnails({ ids: result.created.map((job) => job.id) });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '上传失败');
    } finally {
      uploading.value = false;
      window.setTimeout(() => {
        if (!uploading.value) uploadQueue.value = [];
      }, 3500);
    }
  }

  function clearUploadQueue(): void {
    if (!uploading.value) uploadQueue.value = [];
  }

  /**
   * 为缺少缩略图的素材批量生成预览图。
   * 用离屏渲染器顺序处理（同一时刻只占一个 WebGL 上下文），不会打断当前视口。
   */
  async function fillMissingThumbnails(options: { ids?: string[]; max?: number } = {}): Promise<void> {
    if (thumbnailRunning) return;
    const limit = options.max ?? 200;
    const candidates = thumbnailsMissing.value
      .filter((job) => (options.ids ? options.ids.includes(job.id) : true))
      .slice(0, limit);
    if (candidates.length === 0) return;

    thumbnailRunning = true;
    thumbnailTask.value = { done: 0, total: candidates.length, current: null };
    let succeeded = 0;

    try {
      for (const job of candidates) {
        const asset = job.asset;
        if (!asset) continue;
        thumbnailTask.value.current = job.name;
        try {
          const dataUrl = await renderAssetThumbnail(asset);
          if (dataUrl) {
            const response = await api.uploadThumbnail(job.id, dataUrl);
            const target = jobs.value.find((item) => item.id === job.id);
            if (target?.asset) {
              target.asset.thumbnailUrl = response.thumbnailUrl ?? `/files/${job.id}/thumb.png`;
            }
            succeeded += 1;
          }
        } catch {
          // 单个失败不影响其它素材
        }
        thumbnailTask.value.done += 1;
        // 让出主线程，避免长时间阻塞界面
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      thumbnailRunning = false;
      const finished = thumbnailTask.value;
      thumbnailTask.value = null;
      releaseThumbnailRenderer();
      if (finished && finished.total > 1) {
        toast(succeeded > 0 ? 'success' : 'error', `缩略图补全完成：${succeeded}/${finished.total}`);
      }
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit.value) {
      const label = activeProviderInfo.value?.label ?? '当前引擎';
      toast(
        'error',
        activeProviderInfo.value?.apiKeyConfigured ? '请先补充生成所需的输入' : `请先在「设置」中配置${label}的 API Key`,
      );
      return;
    }
    submitting.value = true;
    try {
      const body = {
        mode: mode.value,
        prompt: prompt.value.trim(),
        params: { ...params.value },
        ...(mode.value === 'image' && image.value
          ? {
              imageBase64: image.value.dataUrl,
              imageName: image.value.name,
              previewDataUrl: image.value.dataUrl,
            }
          : {}),
        ...(mode.value === 'multiview'
          ? {
              views: Object.entries(views.value).map(([viewType, prepared]) => ({
                viewType: viewType as ViewType,
                imageBase64: prepared!.dataUrl,
                name: prepared!.name,
              })),
              previewDataUrl: Object.values(views.value)[0]?.dataUrl,
            }
          : {}),
      };
      const job = await api.createJob(body);
      followJobId = job.id;
      jobs.value = [job, ...jobs.value];
      toast('success', '任务已提交，正在排队生成');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '提交失败');
    } finally {
      submitting.value = false;
    }
  }

  async function retry(jobId: string): Promise<void> {
    try {
      const result = await api.retryJob(jobId);
      followJobId = jobId;
      toast('success', result.message);
      await refresh();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '重试失败');
    }
  }

  async function cancel(jobId: string): Promise<void> {
    try {
      await api.cancelJob(jobId);
      toast('info', '已取消任务');
      await refresh();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '取消失败');
    }
  }

  async function remove(jobId: string): Promise<void> {
    try {
      await api.deleteJob(jobId);
      if (selectedId.value === jobId) selectedId.value = null;
      toast('info', '已删除素材');
      await refresh();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '删除失败');
    }
  }

  async function rename(jobId: string, name: string): Promise<void> {
    try {
      const updated = await api.renameJob(jobId, name);
      const index = jobs.value.findIndex((job) => job.id === jobId);
      if (index >= 0) jobs.value[index] = updated;
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '重命名失败');
    }
  }

  async function saveApiKey(key: string, provider?: ProviderId): Promise<void> {
    settings.value = await api.saveApiKey(provider ?? params.value.provider, key);
    toast('success', 'API Key 已保存');
  }

  async function clearApiKey(provider?: ProviderId): Promise<void> {
    settings.value = await api.clearApiKey(provider ?? params.value.provider);
    toast('info', '已清除界面中保存的 API Key');
  }

  async function saveBaseUrl(baseUrl: string, provider?: ProviderId): Promise<void> {
    settings.value = await api.saveBaseUrl(provider ?? params.value.provider, baseUrl);
    toast('success', '接口域名已保存');
  }

  async function verifyApiKey(provider?: ProviderId): Promise<{ ok: boolean; message: string }> {
    const result = await api.verifyApiKey(provider ?? params.value.provider);
    toast(result.ok ? 'success' : 'error', result.message);
    return result;
  }

  /** 远端没有返回预览图时，用浏览器渲染结果回填缩略图 */
  async function uploadThumbnail(jobId: string, dataUrl: string): Promise<void> {
    try {
      const response = await api.uploadThumbnail(jobId, dataUrl);
      const job = jobs.value.find((item) => item.id === jobId);
      if (job?.asset) job.asset.thumbnailUrl = response.thumbnailUrl ?? `/files/${jobId}/thumb.png`;
    } catch {
      /* 缩略图失败不影响主流程 */
    }
  }

  watch(
    [mode, prompt, params],
    () => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ mode: mode.value, prompt: prompt.value, params: params.value }));
      } catch {
        /* 忽略隐私模式下的写入失败 */
      }
    },
    { deep: true },
  );

  return {
    // state
    jobs,
    settings,
    queue,
    totalJobs,
    loading,
    offline,
    selectedId,
    toasts,
    mode,
    prompt,
    image,
    views,
    params,
    submitting,
    wireframe,
    showGrid,
    autoRotate,
    nodeTree,
    selectedNodeIds,
    nodeKeyword,
    nodeShowBones,
    uploadQueue,
    uploading,
    uploadInfo,
    thumbnailTask,
    // getters
    selectedJob,
    selectedAsset,
    activeJobs,
    viewCount,
    canSubmit,
    thumbnailsMissing,
    providers,
    activeProviderInfo,
    providerCapabilities,
    providerModels,
    providerLabel,
    // actions
    setNodeTree,
    selectNode,
    clearNodeSelection,
    startPolling,
    stopPolling,
    refresh,
    select,
    setMode,
    setParams,
    setModel,
    setGenerateType,
    setPolygonType,
    setResultFormat,
    setProvider,
    setImage,
    setView,
    clearViews,
    reuseParams,
    uploadFiles,
    clearUploadQueue,
    fillMissingThumbnails,
    submit,
    retry,
    cancel,
    remove,
    rename,
    saveApiKey,
    clearApiKey,
    saveBaseUrl,
    verifyApiKey,
    uploadThumbnail,
    toast,
    dismissToast,
  };
});
