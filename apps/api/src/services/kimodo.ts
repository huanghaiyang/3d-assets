import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { repoRoot } from '../lib/paths.js';
import { listProjects } from './animProjects.js';
import { promptEnhancerReady } from './promptEnhance.js';

const log = createLogger('kimodo');

/** 多段生成里的一段提示词 */
export interface KimodoPromptSegment {
  prompt: string;
  frames: number;
}

/** 单次生成的请求参数 */
export interface KimodoGenerateRequest {
  prompt: string;
  frames: number;
  steps: number;
  seed?: number;
  /** 首尾过渡帧，默认 5，与 kimodo.cpp 官方 demo 一致 */
  transitionFrames?: number;
  /**
   * 复合动作分段：按顺序生成并自动过渡（接近 / 施力 / 收势）。
   * 至少 2 段才生效，为空时退回单段 prompt。
   */
  segments?: KimodoPromptSegment[];
}

/**
 * 真实 pose 约束的双向过渡生成请求。
 *
 * 调用方（前端）需要把 prev / next 段的末帧 / 首帧写成 f32 文件
 * （root_positions.f32: [T_prev, 3] + local_rotations_xyzw.f32: [T_prev, 30, 4]），
 * 然后把它们的绝对路径传给这里。shim 会 encode → normalize → 双向构造
 * observed / observed_mask → DDIM 采样 → 硬约束覆盖 → decode → 输出标准 f32。
 */
export interface KimodoConditionedRequest {
  /** prev 段尾部的 root_positions.f32 绝对路径（至少 1 帧 = 12 字节） */
  prevRootPath: string;
  /** prev 段尾部的 local_rotations_xyzw.f32 绝对路径（至少 1 帧 = 480 字节） */
  prevRotPath: string;
  /** next 段头部的 root_positions.f32 绝对路径 */
  nextRootPath: string;
  /** next 段头部的 local_rotations_xyzw.f32 绝对路径 */
  nextRotPath: string;
  /**
   * 让 next 段约束整体平移的舞台位移（米），可选。
   *
   * 为什么需要：prev / next 两段的 root_positions 属于各自 Kimodo job 的局部坐标系，
   * 每个 job 都从自己的原点出发，所以 prev 末帧与 next 首帧通常都在原点附近。
   * 直接把这两个点当约束，模型看到的是「起点≈终点」，只会生成原地动作。
   *
   * 传入本字段后，服务层会把 next 的 root 整段平移到 `prev 末帧 + rootDelta`，
   * 于是在 observed 的 body[0..2]（根位置）里就编码了真实的跨越距离，
   * 模型必须生成带位移的动作才能同时满足首尾约束。
   */
  rootDelta?: { dx: number; dz: number };
  /** 过渡段总帧数（首尾帧精确对齐，中间 DDIM 生成） */
  frames: number;
  /** 约束帧数：首尾各约束这么多帧，默认 1（单帧对齐） */
  transitionFrames?: number;
  /** DDIM 扩散步数，默认 50（比文本 prompt 多，条件生成需要更充分收敛） */
  steps?: number;
  seed?: number;
  /** 辅助提示词（告诉模型中间过渡的节奏/风格） */
  prompt: string;
  /** prev 约束来源动画 id（路由走 animationId 快捷方式时填入，产物面板据此展示关联关系） */
  prevAnimationId?: string;
  /** next 约束来源动画 id */
  nextAnimationId?: string;
  /** 约束切片的临时目录名（输出目录下 _constraints/<tag>，走 animationId 快捷方式时由路由填入） */
  constraintTag?: string;
}

export type KimodoStatusValue = 'queued' | 'running' | 'ready' | 'failed';

/**
 * conditioned（真实 pose 约束过渡）任务的约束来源与完整参数。
 *
 * 为什么要落盘：过渡段生成后，产物面板需要还原「这段过渡是从哪两段动画的
 * 哪些帧切出来的、实际喂给 shim 的是哪几个 f32 文件」，否则只剩下一个结果目录，
 * 中间链路无法追查。写入 meta.json 后，服务重启也能完整展示。
 */
export interface KimodoConditionedInfo {
  /** prev 约束来源动画 id（走 animationId 快捷方式时才有） */
  prevAnimationId?: string;
  /** next 约束来源动画 id */
  nextAnimationId?: string;
  /** 约束切片的临时目录名（输出目录下 _constraints/<tag>） */
  constraintTag?: string;
  /** prev 尾部 root_positions.f32 绝对路径 */
  prevRootPath: string;
  /** prev 尾部 local_rotations_xyzw.f32 绝对路径 */
  prevRotPath: string;
  /** next 头部 root_positions.f32 绝对路径（平移前的原始约束） */
  nextRootPath: string;
  /** next 头部 local_rotations_xyzw.f32 绝对路径 */
  nextRotPath: string;
  /** 有 rootDelta 时，实际喂给 shim 的平移后 next root 文件 */
  nextRootShiftedPath?: string;
  /** 首尾各硬约束的帧数 */
  transitionFrames: number;
  /** 舞台位移（米，prev 局部坐标系） */
  rootDelta?: { dx: number; dz: number };
}

/** 一条生成任务（持久化到 <outputDir>/<id>/meta.json） */
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
  /** conditioned 任务的约束来源与参数（其他模式不写） */
  conditioned?: KimodoConditionedInfo;
  /** 多段生成时的分段提示词与各自帧数（单段任务不写） */
  segments?: KimodoPromptSegment[];
  /** 生成耗时（毫秒），完成后写入 */
  durationMs?: number;
  /** 开始生成的时刻（进入 running 时写入），供前端计算进度 */
  startedAt?: number;
  /** 预计总耗时（毫秒），由帧数、步数与实测速率估算 */
  etaMs?: number;
  /** 其中估算的冷启动模型加载耗时（毫秒），权重已驻留时为 0 */
  loadMs?: number;
  /** 用户给这条结果添加的注释（用于标记动作用途、候选编号等） */
  note?: string;
}

export interface KimodoStatus {
  /** .env 里的可执行文件 / 模型是否齐备 */
  ready: boolean;
  /** 生成器进程是否存活（首次生成时懒启动） */
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
  /** 约束过渡 shim 路径，null 表示未配置（回退到旧版文本 prompt） */
  conditionedShimExe: string | null;
  /** shim 可执行文件存在 */
  conditionedReady: boolean;
  /** 提示词转译厂商（deepseek / openai / qwen / ...） */
  promptProvider: string;
  /** 厂商显示名（前端展示用） */
  promptProviderLabel: string;
  /** 纯文字转译模型名 */
  promptModel: string;
  /** 带参考图时使用的视觉模型名 */
  promptVisionModel: string;
  /** 提示词模型是否可用（Key、接口地址、模型名齐全） */
  promptModelReady: boolean;
  /** 配置或运行期的错误说明 */
  error: string | null;
}

/** 产物分组：前端按组展示，避免文本 / 约束 / 输出 / 导入混在一起 */
export type KimodoArtifactGroup = 'text' | 'constraint' | 'motion' | 'import';

/** 一次生成留下的中间产物（保留在输出目录里，可查看） */
export interface KimodoArtifact {
  key: KimodoArtifactKey;
  label: string;
  /** 相对输出目录的路径（不在输出目录内时退化为绝对路径） */
  file: string;
  /** 绝对路径：.f32 无法预览，完整路径本身就是排查信息 */
  absolutePath?: string;
  format: 'text' | 'json' | 'f32';
  size: number;
  exists: boolean;
  /** 是否可当作文本查看（.f32 为二进制） */
  viewable: boolean;
  description: string;
  group: KimodoArtifactGroup;
  /** f32 帧数（按文件字节数与每帧布局反推） */
  frames?: number;
  /** f32 每帧字节数 */
  bytesPerFrame?: number;
  /** f32 数据形状，如 [60, 3] float32 / [60, 30, 4] float32 */
  shape?: string;
  /** 来源说明：来自哪个动画、切出哪些帧 */
  source?: string;
}

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

