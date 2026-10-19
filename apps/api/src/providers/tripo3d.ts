/**
 * 生成引擎：Tripo3D（VAST AI）开放 API v2。
 *
 * 文档: https://platform.tripo3d.ai/docs
 * 鉴权: Authorization: Bearer <tsk_...>
 *
 * 流程：
 *   1. 图片/多视角先 POST /upload（multipart）换 file_token
 *   2. POST /task { type: text_to_model | image_to_model | multiview_to_model, ... } → task_id
 *   3. GET /task/{task_id} 轮询，成功时 output.model / pbr_model 是 GLB 下载地址
 *
 * 注意：Tripo 的业务错误通常以 HTTP 200 + {code, message} 返回，需要自己判 code。
 */

import { DEFAULT_PARAMS, type GenerationParams, type ViewType } from '../store/types.js';
import { httpBuffer, httpJson, imageMimeOf } from './http.js';
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

const DEFAULT_BASE_URL = 'https://api.tripo3d.ai/v2/openapi';

/** Tripo 单任务面数上限（超出会被接口拒绝，这里提前收窄） */
const FACE_LIMIT_MAX = 20_000;
const FACE_LIMIT_MIN = 500;

const INFO: ProviderInfo = {
  id: 'tripo3d',
  label: 'Tripo3D',
  vendor: 'VAST AI',
  docsUrl: 'https://platform.tripo3d.ai/api-keys',
  keyHint: '在 Tripo3D 开放平台创建 API Key，以 tsk_ 开头',
  keyPrefix: 'tsk_',
  envKeyName: 'TRIPO3D_API_KEY',
  envBaseUrlName: 'TRIPO3D_BASE_URL',
  defaultBaseUrl: DEFAULT_BASE_URL,
  capabilities: {
    modes: ['text', 'image', 'multiview'],
    generateTypes: ['Normal', 'LowPoly', 'Geometry'],
    pbr: true,
    faceCount: true,
    faceCountRange: { min: 3_000, max: FACE_LIMIT_MAX },
    multiview: true,
    formats: ['GLB'],
  },
  models: [
    { value: '', label: '默认（推荐）', hint: '由 Tripo 返回当前账号可用的最新模型' },
    { value: 'v2.5-20250123', label: 'v2.5', hint: '兼顾质量与速度' },
    { value: 'v3.0-20250812', label: 'v3.0', hint: '几何更精细，计价更高' },
  ],
  defaults: { ...DEFAULT_PARAMS, provider: 'tripo3d', model: '', resultFormat: 'GLB' },
};

/** 多视角上传顺序：Tripo 期望「正面、左、背面、右」这类语义顺序，我们按最接近的视角排 */
const VIEW_ORDER: readonly ViewType[] = ['left_front', 'right_front', 'top', 'bottom', 'left', 'right', 'back'];

interface TripoEnvelope<T> {
  code?: number;
  message?: string;
  suggestion?: string;
  data?: T;
}

interface TripoTask {
  task_id?: string;
  type?: string;
  status?: string;
  progress?: number;
  output?: {
    model?: string;
    base_model?: string;
    pbr_model?: string;
    rendered_image?: string;
  };
  error_code?: number;
  error_message?: string;
  credits_consumed?: number;
}

