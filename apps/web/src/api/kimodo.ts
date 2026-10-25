import { request } from './client';

export interface KimodoStatus {
  /** .env 里的可执行文件 / 模型是否齐备 */
  ready: boolean;
  /** 生成器进程是否已拉起（首次生成时懒启动） */
  running: boolean;
  /** 是否有任务正在生成 */
  busy: boolean;
  /** 排队中的任务数 */
  queued: number;
  generatorExe: string | null;
  motionModel: string | null;
  textBundle: string | null;
  outputDir: string;
  backend: string;
  /** 提示词转译厂商（deepseek / openai / qwen / ...） */
  promptProvider: string;
  /** 厂商显示名 */
  promptProviderLabel: string;
  /** 纯文字转译模型名 */
  promptModel: string;
  /** 带参考图时使用的视觉模型名 */
  promptVisionModel: string;
  /** 提示词模型是否可用 */
  promptModelReady: boolean;
  error: string | null;
}

export type KimodoStatusValue = 'queued' | 'running' | 'ready' | 'failed';

export interface KimodoAnimation {
  id: string;
  prompt: string;
  frames: number;
  steps: number;
  seed: number;
  status: KimodoStatusValue;
  error?: string;
  createdAt: number;
  /** 多段生成时的分段提示词与各自帧数 */
  segments?: KimodoPromptSegment[];
  durationMs?: number;
  /** 开始生成的时刻，用于计算进度 */
  startedAt?: number;
  /** 预计总耗时（毫秒） */
  etaMs?: number;
  /** 预计其中冷启动加载模型的耗时（毫秒），0 表示权重已驻留 */
  loadMs?: number;
}

/** 多段生成里的一段提示词 */
export interface KimodoPromptSegment {
  prompt: string;
  frames: number;
}

export interface SomaSkeleton {
  names: string[];
  parents: number[];
  offsets: [number, number, number][];
}

export interface KimodoGenerateBody {
  prompt: string;
  frames: number;
  steps: number;
  seed?: number;
  /** 首尾过渡帧，留空用后端默认值 5 */
  transitionFrames?: number;
  /** 复合动作分段：至少 2 段才生效 */
  segments?: KimodoPromptSegment[];
}

export interface KimodoImportResult {
  ok: boolean;
  data: unknown;
  clipName: string;
}

export type KimodoArtifactKey = 'prompt' | 'meta' | 'mixamo' | 'root' | 'rotations';

/** 一次生成留下的中间产物 */
export interface KimodoArtifact {
  key: KimodoArtifactKey;
  label: string;
  /** 相对输出目录的路径 */
  file: string;
  format: 'text' | 'json' | 'f32';
  size: number;
  exists: boolean;
  /** 二进制产物只展示信息，不可当文本查看 */
  viewable: boolean;
  description: string;
}

/** 产物关联到的新建动画项目 */
export interface KimodoRelation {
  id: string;
  name: string;
  importedName: string | null;
  updatedAt: string;
  clipCount: number;
  trackCount: number;
}

export interface KimodoArtifactsResponse {
  task: KimodoAnimation;
  artifacts: KimodoArtifact[];
  relations: KimodoRelation[];
}

export interface KimodoArtifactContent {
  key: 'prompt' | 'meta' | 'mixamo';
  file: string;
  format: 'text' | 'json';
  size: number;
  text: string;
  truncated: boolean;
}

export interface PromptDecomposition {
  /** 按时间顺序的身体动作链（中文） */
  steps: string[];
  /** 描述的物体（模型无物体接触，仅提示） */
  objects: string[];
  /** 是否做过改写的一句话说明 */
  note: string;
}

export interface EnhancePromptResult {
  prompt: string;
  model: string;
  usedImage: boolean;
  /** 解析成功时为动作拆解，失败时为 null */
  decomposition: PromptDecomposition | null;
  /** 2–4 段英文提示词，可用于分段生成 */
  segments: string[];
}

export const kimodoApi = {
  status: () => request<KimodoStatus>('/api/kimodo/status'),

  skeleton: () => request<SomaSkeleton>('/api/kimodo/skeleton'),

  generate: (body: KimodoGenerateBody) =>
    request<KimodoAnimation>('/api/kimodo/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  animations: () => request<KimodoAnimation[]>('/api/kimodo/animations'),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/kimodo/animations/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  importAnimation: (id: string, clipName?: string) => {
    const query = clipName ? `?clipName=${encodeURIComponent(clipName)}` : '';
    return request<KimodoImportResult>(`/api/kimodo/import/${encodeURIComponent(id)}${query}`);
  },

  /** 中间产物清单与关联关系 */
  artifacts: (id: string) =>
    request<KimodoArtifactsResponse>(`/api/kimodo/animations/${encodeURIComponent(id)}/artifacts`),

  /** 产物文本内容（JSON 已格式化） */
  artifact: (id: string, key: string) =>
    request<KimodoArtifactContent>(
      `/api/kimodo/animations/${encodeURIComponent(id)}/artifact?key=${encodeURIComponent(key)}`,
    ),

  /** 提示词转译：中文描述 / 参考图片 → 英文动作提示词 */
  enhancePrompt: (body: { prompt: string; image?: string }) =>
    request<EnhancePromptResult>('/api/kimodo/enhance-prompt', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 拉取原始动作数据（Float32 小端） */
  async motion(id: string): Promise<{ root: Float32Array; rotations: Float32Array }> {
    const [rootResponse, rotationResponse] = await Promise.all([
      fetch(`/api/kimodo/animations/${encodeURIComponent(id)}/root.f32`),
      fetch(`/api/kimodo/animations/${encodeURIComponent(id)}/rotations.f32`),
    ]);
    if (!rootResponse.ok || !rotationResponse.ok) {
      throw new Error('动作数据读取失败');
    }
    return {
      root: new Float32Array(await rootResponse.arrayBuffer()),
      rotations: new Float32Array(await rotationResponse.arrayBuffer()),
    };
  },
};
