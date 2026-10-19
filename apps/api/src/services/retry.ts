/**
 * 带指数退避的重试工具。
 *
 * 用途：远端任务轮询、远端取消这类**幂等**请求。提交生成任务不能用它——
 * 提交请求一旦真正发出就可能已经计费，重发有重复扣费风险，所以 worker 里只对
 * query / cancel 重试，提交失败走「用户手动重试 + 续查」路径。
 */

import { createLogger } from '../lib/logger.js';
import { ProviderError } from '../providers/types.js';

const log = createLogger('retry');

export interface RetryOptions {
  /** 总尝试次数（含第一次），默认 3 */
  attempts?: number;
  /** 首次退避，默认 1000ms */
  baseDelayMs?: number;
  /** 退避上限，默认 8000ms */
  maxDelayMs?: number;
  /** 日志标签 */
  label?: string;
  /** 判断某个错误是否值得重试；默认只重试 ProviderError.retryable */
  shouldRetry?: (error: unknown) => boolean;
  /** 自定义重试回调（默认打日志） */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** 引擎明确标记为可重试的错误：网络 / 限流 / 5xx / 超时 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

/** 可重试错误的用户可读原因（写进任务失败信息里） */
export function describeRetryFailure(error: unknown, attempts: number): string {
  const message = (error as Error)?.message ?? '未知错误';
  return `连续 ${attempts} 次请求失败（${message}），已停止自动重试；网络恢复后可在任务上点「重试」续查远端任务，不会重复计费。`;
}

export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(50, options.baseDelayMs ?? 1_000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 8_000);
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  const label = options.label ?? '请求';
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      // 指数退避 + 一点抖动，避免多个任务同时恢复时一起打远端
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(backoff * (0.85 + Math.random() * 0.3));
      if (options.onRetry) options.onRetry(error, attempt, delayMs);
      else {
        log.warn(`${label}失败（${attempt}/${attempts}）：${(error as Error).message}，${delayMs}ms 后重试`);
      }
      await delay(delayMs);
    }
  }

  throw lastError;
}

function delay(ms: number): Promise<void> {
  // 注意：这里不能 unref —— 独立调用（例如自测脚本、一次性任务）时没有其它句柄，
  // unref 会让进程在退避期间直接退出，重试逻辑就“静默消失”了。
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
