/**
 * 封面渲染服务：把封面渲染放到 Node 的 worker_threads 子线程里，
 * 避免占用主线程（HTTP 服务 / 任务调度）和浏览器主线程。
 *
 * - 渲染引擎：worker 里优先用 headless-gl（真实 WebGL，贴图/光照与浏览器一致）；
 *   headless-gl 不可用时自动退回纯 JS 软件光栅器
 * - 单个 worker 串行处理；默认开 2 个并行，避免一台机器上同时编译太多模型
 * - 渲染失败/超时只抛错，由调用方决定是否回退到浏览器渲染
 * - 动画页封面有三级缓存：内存 LRU → 项目内磁盘缓存（data/cache/covers）→ 真正渲染
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { coversCacheDir } from '../lib/paths.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('covers');

export type CoverEngine = 'auto' | 'webgl' | 'software';

export interface CoverRequest {
  filePath: string;
  /** 输出边长（像素），默认 256 */
  size?: number;
  /** 动画类模型取第几帧（0~1），不传则用绑定姿态 */
  poseFraction?: number | null;
  /** 渲染引擎：auto = 优先 WebGL，失败退回软件光栅器 */
  engine?: CoverEngine;
  /** 地面软接触阴影（对应前端 ShadowMaterial）；默认 shadow */
  ground?: 'shadow' | 'none';
  /** 相机垂直视角，默认 42（工作台 ModelViewer 的 42 / 动画 FbxPlayer 的 40） */
  fov?: number;
  /**
   * 新建动画项目的动画数据（fbx-animation-data JSON）。
   * 用于把「导入的动画」套到基础模型上再取某一个时刻的姿势，
   * 否则封面只能看到基础模型自带的 Mixamo 动作。
   */
  animation?: unknown;
  /** true = 只使用 animation 里的数据，不回退到 FBX 自带动画（新建动画的基础模型应是无动画的） */
  animationOnly?: boolean;
  /** 缓存标识（如项目 updatedAt）：参与内存/磁盘缓存 key，项目改动画后封面自动失效 */
  cacheTag?: string;
  timeoutMs?: number;
}

export interface CoverResult {
  png: Buffer;
  engine: 'webgl' | 'software';
}

interface PendingTask {
  id: number;
  request: CoverRequest;
  resolve: (result: CoverResult) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  task: PendingTask | null;
}

// headless-gl 的原生模块不能在同一个进程里被多个 worker 线程同时加载
// （第二个 worker import 时会报 "Module did not self-register"），
// 所以池子固定 1 个 worker：渲染串行、但都在子线程里，不阻塞主线程。
const DEFAULT_POOL_SIZE = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

export class CoverRenderer {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingTask[] = [];
  private nextId = 1;
  private stopped = false;

  constructor(
    private readonly options: { poolSize?: number; timeoutMs?: number } = {},
  ) {}

  private get poolSize(): number {
    return Math.max(1, this.options.poolSize ?? DEFAULT_POOL_SIZE);
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 渲染一张封面，返回 PNG 字节（渲染引擎信息见 renderWithMeta） */
  async render(request: CoverRequest): Promise<Buffer> {
    const result = await this.renderWithMeta(request);
    return result.png;
  }

  /** 渲染并返回实际使用的引擎（测试 / 诊断用） */
  renderWithMeta(request: CoverRequest): Promise<CoverResult> {
    if (this.stopped) return Promise.reject(new Error('封面渲染服务已停止'));
    return new Promise<CoverResult>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, request, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const slot = this.ensureSlot();
      if (!slot) return;
      const task = this.queue.shift()!;
      this.run(slot, task);
    }
  }

  private run(slot: WorkerSlot, task: PendingTask): void {
    slot.task = task;
    const timeoutMs = task.request.timeoutMs ?? this.timeoutMs;

    const cleanup = (): void => {
      clearTimeout(timer);
      slot.worker.off('message', onMessage);
      if (slot.task === task) slot.task = null;
    };

    const timer = setTimeout(() => {
      cleanup();
      // 超时的 worker 可能卡在渲染里，直接销毁并让下次请求重建
      this.destroySlot(slot);
      task.reject(new Error(`封面渲染超时（>${Math.round(timeoutMs / 1000)}s）`));
      this.dispatch();
    }, timeoutMs);
    timer.unref?.();

    const onMessage = (message: {
      id?: number;
      ok?: boolean;
      png?: Buffer | Uint8Array;
      engine?: 'webgl' | 'software';
      fallbackReason?: string;
      error?: string;
    }): void => {
      if (!message || message.id !== task.id) return;
      cleanup();
      // worker_threads 传输后 Buffer 会变成 Uint8Array，这里转回 Buffer
      if (message.ok && message.png) {
        if (message.fallbackReason) log.warn(`WebGL 封面失败，已回退软件渲染：${message.fallbackReason}`);
        task.resolve({
          png: Buffer.from(message.png),
          engine: message.engine === 'software' ? 'software' : 'webgl',
        });
      } else {
        task.reject(new Error(message.error || '封面渲染失败'));
      }
      this.dispatch();
    };

    slot.worker.on('message', onMessage);
    slot.worker.postMessage({
      id: task.id,
      filePath: task.request.filePath,
      size: task.request.size ?? 256,
      poseFraction: task.request.poseFraction ?? null,
      engine: task.request.engine ?? 'auto',
      ground: task.request.ground ?? 'shadow',
      fov: task.request.fov ?? 42,
      animation: task.request.animation ?? null,
      animationOnly: task.request.animationOnly ?? false,
    });
  }