/** 产物关联到的项目（关联关系） */
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
  /** 源动画总帧数（按 root_positions.f32 字节数反推） */
  frames: number | null;
  /** 从该动画切出的约束帧区间 [start, end)，0 起 */
  sliceStart: number | null;
  sliceEnd: number | null;
}

/** 可文本查看的产物 key（其余为 .f32 二进制） */
export type KimodoArtifactTextKey = 'prompt' | 'meta' | 'mixamo';

export interface KimodoArtifactContent {
  key: KimodoArtifactTextKey;
  file: string;
  format: 'text' | 'json';
  size: number;
  text: string;
  truncated: boolean;
}

/** 默认「帧 × 步」单个单位的生成耗时（毫秒），实测约 60 帧 / 10 步 ≈ 50s */
const DEFAULT_MS_PER_UNIT = 100;
/** 冷启动时加载模型权重的估算耗时（毫秒） */
const COLD_LOAD_MS = 25_000;

/**
 * Kimodo 文生动作服务。
 *
 * 直接以 `--server` 模式驱动 kmd-generate：一个常驻子进程，通过 stdin 写入一行
 * 制表符分隔的请求（过渡帧 / 扩散步数 / 随机种子 / 输出目录，随后每段「帧数 + 提示词文件」），
 * stdout 回复一行 `OK` 或 `ERR\t原因`。生成结果写到输出目录：
 *   - root_positions.f32        [FRAMES, 3]
 *   - local_rotations_xyzw.f32  [FRAMES, 30, 4]
 *
 * 同一时间只跑一个任务（CPU 推理本来就是单线程瓶颈），其余排队。
 */
class KimodoService {
  // --- text prompt session ---
  private session: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private pendingLines: string[] = [];
  private lineWaiters: Array<(line: string | null) => void> = [];
  private stderrTail: string[] = [];
  private weightsLoaded = false;

  // --- conditioned (真实 pose 约束) session ---
  // 与 text session 结构完全对称，独立维护一套子进程 / stdout 缓冲 / 行等待队列，
  // 因为两者命令行协议不同（shim 不走 --server、不接受分段），不能复用同一个进程。
  private conditionedSession: ChildProcessWithoutNullStreams | null = null;
  private conditionedStdoutBuffer = '';          // stdout 字节流缓冲（凑齐一行再派发）
  private conditionedPendingLines: string[] = []; // 没有等待者时暂存的已读行
  private conditionedLineWaiters: Array<(line: string | null) => void> = []; // 等待下一行响应的 Promise 回调
  private conditionedStderrTail: string[] = [];   // 最近 30 条 stderr，用于排错
  private conditionedWeightsLoaded = false;        // 模型权重是否已加载（冷启动耗时估算用）

  // --- 全局状态（两个 session 共享同一套队列和计数器） ---
  // 为什么两个 session 独立却共享一个 queue？
  //   text 与 conditioned 是两个不同的子进程，理论上可以并行；但它们加载的是同一份
  //   动作模型权重 + 同一个 Vulkan/CPU 后端，同时跑会争抢显存/算力导致 OOM 或速度骤降。
  //   因此用一条全局 Promise 链把所有任务（不管走哪个 session）串行化，同一时间只跑一条。
  private busy = false;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private lastError: string | null = null;
  /** 每「帧 × 步」单位的实测耗时（毫秒），随成功任务自适应修正 */
  private msPerUnit = DEFAULT_MS_PER_UNIT;
  private readonly jobs = new Map<string, KimodoAnimation>();

  get outputDir(): string {
    return config.kimodo.outputDir;
  }

  get isRunning(): boolean {
    return this.session !== null || this.conditionedSession !== null;
  }

