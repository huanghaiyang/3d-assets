import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { repoRoot } from '../lib/paths.js';
import { listProjects } from './animProjects.js';

const log = createLogger('kimodo');

/** 单次生成的请求参数 */
export interface KimodoGenerateRequest {
  prompt: string;
  frames: number;
  steps: number;
  seed?: number;
  /** 首尾过渡帧，默认 5，与 kimodo.cpp 官方 demo 一致 */
  transitionFrames?: number;
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
  /** 生成耗时（毫秒），完成后写入 */
  durationMs?: number;
  /** 开始生成的时刻（进入 running 时写入），供前端计算进度 */
  startedAt?: number;
  /** 预计总耗时（毫秒），由帧数、步数与实测速率估算 */
  etaMs?: number;
  /** 其中估算的冷启动模型加载耗时（毫秒），权重已驻留时为 0 */
  loadMs?: number;
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
  /** 提示词转译模型名（前端展示用） */
  promptModel: string;
  /** 是否配置了提示词模型的 Key */
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
      promptModel: config.kimodo.promptModel,
      promptModelReady: Boolean(config.kimodo.promptApiKey),
      error: check.ok ? this.lastError : check.missing.join('；'),
    };
  }

  /** 提交一次生成，立即返回排队中的任务，实际生成在后台串行执行 */
  submit(request: KimodoGenerateRequest): KimodoAnimation {
    const check = this.validate();
    if (!check.ok) throw new Error(`Kimodo 未正确配置：${check.missing.join('；')}`);

    const frames = Math.max(8, Math.min(300, Math.round(request.frames)));
    const job: KimodoAnimation = {
      id: Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-6),
      prompt: request.prompt,
      frames,
      steps: Math.max(1, Math.round(request.steps)),
      seed: request.seed && request.seed > 0 ? Math.round(request.seed) : Math.floor(Math.random() * 1e9),
      status: 'queued',
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    this.pending += 1;

    this.queue = this.queue.then(() => this.run(job, request.transitionFrames ?? 5)).catch(() => void 0);
    return job;
  }

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
      const promptPath = path.join(dir, 'segment-01.txt');
      fs.writeFileSync(promptPath, job.prompt, 'utf8');

      const session = this.ensureSession();
      // 请求格式：过渡帧 \t 步数 \t 种子 \t 输出目录 \t 帧数 \t 提示词文件
      const line = [transitionFrames, job.steps, job.seed, dir, job.frames, promptPath].join('\t');
      log.info(`生成 ${job.id}：${job.frames} 帧 / ${job.steps} 步，seed=${job.seed}`);
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
          description: '提交给生成器的原始提示词（kmd-generate 按段读取）',
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

  /** 列出中间产物与关联的新建动画（提示词 → 任务 → 动作数据 → Mixamo JSON → 项目） */
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
      const file = key === 'mixamo' ? this.mixamoFile(id) : path.join(dir, desc.file);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
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

  /** 读取可查看产物的文本内容（JSON 会格式化输出） */
  readArtifact(id: string, key: string): KimodoArtifactContent | null {
    if (key !== 'prompt' && key !== 'meta' && key !== 'mixamo') return null;
    const dir = this.motionDir(id);
    if (!dir) return null;

    const target = key === 'mixamo' ? this.mixamoFile(id) : path.join(dir, key === 'prompt' ? 'segment-01.txt' : 'meta.json');
    const format: 'text' | 'json' = key === 'prompt' ? 'text' : 'json';
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch {
      return null;
    }
    if (size === 0) return null;

    const MAX_BYTES = 2 * 1024 * 1024;
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
    const file = key === 'mixamo' ? `mixamo/${id}.json` : key === 'prompt' ? 'segment-01.txt' : 'meta.json';
    return { key, file, format, size, text, truncated };
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
 * HTTP 路由与 MCP 共用，避免两处各写一遍 Python 调用。
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
