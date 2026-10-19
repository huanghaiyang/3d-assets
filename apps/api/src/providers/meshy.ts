/**
 * 生成引擎：Meshy（v2 OpenAPI）。
 *
 * 文档: https://docs.meshy.ai/en/api/text-to-3d
 * 鉴权: Authorization: Bearer <msy_...>
 *
 * 流程差异（由适配器内部消化，worker 只看到统一的 WAIT/RUN/DONE）：
 *   文生3D  POST /text-to-3d (mode=preview) → 轮询 → 需要贴图时再 POST /text-to-3d (mode=refine)
 *   图生3D  POST /image-to-3d（内部会走纹理）→ 轮询
 *
 * 多步流程的状态存在 job.providerMeta 里（stage / previewTaskId），服务重启后仍能继续。
 */

import { DEFAULT_PARAMS, type GenerationParams, type ProviderMeta } from '../store/types.js';
import { httpBuffer, httpJson, toDataUri, imageMimeOf } from './http.js';
import {
  ProviderError,
  clampFaceCount,
  type GenerationProvider,
  type ProviderContext,
  type ProviderFile,
  type ProviderInfo,
  type ProviderInput,
  type ProviderQueryResult,
  type ProviderSubmitResult,
  type ProviderVerifyResult,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.meshy.ai/openapi/v2';

/** Meshy 面数区间 */
const POLYCOUNT_MIN = 100;
const POLYCOUNT_MAX = 300_000;

const INFO: ProviderInfo = {
  id: 'meshy',
  label: 'Meshy',
  vendor: 'Meshy AI',
  docsUrl: 'https://www.meshy.ai/api',
  keyHint: '在 Meshy 控制台 API Keys 页面创建，以 msy_ 开头',
  keyPrefix: 'msy_',
  envKeyName: 'MESHY_API_KEY',
  envBaseUrlName: 'MESHY_BASE_URL',
  defaultBaseUrl: DEFAULT_BASE_URL,
  capabilities: {
    modes: ['text', 'image'],
    generateTypes: ['Normal', 'LowPoly', 'Geometry'],
    pbr: false,
    faceCount: true,
    faceCountRange: { min: 3_000, max: POLYCOUNT_MAX },
    multiview: false,
    formats: ['GLB', 'FBX', 'OBJ', 'USDZ'],
  },
  models: [
    { value: '', label: '默认（推荐）', hint: '由 Meshy 返回当前可用的最新模型' },
    { value: 'meshy-5', label: 'meshy-5', hint: '最新一代，细节更强' },
    { value: 'meshy-4', label: 'meshy-4', hint: '更省积分' },
  ],
  defaults: { ...DEFAULT_PARAMS, provider: 'meshy', model: '', enablePbr: false, resultFormat: 'GLB' },
};

interface MeshyTask {
  id?: string;
  mode?: string;
  status?: string;
  progress?: number;
  model_urls?: { glb?: string; fbx?: string; obj?: string; usdz?: string };
  thumbnail_url?: string;
  /** 部分返回里带消耗的积分 */
  consumed_credits?: number;
  task_error?: { message?: string };
}

interface MeshyCreateResponse {
  result?: string;
}

function headers(ctx: ProviderContext): Record<string, string> {
  return { Authorization: `Bearer ${ctx.apiKey}`, 'Content-Type': 'application/json' };
}

function mapStatus(status: string | undefined): 'WAIT' | 'RUN' | 'DONE' | 'FAIL' {
  switch ((status ?? '').toUpperCase()) {
    case 'PENDING':
      return 'WAIT';
    case 'IN_PROGRESS':
      return 'RUN';
    case 'SUCCEEDED':
      return 'DONE';
    case 'FAILED':
    case 'CANCELED':
    case 'CANCELLED':
      return 'FAIL';
    default:
      return 'WAIT';
  }
}

/** 统一的建模能力参数 */
function meshSettings(params: GenerationParams): Record<string, unknown> {
  const target = clampFaceCount(params.faceCount, POLYCOUNT_MIN, POLYCOUNT_MAX, 100);
  const settings: Record<string, unknown> = { should_remesh: true, target_polycount: target };
  if (params.model) settings.ai_model = params.model;
  return settings;
}

async function createTextTask(
  ctx: ProviderContext,
  body: Record<string, unknown>,
): Promise<string> {
  const { data } = await httpJson<MeshyCreateResponse>(`${ctx.baseUrl}/text-to-3d`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    label: 'Meshy 提交文生3D',
    timeoutMs: 120_000,
  });
  if (!data.result) throw new ProviderError('Meshy 提交成功但未返回任务 ID', 'InternalError.BadResponse');
  return data.result;
}

async function createImageTask(ctx: ProviderContext, body: Record<string, unknown>): Promise<string> {
  const { data } = await httpJson<MeshyCreateResponse>(`${ctx.baseUrl}/image-to-3d`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    label: 'Meshy 提交图生3D',
    timeoutMs: 120_000,
  });
  if (!data.result) throw new ProviderError('Meshy 提交成功但未返回任务 ID', 'InternalError.BadResponse');
  return data.result;
}

