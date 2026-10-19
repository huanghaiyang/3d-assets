/**
 * 领域模型类型。
 *
 * 生成引擎（provider）是可插拔的：默认 hunyuan3d，同时支持 tripo3d / meshy。
 * 这里只描述“工作台”自己的数据形状，具体引擎的请求/响应格式放在 providers/ 下，
 * 这样新增引擎不会污染任务存储与前端协议。
 */

// ===== 生成引擎 =====

export const PROVIDER_IDS = ['hunyuan3d', 'tripo3d', 'meshy'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** 默认引擎：混元生3D */
export const DEFAULT_PROVIDER_ID: ProviderId = 'hunyuan3d';

/** 某个引擎的额外进展信息（例如 Meshy 的 preview/refine 阶段），只存基础标量以便安全持久化 */
export type ProviderMeta = Record<string, string | number | boolean | null>;

// ===== 生成参数枚举 =====

/** 输入模式 */
export type InputMode = 'text' | 'image' | 'multiview' | 'upload';

/** 多视角类型（混元支持 7 种，其它引擎会做映射） */
export const VIEW_TYPES = ['left', 'right', 'back', 'top', 'bottom', 'left_front', 'right_front'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/** 生成类型：标准 / 智能拓扑低模 / 白模 / 草图 */
export const GENERATE_TYPES = ['Normal', 'LowPoly', 'Geometry', 'Sketch'] as const;
export type GenerateType = (typeof GENERATE_TYPES)[number];

/** 多边形类型，只有低模模式生效 */
export const POLYGON_TYPES = ['triangle', 'quadrilateral'] as const;
export type PolygonType = (typeof POLYGON_TYPES)[number];

/** 输出格式（各引擎支持范围不同，最终以 provider 的 capabilities.formats 为准） */
export const RESULT_FORMATS = ['OBJ', 'GLB', 'STL', 'FBX', 'USDZ'] as const;
export type ResultFormat = (typeof RESULT_FORMATS)[number];

/** 远端任务状态（各引擎统一映射到这四个） */
export type RemoteJobStatus = 'WAIT' | 'RUN' | 'FAIL' | 'DONE';

// ===== 工作台通用限制 =====

/** 面数取值范围（工作台级信封，各引擎会再收窄） */
export const FACE_COUNT_MIN = 3_000;
export const FACE_COUNT_MAX = 1_500_000;
export const FACE_COUNT_DEFAULT = 500_000;

/** 单图 base64 上限（6MB） */
export const IMAGE_BASE64_MAX_BYTES = 6 * 1024 * 1024;
/** 提示词最大字符数 */
export const PROMPT_MAX_CHARS = 1024;

// ===== 任务 =====

/** 任务在本地工作台的生命周期 */
export type JobPhase =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'canceled';

/** 所有仍在推进中的阶段 */
export const ACTIVE_PHASES: readonly JobPhase[] = ['queued', 'submitting', 'running', 'downloading'];

export function isActivePhase(phase: JobPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/**
 * 生成参数。
 *
 * `provider` 决定用哪个引擎，`model` 是该引擎内部的模型/版本标识（混元是 3.0/3.1，
 * Tripo 是 v2.5-…，Meshy 是 meshy-5，空字符串表示用引擎默认）。
 * 其余字段是工作台的通用概念，由各引擎自行映射或忽略。
 */
export interface GenerationParams {
  provider: ProviderId;
  /** 引擎的模型/版本标识；'' 表示使用引擎默认模型 */
  model: string;
  generateType: GenerateType;
  faceCount: number;
  enablePbr: boolean;
  polygonType: PolygonType;
  /** null 表示使用引擎默认（通常同时返回 OBJ + GLB） */
  resultFormat: ResultFormat | null;
}

/** 默认参数（混元生3D 的默认值，也是全新草稿的默认值） */
export const DEFAULT_PARAMS: GenerationParams = {
  provider: DEFAULT_PROVIDER_ID,
  model: '3.0',
  generateType: 'Normal',
  faceCount: 100_000,
  enablePbr: false,
  polygonType: 'triangle',
  resultFormat: 'GLB',
};

/** 素材来源：生成引擎产出 or 用户上传的本地模型 */
export type JobOrigin = 'generated' | 'uploaded';

/** 入库的输入摘要（预览图另存 uploads/，这里只记录访问地址） */
export interface InputSummary {
  mode: InputMode;
  prompt: string;
  imageName: string | null;
  /** 前端压缩后的输入预览图地址，形如 /api/jobs/<id>/preview */
  previewUrl: string | null;
  viewTypes: ViewType[];
}

export type FileRole = 'model' | 'material' | 'texture' | 'other';

export interface AssetFileEntry {
  /** 相对素材目录的路径 */
  name: string;
  size: number;
  /** 可直接访问的 URL */
  url: string;
  role: FileRole;
}

export interface AssetFile {
  type: string;
  /** 远端原始下载地址（通常 24 小时有效） */
  sourceUrl: string;
  /** 转存后的入口文件名 */
  storedName: string;
  size: number;
  wasZip: boolean;
  /** 主模型扩展名：glb / obj / stl / fbx / usdz */
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
  /** 素材展示名称，生成时可重命名 */
  name: string;
  /** generated：生成引擎产出；uploaded：用户上传的本地模型 */
  origin: JobOrigin;
  phase: JobPhase;
  params: GenerationParams;
  input: InputSummary;
  remoteJobId: string | null;
  remoteStatus: RemoteJobStatus | null;
  /** 多步引擎（Meshy preview → refine）的进展信息 */
  providerMeta: ProviderMeta;
  requestId: string | null;
  error: string | null;
  errorCode: string | null;
  creditConsumed: number | null;
  creditDetails: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
  /** 远端明确判定任务失败 → 重试需要重新提交（会再次计费） */
  remoteFailed: boolean;
  asset: Asset | null;
}

/** 单个引擎的凭据（界面填写优先于 .env） */
export interface ProviderCredential {
  apiKey: string | null;
  /** 自定义接口域名（代理 / 私有化部署时使用），null 表示用默认值 */
  baseUrl: string | null;
}

export interface AppSettings {
  /** 界面默认选中的引擎（新任务默认使用它） */
  activeProvider: ProviderId;
  providers: Record<string, ProviderCredential>;
  /** 旧版本的单一混元 Key，仅用于迁移，写入后不再更新 */
  apiKey?: string | null;
}

export interface PersistedState {
  version: number;
  jobs: Job[];
  settings: AppSettings;
  /** 动画预览里用户记录的 FBX 文件夹（有序，仅供只读扫描） */
  animationDirs: string[];
}
