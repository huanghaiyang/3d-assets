import { getProvider } from '../providers/registry.js';
import { ProviderError, type GenerationProvider } from '../providers/types.js';
import type { JobPayload } from '../services/payload.js';
import {
  DEFAULT_PARAMS as DEFAULT_GENERATION_PARAMS,
  FACE_COUNT_MAX,
  FACE_COUNT_MIN,
  GENERATE_TYPES,
  IMAGE_BASE64_MAX_BYTES,
  POLYGON_TYPES,
  PROMPT_MAX_CHARS,
  RESULT_FORMATS,
  VIEW_TYPES,
  type GenerateType,
  type GenerationParams,
  type InputMode,
  type InputSummary,
  type PolygonType,
  type ResultFormat,
  type ViewType,
} from '../store/types.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i;
const RAW_BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

/** 去掉 data URI 前缀并校验 base64 体积 */
export function normalizeBase64(input: string, label: string): string {
  const trimmed = input.trim();
  const match = DATA_URL_RE.exec(trimmed);
  const raw = (match ? match[2] : trimmed).replace(/\s+/g, '');
  if (!raw) throw new ValidationError(`${label}为空`);
  if (!RAW_BASE64_RE.test(raw)) throw new ValidationError(`${label}不是合法的 base64 图片数据`);
  const bytes = Math.floor((raw.length * 3) / 4);
  if (bytes > IMAGE_BASE64_MAX_BYTES) {
    throw new ValidationError(
      `${label}过大（约 ${(bytes / 1024 / 1024).toFixed(1)}MB），单图 base64 需 ≤ ${IMAGE_BASE64_MAX_BYTES / 1024 / 1024}MB`,
    );
  }
  return raw;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${label}必须是字符串`);
  return value;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined || value === null || value === '') return fallback;
  const text = asString(value, label);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new ValidationError(`${label}只支持 ${allowed.join(' / ')}，收到 ${text}`);
  }
  return text as T;
}

/** 从请求体里解析出目标引擎（params.provider 或顶层 provider） */
export function resolveProviderFromBody(body: unknown): GenerationProvider {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const rawParams = (typeof raw.params === 'object' && raw.params !== null ? raw.params : {}) as Record<
    string,
    unknown
  >;
  const id = rawParams.provider ?? raw.provider;
  return getProvider(typeof id === 'string' ? id : undefined);
}

export interface CreateJobBody {
  mode: InputMode;
  prompt: string;
  imageBase64: string | null;
  imageName: string | null;
  previewDataUrl: string | null;
  views: { viewType: ViewType; base64: string; name: string }[];
  params: GenerationParams;
  provider: GenerationProvider;
}

export const DEFAULT_PARAMS: GenerationParams = DEFAULT_GENERATION_PARAMS;

/** 解析并校验生成参数（供创建任务与修改未提交任务共用） */
export function parseParams(rawParams: Record<string, unknown>, provider: GenerationProvider): GenerationParams {
  const caps = provider.info.capabilities;
  const defaults = provider.info.defaults;

  const modelRaw = rawParams.model;
  let model = defaults.model;
  if (modelRaw !== undefined && modelRaw !== null) {
    model = asString(modelRaw, '模型版本').trim().slice(0, 64);
    if (!model) model = defaults.model;
  }

  const supportedTypes = caps.generateTypes.length > 0 ? caps.generateTypes : GENERATE_TYPES;
  const generateType = pickEnum<GenerateType>(rawParams.generateType, supportedTypes, defaults.generateType, '生成类型');

  const polygonType = pickEnum<PolygonType>(rawParams.polygonType, POLYGON_TYPES, defaults.polygonType, '多边形类型');

  const supportedFormats: readonly ResultFormat[] = caps.formats.length > 0 ? caps.formats : RESULT_FORMATS;
  let resultFormat: ResultFormat | null = defaults.resultFormat;
  if (rawParams.resultFormat === null || rawParams.resultFormat === 'default' || rawParams.resultFormat === '') {
    resultFormat = null;
  } else if (rawParams.resultFormat !== undefined) {
    resultFormat = pickEnum<ResultFormat>(rawParams.resultFormat, supportedFormats, 'GLB', '输出格式');
    if (!supportedFormats.includes(resultFormat)) {
      throw new ValidationError(
        `${provider.info.label}只支持 ${supportedFormats.join(' / ')} 输出，当前选择 ${resultFormat}`,
      );
    }
  }

  let faceCount = defaults.faceCount;
  if (rawParams.faceCount !== undefined && rawParams.faceCount !== null) {
    const parsed = Number(rawParams.faceCount);
    if (!Number.isFinite(parsed)) throw new ValidationError('面数必须是数字');
    if (parsed < FACE_COUNT_MIN || parsed > FACE_COUNT_MAX) {
      throw new ValidationError(`面数需在 ${FACE_COUNT_MIN} ~ ${FACE_COUNT_MAX} 之间（收到 ${parsed}）`);
    }
    faceCount = Math.round(parsed);
  }

  let enablePbr = defaults.enablePbr;
  if (rawParams.enablePbr !== undefined) {
    if (typeof rawParams.enablePbr !== 'boolean') throw new ValidationError('enablePbr 必须是布尔值');
    enablePbr = rawParams.enablePbr;
  }

  let params: GenerationParams = {
    provider: provider.info.id,
    model,
    generateType,
    faceCount,
    enablePbr,
    polygonType,
    resultFormat,
  };

  // 引擎专属的裁剪与跨字段校验（例如混元 3.1 不支持低模/草图、Tripo 面数上限）
  if (provider.normalizeParams) {
    try {
      params = provider.normalizeParams(params);
    } catch (err) {
      if (err instanceof ProviderError) throw new ValidationError(err.message);
      throw err;
    }
  }
  return params;
}

/** 解析并校验创建任务的请求体 */
export function parseCreateJobBody(body: unknown): CreateJobBody {
  if (typeof body !== 'object' || body === null) throw new ValidationError('请求体必须是 JSON 对象');
  const raw = body as Record<string, unknown>;
  const provider = resolveProviderFromBody(raw);
  const caps = provider.info.capabilities;

  const mode = pickEnum<Exclude<InputMode, 'upload'>>(
    raw.mode,
    caps.modes,
    caps.modes.includes('text') ? 'text' : caps.modes[0]!,
    '输入模式',
  );
  if (!caps.modes.includes(mode)) {
    throw new ValidationError(`${provider.info.label}不支持「${mode}」输入模式，请切换引擎或输入方式`);
  }

  const rawParams = (typeof raw.params === 'object' && raw.params !== null ? raw.params : {}) as Record<string, unknown>;
  const params = parseParams(rawParams, provider);

  if (mode === 'text' && !caps.modes.includes('text')) {
    throw new ValidationError(`${provider.info.label}不支持文生3D`);
  }
  if (mode === 'multiview' && !caps.multiview) {
    throw new ValidationError(`${provider.info.label}不支持多视角输入，请改用单张参考图`);
  }

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new ValidationError(`提示词最多 ${PROMPT_MAX_CHARS} 个字符，当前 ${prompt.length}`);
  }

  let imageBase64: string | null = null;
  let imageName: string | null = null;
  let views: CreateJobBody['views'] = [];

  if (mode === 'text') {
    if (!prompt) throw new ValidationError('请输入描述文字');
  } else if (mode === 'image') {
    if (typeof raw.imageBase64 !== 'string' || !raw.imageBase64.trim()) {
      throw new ValidationError('请先上传一张参考图');
    }
    imageBase64 = normalizeBase64(raw.imageBase64, '参考图');
    imageName = typeof raw.imageName === 'string' ? raw.imageName.slice(0, 200) : null;
  } else {
    const rawViews = Array.isArray(raw.views) ? raw.views : [];
    if (rawViews.length === 0) throw new ValidationError('多视角模式至少需要 1 张图片');
    const seen = new Set<ViewType>();
    views = rawViews.slice(0, VIEW_TYPES.length).map((item, index) => {
      const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      const viewType = pickEnum<ViewType>(entry.viewType, VIEW_TYPES, 'left', `第 ${index + 1} 张图的视角`);
      if (seen.has(viewType)) throw new ValidationError(`视角 ${viewType} 重复`);
      seen.add(viewType);
      if (typeof entry.imageBase64 !== 'string' || !entry.imageBase64.trim()) {
        throw new ValidationError(`视角 ${viewType} 的图片为空`);
      }
      return {
        viewType,
        base64: normalizeBase64(entry.imageBase64, `视角 ${viewType} 的图片`),
        name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : `${viewType}.png`,
      };
    });
  }

  const previewDataUrl =
    typeof raw.previewDataUrl === 'string' && /^data:image\/(png|jpe?g|webp);base64,/i.test(raw.previewDataUrl)
      ? raw.previewDataUrl.slice(0, 400_000)
      : null;

  return { mode, prompt, imageBase64, imageName, previewDataUrl, views, params, provider };
}

export function toPayload(body: CreateJobBody): JobPayload {
  return {
    prompt: body.prompt,
    imageBase64: body.imageBase64,
    imageName: body.imageName,
    views: body.views,
  };
}

export function toInputSummary(body: CreateJobBody, jobId: string): InputSummary {
  return {
    mode: body.mode,
    prompt: body.prompt,
    imageName: body.imageName,
    previewUrl: body.previewDataUrl ? `/api/jobs/${jobId}/preview` : null,
    viewTypes: body.views.map((view) => view.viewType),
  };
}
