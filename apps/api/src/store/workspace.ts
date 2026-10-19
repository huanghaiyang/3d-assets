import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import { dataDir, stateFile } from '../lib/paths.js';
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS, type AppSettings, type Job, type PersistedState } from './types.js';

const log = createLogger('store');
const STATE_VERSION = 1;

function emptySettings(): AppSettings {
  return { activeProvider: DEFAULT_PROVIDER_ID, providers: {} };
}

function emptyState(): PersistedState {
  return { version: STATE_VERSION, jobs: [], settings: emptySettings(), animationDirs: [] };
}

/**
 * 工作区状态存储：单个 JSON 文件 + 原子写入。
 * 所有写操作串行化，避免并发 rename 竞争。
 */
export class Workspace {
  private state: PersistedState;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(state: PersistedState) {
    this.state = state;
  }

  static async open(): Promise<Workspace> {
    await fs.mkdir(dataDir, { recursive: true });
    let state = emptyState();
    try {
      const raw = await fs.readFile(stateFile, 'utf8');
      state = normalize(JSON.parse(raw) as Partial<PersistedState>);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log.warn(`读取 state.json 失败，将重建: ${(err as Error).message}`);
    }
    const ws = new Workspace(state);
    // 启动时把中断的任务重新排队（远端可能仍在运行，交由 worker 恢复）
    let requeued = 0;
    for (const job of ws.state.jobs) {
      if (job.phase === 'submitting') {
        job.phase = 'queued';
        requeued += 1;
      }
    }
    if (requeued > 0) {
      log.info(`恢复 ${requeued} 个中断的提交任务`);
      await ws.persist();
    }
    return ws;
  }

  get jobs(): readonly Job[] {
    return this.state.jobs;
  }

  get settings(): AppSettings {
    return this.state.settings;
  }

  /** 动画预览记录的文件夹（只读扫描用，不会被写入） */
  get animationDirs(): string[] {
    return this.state.animationDirs;
  }

  findJob(id: string): Job | undefined {
    return this.state.jobs.find((job) => job.id === id);
  }

  /** 变更状态并落盘。mutator 内不要执行异步操作。 */
  async mutate<T>(mutator: (state: PersistedState) => T): Promise<T> {
    const result = mutator(this.state);
    await this.persist();
    return result;
  }

  async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${stateFile}.${process.pid}.tmp`;
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
        await fs.rename(tmp, stateFile);
      } catch (err) {
        log.error(`写入 state.json 失败: ${(err as Error).message}`);
        await fs.rm(tmp, { force: true });
      }
    });
    return this.writeChain;
  }

  /** 等待所有挂起的写入完成 */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

function normalize(raw: Partial<PersistedState>): PersistedState {
  const state = emptyState();
  if (typeof raw === 'object' && raw !== null) {
    if (raw.settings && typeof raw.settings === 'object') {
      state.settings = normalizeSettings(raw.settings as Partial<AppSettings> & { apiKey?: string | null });
    }
    if (Array.isArray(raw.jobs)) {
      state.jobs = raw.jobs.filter(isJobLike).map((job) => ({
        ...job,
        name: typeof job.name === 'string' && job.name ? job.name : job.asset?.name ?? '未命名模型',
        origin: job.origin === 'uploaded' ? 'uploaded' : 'generated',
        cancelRequested: Boolean(job.cancelRequested),
        remoteFailed: Boolean(job.remoteFailed),
        asset: job.asset ?? null,
        // 旧任务没有 provider / providerMeta 字段
        params: {
          ...job.params,
          provider: PROVIDER_IDS.includes(job.params.provider) ? job.params.provider : DEFAULT_PROVIDER_ID,
          resultFormat: job.params.resultFormat ?? 'GLB',
        },
        providerMeta: job.providerMeta && typeof job.providerMeta === 'object' ? job.providerMeta : {},
      }));
    }
    if (Array.isArray(raw.animationDirs)) {
      state.animationDirs = raw.animationDirs.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
    }
    // 服务重启后，正在轮询/下载的任务由 worker 接手
  }
  return state;
}

/** 设置迁移：旧版本的单一混元 Key → providers.hunyuan3d.apiKey */
function normalizeSettings(raw: Partial<AppSettings> & { apiKey?: string | null }): AppSettings {
  const settings = emptySettings();
  const rawProviders = (raw.providers ?? {}) as Record<string, { apiKey?: unknown; baseUrl?: unknown }>;
  for (const id of PROVIDER_IDS) {
    const entry = rawProviders[id];
    if (!entry || typeof entry !== 'object') continue;
    settings.providers[id] = {
      apiKey: typeof entry.apiKey === 'string' && entry.apiKey.trim() ? entry.apiKey.trim() : null,
      baseUrl: typeof entry.baseUrl === 'string' && entry.baseUrl.trim() ? entry.baseUrl.trim() : null,
    };
  }
  if (typeof raw.activeProvider === 'string' && (PROVIDER_IDS as readonly string[]).includes(raw.activeProvider)) {
    settings.activeProvider = raw.activeProvider as AppSettings['activeProvider'];
  }
  const legacyKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (legacyKey && !settings.providers[DEFAULT_PROVIDER_ID]?.apiKey) {
    settings.providers[DEFAULT_PROVIDER_ID] = { apiKey: legacyKey, baseUrl: null };
  }
  return settings;
}

function isJobLike(value: unknown): value is Job {
  const job = value as Job | null;
  return Boolean(job && typeof job.id === 'string' && typeof job.phase === 'string' && job.params && job.input);
}

export function storagePathFor(...parts: string[]): string {
  return path.join(dataDir, 'storage', ...parts);
}
