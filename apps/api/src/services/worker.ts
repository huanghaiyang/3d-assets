import { createLogger } from '../lib/logger.js';
import { getProvider } from '../providers/registry.js';
import { MissingProviderKeyError, ProviderError, type GenerationProvider } from '../providers/types.js';
import { providerContext } from '../services/settings.js';
import type { Job, ProviderMeta, PersistedState } from '../store/types.js';
import { isActivePhase } from '../store/types.js';
import type { Workspace } from '../store/workspace.js';
import { deriveName, materializeAsset } from './assets.js';
import { loadPayload, type JobPayload } from './payload.js';
import { describeRetryFailure, withRetry } from './retry.js';

const log = createLogger('worker');

export interface WorkerOptions {
  pollIntervalMs: number;
  maxConcurrency: number;
  /** 单任务整体超时（毫秒）：远端卡死时任务不会永远停在「生成中」 */
  jobTimeoutMs: number;
}

export type RetryMode = 'resume' | 'resubmit';

/** 远端取消的结果：ok=远端已接受；unsupported=引擎/阶段不支持；failed=调用失败；not-submitted=还没提交到远端 */
export type RemoteCancelStatus = 'ok' | 'unsupported' | 'failed' | 'not-submitted';

export interface CancelResult {
  canceled: boolean;
  remote: RemoteCancelStatus;
  message: string;
}

/** 把落盘的输入转换成引擎契约里的 ProviderInput */
function toProviderInput(job: Job, payload: JobPayload) {
  return {
    mode: job.input.mode === 'upload' ? ('text' as const) : job.input.mode,
    prompt: payload.prompt,
    image: payload.imageBase64 ? { base64: payload.imageBase64, name: payload.imageName } : null,
    views: payload.views.map((view) => ({ viewType: view.viewType, base64: view.base64, name: view.name })),
  };
}

/**
 * 生成任务调度器。
 *
 * - 串行化本地状态写入，最多同时推进 maxConcurrency 个远端任务
 * - 每个任务按自己的 params.provider 选择生成引擎（默认混元，可切 Tripo3D / Meshy）
 * - 服务重启后自动接管已有 remoteJobId 的任务继续轮询（不重复计费）
 * - 网络类错误标记失败，重试时优先“续查”远端任务
 */