function headers(ctx: ProviderContext): Record<string, string> {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

/** Tripo 的 code!==0 视为业务错误 */
function assertOk<T>(envelope: TripoEnvelope<T>, label: string): T {
  const code = envelope.code ?? 0;
  if (code !== 0) {
    const detail = [envelope.message, envelope.suggestion].filter(Boolean).join('；');
    const codeText = String(code);
    // 1002/1004 等鉴权类错误
    const isAuth = ['1002', '1004', '1006'].includes(codeText) || code === 401;
    throw new ProviderError(
      detail || `${label}失败（Tripo code ${code}）`,
      isAuth ? 'AuthFailure.InvalidApiKey' : `TripoError.${code}`,
      { httpStatus: isAuth ? 401 : undefined },
    );
  }
  if (envelope.data === undefined) {
    throw new ProviderError(`${label}失败：Tripo 未返回 data`, 'InternalError.BadResponse');
  }
  return envelope.data;
}

/** 上传一张图片，返回 file_token */
async function uploadImage(ctx: ProviderContext, base64: string, name: string | null): Promise<string> {
  const mime = imageMimeOf(name);
  const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]!;
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mime }), name ?? `image.${ext}`);
  const { data } = await httpJson<TripoEnvelope<{ image_token?: string; file_token?: string }>>(
    `${ctx.baseUrl}/upload`,
    { method: 'POST', headers: headers(ctx), body: form, label: 'Tripo 图片上传', timeoutMs: 120_000 },
  );
  const result = assertOk(data, 'Tripo 图片上传');
  const token = result.image_token || result.file_token;
  if (!token) throw new ProviderError('Tripo 图片上传未返回 file_token', 'InternalError.BadResponse');
  return token;
}

/** 按引擎期望顺序排列多视角 */
function orderViews(input: ProviderInput): { viewType: ViewType; base64: string; name: string }[] {
  const rank = (viewType: ViewType): number => {
    const index = VIEW_ORDER.indexOf(viewType);
    return index < 0 ? VIEW_ORDER.length : index;
  };
  return [...input.views].sort((a, b) => rank(a.viewType) - rank(b.viewType));
}

async function buildTaskBody(
  ctx: ProviderContext,
  params: GenerationParams,
  input: ProviderInput,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (params.model) body.model_version = params.model;
  if (params.generateType !== 'Geometry') {
    body.texture = true;
    body.pbr = params.enablePbr;
  } else {
    body.texture = false;
  }
  if (params.generateType === 'LowPoly') {
    body.face_limit = clampFaceCount(Math.min(params.faceCount, 10_000), FACE_LIMIT_MIN, 10_000);
    body.quad = params.polygonType === 'quadrilateral';
  } else {
    body.face_limit = clampFaceCount(params.faceCount, FACE_LIMIT_MIN, FACE_LIMIT_MAX);
  }

  const prompt = input.prompt.trim();
  if (input.image) {
    // Tripo 的 image_to_model 只接收图片，忽略附带的 prompt
    const token = await uploadImage(ctx, input.image.base64, input.image.name);
    const mime = imageMimeOf(input.image.name);
    body.type = 'image_to_model';
    body.file = { type: mime.split('/')[1] ?? 'png', file_token: token };
    return body;
  }

  if (input.views.length > 0) {
    const views = orderViews(input).slice(0, 4);
    const files: { type: string; file_token: string }[] = [];
    for (const view of views) {
      const token = await uploadImage(ctx, view.base64, view.name);
      files.push({ type: imageMimeOf(view.name).split('/')[1] ?? 'png', file_token: token });
    }
    // 只有 1 张时按单图任务提交；2~4 张走多视角
    if (files.length === 1) {
      body.type = 'image_to_model';
      body.file = files[0];
    } else {
      body.type = 'multiview_to_model';
      body.files = files;
    }
    return body;
  }

  body.type = 'text_to_model';
  body.prompt = prompt;
  return body;
}

function mapFiles(task: TripoTask): ProviderFile[] {
  const output = task.output ?? {};
  // 优先 PBR 模型，其次普通模型
  const url = output.pbr_model || output.model || output.base_model;
  if (!url) return [];
  const rendered = output.rendered_image;
  const preview = typeof rendered === 'string' && /^https?:\/\//i.test(rendered) ? rendered : null;
  return [{ type: 'GLB', url, previewImageUrl: preview }];
}

function normalizeStatus(status: string | undefined): 'WAIT' | 'RUN' | 'DONE' | 'FAIL' {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
      return 'WAIT';
    case 'running':
      return 'RUN';
    case 'success':
      return 'DONE';
    case 'failed':
    case 'banned':
    case 'cancelled':
    case 'unknown':
    case 'expired':
      return 'FAIL';
    default:
      return 'WAIT';
  }
}