async function fetchTask(ctx: ProviderContext, kind: 'text-to-3d' | 'image-to-3d', taskId: string): Promise<MeshyTask> {
  const { data } = await httpJson<MeshyTask>(`${ctx.baseUrl}/${kind}/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: headers(ctx),
    label: 'Meshy 查询任务',
  });
  if (!data.status) throw new ProviderError('Meshy 查询任务未返回 status', 'InternalError.BadResponse');
  return data;
}

function filesFromTask(task: MeshyTask, format: string): ProviderFile[] {
  const fmt = format.toLowerCase();
  const urls = (task.model_urls ?? {}) as Record<string, string | undefined>;
  const url = urls[fmt] ?? urls.glb;
  if (!url) return [];
  const type = (urls[fmt] ? fmt : 'glb').toUpperCase();
  return [{ type, url, previewImageUrl: task.thumbnail_url ?? null }];
}

export const meshyProvider: GenerationProvider = {
  info: INFO,

  normalizeParams(params: GenerationParams): GenerationParams {
    return {
      ...params,
      faceCount: clampFaceCount(params.faceCount, POLYCOUNT_MIN, POLYCOUNT_MAX, 100),
      // Meshy 没有独立的 PBR 开关，纹理在 refine 阶段产物里
      enablePbr: false,
    };
  },

  async submit(
    ctx: ProviderContext,
    params: GenerationParams,
    input: ProviderInput,
  ): Promise<ProviderSubmitResult> {
    const settings = meshSettings(params);

    if (input.image) {
      const mime = imageMimeOf(input.image.name);
      const taskId = await createImageTask(ctx, {
        ...settings,
        image_url: toDataUri(input.image.base64, mime),
        // 白模模式不生成纹理
        should_texture: params.generateType !== 'Geometry',
        enable_pbr: params.enablePbr,
      });
      return {
        remoteJobId: taskId,
        requestId: null,
        meta: { kind: 'image', stage: 'single', needsRefine: false, format: params.resultFormat ?? 'GLB' },
      };
    }

    // 文生3D：先出几何（preview），需要贴图时再 refine
    const needsRefine = params.generateType !== 'Geometry';
    const taskId = await createTextTask(ctx, {
      ...settings,
      mode: 'preview',
      prompt: input.prompt.trim(),
    });
    return {
      remoteJobId: taskId,
      requestId: null,
      meta: {
        kind: 'text',
        stage: 'preview',
        needsRefine,
        previewTaskId: taskId,
        format: params.resultFormat ?? 'GLB',
      },
    };
  },

  async query(ctx: ProviderContext, remoteJobId: string, meta: ProviderMeta): Promise<ProviderQueryResult> {
    const kind = meta.kind === 'image' ? 'image-to-3d' : 'text-to-3d';
    const format = typeof meta.format === 'string' && meta.format ? meta.format : 'GLB';
    const task = await fetchTask(ctx, kind, remoteJobId);
    const status = mapStatus(task.status);

    if (status === 'FAIL') {
      return {
        status: 'FAIL',
        remoteStatus: task.status ?? null,
        errorCode: 'Meshy.Failed',
        errorMessage: task.task_error?.message ?? 'Meshy 任务执行失败',
        creditConsumed: task.consumed_credits ?? null,
      };
    }

    if (status === 'DONE') {
      // 文生3D 的 preview 只是几何；需要贴图时自动提交 refine
      const needsRefine = meta.needsRefine === true;
      if (kind === 'text-to-3d' && needsRefine && meta.stage !== 'refine') {
        const refineId = await createTextTask(ctx, {
          mode: 'refine',
          preview_task_id: remoteJobId,
        });
        return {
          status: 'RUN',
          remoteStatus: 'refine_submitted',
          progress: 0,
          nextRemoteJobId: refineId,
          meta: {
            kind: 'text',
            stage: 'refine',
            needsRefine: true,
            previewTaskId: remoteJobId,
            refineTaskId: refineId,
            format,
          },
        };
      }
      // 结果格式在提交时记到 meta（query 拿不到 params）
      const files = filesFromTask(task, format);
      return {
        status: 'DONE',
        remoteStatus: task.status ?? null,
        progress: 100,
        files,
        creditConsumed: task.consumed_credits ?? null,
      };
    }

    return {
      status,
      remoteStatus: task.status ?? null,
      progress: typeof task.progress === 'number' ? task.progress : null,
    };
  },

  async download(ctx: ProviderContext, url: string): Promise<{ buffer: Buffer; contentType: string }> {
    return httpBuffer(url, { headers: { Authorization: `Bearer ${ctx.apiKey}` }, label: 'Meshy 下载结果' });
  },

  /**
   * 通知 Meshy 取消任务（best-effort）。
   * 入口以官方文档为准：`DELETE /{text-to-3d|image-to-3d}/{task_id}`；不支持时返回 404/405 → false。
   */
  async cancel(ctx: ProviderContext, remoteJobId: string, meta: ProviderMeta): Promise<boolean> {
    const kind = meta.kind === 'image' ? 'image-to-3d' : 'text-to-3d';
    try {
      await httpJson<unknown>(`${ctx.baseUrl}/${kind}/${encodeURIComponent(remoteJobId)}`, {
        method: 'DELETE',
        headers: headers(ctx),
        label: 'Meshy 取消任务',
        timeoutMs: 20_000,
        retries: 0,
      });
      return true;
    } catch (err) {
      if (err instanceof ProviderError && (err.httpStatus === 404 || err.httpStatus === 405)) return false;
      throw err;
    }
  },

  async verify(ctx: ProviderContext): Promise<ProviderVerifyResult> {
    try {
      await httpJson<unknown>(`${ctx.baseUrl}/text-to-3d?page_size=1`, {
        method: 'GET',
        headers: headers(ctx),
        label: 'Meshy 任务列表',
      });
      return { ok: true, message: 'Meshy API Key 有效，接口连通正常' };
    } catch (err) {
      const error = err instanceof ProviderError ? err : new ProviderError((err as Error).message);
      return { ok: false, message: error.message };
    }
  },
};