  /** 检查 .env 配置是否齐备，返回缺失项说明 */
  private validate(): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    const { generatorExe, motionModel, textBundle } = config.kimodo;
    if (!generatorExe) missing.push('KIMODO_GENERATE_EXE（生成器可执行文件）');
    else if (!fs.existsSync(generatorExe)) missing.push(`KIMODO_GENERATE_EXE 指向的文件不存在：${generatorExe}`);
    if (!motionModel) missing.push('KIMODO_MOTION_MODEL（动作模型 GGUF）');
    else if (!fs.existsSync(motionModel)) missing.push(`KIMODO_MOTION_MODEL 指向的文件不存在：${motionModel}`);
    if (!textBundle) missing.push('KIMODO_TEXT_BUNDLE（文本编码器 GGUF）');
    else if (!fs.existsSync(textBundle)) missing.push(`KIMODO_TEXT_BUNDLE 指向的文件不存在：${textBundle}`);
    return { ok: missing.length === 0, missing };
  }

  status(): KimodoStatus {
    const check = this.validate();
    const conditionedShimExe = config.kimodo.conditionedShimExe;
    const conditionedReady = !!conditionedShimExe && fs.existsSync(conditionedShimExe);
    return {
      ready: check.ok,
      running: this.isRunning,
      busy: this.busy,
      queued: this.pending,
      generatorExe: config.kimodo.generatorExe,
      motionModel: config.kimodo.motionModel,
      textBundle: config.kimodo.textBundle,
      outputDir: this.outputDir,
      backend: config.kimodo.backend,
      conditionedShimExe,
      conditionedReady,
      promptProvider: config.kimodo.promptProvider,
      promptProviderLabel: config.kimodo.promptProviderLabel,
      promptModel: config.kimodo.promptModel,
      promptVisionModel: config.kimodo.promptVisionModel,
      promptModelReady: promptEnhancerReady(),
      error: check.ok ? this.lastError : check.missing.join('；'),
    };
  }

  /**
   * 提交一次生成：只做参数规整与入队，真正的推理在后台串行执行。
   *
   * - 单段帧数限制在 8–300，多段总帧数最多 900，避免一次任务占满 CPU 太久；
   * - 种子必须为正整数，传 0 / 留空时服务端自己掷一个，保证结果可复现；
   * - 任务先落盘再排队，服务重启后能立刻从 meta.json 恢复出「排队中」状态。
   */
  submit(request: KimodoGenerateRequest): KimodoAnimation {
    const check = this.validate();
    if (!check.ok) throw new Error(`Kimodo 未正确配置：${check.missing.join('；')}`);

    const segments = (request.segments ?? [])
      .map((segment) => ({
        prompt: segment.prompt.trim(),
        frames: Math.max(8, Math.min(300, Math.round(segment.frames) || 0)),
      }))
      .filter((segment) => segment.prompt.length > 0)
      .slice(0, 6);
    const multi = segments.length >= 2;
    const totalFrames = multi
      ? Math.min(900, segments.reduce((sum, segment) => sum + segment.frames, 0))
      : Math.max(8, Math.min(300, Math.round(request.frames)));

    const job: KimodoAnimation = {
      id: Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-6),
      prompt: multi ? segments.map((segment) => segment.prompt).join(' → ') : request.prompt,
      frames: totalFrames,
      steps: Math.max(1, Math.round(request.steps)),
      seed: request.seed && request.seed > 0 ? Math.round(request.seed) : Math.floor(Math.random() * 1e9),
      status: 'queued',
      createdAt: Date.now(),
    };
    if (multi) job.segments = segments;
    this.jobs.set(job.id, job);
    this.persist(job);
    this.pending += 1;

    this.queue = this.queue.then(() => this.run(job, request.transitionFrames ?? 5)).catch(() => void 0);
    return job;
  }

  /**
   * 执行一次生成（由队列串行调用）。
   *
   * 与生成器的交互只有一问一答：写入一行请求，读回一行 `OK` / `ERR\t原因`。
   * 请求行按 TAB 分成 4 段固定头（过渡帧、扩散步数、随机种子、输出目录），
   * 之后每段追加「帧数 + 提示词文件」，单段任务就是一组、复合动作可多组。
   * 生成期间没有任何进度回传，所以进度条用「帧数 × 步数 × 实测速率」估算，
   * 每完成一个任务就用真实耗时反向校正 msPerUnit，下一次估算会更准。
   */
  private async run(job: KimodoAnimation, transitionFrames: number): Promise<void> {
    this.pending = Math.max(0, this.pending - 1);
    this.busy = true;
    const startedAt = Date.now();
    const units = Math.max(1, job.frames * job.steps);
    const loadMs = this.weightsLoaded ? 0 : COLD_LOAD_MS;
    job.status = 'running';
    job.startedAt = startedAt;
    job.loadMs = loadMs;
    job.etaMs = Math.round(units * this.msPerUnit + loadMs);
    this.persist(job);
    try {
      const dir = path.join(this.outputDir, job.id);
      fs.mkdirSync(dir, { recursive: true });
      // 单段与多段共用同一套协议：每段一个文本文件，按顺序拼到请求行里
      const segments = job.segments?.length ? job.segments : [{ prompt: job.prompt, frames: job.frames }];
      const fields: (string | number)[] = [transitionFrames, job.steps, job.seed, dir];
      segments.forEach((segment, index) => {
        const promptPath = path.join(dir, `segment-${String(index + 1).padStart(2, '0')}.txt`);
        fs.writeFileSync(promptPath, segment.prompt, 'utf8');
        fields.push(segment.frames, promptPath);
      });

      const session = this.ensureSession();
      const line = fields.join('\t');
      log.info(
        `生成 ${job.id}：${job.frames} 帧 / ${job.steps} 步 / ${segments.length} 段，seed=${job.seed}`,
      );
      session.stdin.write(`${line}\n`);

      // CPU 推理较慢，给足 30 分钟；超时视为进程卡死
      const response = await this.nextLine(30 * 60 * 1000);
      if (response === null) throw new Error('生成器无响应（超时）');
      const trimmed = response.trim();
      if (trimmed.startsWith('ERR\t')) throw new Error(trimmed.slice(4));
      if (!trimmed.startsWith('OK')) throw new Error(`生成器返回异常：${trimmed.slice(0, 200)}`);

      const rootPath = path.join(dir, 'root_positions.f32');
      const rotPath = path.join(dir, 'local_rotations_xyzw.f32');
      if (!fs.existsSync(rootPath) || !fs.existsSync(rotPath)) {
        throw new Error('生成器未输出动作数据文件');
      }
      job.status = 'ready';
      job.error = undefined;
      this.lastError = null;
      // 用本次实测（扣掉冷启动加载）修正后续任务的估算速率
      const samplingMs = Math.max(1, Date.now() - startedAt - loadMs);
      this.msPerUnit = Math.min(500, Math.max(10, samplingMs / units));
      this.weightsLoaded = true;
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      this.lastError = job.error;
      log.error(`生成 ${job.id} 失败：${job.error}`);
      // 子进程可能已经崩溃，直接丢弃，下次生成会重新拉起
      this.killSession();
    } finally {
      job.durationMs = Date.now() - startedAt;
      this.busy = false;
      this.persist(job);
    }
  }

  // ---------------------------------------------------------------- 子进程

  /**
   * 确保常驻生成器进程存在（首次生成时懒启动）。
   *
   * 启动参数固定为 `--server <动作模型 GGUF> <文本编码器 GGUF>`，之后所有任务复用
   * 同一个进程，模型权重只加载一次。Windows 上 ggml 的 DLL 必须能从 PATH 找到，
   * 所以这里会把可执行文件周边含 .dll 的目录拼到 PATH 前面。
   */
  private ensureSession(): ChildProcessWithoutNullStreams {
    if (this.session) return this.session;

    const { generatorExe, motionModel, textBundle, backend, textLayerChunk } = config.kimodo;
    if (!generatorExe || !motionModel || !textBundle) {
      throw new Error('Kimodo 未配置（KIMODO_GENERATE_EXE / KIMODO_MOTION_MODEL / KIMODO_TEXT_BUNDLE）');
    }

    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const dllDirs = this.collectDllDirs(generatorExe);
    env[pathKey] = [...dllDirs, env[pathKey] ?? ''].filter(Boolean).join(path.delimiter);
    env.KIMODO_BACKEND = backend;
    env.KIMODO_TEXT_RESIDENT_LIMIT_MIB = env.KIMODO_TEXT_RESIDENT_LIMIT_MIB ?? '10000';
    if (textLayerChunk) env.KIMODO_TEXT_LAYER_CHUNK = textLayerChunk;

    log.info(`拉起生成器：${generatorExe} --server ${motionModel} ${textBundle}`);
    const child = spawn(generatorExe, ['--server', motionModel, textBundle], {
      cwd: path.dirname(generatorExe),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.session = child;
    this.stdoutBuffer = '';
    this.pendingLines = [];
    this.stderrTail = [];

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
      log.warn(`[kmd-generate] ${text}`);
    });
    child.on('exit', (code) => {
      if (this.session === child) {
        this.session = null;
        // 进程没了，权重也随之释放，下次生成重新计入冷启动耗时
        this.weightsLoaded = false;
        // 唤醒所有等待者，让挂起的任务立刻失败而不是死等
        for (const wake of this.lineWaiters.splice(0)) wake(null);
        this.pendingLines = [];
      }
      log.warn(`生成器退出，code=${code}${this.stderrTail.length ? `，stderr 末尾：${this.stderrTail.at(-1)}` : ''}`);
    });
    child.on('error', (err) => {
      this.lastError = `启动生成器失败：${err.message}`;
      log.error(this.lastError);
    });
    return child;
  }

  /** 可执行文件所在的目录与其相邻的 DLL 目录都要进 PATH，否则 Windows 上加载 ggml 会失败 */
  private collectDllDirs(exePath: string): string[] {
    const dirs: string[] = [];
    const exeDir = path.dirname(exePath);
    dirs.push(exeDir);
    const hasDll = (dir: string): boolean => {
      try {
        return fs.readdirSync(dir).some((name) => name.toLowerCase().endsWith('.dll'));
      } catch {
        return false;
      }
    };
    // 从可执行文件目录向上找 3 层，把含 dll 的子目录（含再下一层）加入 PATH
    let current = exeDir;
    for (let depth = 0; depth < 3; depth += 1) {
      current = path.dirname(current);
      if (!current || current.length < 3) break;
      let entries: string[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        break;
      }
      for (const name of entries) {
        const dir = path.join(current, name);
        if (hasDll(dir)) dirs.push(dir);
        else {
          try {
            for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
              if (sub.isDirectory() && hasDll(path.join(dir, sub.name))) dirs.push(path.join(dir, sub.name));
            }
          } catch {
            /* 无权限等，忽略 */
          }
        }
      }
    }
    return [...new Set(dirs)];
  }

  /**
   * 把 stdout 的字节流切成整行，交给等待者。
   *
   * 生成器可能一次吐出多行，也可能一行被拆成多个 chunk，因此必须缓冲到出现 `\n`
   * 才算一条响应；没有等待者时先存进 pendingLines，避免响应丢失。
   */
  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      const waiter = this.lineWaiters.shift();
      if (waiter) waiter(line);
      else this.pendingLines.push(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  /**
   * 等待生成器回一行。超时返回 null（由调用方当成失败处理）；
   * 子进程退出时会被 exit 回调以 null 唤醒，避免任务永远挂着。
   */
  private nextLine(timeoutMs: number): Promise<string | null> {
    if (this.pendingLines.length > 0) return Promise.resolve(this.pendingLines.shift() ?? '');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const at = this.lineWaiters.indexOf(finish);
        if (at >= 0) this.lineWaiters.splice(at, 1);
        finish(null);
      }, timeoutMs);
      this.lineWaiters.push(finish);
    });
  }

  private killSession(): void {
    const child = this.session;
    this.session = null;
    this.weightsLoaded = false;
    if (child) this.terminateChild(child);
  }

  private killConditionedSession(): void {
    const child = this.conditionedSession;
    this.conditionedSession = null;
    this.conditionedWeightsLoaded = false;
    if (child) this.terminateChild(child);
  }

  /** 通用兜底：kill + Windows taskkill /F /T 防止子线程残留 */
  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
  }

  shutdown(): void {
    this.killSession();
    this.killConditionedSession();
  }

  // ---------------------------------------------------------- conditioned shim 子进程

  /**
   * 确保 conditioned shim（真实 pose 约束过渡）进程存在。
   *
   * 与 ensureSession 的差异：
   *   - 命令行：shim 直接接受 GGUF 路径作为 args（不走 `--server`）
   *   - 不设 KIMODO_BACKEND 环境变量（shim 不依赖）
   *   - 其他（collectDllDirs、PATH 拼接、stdio 管道、stdout 行协议）与 text 版本完全一致，
   *     因为两者输出都是 root_positions.f32 + local_rotations_xyzw.f32。
   */
  private ensureConditionedSession(): ChildProcessWithoutNullStreams {
    if (this.conditionedSession) return this.conditionedSession;

    const shimExe = config.kimodo.conditionedShimExe;
    const { motionModel, textBundle } = config.kimodo;
    if (!shimExe || !motionModel || !textBundle) {
      throw new Error('Kimodo conditioned shim 未配置（KIMODO_CONDITIONED_SHIM / KIMODO_MOTION_MODEL / KIMODO_TEXT_BUNDLE）');
    }

    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const dllDirs = this.collectDllDirs(shimExe);
    env[pathKey] = [...dllDirs, env[pathKey] ?? ''].filter(Boolean).join(path.delimiter);
    // 不设 KIMODO_BACKEND / KIMODO_TEXT_RESIDENT_LIMIT_MIB —— shim 有自己的默认值

    log.info(`拉起 conditioned shim：${shimExe} ${motionModel} ${textBundle}`);
    const child = spawn(shimExe, [motionModel, textBundle], {
      cwd: path.dirname(shimExe),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.conditionedSession = child;
    this.conditionedStdoutBuffer = '';
    this.conditionedPendingLines = [];
    this.conditionedStderrTail = [];

    child.stdout.on('data', (chunk: Buffer) => this.onConditionedStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.conditionedStderrTail.push(text);
      if (this.conditionedStderrTail.length > 30) this.conditionedStderrTail.shift();
      log.warn(`[kmd-conditioned] ${text}`);
    });
    child.on('exit', (code) => {
      if (this.conditionedSession === child) {
        this.conditionedSession = null;
        this.conditionedWeightsLoaded = false;
        for (const wake of this.conditionedLineWaiters.splice(0)) wake(null);
        this.conditionedPendingLines = [];
      }
      log.warn(`conditioned shim 退出，code=${code}${this.conditionedStderrTail.length ? `，stderr 末尾：${this.conditionedStderrTail.at(-1)}` : ''}`);
    });
    child.on('error', (err) => {
      this.lastError = `启动 conditioned shim 失败：${err.message}`;
      log.error(this.lastError);
    });
    return child;
  }

  /** conditioned shim stdout 行切分（与 onStdout 完全同构，只是作用在 conditioned 成员上） */
  private onConditionedStdout(chunk: Buffer): void {
    this.conditionedStdoutBuffer += chunk.toString();
    let index = this.conditionedStdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.conditionedStdoutBuffer.slice(0, index);
      this.conditionedStdoutBuffer = this.conditionedStdoutBuffer.slice(index + 1);
      const waiter = this.conditionedLineWaiters.shift();
      if (waiter) waiter(line);
      else this.conditionedPendingLines.push(line);
      index = this.conditionedStdoutBuffer.indexOf('\n');
    }
  }

  /** 等待 conditioned shim 回一行（超时返回 null；exit 时被 exit 回调以 null 唤醒） */
  private nextConditionedLine(timeoutMs: number): Promise<string | null> {
    if (this.conditionedPendingLines.length > 0) {
      return Promise.resolve(this.conditionedPendingLines.shift() ?? '');
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const at = this.conditionedLineWaiters.indexOf(finish);
        if (at >= 0) this.conditionedLineWaiters.splice(at, 1);
        finish(null);
      }, timeoutMs);
      this.conditionedLineWaiters.push(finish);
    });
  }

  /**
   * 提交一次「真实 pose 约束的双向过渡」生成：只做参数规整与入队，
   * 真正的推理在后台串行执行（与 text 任务共享同一 queue）。
   *
   * 四个 f32 文件必须提前由调用方写好（一般是前端把上一段尾部 / 下一段头部
   * 各截几帧，用 Blob 写到本地临时目录），这里只校验路径存在性，不再做二次加工。
   */
  submitConditioned(req: KimodoConditionedRequest): KimodoAnimation {
    const shimExe = config.kimodo.conditionedShimExe;
    if (!shimExe || !fs.existsSync(shimExe)) {
      throw new Error('Kimodo conditioned shim 未配置或不存在（KIMODO_CONDITIONED_SHIM）');
    }

    // 校验四个 f32 约束文件
    const requiredFiles: Array<[string, string]> = [
      ['prevRootPath', 'prev 段尾部 root_positions.f32'],
      ['prevRotPath', 'prev 段尾部 local_rotations_xyzw.f32'],
      ['nextRootPath', 'next 段头部 root_positions.f32'],
      ['nextRotPath', 'next 段头部 local_rotations_xyzw.f32'],
    ];
    for (const [key, label] of requiredFiles) {
      const value = (req as unknown as Record<string, string>)[key];
      if (!value || typeof value !== 'string' || !fs.existsSync(value)) {
        throw new Error(`约束文件 ${label} 不存在：${value ?? '(未提供)'}`);
      }
    }

    // 参数二次夹紧（路由层已校验过，但 service 层作为最终防线再夹一次）
    // frames: 8~300，同文本生成
    const frames = Math.max(8, Math.min(300, Math.round(req.frames) || 0));
    // transitionFrames: 1 ~ floor(frames/2)
    //   上限设为总帧的一半，避免约束帧占比过高导致生成结果被「钉死」、中间没空间过渡
    const transitionFrames = Math.max(1, Math.min(Math.floor(frames / 2), Math.round(req.transitionFrames ?? 1) || 1));
    // steps: 至少 1 步；默认 50（条件生成需要比文本更充分收敛）
    const steps = Math.max(1, Math.round(req.steps ?? 50) || 50);
    // seed: 正整数才用，否则随机一个 0~1e9
    const seed = req.seed && req.seed > 0 ? Math.round(req.seed) : Math.floor(Math.random() * 1e9);
    const prompt = (req.prompt ?? '').trim();
    if (!prompt) throw new Error('辅助提示词不能为空');

    const job: KimodoAnimation = {
      id: Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-6),
      prompt,
      frames,
      steps,
      seed,
      mode: 'conditioned',
      conditioned: {
        prevAnimationId: req.prevAnimationId,
        nextAnimationId: req.nextAnimationId,
        constraintTag: req.constraintTag,
        prevRootPath: req.prevRootPath,
        prevRotPath: req.prevRotPath,
        nextRootPath: req.nextRootPath,
        nextRotPath: req.nextRotPath,
        transitionFrames,
        rootDelta: req.rootDelta,
      },
      status: 'queued',
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    this.pending += 1;

    // 挂到全局 queue 尾部：与 text 任务串行执行，避免两个子进程同时抢 GPU
    this.queue = this.queue.then(() => this.runConditioned(job, { ...req, frames, transitionFrames, steps, seed, prompt })).catch(() => void 0);
    return job;
  }

  /**
   * 把 next 段的 root_positions 整段平移，使其首帧正好落在 `prev 末帧 + delta`。
   *
   * 为什么是「prev 末帧 + delta」而不是「next 首帧 + delta」：
   * shim 的约束是「起始位置 = observed 第一帧、结束位置 = observed 最后一帧」，
   * 过渡段自身的位移量 = 结束位置 - 起始位置。要让这段位移恰好等于 delta，
   * 就必须把 next 挪到 prev 末帧 + delta，即偏移量 = delta + (prev末 - next首)。
   * 两段各自都在原点附近时这一项接近 0，但 prev 走得很远时需要它来消除跳变。
   *
   * root_positions.f32 布局：每帧 3 个 float32（x, y, z），共 12 字节；
   * 只平移 x / z（水平面），保留 y（身高），局部旋转不受根平移影响所以无需改动。
   */
  private shiftNextRoot(
    dir: string,
    prevRootPath: string,
    nextRootPath: string,
    delta: { dx: number; dz: number },
  ): string {
    const prevBuf = fs.readFileSync(prevRootPath);
    const nextBuf = fs.readFileSync(nextRootPath);
    const prevFrames = Math.floor(prevBuf.length / 12);
    const nextFrames = Math.floor(nextBuf.length / 12);
    // 文件为空或长度不合法时放弃平移，避免写坏约束
    if (prevFrames < 1 || nextFrames < 1) return nextRootPath;

    const tail = (prevFrames - 1) * 12;
    const prevX = prevBuf.readFloatLE(tail);
    const prevZ = prevBuf.readFloatLE(tail + 8);
    const nextX = nextBuf.readFloatLE(0);
    const nextZ = nextBuf.readFloatLE(8);

    const offsetX = delta.dx + (prevX - nextX);
    const offsetZ = delta.dz + (prevZ - nextZ);

    const shifted = Buffer.from(nextBuf);
    for (let frame = 0; frame < nextFrames; frame += 1) {
      const base = frame * 12;
      shifted.writeFloatLE(shifted.readFloatLE(base) + offsetX, base);
      shifted.writeFloatLE(shifted.readFloatLE(base + 8) + offsetZ, base + 8);
    }
    const out = path.join(dir, 'next_root_shifted.f32');
    fs.writeFileSync(out, shifted);
    return out;
  }

  /**
   * 执行一次 conditioned shim 生成（由队列串行调用）。
   *
   * 协议行（TAB 分隔）：
   *   CONDITIONED<T>STEPS<T>SEED<T>OUTPUT_DIR<T>PREV_ROOT<T>PREV_ROT
   *     <T>NEXT_ROOT<T>NEXT_ROT<T>TRANSITION_FRAMES<T>TOTAL_FRAMES<T>PROMPT.txt
   *
   * shim 输出到 OUTPUT_DIR：root_positions.f32 + local_rotations_xyzw.f32，
   * 格式与 text 生成完全一致，后续 persist / readMotion / importKimodoAnimation 等
   * 全部复用现有基础设施。
   */
  private async runConditioned(
    job: KimodoAnimation,
    req: KimodoConditionedRequest & { frames: number; transitionFrames: number; steps: number; seed: number; prompt: string },
  ): Promise<void> {
    this.pending = Math.max(0, this.pending - 1);
    this.busy = true;
    const startedAt = Date.now();
    const units = Math.max(1, job.frames * job.steps);
    const loadMs = this.conditionedWeightsLoaded ? 0 : COLD_LOAD_MS;
    job.status = 'running';
    job.startedAt = startedAt;
    job.loadMs = loadMs;
    job.etaMs = Math.round(units * this.msPerUnit + loadMs);
    this.persist(job);
    try {
      const dir = path.join(this.outputDir, job.id);
      fs.mkdirSync(dir, { recursive: true });
      const promptPath = path.join(dir, 'prompt.txt');
      fs.writeFileSync(promptPath, req.prompt, 'utf8');

      // 有舞台位移时，把 next 段约束平移到 prev 末帧 + rootDelta，
      // 让首尾约束本身携带跨越距离，模型才会生成带位移的过渡而不是原地踏步
      const nextRootPath = req.rootDelta
        ? this.shiftNextRoot(dir, req.prevRootPath, req.nextRootPath, req.rootDelta)
        : req.nextRootPath;
      // 落盘实际生效的约束文件：产物面板需要区分「原始 next 约束」与「平移后约束」
      if (job.conditioned && nextRootPath !== req.nextRootPath) {
        job.conditioned.nextRootShiftedPath = nextRootPath;
      }

      // 协议行（TAB 分隔），与 shim main.cpp 解析顺序严格一一对应：
      //   0: CONDITIONED       命令字（shim 用它区分协议分支）
      //   1: steps             DDIM 扩散步数
      //   2: seed              随机种子
      //   3: dir               输出目录（shim 写 root_positions.f32 + local_rotations_xyzw.f32）
      //   4: prevRootPath      prev 段尾部 root f32
      //   5: prevRotPath       prev 段尾部 rotation f32
      //   6: nextRootPath      next 段头部 root f32
      //   7: nextRotPath       next 段头部 rotation f32
      //   8: transitionFrames  首尾各约束多少帧
      //   9: frames            过渡段总帧数
      //  10: promptPath        辅助提示词文本文件路径
      const fields: (string | number)[] = [
        'CONDITIONED',
        req.steps,
        req.seed,
        dir,
        req.prevRootPath,
        req.prevRotPath,
        nextRootPath,
        req.nextRotPath,
        req.transitionFrames,
        req.frames,
        promptPath,
      ];
      const line = fields.join('\t');
      const session = this.ensureConditionedSession();

      log.info(
        `conditioned 生成 ${job.id}：${job.frames} 帧 / ${req.steps} 步 / 约束 ${req.transitionFrames} 帧，seed=${req.seed}`,
      );
      session.stdin.write(`${line}\n`);

      const response = await this.nextConditionedLine(30 * 60 * 1000);
      if (response === null) throw new Error('conditioned shim 无响应（超时）');
      const trimmed = response.trim();
      if (trimmed.startsWith('ERR\t')) throw new Error(trimmed.slice(4));
      if (!trimmed.startsWith('OK')) throw new Error(`conditioned shim 返回异常：${trimmed.slice(0, 200)}`);

      const rootPath = path.join(dir, 'root_positions.f32');
      const rotPath = path.join(dir, 'local_rotations_xyzw.f32');
      if (!fs.existsSync(rootPath) || !fs.existsSync(rotPath)) {
        throw new Error('conditioned shim 未输出动作数据文件');
      }
      job.status = 'ready';
      job.error = undefined;
      this.lastError = null;
      const samplingMs = Math.max(1, Date.now() - startedAt - loadMs);
      this.msPerUnit = Math.min(500, Math.max(10, samplingMs / units));
      this.conditionedWeightsLoaded = true;
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      this.lastError = job.error;
      log.error(`conditioned 生成 ${job.id} 失败：${job.error}`);
      this.killConditionedSession();
    } finally {
      job.durationMs = Date.now() - startedAt;
      this.busy = false;
      this.persist(job);
    }
  }

  // ---------------------------------------------------------------- 任务持久化

  private metaPath(id: string): string {
    return path.join(this.outputDir, id, 'meta.json');
  }

  private persist(job: KimodoAnimation): void {
    try {
      const dir = path.join(this.outputDir, job.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.metaPath(job.id), JSON.stringify(job, null, 2), 'utf8');
    } catch (err) {
      log.warn(`写入任务元数据失败：${(err as Error).message}`);
    }
  }

  /** 内存中的任务 + 磁盘上历史任务（服务重启后仍可导入） */
  list(): KimodoAnimation[] {
    const items = new Map<string, KimodoAnimation>();
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.outputDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    for (const id of entries) {
      const fromDisk = this.readMeta(id);
      if (!fromDisk) continue;
      // 服务重启后磁盘上仍标记为排队/生成中的任务已经不可能继续，改为失败，
      // 否则前端会一直显示一条停在 99% 的进度条
      if (!this.jobs.has(id) && (fromDisk.status === 'queued' || fromDisk.status === 'running')) {
        fromDisk.status = 'failed';
        fromDisk.error = '服务重启，任务已中断';
        this.persist(fromDisk);
      }
      items.set(id, fromDisk);
    }
    for (const [id, job] of this.jobs) items.set(id, job);
    return [...items.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private readMeta(id: string): KimodoAnimation | null {
    if (!/^[0-9a-zA-Z._-]+$/.test(id)) return null;
    try {
      const raw = fs.readFileSync(this.metaPath(id), 'utf8');
      const parsed = JSON.parse(raw) as KimodoAnimation;
      if (!parsed || typeof parsed.id !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  get(id: string): KimodoAnimation | null {
    return this.jobs.get(id) ?? this.readMeta(id);
  }

  /** 更新某条结果的注释并落盘（空字符串表示清除注释） */
  updateNote(id: string, note: string): KimodoAnimation | null {
    const job = this.get(id);
    if (!job) return null;
    job.note = note.trim() || undefined;
    this.persist(job);
    return job;
  }

  /** 读取动作数据文件（root_positions.f32 / local_rotations_xyzw.f32） */
  readMotion(id: string, kind: 'root' | 'rotations'): Buffer | null {
    if (!/^[0-9a-zA-Z._-]+$/.test(id)) return null;
    const file = path.join(this.outputDir, id, kind === 'root' ? 'root_positions.f32' : 'local_rotations_xyzw.f32');
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  motionDir(id: string): string | null {
    if (!/^[0-9a-zA-Z._-]+$/.test(id)) return null;
    return path.join(this.outputDir, id);
  }

  // ---------------------------------------------------------------- 中间产物

  /** Mixamo 转换结果文件（导入到新建动画后才会生成） */
  private mixamoFile(id: string): string {
    return path.join(this.outputDir, 'mixamo', `${id}.json`);
  }

  /** 相对输出目录的路径；不在输出目录内时原样返回绝对路径 */
  private relativeOutputPath(target: string): string {
    const rel = path.relative(this.outputDir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return target;
    return rel.split(path.sep).join('/');
  }

  /** 通用产物：文本 / JSON 只看体积与是否存在 */
  private baseArtifact(
    key: KimodoArtifactKey,
    label: string,
    target: string,
    format: 'text' | 'json' | 'f32',
    description: string,
    group: KimodoArtifactGroup,
    extra: Partial<KimodoArtifact> = {},
  ): KimodoArtifact {
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch {
      size = 0;
    }
    return {
      key,
      label,
      file: this.relativeOutputPath(target),
      absolutePath: target,
      format,
      size,
      exists: size > 0,
      viewable: format !== 'f32',
      description,
      group,
      ...extra,
    };
  }

  /** .f32 二进制产物：体积 + 帧数 + 每帧字节数 + 形状（joints=3 为 root，120 为 30×4 旋转） */
  private f32Artifact(
    key: KimodoArtifactKey,
    label: string,
    target: string,
    bytesPerFrame: number,
    joints: 3 | 120,
    description: string,
    group: KimodoArtifactGroup,
    source?: string,
  ): KimodoArtifact {
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch {
      size = 0;
    }
    const frames = Math.floor(size / bytesPerFrame);
    return this.baseArtifact(key, label, target, 'f32', description, group, {
      frames,
      bytesPerFrame,
      shape: joints === 3 ? `[${frames}, 3] float32` : `[${frames}, 30, 4] float32`,
      source,
    });
  }

  /** 某个任务动作 f32 的帧数（root 每帧 12 字节，rotations 每帧 30×4×4=480 字节） */
  private motionFrameCount(animationId: string, kind: 'root' | 'rotations'): number | null {
    if (!/^[0-9a-zA-Z._-]+$/.test(animationId)) return null;
    const file = path.join(
      this.outputDir,
      animationId,
      kind === 'root' ? 'root_positions.f32' : 'local_rotations_xyzw.f32',
    );
    try {
      return Math.floor(fs.statSync(file).size / (kind === 'root' ? 12 : 480));
    } catch {
      return null;
    }
  }

  /** 还原把 next root 平移到 prev 末帧 + rootDelta 时的实际平移量（产物说明用） */
  private rootShiftOffset(info: KimodoConditionedInfo): { x: number; z: number } | null {
    try {
      const prevBuf = fs.readFileSync(info.prevRootPath);
      const nextBuf = fs.readFileSync(info.nextRootPath);
      const prevFrames = Math.floor(prevBuf.length / 12);
      if (prevFrames < 1 || nextBuf.length < 12) return null;
      const tail = (prevFrames - 1) * 12;
      return {
        x: (info.rootDelta?.dx ?? 0) + prevBuf.readFloatLE(tail) - nextBuf.readFloatLE(0),
        z: (info.rootDelta?.dz ?? 0) + prevBuf.readFloatLE(tail + 8) - nextBuf.readFloatLE(8),
      };
    } catch {
      return null;
    }
  }

  /** 约束来源动画的关联信息（prev / next） */
  private sourceRelation(
    role: 'prev' | 'next',
    animationId: string,
    transitionFrames: number,
  ): KimodoArtifactSource {
    const job = this.get(animationId);
    const frames = this.motionFrameCount(animationId, 'root') ?? job?.frames ?? null;
    let sliceStart: number | null = null;
    let sliceEnd: number | null = null;
    if (frames !== null) {
      if (role === 'prev') {
        sliceStart = Math.max(0, frames - transitionFrames);
        sliceEnd = frames;
      } else {
        sliceStart = 0;
        sliceEnd = Math.min(transitionFrames, frames);
      }
    }
    return {
      role,
      animationId,
      prompt: job?.prompt ?? null,
      status: job?.status ?? null,
      frames,
      sliceStart,
      sliceEnd,
    };
  }

  /**
   * 中间产物清单 + 关联关系。
   *
   * 文本任务：提示词 → 元数据 → 根位移 → 关节旋转 → Mixamo JSON。
   * conditioned（f32 约束）任务额外展示完整链路：
   *   prev 尾部 root/rot f32 → next 头部 root/rot f32（+ 平移后的 next root）
   *   → 生成输出 root/rot f32 → Mixamo JSON。
   * 二进制 .f32 只给路径 / 帧数 / 每帧布局 / 形状，不做文本预览。
   *
   * 关联关系没有单独建表：导入时项目里记录的 imported.name 就是 Mixamo 片段名，
   * 所以用「Mixamo JSON 的 clips[0].name」或「提示词前 40 字」反查项目即可；
   * conditioned 任务的 prev / next 来源动画直接从 meta.json 的 conditioned 字段还原。
   */
  async artifacts(id: string): Promise<{
    task: KimodoAnimation;
    artifacts: KimodoArtifact[];
    relations: KimodoRelation[];
    sources: KimodoArtifactSource[];
  } | null> {
    const dir = this.motionDir(id);
    const task = this.get(id);
    if (!dir || !task) return null;

    const isConditioned = task.mode === 'conditioned';
    const conditioned = isConditioned ? task.conditioned : undefined;
    const artifacts: KimodoArtifact[] = [];

    // ---- 提示词：conditioned 写 prompt.txt，文本生成写 segment-01.txt… ----
    const promptName = isConditioned ? 'prompt.txt' : 'segment-01.txt';
    const promptFiles = isConditioned ? ['prompt.txt'] : this.segmentFiles(dir);
    let promptSize = 0;
    for (const name of promptFiles) {
      try {
        promptSize += fs.statSync(path.join(dir, name)).size;
      } catch {
        /* 忽略单个文件读取失败 */
      }
    }
    artifacts.push({
      key: 'prompt',
      label: isConditioned ? '辅助提示词' : '提示词文本',
      file: promptName,
      absolutePath: path.join(dir, promptName),
      format: 'text',
      size: promptSize,
      exists: promptSize > 0,
      viewable: true,
      group: 'text',
      description: isConditioned
        ? '真实 pose 约束过渡的辅助提示词（prompt.txt），只描述中间过渡的节奏 / 风格'
        : '提交给生成器的原始提示词（多段任务依次写入 segment-01.txt、segment-02.txt…，此处按顺序合并展示）',
    });

    // ---- 任务元数据：conditioned 参数与约束来源都落在这里 ----
    artifacts.push(
      this.baseArtifact(
        'meta',
        '任务元数据',
        this.metaPath(id),
        'json',
        isConditioned
          ? '任务参数、状态、耗时与进度估算；conditioned 的 prev/next 来源、transitionFrames、rootDelta 与约束文件路径都在这里'
          : '任务参数、状态、耗时与进度估算，服务重启后据此恢复列表',
        'text',
      ),
    );

    const sources: KimodoArtifactSource[] = [];
    const transitionFrames = Math.max(1, Math.round(conditioned?.transitionFrames ?? 1));

    // ---- conditioned：完整展示四个约束切片 + 平移后的 next root ----
    if (conditioned) {
      const prevTotal = conditioned.prevAnimationId
        ? this.motionFrameCount(conditioned.prevAnimationId, 'root')
        : null;
      const nextTotal = conditioned.nextAnimationId
        ? this.motionFrameCount(conditioned.nextAnimationId, 'root')
        : null;
      const prevRange =
        prevTotal !== null
          ? { start: Math.max(0, prevTotal - transitionFrames), end: prevTotal, total: prevTotal }
          : null;
      const nextRange =
        nextTotal !== null
          ? { start: 0, end: Math.min(transitionFrames, nextTotal), total: nextTotal }
          : null;
      const sliceLabel = (
        role: 'prev' | 'next',
        animationId: string | undefined,
        range: { start: number; end: number; total: number } | null,
      ): string => {
        if (!animationId) return `外部 ${role} 约束文件`;
        const side = role === 'prev' ? '尾部' : '头部';
        if (!range) return `${role} 动画 ${animationId} 的${side}约束`;
        return `${role} 动画 ${animationId} 的${side} ${range.end - range.start} 帧（第 ${range.start + 1}–${range.end} 帧 / 共 ${range.total} 帧）`;
      };

      const prevLabel = sliceLabel('prev', conditioned.prevAnimationId, prevRange);
      const nextLabel = sliceLabel('next', conditioned.nextAnimationId, nextRange);

      artifacts.push(
        this.f32Artifact(
          'prev-root',
          'prev 约束 · 根位移',
          conditioned.prevRootPath,
          12,
          3,
          `约束输入：${prevLabel}。每帧 3 个 float32（XYZ），作为过渡段起点的硬约束。`,
          'constraint',
          prevLabel,
        ),
        this.f32Artifact(
          'prev-rot',
          'prev 约束 · 关节旋转',
          conditioned.prevRotPath,
          480,
          120,
          `约束输入：${prevLabel}。每帧 30 关节 × 4 分量（XYZW），与 prev 根位移成对使用。`,
          'constraint',
          prevLabel,
        ),
        this.f32Artifact(
          'next-root',
          'next 约束 · 根位移（平移前）',
          conditioned.nextRootPath,
          12,
          3,
          `约束输入：${nextLabel}。每帧 3 个 float32（XYZ），作为过渡段终点的硬约束（原始文件）。`,
          'constraint',
          nextLabel,
        ),
        this.f32Artifact(
          'next-rot',
          'next 约束 · 关节旋转',
          conditioned.nextRotPath,
          480,
          120,
          `约束输入：${nextLabel}。每帧 30 关节 × 4 分量（XYZW），与 next 根位移成对使用。`,
          'constraint',
          nextLabel,
        ),
      );

      if (conditioned.nextRootShiftedPath) {
        const offset = this.rootShiftOffset(conditioned);
        const delta = conditioned.rootDelta;
        const deltaText = delta
          ? `rootDelta = (Δx ${delta.dx.toFixed(3)} m, Δz ${delta.dz.toFixed(3)} m)`
          : 'rootDelta';
        const appliedText = offset
          ? `，实际平移 = (Δx ${offset.x.toFixed(3)} m, Δz ${offset.z.toFixed(3)} m)`
          : '';
        artifacts.push(
          this.f32Artifact(
            'next-root-shifted',
            'next 约束 · 平移后的根位移',
            conditioned.nextRootShiftedPath,
            12,
            3,
            `中间产物：${deltaText}${appliedText}。shim 实际读取的 next 根位置约束，负责把舞台位移编码进首尾约束。`,
            'constraint',
            nextLabel,
          ),
        );
      }
    }

    // ---- 生成输出：root_positions.f32 / local_rotations_xyzw.f32 ----
    artifacts.push(
      this.f32Artifact(
        'root',
        '输出 · 根位移',
        path.join(dir, 'root_positions.f32'),
        12,
        3,
        `生成结果：根关节世界位置，每帧 3 个 float32（XYZ）；任务声明 ${task.frames} 帧。`,
        'motion',
      ),
      this.f32Artifact(
        'rotations',
        '输出 · 关节旋转',
        path.join(dir, 'local_rotations_xyzw.f32'),
        480,
        120,
        `生成结果：30 关节局部旋转，每帧 30 × 4 分量（XYZW）；任务声明 ${task.frames} 帧。`,
        'motion',
      ),
    );

    // ---- 导入产物：Mixamo JSON（导入新建动画后才会生成） ----
    artifacts.push(
      this.baseArtifact(
        'mixamo',
        'Mixamo 动画 JSON',
        this.mixamoFile(id),
        'json',
        'to_mixamo.py 重定向后的 fbx-animation-data，可导入新建动画',
        'import',
      ),
    );

    // ---- 关联关系 1：conditioned 的 prev / next 来源动画 ----
    if (conditioned?.prevAnimationId) {
      sources.push(this.sourceRelation('prev', conditioned.prevAnimationId, transitionFrames));
    }
    if (conditioned?.nextAnimationId) {
      sources.push(this.sourceRelation('next', conditioned.nextAnimationId, transitionFrames));
    }

    // ---- 关联关系 2：Mixamo JSON 片段名 / 提示词前缀与项目 imported.name 对齐 ----
    const clipName = this.mixamoClipName(id);
    const expected = task.prompt.slice(0, 40);
    const projects = await listProjects();
    const relations = projects
      .filter(
        (project) =>
          project.imported !== null &&
          (project.imported.name === clipName || project.imported.name === expected),
      )
      .map((project) => ({
        id: project.id,
        name: project.name,
        importedName: project.imported?.name ?? null,
        updatedAt: project.updatedAt,
        clipCount: project.clipCount,
        trackCount: project.trackCount,
      }));

    return { task, artifacts, relations, sources };
  }

  /** 读取 Mixamo JSON 里的第一个片段名（没有导入过时为 null） */
  private mixamoClipName(id: string): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.mixamoFile(id), 'utf8')) as {
        clips?: { name?: unknown }[];
      };
      const name = parsed.clips?.[0]?.name;
      return typeof name === 'string' ? name : null;
    } catch {
      return null;
    }
  }

  /**
   * 读取可查看产物的文本内容。
   *
   * 只放行 prompt/meta/mixamo 三种文本产物；单次最多读 2MB，超出部分截断并标记
   * truncated（此时不再尝试 JSON 解析）；正常大小的 JSON 会重新缩进后再给前端，
   * 让 vue-json-pretty 的树形展示有完整结构。
   */
  readArtifact(id: string, key: string): KimodoArtifactContent | null {
    if (key !== 'prompt' && key !== 'meta' && key !== 'mixamo') return null;
    const dir = this.motionDir(id);
    if (!dir) return null;

    const MAX_BYTES = 2 * 1024 * 1024;

    // 文本任务有多段提示词（segment-01.txt…）；conditioned 任务只有 prompt.txt
    if (key === 'prompt') {
      const files = this.segmentFiles(dir);
      if (files.length === 0 && fs.existsSync(path.join(dir, 'prompt.txt'))) files.push('prompt.txt');
      if (files.length === 0) return null;
      const chunks: string[] = [];
      let size = 0;
      let truncated = false;
      for (const name of files) {
        const buffer = fs.readFileSync(path.join(dir, name));
        size += buffer.length;
        if (size > MAX_BYTES) {
          chunks.push(buffer.subarray(0, Math.max(0, MAX_BYTES - size + buffer.length)).toString('utf8'));
          truncated = true;
          break;
        }
        const body = buffer.toString('utf8');
        chunks.push(files.length > 1 ? `# ${name}\n${body}` : body);
      }
      return {
        key,
        file: files[0]!,
        format: 'text',
        size,
        text: chunks.join('\n\n'),
        truncated,
      };
    }

    const target = key === 'mixamo' ? this.mixamoFile(id) : path.join(dir, 'meta.json');
    const format: 'text' | 'json' = 'json';
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch {
      return null;
    }
    if (size === 0) return null;

    const truncated = size > MAX_BYTES;
    let text: string;
    try {
      text = fs.readFileSync(target).subarray(0, MAX_BYTES).toString('utf8');
    } catch {
      return null;
    }
    if (format === 'json' && !truncated) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* 解析失败就保留原文，交给前端按纯文本展示 */
      }
    }
    const file = key === 'mixamo' ? `mixamo/${id}.json` : 'meta.json';
    return { key, file, format, size, text, truncated };
  }

  /**
   * 读取 .f32 二进制产物：给前端把中间产物渲染成骨架 / 轨迹预览用。
   *
   * 只放行产物清单里 format 为 f32 且存在的产物；absolutePath 可能指向
   * 其他动画的输出目录（例如 conditioned 的 prev/next 约束切片），因此按清单走。
   */
  async readArtifactF32(id: string, key: string): Promise<Buffer | null> {
    const listing = await this.artifacts(id);
    if (!listing) return null;
    const artifact = listing.artifacts.find((item) => item.key === key);
    if (!artifact || artifact.format !== 'f32' || !artifact.exists || !artifact.absolutePath) return null;
    const MAX_BYTES = 16 * 1024 * 1024;
    if (artifact.size <= 0 || artifact.size > MAX_BYTES) return null;
    try {
      return fs.readFileSync(artifact.absolutePath);
    } catch {
      return null;
    }
  }

  /** 任务目录里的分段提示词文件，按序号排序 */
  private segmentFiles(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => /^segment-\d+\.txt$/i.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  remove(id: string): boolean {
    const dir = this.motionDir(id);
    if (!dir || this.jobs.get(id)?.status === 'running') return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(this.mixamoFile(id), { force: true });
      this.jobs.delete(id);
      return true;
    } catch {
      return false;
    }
  }
}

