/**
 * 生成引擎：腾讯云混元生3D（默认引擎）。
 *
 * 把工作台的通用参数映射到混元的 OpenAI 兼容接口，并把结果回落成统一的 Provider 契约。
 */

import { Hunyuan3DClient, HunyuanApiError } from '../hunyuan/client.js';
import type { File3D, ModelVersion, MultiViewImage, QueryJobData, SubmitJobRequest } from '../hunyuan/types.js';
import { MODEL_VERSIONS } from '../hunyuan/types.js';
import { DEFAULT_PARAMS, FACE_COUNT_DEFAULT, FACE_COUNT_MAX, FACE_COUNT_MIN, type GenerationParams } from '../store/types.js';
import {
  MissingProviderKeyError,
  ProviderError,
  type GenerationProvider,
  type ProviderContext,
  type ProviderFile,
  type ProviderInfo,
  type ProviderInput,
  type ProviderQueryResult,
  type ProviderSubmitResult,
  type ProviderVerifyResult,
} from './types.js';

const INFO: ProviderInfo = {
  id: 'hunyuan3d',
  label: '混元生3D',
  vendor: '腾讯云',
  docsUrl: 'https://console.cloud.tencent.com/ai3d/start',
  keyHint: '在腾讯云混元生3D 控制台创建，以 sk- 开头',
  keyPrefix: 'sk-',
  envKeyName: 'HUNYUAN3D_API_KEY',
  envBaseUrlName: 'HUNYUAN3D_BASE_URL',
  defaultBaseUrl: 'https://api.ai3d.cloud.tencent.com',
  capabilities: {
    modes: ['text', 'image', 'multiview'],
    generateTypes: ['Normal', 'LowPoly', 'Geometry', 'Sketch'],
    pbr: true,
    faceCount: true,
    faceCountRange: { min: FACE_COUNT_MIN, max: FACE_COUNT_MAX },
    multiview: true,
    formats: ['OBJ', 'GLB', 'STL', 'FBX', 'USDZ'],
  },
  models: [
    { value: '3.0', label: '3.0', hint: '支持全部生成类型（含智能拓扑 / 草图）' },
    { value: '3.1', label: '3.1', hint: '几何质量更好，但不支持智能拓扑与草图' },
  ],
  defaults: { ...DEFAULT_PARAMS, provider: 'hunyuan3d', model: '3.0' },
};

function asModelVersion(model: string): ModelVersion {
  return (MODEL_VERSIONS as readonly string[]).includes(model) ? (model as ModelVersion) : '3.0';
}

/** 把通用参数 + 输入映射成混元提交请求体 */
function buildSubmitRequest(params: GenerationParams, input: ProviderInput): SubmitJobRequest {
  const req: SubmitJobRequest = { Model: asModelVersion(params.model), GenerateType: params.generateType };

  const prompt = input.prompt.trim();
  const imageBase64 = input.image?.base64 ?? null;
  const hasImage = Boolean(imageBase64);
  const hasViews = input.views.length > 0;
  // Sketch 模式允许图文同时输入；其他模式 Prompt 与图片互斥
  const allowBoth = params.generateType === 'Sketch';

  if (hasImage) {
    req.ImageBase64 = imageBase64 ?? undefined;
  } else if (hasViews) {
    req.MultiViewImages = input.views.map<MultiViewImage>((view) => ({
      ViewType: view.viewType,
      ViewImageBase64: view.base64,
    }));
  }

  if (prompt && (allowBoth || !hasImage)) {
    req.Prompt = prompt;
  }

  if (params.generateType !== 'LowPoly') req.FaceCount = params.faceCount;
  if (params.generateType !== 'Geometry') req.EnablePBR = params.enablePbr;
  if (params.generateType === 'LowPoly') req.PolygonType = params.polygonType;
  if (params.resultFormat) req.ResultFormat = params.resultFormat;

  return req;
}

