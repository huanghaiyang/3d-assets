/**
 * 生成引擎（provider）契约。
 *
 * 工作台默认使用 hunyuan3d，三方引擎（tripo3d / meshy）实现同一套契约即可接入：
 *   submit  → 提交任务，拿到远端任务 ID
 *   query   → 轮询远端任务，返回统一状态 + 可下载结果
 *   download→ 下载结果文件（由素材服务转存到本地）
 *   verify  → 校验 Key / 连通性
 *
 * 引擎差异（鉴权方式、请求字段、状态枚举、多步流程）全部收敛在各自的适配器里，
 * worker / 路由 / 前端只依赖这里的统一形状。
 */

import type {
  GenerateType,
  GenerationParams,
  InputMode,
  ProviderId,
  ProviderMeta,
  RemoteJobStatus,
  ResultFormat,
  ViewType,
} from '../store/types.js';

/** 引擎返回的通用错误 */
export class ProviderError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly requestId?: string;

  constructor(message: string, code = 'ProviderError', extra: { httpStatus?: number; requestId?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.httpStatus = extra.httpStatus;
    this.requestId = extra.requestId;
  }

  /** 网络/限流/服务端错误可以安全重试；参数或鉴权错误不能 */
  get retryable(): boolean {
    return (
      this.code === 'NetworkError' ||
      this.code === 'RateLimited' ||
      this.code.startsWith('InternalError') ||
      this.code.startsWith('Timeout')
    );
  }
}

export class MissingProviderKeyError extends ProviderError {
  constructor(providerLabel: string, envName: string) {
    super(
      `尚未配置${providerLabel}的 API Key，请在右上角「设置」中填写，或写入 .env 的 ${envName}。`,
      'AuthFailure.MissingApiKey',
    );
    this.name = 'MissingProviderKeyError';
  }
}

// ===== 能力声明（驱动前端表单与后端校验） =====

export interface ProviderCapabilities {
  /** 支持哪些输入模式（upload 是本地导入，不算引擎能力） */
  modes: readonly Exclude<InputMode, 'upload'>[];
  /** 支持哪些生成类型；其余类型的选项在前端隐藏、后端拒绝 */
  generateTypes: readonly GenerateType[];
  /** 是否支持 PBR 贴图开关 */
  pbr: boolean;
  /** 是否支持自定义面数 */
  faceCount: boolean;
  /** 引擎自己的面数区间（省略时用工作台通用区间） */
  faceCountRange?: { min: number; max: number };
  /** 是否支持多视角输入 */
  multiview: boolean;
  /** 支持的结果格式；null（默认）始终可用 */
  formats: readonly ResultFormat[];
}

export interface ProviderModelOption {
  /** 传给引擎的模型标识；'' 表示引擎默认模型 */
  value: string;
  label: string;
  hint?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  /** 界面展示名 */
  label: string;
  vendor: string;
  docsUrl: string;
  /** Key 申请说明（展示在设置面板） */
  keyHint: string;
  /** Key 前缀校验，如 'sk-'、'tsk_'；null 表示不校验 */
  keyPrefix: string | null;
  /** .env 中对应的变量名 */
  envKeyName: string;
  envBaseUrlName: string;
  defaultBaseUrl: string;
  capabilities: ProviderCapabilities;
  models: ProviderModelOption[];
  /** 该引擎的默认参数（切换引擎时前端会套用） */
  defaults: GenerationParams;
}

// ===== 运行时上下文与输入输出 =====

export interface ProviderContext {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

/** 归一化后的任务输入（图片一律是去掉 data URI 前缀的 base64） */
export interface ProviderInput {
  mode: Exclude<InputMode, 'upload'>;
  prompt: string;
  image: { base64: string; name: string | null } | null;
  views: { viewType: ViewType; base64: string; name: string }[];
}

export interface ProviderSubmitResult {
  remoteJobId: string;
  requestId: string | null;
  /** 引擎自己的附加状态（如 Meshy 的 preview 阶段标记） */
  meta?: ProviderMeta;
}

export interface ProviderFile {
  /** 文件类型标签，如 GLB / OBJ / ZIP */
  type: string;
  url: string;
  previewImageUrl: string | null;
}

export interface ProviderQueryResult {
  status: RemoteJobStatus;
  files?: ProviderFile[];
  errorCode?: string;
  errorMessage?: string;
  creditConsumed?: number | null;
  creditDetails?: string | null;
  requestId?: string;
  /** 远端原始状态字符串（便于排查，如 queued/running/SUCCEEDED） */
  remoteStatus?: string | null;
  /** 进度 0-100（部分引擎提供） */
  progress?: number | null;
  /** 需要串行推进多步时，返回下一个远端任务 ID（worker 会替换 remoteJobId） */
  nextRemoteJobId?: string | null;
  /** 合并进 job.providerMeta 的增量状态 */
  meta?: ProviderMeta;
}

export interface ProviderVerifyResult {
  ok: boolean;
  message: string;
  requestId?: string;
}

export type Downloader = (url: string) => Promise<{ buffer: Buffer; contentType: string }>;

export interface GenerationProvider {
  readonly info: ProviderInfo;
  /** 引擎专属的参数归一化（裁剪不支持的能力、纠正非法组合） */
  normalizeParams?(params: GenerationParams): GenerationParams;
  submit(ctx: ProviderContext, params: GenerationParams, input: ProviderInput): Promise<ProviderSubmitResult>;
  query(ctx: ProviderContext, remoteJobId: string, meta: ProviderMeta): Promise<ProviderQueryResult>;
  download(ctx: ProviderContext, url: string): Promise<{ buffer: Buffer; contentType: string }>;
  verify(ctx: ProviderContext): Promise<ProviderVerifyResult>;
  /**
   * 可选：通知远端取消任务。返回 true 表示远端已接受；false 表示该引擎/该阶段不支持取消。
   * 调用方只做 best-effort（失败不影响本地取消），因此这里抛错只会被记录成提示。
   */
  cancel?(ctx: ProviderContext, remoteJobId: string, meta: ProviderMeta): Promise<boolean>;
}

// ===== 小工具 =====

/** 把面数夹到引擎允许的区间并量化 */
export function clampFaceCount(value: number, min: number, max: number, step = 1): number {
  const stepped = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

/** 取参数里指定的格式（不指定时用默认格式），返回小写扩展名 */
export function wantedFormat(params: GenerationParams, fallback = 'glb'): string {
  return (params.resultFormat ?? fallback).toLowerCase();
}
