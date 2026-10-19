import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import { dataDir, stateBackupFile, stateFile } from '../lib/paths.js';
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
 *
 * 数据安全：
 * - 启动时把当时的状态写一份 `state.json.bak` 快照
 * - 主文件损坏/丢失时从快照恢复；损坏文件改名隔离，不会被静默覆盖
 * - `recoveredFromCorrupt` 告知上层（app.ts）本次启动**不要**清理素材目录，
 *   否则记录丢失 + 启动 sweep 会把 data/storage 下的模型一起删掉
 */
export class Workspace {
  private state: PersistedState;
  private writeChain: Promise<void> = Promise.resolve();
  /** 本次启动是否发生过状态恢复/损坏隔离（为 true 时上层必须跳过素材清理） */
  readonly recoveredFromCorrupt: boolean;

  private constructor(state: PersistedState, recoveredFromCorrupt = false) {
    this.state = state;
    this.recoveredFromCorrupt = recoveredFromCorrupt;
  }

  static async open(): Promise<Workspace> {
    await fs.mkdir(dataDir, { recursive: true });
    let state = emptyState();
    let recovered = false;

    const primary = await readStateFile(stateFile);
    if (primary.ok) {
      state = primary.state;
    } else if (primary.reason === 'invalid') {
      recovered = true;
      await quarantine(stateFile);
      log.error(`state.json 无法解析（${primary.error ?? '未知原因'}），已隔离为 state.json.corrupt-*`);
    }

    if (!primary.ok) {
      const backup = await readStateFile(stateBackupFile);
      if (backup.ok) {
        state = backup.state;
        recovered = true;
        log.warn(`已从备份 state.json.bak 恢复 ${state.jobs.length} 个任务、${state.animationDirs.length} 个动画目录`);
      } else if (primary.reason === 'missing') {
        log.info('未找到 state.json，按全新工作区启动');
      }
    }

    const ws = new Workspace(state, recovered);

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
    } else if (recovered) {
      // 把恢复后的状态写回主文件，避免下次启动又走恢复分支
      await ws.persist();
    }

    // 每次启动都刷新一次快照，覆盖“会话中途被外部改坏”的情况
    await ws.writeBackup();
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

  /** 写一份当前状态的快照（启动 / 退出时调用，不参与高频写入） */
  async writeBackup(): Promise<void> {
    const tmp = `${stateBackupFile}.tmp`;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      await fs.rename(tmp, stateBackupFile);
    } catch (err) {
      log.warn(`写入 state.json.bak 失败: ${(err as Error).message}`);
      await fs.rm(tmp, { force: true });
    }
  }

  /** 等待所有挂起的写入完成，并刷新一次退出快照 */
  async flush(): Promise<void> {
    await this.writeChain;
    await this.writeBackup();
  }
}

type StateReadResult =
  | { ok: true; state: PersistedState }
  | { ok: false; reason: 'missing' | 'invalid'; error?: string };

async function readStateFile(file: string): Promise<StateReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'invalid', error: (err as Error).message };
  }
  if (!raw.trim()) return { ok: false, reason: 'invalid', error: '文件为空' };
  try {
    return { ok: true, state: normalize(JSON.parse(raw) as Partial<PersistedState>) };
  } catch (err) {
    return { ok: false, reason: 'invalid', error: (err as Error).message };
  }
}

/** 把损坏的状态文件改名隔离，保留现场供排查，避免被下一次写入静默覆盖 */
async function quarantine(file: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}`;
  try {
    await fs.rename(file, target);
    log.warn(`损坏的状态文件已隔离到 ${path.basename(target)}`);
  } catch (err) {
    log.warn(`隔离损坏状态文件失败: ${(err as Error).message}`);
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
