import type {
  GenerateType,
  ModelVersion,
  PolygonType,
  RemoteJobStatus,
  ResultFormat,
  ViewType,
} from '../hunyuan/types.js';

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

export interface GenerationParams {
  model: ModelVersion;
  generateType: GenerateType;
  faceCount: number;
  enablePbr: boolean;
  polygonType: PolygonType;
  /** null 表示使用接口默认（同时返回 OBJ + GLB） */
  resultFormat: ResultFormat | null;
}

/** 生成参数的默认值（上传的素材也会带一份，便于界面统一处理） */
export const DEFAULT_PARAMS: GenerationParams = {
  model: '3.0',
  generateType: 'Normal',
  faceCount: 100_000,
  enablePbr: false,
  polygonType: 'triangle',
  resultFormat: 'GLB',
};

export type InputMode = 'text' | 'image' | 'multiview' | 'upload';

/** 素材来源：混元接口生成 or 用户上传的本地模型 */
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
  /** 远端原始下载地址（24 小时有效） */
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
  /** generated：混元接口生成；uploaded：用户上传的本地模型 */
  origin: JobOrigin;
  phase: JobPhase;
  params: GenerationParams;
  input: InputSummary;
  remoteJobId: string | null;
  remoteStatus: RemoteJobStatus | null;
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

export interface AppSettings {
  /** 用户在界面里填写的 API Key（优先级高于 .env） */
  apiKey: string | null;
}

export interface PersistedState {
  version: number;
  jobs: Job[];
  settings: AppSettings;
  /** 动画预览里用户记录的 FBX 文件夹（有序，仅供只读扫描） */
  animationDirs: string[];
}