export const tripo3dProvider: GenerationProvider = {
  info: INFO,

  normalizeParams(params: GenerationParams): GenerationParams {
    // Tripo 的面数上限远小于工作台信封，这里提前收窄，避免提交时被接口拒绝
    const faceCount = clampFaceCount(params.faceCount, Math.max(FACE_LIMIT_MIN, 3_000), FACE_LIMIT_MAX);
    return { ...params, faceCount, enablePbr: params.generateType === 'Geometry' ? false : params.enablePbr };
  },

  async submit(ctx: ProviderContext, params: GenerationParams, input: ProviderInput): Promise<ProviderSubmitResult> {
    const body = await buildTaskBody(ctx, params, input);
    const { data } = await httpJson<TripoEnvelope<{ task_id?: string }>>(`${ctx.baseUrl}/task`, {
      method: 'POST',
      headers: { ...headers(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      label: 'Tripo 提交任务',
      timeoutMs: 120_000,
    });
    const task = assertOk(data, 'Tripo 提交任务');
    if (!task.task_id) throw new ProviderError('Tripo 提交成功但未返回 task_id', 'InternalError.BadResponse');
    return { remoteJobId: task.task_id, requestId: null, meta: { stage: 'task' } };
  },

  async query(ctx: ProviderContext, remoteJobId: string): Promise<ProviderQueryResult> {
    const { data } = await httpJson<TripoEnvelope<TripoTask>>(
      `${ctx.baseUrl}/task/${encodeURIComponent(remoteJobId)}?with_rendered_image=true`,
      { method: 'GET', headers: headers(ctx), label: 'Tripo 查询任务' },
    );
    const task = assertOk(data, 'Tripo 查询任务');
    const status = normalizeStatus(task.status);
    return {
      status,
      remoteStatus: task.status ?? null,
      progress: typeof task.progress === 'number' ? task.progress : null,
      files: status === 'DONE' ? mapFiles(task) : [],
      errorCode: task.error_code !== undefined ? `Tripo.${task.error_code}` : undefined,
      errorMessage: task.error_message,
      creditConsumed: task.credits_consumed ?? null,
      creditDetails: null,
    };
  },

  async download(ctx: ProviderContext, url: string): Promise<{ buffer: Buffer; contentType: string }> {
    return httpBuffer(url, { headers: headers(ctx), label: 'Tripo 下载结果' });
  },

  /**
   * 通知 Tripo 取消任务（best-effort）。
   * 取消入口以官方文档为准：`POST /task/{task_id}/cancel`；若接口不存在/不支持会返回 404/405，
   * 这里返回 false 让上层提示「已停止本地跟踪，远端可能仍会计费」。
   */
  async cancel(ctx: ProviderContext, remoteJobId: string): Promise<boolean> {
    try {
      const { data } = await httpJson<TripoEnvelope<unknown>>(
        `${ctx.baseUrl}/task/${encodeURIComponent(remoteJobId)}/cancel`,
        { method: 'POST', headers: headers(ctx), label: 'Tripo 取消任务', timeoutMs: 20_000, retries: 0 },
      );
      assertOk(data, 'Tripo 取消任务');
      return true;
    } catch (err) {
      if (err instanceof ProviderError && (err.httpStatus === 404 || err.httpStatus === 405)) return false;
      throw err;
    }
  },

  async verify(ctx: ProviderContext): Promise<ProviderVerifyResult> {
    try {
      const { data } = await httpJson<TripoEnvelope<{ balance?: number; frozen?: number }>>(
        `${ctx.baseUrl}/user/balance`,
        { method: 'GET', headers: headers(ctx), label: 'Tripo 余额查询' },
      );
      const balance = assertOk(data, 'Tripo 余额查询');
      const credits = typeof balance.balance === 'number' ? `，剩余 ${balance.balance} 积分` : '';
      return { ok: true, message: `Tripo3D API Key 有效${credits}` };
    } catch (err) {
      const error = err instanceof ProviderError ? err : new ProviderError((err as Error).message);
      return { ok: false, message: error.message };
    }
  },
};

export { DEFAULT_BASE_URL as TRIPO_DEFAULT_BASE_URL };
