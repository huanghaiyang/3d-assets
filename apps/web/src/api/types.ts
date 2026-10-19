/** 与 apps/api 的接口类型保持一致（前端只依赖这些形状） */

export type ProviderId = 'hunyuan3d' | 'tripo3d' | 'meshy';

export type JobPhase =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'canceled';

export type InputMode = 'text' | 'image' | 'multiview' | 'upload';
/** generated：生成引擎产出；uploaded：用户上传的本地模型 */
export type JobOrigin = 'generated' | 'uploaded';
export type GenerateType = 'Normal' | 'LowPoly' | 'Geometry' | 'Sketch';
export type PolygonType = 'triangle' | 'quadrilateral';
export type ResultFormat = 'OBJ' | 'GLB' | 'STL' | 'FBX' | 'USDZ';
export type ViewType = 'left' | 'right' | 'back' | 'top' | 'bottom' | 'left_front' | 'right_front';

/** 引擎能力：驱动表单裁剪与提交校验 */
export interface ProviderCapabilities {
  modes: Exclude<InputMode, 'upload'>[];
  generateTypes: GenerateType[];
  pbr: boolean;
  faceCount: boolean;
  /** 引擎自己的面数区间（省略时用工作台通用区间） */
  faceCountRange?: { min: number; max: number };
  multiview: boolean;
  formats: ResultFormat[];
}

export interface ProviderModel {
  value: string;
  label: string;
  hint?: string;
}

export interface ProviderSummary {
  id: ProviderId;
  label: string;
  vendor: string;
  docsUrl: string;
  keyHint: string;
  keyPrefix: string | null;
  envKeyName: string;
  envBaseUrlName: string;
  defaultBaseUrl: string;
  baseUrl: string;
  capabilities: ProviderCapabilities;
  models: ProviderModel[];
  defaults: GenerationParams;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
  apiKeySource: 'settings' | 'env' | 'none';
}

export interface GenerationParams {
  provider: ProviderId;
  /** 引擎的模型/版本标识；'' 表示用引擎默认模型 */
  model: string;
  generateType: GenerateType;
  faceCount: number;
  enablePbr: boolean;
  polygonType: PolygonType;
  resultFormat: ResultFormat | null;
}

export interface InputSummary {
  mode: InputMode;
  prompt: string;
  imageName: string | null;
  previewUrl: string | null;
  viewTypes: ViewType[];
}

export type FileRole = 'model' | 'material' | 'texture' | 'other';

export interface AssetFileEntry {
  name: string;
  size: number;
  url: string;
  role: FileRole;
}

export interface AssetFile {
  type: string;
  sourceUrl: string;
  storedName: string;
  size: number;
  wasZip: boolean;
  format: string;
  entries: AssetFileEntry[];
  primaryUrl: string | null;
  materialUrl: string | null;
}

export interface Asset {
  id: string;
  createdAt: string;
  name: string;
  prompt: string;
  mode: InputMode;
  params: GenerationParams;
  thumbnailUrl: string | null;
  previewRemoteUrl: string | null;
  files: AssetFile[];
  creditConsumed: number | null;
  creditDetails: string | null;
  bytes: number;
}

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  /** generated：生成引擎产出；uploaded：本地导入 */
  origin: JobOrigin;
  phase: JobPhase;
  params: GenerationParams;
  input: InputSummary;
  remoteJobId: string | null;
  remoteStatus: string | null;
  /** 多步引擎（如 Meshy preview → refine）的进展信息 */
  providerMeta: Record<string, string | number | boolean | null>;
  requestId: string | null;
  error: string | null;
  errorCode: string | null;
  creditConsumed: number | null;
  creditDetails: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
  remoteFailed: boolean;
  asset: Asset | null;
}

export interface SettingsSummary {
  activeProvider: ProviderId;
  /** 当前引擎的完整摘要（表单用它渲染参数） */
  active: ProviderSummary;
  providers: ProviderSummary[];
  defaults: GenerationParams;
  limits: {
    faceCount: { min: number; max: number; default: number };
    promptMaxChars: number;
    imageMaxBytes: number;
    maxConcurrency: number;
    pollIntervalMs: number;
  };
  enums: {
    providers: ProviderId[];
    generateTypes: GenerateType[];
    polygonTypes: PolygonType[];
    resultFormats: ResultFormat[];
    viewTypes: ViewType[];
    viewTypes31Only: ViewType[];
  };
}

export interface QueueSummary {
  active: number;
  pending: number;
  maxConcurrency: number;
  running: number;
}

export interface StateResponse {
  serverTime: number;
  jobs: Job[];
  totalJobs: number;
  assets: number;
  queue: QueueSummary;
  api: SettingsSummary;
}

export interface VerifyResponse {
  ok: boolean;
  message: string;
  requestId?: string;
}

export interface CreateJobBody {
  mode: InputMode;
  prompt: string;
  imageBase64?: string;
  imageName?: string;
  previewDataUrl?: string;
  views?: { viewType: ViewType; imageBase64: string; name: string }[];
  params: GenerationParams;
}

export interface UploadInfo {
  acceptedExtensions: string[];
  maxBytes: number;
  hint: string;
}

export interface CommitUploadResponse {
  ok: boolean;
  created: Job[];
  warnings: string[];
}
