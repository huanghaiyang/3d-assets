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

export type KimodoStatusValue = 'queued' | 'running' | 'ready' | 'failed';

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

/** 一次生成留下的中间产物（保留在输出目录里，可查看） */
export interface KimodoArtifact {
  key: KimodoArtifactKey;
  label: string;
  /** 相对输出目录的路径 */
  file: string;
  format: 'text' | 'json' | 'f32';
  size: number;
  exists: boolean;
  /** 是否可当作文本查看（.f32 为二进制） */
  viewable: boolean;
  description: string;
}

export type KimodoArtifactKey = 'prompt' | 'meta' | 'mixamo' | 'root' | 'rotations';

/** 产物对应到的项目（关联关系） */
export interface KimodoRelation {
  id: string;
  name: string;
  importedName: string | null;
  updatedAt: string;
  clipCount: number;
  trackCount: number;
}

export interface KimodoArtifactContent {
  key: Exclude<KimodoArtifactKey, 'root' | 'rotations'>;
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
  private session: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private pendingLines: string[] = [];
  private lineWaiters: Array<(line: string | null) => void> = [];
  private stderrTail: string[] = [];
  private busy = false;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private lastError: string | null = null;
  /** 常驻进程是否已完成过一次生成（权重已驻留，后续任务无需再加载） */
  private weightsLoaded = false;
  /** 每「帧 × 步」单位的实测耗时（毫秒），随成功任务自适应修正 */
  private msPerUnit = DEFAULT_MS_PER_UNIT;
  private readonly jobs = new Map<string, KimodoAnimation>();

  get outputDir(): string {
    return config.kimodo.outputDir;
  }

  get isRunning(): boolean {
    return this.session !== null;
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
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    // Windows 下 kmd-generate 可能还有子线程句柄，强制兜底
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

  private describe(key: KimodoArtifactKey, id: string): Omit<KimodoArtifact, 'size' | 'exists'> {
    switch (key) {
      case 'prompt':
        return {
          key,
          label: '提示词文本',
          file: 'segment-01.txt',
          format: 'text',
          viewable: true,
          description: '提交给生成器的原始提示词（多段任务依次写入 segment-01.txt、segment-02.txt…，此处按顺序合并展示）',
        };
      case 'meta':
        return {
          key,
          label: '任务元数据',
          file: 'meta.json',
          format: 'json',
          viewable: true,
          description: '任务参数、状态、耗时与进度估算，服务重启后据此恢复列表',
        };
      case 'mixamo':
        return {
          key,
          label: 'Mixamo 动画 JSON',
          file: `mixamo/${id}.json`,
          format: 'json',
          viewable: true,
          description: 'to_mixamo.py 重定向后的 fbx-animation-data，可导入新建动画',
        };
      case 'root':
        return {
          key,
          label: '根位移（二进制）',
          file: 'root_positions.f32',
          format: 'f32',
          viewable: false,
          description: '每帧 3 个 float32（XYZ）根关节世界位置',
        };
      case 'rotations':
        return {
          key,
          label: '关节旋转（二进制）',
          file: 'local_rotations_xyzw.f32',
          format: 'f32',
          viewable: false,
          description: '每帧 30 个关节 × 4 分量（XYZW）局部旋转',
        };
    }
  }

  /**
   * 中间产物清单 + 关联关系。
   *
   * 产物顺序固定为「提示词 → 元数据 → Mixamo JSON → 根位移 → 关节旋转」，
   * 与前端链路条一致；二进制 .f32 只给体积，不做文本预览。
   *
   * 关联关系没有单独建表：导入时项目里记录的 imported.name 就是 Mixamo 片段名，
   * 所以用「Mixamo JSON 的 clips[0].name」或「提示词前 40 字」反查项目即可。
   */
  async artifacts(
    id: string,
  ): Promise<{ task: KimodoAnimation; artifacts: KimodoArtifact[]; relations: KimodoRelation[] } | null> {
    const dir = this.motionDir(id);
    const task = this.get(id);
    if (!dir || !task) return null;

    const keys: KimodoArtifactKey[] = ['prompt', 'meta', 'mixamo', 'root', 'rotations'];
    const artifacts = keys.map((key): KimodoArtifact => {
      const desc = this.describe(key, id);
      // Mixamo JSON 由导入动作时写到 <outputDir>/mixamo 下，不在任务目录内
      let size = 0;
      if (key === 'prompt') {
        // 多段任务会有 segment-01/02/…，体积按全部段累加
        for (const name of this.segmentFiles(dir)) {
          try {
            size += fs.statSync(path.join(dir, name)).size;
          } catch {
            /* 忽略单个文件读取失败 */
          }
        }
      } else {
        const file = key === 'mixamo' ? this.mixamoFile(id) : path.join(dir, desc.file);
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      return { ...desc, size, exists: size > 0 };
    });

    // 关联关系：Mixamo JSON 的片段名 / 提示词前缀与项目记录的 imported.name 对齐
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

    return { task, artifacts, relations };
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

    // 提示词可能有多段（segment-01.txt、segment-02.txt…），按顺序拼起来展示
    if (key === 'prompt') {
      const files = this.segmentFiles(dir);
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