export class GenerationWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;
  private ticking = false;

  constructor(
    private readonly workspace: Workspace,
    private readonly options: WorkerOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.running.values()]);
  }

  get activeCount(): number {
    return this.running.size;
  }

  /** 调度一轮：拾取待处理任务，受并发上限约束 */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.workspace.jobs) {
        if (this.running.size >= this.options.maxConcurrency) break;
        if (this.running.has(job.id)) continue;
        if (job.phase === 'queued' || job.phase === 'running' || job.phase === 'downloading') {
          this.spawn(job.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private spawn(jobId: string): void {
    const promise = this.run(jobId)
      .catch((err: unknown) => {
        log.error(`任务 ${jobId} 异常退出: ${(err as Error)?.message}`);
      })
      .finally(() => {
        this.running.delete(jobId);
      });
    this.running.set(jobId, promise);
  }

  private async run(jobId: string): Promise<void> {
    const snapshot = this.workspace.findJob(jobId);
    if (!snapshot) return;

    let provider: GenerationProvider;
    try {
      provider = getProvider(snapshot.params.provider);
    } catch (err) {
      await this.fail(jobId, (err as Error).message, 'InvalidParameter.Provider');
      return;
    }

    const ctx = providerContext(this.workspace, provider.info.id);
    if (!ctx) {
      const missing = new MissingProviderKeyError(provider.info.label, provider.info.envKeyName);
      await this.fail(jobId, missing.message, missing.code);
      return;
    }

    // 本次运行的截止时间：每次重试都重新计时
    const deadline = Date.now() + this.options.jobTimeoutMs;

    try {
      let remoteJobId = snapshot.remoteJobId;
      if (!remoteJobId) {
        const payload = await loadPayload(jobId);
        if (!payload) {
          await this.fail(
            jobId,
            '任务的输入数据已丢失（data/payloads 下找不到记录），请重新创建任务。',
            'LocalPayloadMissing',
          );
          return;
        }
        await this.mutate(jobId, (job) => {
          job.phase = 'submitting';
          job.attempts += 1;
          job.error = null;
          job.errorCode = null;
          job.startedAt = job.startedAt ?? new Date().toISOString();
        });
        const submitted = await provider.submit(ctx, snapshot.params, toProviderInput(snapshot, payload));
        remoteJobId = submitted.remoteJobId;
        await this.mutate(jobId, (job) => {
          job.remoteJobId = submitted.remoteJobId;
          job.requestId = submitted.requestId;
          job.providerMeta = { ...job.providerMeta, ...(submitted.meta ?? {}) };
          job.phase = 'running';
          job.remoteStatus = 'WAIT';
        });
        log.info(`任务已提交 ${jobId} [${provider.info.id}] -> ${submitted.remoteJobId}`);
      } else {
        await this.mutate(jobId, (job) => {
          job.phase = 'running';
          job.error = null;
          job.errorCode = null;
          job.startedAt = job.startedAt ?? new Date().toISOString();
        });
      }

      // 轮询远端状态（部分引擎会在这里推进 preview → refine 等多步流程）
      for (;;) {
        const current = this.workspace.findJob(jobId);
        if (!current) return;
        if (current.cancelRequested) {
          await this.mutate(jobId, (job) => {
            job.phase = 'canceled';
            job.finishedAt = new Date().toISOString();
          });
          return;
        }

        // 整体超时：远端长时间不结束时主动收尾，把任务标成失败而不是一直等待
        if (Date.now() > deadline) {
          const minutes = Math.round(this.options.jobTimeoutMs / 60_000);
          await this.fail(
            jobId,
            `任务超过 ${minutes} 分钟仍未完成，已停止跟踪（远端可能仍会计费，可重试继续查询）`,
            'LocalTimeout',
          );
          return;
        }

        const meta: ProviderMeta = current.providerMeta ?? {};
        if (!remoteJobId) {
          await this.fail(jobId, '任务缺少远端 ID，无法查询；请重新提交', 'LocalRemoteIdMissing');
          return;
        }
        const currentRemoteJobId: string = remoteJobId;
        // 轮询是幂等操作：网络抖动 / 限流 / 5xx 自动退避重试，避免一次抖动就把付费任务判死
        let result;
        try {
          result = await withRetry(() => provider.query(ctx, currentRemoteJobId, meta), {
            attempts: 4,
            baseDelayMs: Math.max(300, Math.round(this.options.pollIntervalMs / 2)),
            maxDelayMs: Math.max(2_000, this.options.pollIntervalMs * 2),
            label: `${provider.info.label} 查询任务`,
          });
        } catch (err) {
          const providerError = err instanceof ProviderError ? err : null;
          await this.fail(jobId, describeRetryFailure(err, 4), providerError?.code ?? 'NetworkError');
          return;
        }

        // 查询期间用户可能已经取消：先落地取消状态，避免被下面的 mutate 改回 running
        const afterQuery = this.workspace.findJob(jobId);
        if (!afterQuery) return;
        if (afterQuery.cancelRequested) {
          await this.mutate(jobId, (job) => {
            job.phase = 'canceled';
            job.finishedAt = job.finishedAt ?? new Date().toISOString();
          });
          return;
        }

        if (result.nextRemoteJobId) remoteJobId = result.nextRemoteJobId;
        if (result.status === 'WAIT' || result.status === 'RUN') {
          await this.mutate(jobId, (job) => {
            job.remoteStatus = result.status as 'WAIT' | 'RUN';
            job.phase = 'running';
            if (result.requestId) job.requestId = result.requestId;
            job.providerMeta = {
              ...job.providerMeta,
              ...(result.meta ?? {}),
              ...(result.nextRemoteJobId ? { remoteJobId: result.nextRemoteJobId } : {}),
              ...(typeof result.progress === 'number' ? { progress: result.progress } : {}),
              ...(result.remoteStatus ? { remoteStatus: result.remoteStatus } : {}),
            };
          });
          await delay(this.options.pollIntervalMs);
          continue;
        }

        if (result.status === 'FAIL') {
          await this.mutate(jobId, (job) => {
            job.phase = 'failed';
            job.remoteStatus = 'FAIL';
            job.remoteFailed = true;
            job.errorCode = result.errorCode ?? `${provider.info.id}.Failed`;
            job.error = result.errorMessage ?? '远端任务执行失败';
            job.finishedAt = new Date().toISOString();
            job.providerMeta = { ...job.providerMeta, ...(result.meta ?? {}) };
          });
          return;
        }

        // DONE
        await this.mutate(jobId, (job) => {
          job.phase = 'downloading';
          job.remoteStatus = 'DONE';
          job.creditConsumed = result.creditConsumed ?? null;
          job.creditDetails = result.creditDetails ?? null;
          job.providerMeta = { ...job.providerMeta, ...(result.meta ?? {}) };
        });

        const asset = await materializeAsset({
          download: (url) => provider.download(ctx, url),
          jobId,
          name: current.name || deriveName(current.input.prompt, current.input.mode, current.input.imageName),
          prompt: current.input.prompt,
          mode: current.input.mode === 'upload' ? 'text' : current.input.mode,
          params: current.params,
          files: result.files ?? [],
          creditConsumed: result.creditConsumed ?? null,
          creditDetails: result.creditDetails ?? null,
        });

        await this.mutate(jobId, (job) => {
          job.asset = asset;
          // 下载期间用户取消：保留已转存的结果，但仍尊重“已取消”的状态
          job.phase = job.cancelRequested ? 'canceled' : 'done';
          job.finishedAt = new Date().toISOString();
          job.error = null;
          job.errorCode = null;
        });
        log.info(
          `任务完成 ${jobId} [${provider.info.id}]: ${asset.files.length} 个文件, ` +
            `${asset.files.filter((file) => file.primaryUrl).length} 个可预览`,
        );
        return;
      }
    } catch (err) {
      const providerError = err instanceof ProviderError ? err : null;
      await this.fail(
        jobId,
        (err as Error).message ?? '未知错误',
        providerError?.code ?? 'LocalError',
      );
    }
  }

  private async fail(jobId: string, message: string, code: string): Promise<void> {
    // 用户已经取消的任务不要再改成失败，否则界面会「取消后变失败」
    let canceled = false;
    await this.mutate(jobId, (job) => {
      if (job.cancelRequested) {
        canceled = true;
        job.phase = 'canceled';
        job.finishedAt = job.finishedAt ?? new Date().toISOString();
        return;
      }
      job.phase = 'failed';
      job.error = message;
      job.errorCode = code;
      job.finishedAt = new Date().toISOString();
    });
    log.warn(canceled ? `任务已取消 ${jobId}（忽略失败：${code}）` : `任务失败 ${jobId} [${code}] ${message}`);
  }

  private async mutate(jobId: string, mutator: (job: Job) => void): Promise<void> {
    await this.workspace.mutate((state: PersistedState) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return;
      mutator(job);
      job.updatedAt = new Date().toISOString();
    });
  }

  /**
   * 取消任务。
   * - 本地立即置为「已取消」（界面无需等下一轮轮询）
   * - 已提交远端的任务 best-effort 通知引擎取消，结果写进 providerMeta 供界面提示
   */
  async cancel(jobId: string): Promise<CancelResult> {
    const job = this.workspace.findJob(jobId);
    if (!job || !isActivePhase(job.phase)) {
      return { canceled: false, remote: 'not-submitted', message: '任务不在进行中，无法取消' };
    }

    const remoteJobId = job.remoteJobId;
    await this.mutate(jobId, (item) => {
      item.phase = 'canceled';
      item.cancelRequested = true;
      item.finishedAt = new Date().toISOString();
    });

    const remote = await this.cancelRemote(job, remoteJobId);
    await this.mutate(jobId, (item) => {
      item.providerMeta = {
        ...item.providerMeta,
        remoteCancel: remote.remote,
        remoteCancelMessage: remote.message,
      };
    });
    log.info(`任务已取消 ${jobId}（远端：${remote.remote}${remote.message ? ` - ${remote.message}` : ''}）`);
    return { canceled: true, remote: remote.remote, message: remote.message };
  }

  /** 尽量通知远端取消；任何失败都只降级成提示，不影响本地取消 */
  private async cancelRemote(
    job: Job,
    remoteJobId: string | null,
  ): Promise<{ remote: RemoteCancelStatus; message: string }> {
    if (!remoteJobId) {
      return { remote: 'not-submitted', message: '任务尚未提交到远端，无需通知' };
    }

    let provider: GenerationProvider;
    try {
      provider = getProvider(job.params.provider);
    } catch (err) {
      return { remote: 'unsupported', message: (err as Error).message };
    }
    if (!provider.cancel) {
      return {
        remote: 'unsupported',
        message: `${provider.info.label} 未提供远端取消接口，已停止本地跟踪（远端可能仍会计费）`,
      };
    }

    const ctx = providerContext(this.workspace, provider.info.id);
    if (!ctx) {
      return { remote: 'failed', message: '缺少该引擎的 API Key，无法通知远端取消' };
    }

    try {
      const accepted = await withRetry(() => provider.cancel!(ctx, remoteJobId, job.providerMeta ?? {}), {
        attempts: 2,
        baseDelayMs: 500,
        label: `${provider.info.label} 取消任务`,
      });
      return accepted
        ? { remote: 'ok', message: '已通知远端取消' }
        : {
            remote: 'unsupported',
            message: `${provider.info.label} 远端不支持取消，已停止本地跟踪（远端可能仍会计费）`,
          };
    } catch (err) {
      const message = (err as Error)?.message ?? '未知错误';
      log.warn(`远端取消失败 ${job.id}: ${message}`);
      return { remote: 'failed', message: `远端取消失败（${message}），已停止本地跟踪` };
    }
  }

  /**
   * 重试任务。
   * 若远端任务仍在（网络中断导致本地失败），则“续查”不重复计费；否则重新提交。
   */
  async retry(jobId: string): Promise<RetryMode> {
    const job = this.workspace.findJob(jobId);
    if (!job) throw new Error('任务不存在');
    if (isActivePhase(job.phase)) throw new Error('任务正在进行中，无法重试');
    if (job.phase === 'done') throw new Error('任务已完成，无需重试');

    const mode: RetryMode = job.remoteJobId && !job.remoteFailed ? 'resume' : 'resubmit';
    await this.mutate(jobId, (item) => {
      item.phase = 'queued';
      item.error = null;
      item.errorCode = null;
      item.cancelRequested = false;
      item.finishedAt = null;
      item.remoteStatus = null;
      if (mode === 'resubmit') {
        item.remoteJobId = null;
        item.providerMeta = {};
      }
    });
    void this.tick();
    return mode;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