export const kimodoService = new KimodoService();

export type KimodoImportOutcome =
  | { ok: true; data: unknown; clipName: string }
  | { ok: false; status: number; error: string };

/**
 * 把 SOMA 动作重定向成 Mixamo 动画 JSON（format=fbx-animation-data）。
 *
 * 处理流程：
 * 1. 校验任务 ID 与 root_positions.f32 / local_rotations_xyzw.f32 是否存在；
 * 2. 用 tools/kimodo/to_mixamo.py（.env 里配置的 Python）做骨架重定向，
 *    片段名默认取任务提示词，也可由调用方指定；
 * 3. 转换结果写到 `<outputDir>/mixamo/<id>.json`，同时作为「中间产物」供前端查看。
 *
 * HTTP 路由与 MCP 共用这一份实现，避免两处各写一遍 Python 调用。
 */
export async function importKimodoAnimation(
  id: string,
  rawClipName?: string,
): Promise<KimodoImportOutcome> {
  if (!/^[0-9a-zA-Z._-]+$/.test(id)) return { ok: false, status: 400, error: '非法任务 ID' };

  const motionDir = kimodoService.motionDir(id);
  if (!motionDir) return { ok: false, status: 400, error: '非法任务 ID' };
  if (
    !fs.existsSync(path.join(motionDir, 'root_positions.f32')) ||
    !fs.existsSync(path.join(motionDir, 'local_rotations_xyzw.f32'))
  ) {
    return { ok: false, status: 404, error: `任务 ${id} 的动作数据不存在` };
  }

  const meta = kimodoService.get(id);
  const outDir = path.join(kimodoService.outputDir, 'mixamo');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${id}.json`);
  const clipName = rawClipName?.trim() || meta?.prompt || `kimodo ${id.slice(0, 8)}`;

  const converter = path.join(repoRoot, 'tools', 'kimodo', 'to_mixamo.py');
  const result = await new Promise<{ code: number; err: string }>((resolve) => {
    const child = spawn(
      config.kimodo.python,
      [converter, '--motion-dir', motionDir, '--clip-name', clipName, '--out', outFile],
      { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', (error) => resolve({ code: 1, err: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, err }));
  });
  if (result.code !== 0) {
    log.error(`to_mixamo 失败：${result.err}`);
    return { ok: false, status: 500, error: result.err.trim() || '动画转换失败' };
  }
  try {
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8')) as unknown;
    return { ok: true, data, clipName };
  } catch (err) {
    return { ok: false, status: 500, error: `读取转换结果失败：${(err as Error).message}` };
  }
}