  private ensureSlot(): WorkerSlot | null {
    const idle = this.slots.find((slot) => slot.task === null);
    if (idle) return idle;
    if (this.slots.length >= this.poolSize) return null;

    let worker: Worker;
    try {
      worker = new Worker(new URL('../covers/worker.mjs', import.meta.url));
    } catch (err) {
      log.error(`封面 Worker 启动失败：${(err as Error).message}`);
      return null;
    }
    worker.unref();
    const slot: WorkerSlot = { worker, task: null };
    worker.on('error', (err) => {
      log.warn(`封面 Worker 异常：${err.message}`);
      this.destroySlot(slot);
      if (slot.task) {
        const failed = slot.task;
        slot.task = null;
        failed.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.dispatch();
    });
    worker.on('exit', (code) => {
      if (code !== 0 && this.slots.includes(slot)) log.warn(`封面 Worker 退出：code=${code}`);
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
    });
    this.slots.push(slot);
    return slot;
  }

  private destroySlot(slot: WorkerSlot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    slot.worker.unref();
    void slot.worker.terminate().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const task of this.queue.splice(0)) {
      task.reject(new Error('封面渲染服务已停止'));
    }
    await Promise.all(this.slots.splice(0).map((slot) => slot.worker.terminate().catch(() => undefined)));
  }
}

// ===== 动画封面：内存 LRU + 项目内磁盘缓存 =====

interface CacheEntry {
  png: Buffer;
  at: number;
}

const ANIMATION_CACHE_MAX = 400;
const animationCache = new Map<string, CacheEntry>();

let renderer: CoverRenderer | null = null;

export function getCoverRenderer(): CoverRenderer {
  if (!renderer) renderer = new CoverRenderer();
  return renderer;
}

export async function shutdownCoverRenderer(): Promise<void> {
  if (!renderer) return;
  await renderer.shutdown();
  renderer = null;
}

/** 封面磁盘缓存目录（项目内 data/cache/covers，已 gitignore） */
export function getCoverCacheDir(): string {
  return coversCacheDir;
}

// 封面渲染行为变化时 +1，让旧缓存自然失效（文件 mtime 之外的第二层保险）
export const COVER_CACHE_VERSION = '2';

/**
 * 缓存 key → 文件名：包含路径、mtime、尺寸、姿态，
 * 以及 cacheTag（新建动画项目的 updatedAt），基础文件或项目动画更新都会自动失效。
 */
function coverCacheFile(
  filePath: string,
  mtimeMs: number,
  size: number,
  pose: number,
  cacheTag: string,
): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${COVER_CACHE_VERSION}|${filePath}|${mtimeMs}|${size}|${pose}|${cacheTag}`)
    .digest('hex');
  return path.join(coversCacheDir, `${hash}.png`);
}

async function writeCacheFile(target: string, png: Buffer): Promise<void> {
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, png);
    await fs.rename(tmp, target);
  } catch (err) {
    log.warn(`写入封面缓存失败: ${(err as Error).message}`);
  }
}

/**
 * 动画（FBX）封面：
 *   1. 内存 LRU（最近 400 张）
 *   2. 磁盘缓存 data/cache/covers/<sha1>.png（重启后仍生效）
 *   3. 真正渲染（worker 子线程，优先 WebGL）
 *
 * refresh=true 时跳过前两层缓存强制重渲染（对应前端「重新生成封面」按钮），
 * 渲染完会覆盖磁盘缓存。
 */
export async function animationCover(
  filePath: string,
  options: {
    size?: number;
    poseFraction?: number;
    refresh?: boolean;
    /** 项目动画数据：套到基础模型上再取姿势（新建动画封面） */
    animation?: unknown;
    animationOnly?: boolean;
    /** 项目级缓存标识（通常是 updatedAt） */
    cacheTag?: string;
  } = {},
): Promise<Buffer> {
  const stat = await fs.stat(filePath);
  const size = options.size ?? 256;
  const pose = options.poseFraction ?? 0.35;
  const cacheTag = options.cacheTag ?? '';
  const key = `${filePath}|${stat.mtimeMs}|${size}|${pose}|${cacheTag}`;

  if (!options.refresh) {
    const cached = animationCache.get(key);
    if (cached) {
      // 命中后移到队尾（Map 保持插入顺序，配合下面的删除实现 LRU）
      animationCache.delete(key);
      animationCache.set(key, cached);
      return cached.png;
    }

    const cacheFile = coverCacheFile(filePath, stat.mtimeMs, size, pose, cacheTag);
    const fromDisk = await fs.readFile(cacheFile).catch(() => null);
    if (fromDisk) {
      animationCache.set(key, { png: fromDisk, at: Date.now() });
      return fromDisk;
    }
  }

  const png = await getCoverRenderer().render({
    filePath,
    size,
    poseFraction: pose,
    ground: 'shadow',
    fov: 40,
    animation: options.animation ?? null,
    animationOnly: options.animationOnly ?? false,
  });
  animationCache.set(key, { png, at: Date.now() });
  while (animationCache.size > ANIMATION_CACHE_MAX) {
    const oldest = animationCache.keys().next().value;
    if (oldest === undefined) break;
    animationCache.delete(oldest);
  }
  await writeCacheFile(coverCacheFile(filePath, stat.mtimeMs, size, pose, cacheTag), png);
  return png;
}

/** 供测试 / 诊断：清空内存缓存（磁盘缓存保留） */
export function clearAnimationCoverCache(): void {
  animationCache.clear();
}

/**
 * 清理过期的封面磁盘缓存（默认 30 天），避免 data/cache 无限增长。
 * 只删 data/cache/covers 下自己生成的 .png，不碰其它目录。
 */
export async function sweepCoverCache(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(coversCacheDir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith('.png')) continue;
    const file = path.join(coversCacheDir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    if (now - stat.mtimeMs < maxAgeMs) continue;
    await fs.rm(file, { force: true });
    removed += 1;
  }
  return removed;
}