function mapFiles(files: File3D[]): ProviderFile[] {
  return files
    .filter((file): file is File3D & { Url: string } => typeof file.Url === 'string' && file.Url.length > 0)
    .map((file) => ({
      type: (file.Type ?? 'FILE').toUpperCase(),
      url: file.Url,
      previewImageUrl: file.PreviewImageUrl ?? null,
    }));
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof HunyuanApiError) {
    return new ProviderError(err.message, err.code, { httpStatus: err.httpStatus, requestId: err.requestId });
  }
  return new ProviderError((err as Error)?.message ?? '混元接口调用失败', 'InternalError.Unknown');
}

export const hunyuan3dProvider: GenerationProvider = {
  info: INFO,

  normalizeParams(params: GenerationParams): GenerationParams {
    const model = asModelVersion(params.model);
    if (params.model !== model) {
      throw new ProviderError(
        `混元生3D 的模型版本只支持 ${MODEL_VERSIONS.join(' / ')}，收到 ${params.model || '(空)'}`,
        'InvalidParameter.ModelVersion',
      );
    }
    let { generateType, enablePbr } = params;
    if (model === '3.1' && (generateType === 'LowPoly' || generateType === 'Sketch')) {
      throw new ProviderError(
        '模型版本 3.1 不支持 LowPoly（智能拓扑）与 Sketch（草图）模式，请改用 3.0 或切换生成类型。',
        'InvalidParameter.ModelGenerateType',
      );
    }
    if (generateType === 'Geometry') enablePbr = false;
    if (generateType === 'LowPoly') params = { ...params, faceCount: FACE_COUNT_DEFAULT };
    return { ...params, model, generateType, enablePbr };
  },

  async submit(ctx: ProviderContext, params: GenerationParams, input: ProviderInput): Promise<ProviderSubmitResult> {
    if (!ctx.apiKey) throw new MissingProviderKeyError(INFO.label, INFO.envKeyName);
    try {
      const client = new Hunyuan3DClient({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
      const submitted = await client.submitJob(buildSubmitRequest(params, input));
      return { remoteJobId: submitted.jobId, requestId: submitted.requestId || null };
    } catch (err) {
      throw toProviderError(err);
    }
  },

  async query(ctx: ProviderContext, remoteJobId: string): Promise<ProviderQueryResult> {
    if (!ctx.apiKey) throw new MissingProviderKeyError(INFO.label, INFO.envKeyName);
    try {
      const client = new Hunyuan3DClient({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
      const data: QueryJobData = await client.queryJob(remoteJobId);
      const result: ProviderQueryResult = {
        status: data.status,
        files: mapFiles(data.files),
        remoteStatus: data.status,
        errorCode: data.errorCode,
        errorMessage: data.errorMessage,
        creditConsumed: data.creditConsumed ?? null,
        creditDetails: data.creditDetails ?? null,
        requestId: data.requestId,
      };
      return result;
    } catch (err) {
      throw toProviderError(err);
    }
  },

  async download(ctx: ProviderContext, url: string): Promise<{ buffer: Buffer; contentType: string }> {
    try {
      const client = new Hunyuan3DClient({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
      return await client.download(url);
    } catch (err) {
      throw toProviderError(err);
    }
  },

  async verify(ctx: ProviderContext): Promise<ProviderVerifyResult> {
    if (!ctx.apiKey) return { ok: false, message: '尚未配置 API Key' };
    try {
      const client = new Hunyuan3DClient({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
      // 用一个不存在的 JobId 调查询接口：返回“任务不存在”说明鉴权通过
      await client.queryJob('0');
      return { ok: true, message: 'API Key 有效（接口返回异常任务状态）' };
    } catch (err) {
      const providerError = toProviderError(err);
      if (providerError.code === 'FailedOperation.JobNotFound') {
        return { ok: true, message: 'API Key 有效，接口连通正常' };
      }
      return { ok: false, message: providerError.message, requestId: providerError.requestId };
    }
  },
};
