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
  /** 约束过渡 shim 路径，null 表示未配置 */
  conditionedShimExe: string | null;
  /** shim 可执行文件存在（= 真实 pose 约束过渡可用） */
  conditionedReady: boolean;
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

/**
 * conditioned（真实 pose 约束过渡）任务的约束来源与完整参数。
 * 与后端 meta.json 的 conditioned 字段一致，产物面板据此还原完整 f32 链路。
 */
export interface KimodoConditionedInfo {
  /** prev 约束来源动画 id */
  prevAnimationId?: string;
  /** next 约束来源动画 id */
  nextAnimationId?: string;
  /** 约束切片临时目录名（输出目录下 _constraints/<tag>） */
  constraintTag?: string;
  /** prev 尾部 root_positions.f32 绝对路径 */
  prevRootPath: string;
  /** prev 尾部 local_rotations_xyzw.f32 绝对路径 */
  prevRotPath: string;
  /** next 头部 root_positions.f32 绝对路径（平移前） */
  nextRootPath: string;
  /** next 头部 local_rotations_xyzw.f32 绝对路径 */
  nextRotPath: string;
  /** 有 rootDelta 时实际喂给 shim 的平移后 next root 文件 */
  nextRootShiftedPath?: string;
  /** 首尾各硬约束的帧数 */
  transitionFrames: number;
  /** 舞台位移（米，prev 局部坐标系） */
  rootDelta?: { dx: number; dz: number };
}

export interface KimodoAnimation {
  id: string;
  prompt: string;
  frames: number;
  steps: number;
  seed: number;
  status: KimodoStatusValue;
  error?: string;
  createdAt: number;
  /** 生成模式：text=纯文本，conditioned=真实 pose 约束过渡 */
  mode?: 'text' | 'conditioned';
  /** conditioned 任务的约束来源与参数 */
  conditioned?: KimodoConditionedInfo;
  /** 多段生成时的分段提示词与各自帧数 */
  segments?: KimodoPromptSegment[];
  durationMs?: number;
  /** 开始生成的时刻，用于计算进度 */
  startedAt?: number;
  /** 预计总耗时（毫秒） */
  etaMs?: number;
  /** 预计其中冷启动加载模型的耗时（毫秒），0 表示权重已驻留 */
  loadMs?: number;
  /** 用户给这条结果添加的注释 */
  note?: string;
}

/**
 * 真实 pose 约束过渡的请求体（推荐用 animationId 快捷方式）。
 *
 * 后端收到后会自动从两个 animationId 的输出目录切出 prev 尾部 / next 头部的 f32，
 * 喂给 conditioned shim 生成首尾精确对齐的过渡段。
 */
export interface KimodoConditionedBody {
  /** 前一段动画的 animationId（必须是 kimodo 生成的，才有原始 f32 可切） */
  prevAnimationId: string;
  /** 后一段动画的 animationId */
  nextAnimationId: string;
  /** 过渡段总帧数（8–300），决定中间过渡有多长 */
  frames: number;
  /** 首尾各硬约束多少帧，默认 1（只对齐 prev 末帧与 next 首帧） */
  transitionFrames?: number;
  /** DDIM 扩散步数，默认 50（条件生成需要更充分收敛） */
  steps?: number;
  /** 随机种子，不传则服务端随机 */
  seed?: number;
  /** 辅助提示词（英文，描述中间过渡的节奏/风格，如 "smooth walking forward"） */
  prompt: string;
  /**
   * 舞台位移（米，prev 局部坐标系），可选。
   *
   * 传了它，服务端会把 next 段约束的根位置平移到 `prev 末帧 + rootDelta`，
   * 于是首尾约束之间就存在真实距离，模型会生成带位移的过渡（走步/转身），
   * 而不是因为两段局部原点都在 0 附近而退化成原地动作。
   */
  rootDelta?: { dx: number; dz: number };
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

/** 产物分组：文本 / 约束输入 / 动作输出 / 导入 */
export type KimodoArtifactGroup = 'text' | 'constraint' | 'motion' | 'import';

export type KimodoArtifactKey =
  | 'prompt'
  | 'meta'
  | 'mixamo'
  | 'root'
  | 'rotations'
  | 'prev-root'
  | 'prev-rot'
  | 'next-root'
  | 'next-rot'
  | 'next-root-shifted';

/** 一次生成留下的中间产物 */
export interface KimodoArtifact {
  key: KimodoArtifactKey;
  label: string;
  /** 相对输出目录的路径（不在输出目录内时为绝对路径） */
  file: string;
  /** 绝对路径：.f32 无法预览，完整路径即排查信息 */
  absolutePath?: string;
  format: 'text' | 'json' | 'f32';
  size: number;
  exists: boolean;
  /** 二进制产物只展示信息，不可当文本查看 */
  viewable: boolean;
  description: string;
  group: KimodoArtifactGroup;
  /** f32 帧数 */
  frames?: number;
  /** f32 每帧字节数 */
  bytesPerFrame?: number;
  /** f32 数据形状，如 [60, 3] float32 */
  shape?: string;
  /** 来源说明：来自哪个动画、切出哪些帧 */
  source?: string;
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

/** conditioned 过渡的约束来源动画（prev 尾帧 / next 首帧） */
export interface KimodoArtifactSource {
  role: 'prev' | 'next';
  animationId: string;
  prompt: string | null;
  status: KimodoStatusValue | null;
  /** 源动画总帧数 */
  frames: number | null;
  /** 从该动画切出的约束帧区间 [start, end)，0 起 */
  sliceStart: number | null;
  sliceEnd: number | null;
}

export interface KimodoArtifactsResponse {
  task: KimodoAnimation;
  artifacts: KimodoArtifact[];
  relations: KimodoRelation[];
  /** conditioned 任务的 prev / next 来源动画；文本任务为空数组 */
  sources: KimodoArtifactSource[];
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

export interface RefinePromptBody {
  /** 修改后的中文动作链，按顺序 */
  steps: string[];
  objects?: string[];
  note?: string;
}

export interface RefinePromptResult {
  prompt: string;
  segments: string[];
  model: string;
}

export const kimodoApi = {
  status: () => request<KimodoStatus>('/api/kimodo/status'),

  skeleton: () => request<SomaSkeleton>('/api/kimodo/skeleton'),

  generate: (body: KimodoGenerateBody) =>
    request<KimodoAnimation>('/api/kimodo/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 真实 pose 约束的双向过渡生成（首尾帧精确对齐 prev 末 / next 首） */
  generateConditioned: (body: KimodoConditionedBody) =>
    request<KimodoAnimation>('/api/kimodo/generate-conditioned', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  animations: () => request<KimodoAnimation[]>('/api/kimodo/animations'),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/kimodo/animations/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** 添加/修改注释（传空字符串清除） */
  updateNote: (id: string, note: string) =>
    request<KimodoAnimation>(`/api/kimodo/animations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    }),

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

  /** 按修改后的动作拆解重新生成英文提示词与分段 */
  refinePrompt: (body: RefinePromptBody) =>
    request<RefinePromptResult>('/api/kimodo/refine-prompt', {
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
