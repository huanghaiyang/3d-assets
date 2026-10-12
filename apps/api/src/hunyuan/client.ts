import { createLogger } from '../lib/logger.js';
import type { QueryJobData, RemoteJobStatus, SubmitJobRequest } from './types.js';

const log = createLogger('hunyuan');

/** 混元接口返回的业务错误 */
export class HunyuanApiError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly httpStatus?: number;

  constructor(message: string, code = 'FailedOperation', requestId?: string, httpStatus?: number) {
    super(message);
    this.name = 'HunyuanApiError';
    this.code = code;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
  }

  /** 网络/超时类错误可以安全重试；参数或鉴权类错误不可以 */
  get retryable(): boolean {
    return this.code === 'NetworkError' || this.code === 'Timeout' || this.code.startsWith('InternalError');
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('尚未配置混元生3D API Key，请在右上角“设置”中填写，或写入 .env 的 HUNYUAN3D_API_KEY。');
    this.name = 'MissingApiKeyError';
  }
}

interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

interface RawResponse {
  Response?: {
    JobId?: string;
    RequestId?: string;
    Status?: string;
    ErrorCode?: string;
    ErrorMessage?: string;
    ResultFile3Ds?: { Type?: string; Url?: string; PreviewImageUrl?: string }[];
    ResultCreditConsumed?: number;
    ResultCreditDetails?: string;
    Error?: { Code?: string; Message?: string };
  };
}

export class Hunyuan3DClient {
  constructor(private readonly options: ClientOptions) {
    if (!options.apiKey) throw new MissingApiKeyError();
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  /** 提交混元生3D专业版任务，成功后返回 JobId */
  async submitJob(payload: SubmitJobRequest): Promise<{ jobId: string; requestId: string }> {
    const body = await this.post<RawResponse>('/v1/ai3d/submit', payload);
    const res = body.Response ?? {};
    if (typeof res.JobId === 'string' && res.JobId.length > 0) {
      return { jobId: res.JobId, requestId: res.RequestId ?? '' };
    }
    throw new HunyuanApiError(
      res.Error?.Message || '提交任务失败：接口未返回 JobId',
      res.Error?.Code || 'FailedOperation',
      res.RequestId,
    );
  }

  /** 查询任务状态与结果 */
  async queryJob(jobId: string): Promise<QueryJobData> {
    const body = await this.post<RawResponse>('/v1/ai3d/query', { JobId: jobId });
    const res = body.Response ?? {};
    if (res.Error) {
      throw new HunyuanApiError(res.Error.Message || '查询任务失败', res.Error.Code || 'FailedOperation', res.RequestId);
    }
    const status = (res.Status ?? '').toUpperCase() as RemoteJobStatus;
    if (!['WAIT', 'RUN', 'FAIL', 'DONE'].includes(status)) {
      throw new HunyuanApiError(
        `查询任务返回未知状态: ${res.Status ?? '(空)'}`,
        'InternalError.UnknownStatus',
        res.RequestId,
      );
    }
    return {
      status,
      errorCode: res.ErrorCode || undefined,
      errorMessage: res.ErrorMessage || undefined,
      files: res.ResultFile3Ds ?? [],
      creditConsumed: res.ResultCreditConsumed,
      creditDetails: res.ResultCreditDetails,
      requestId: res.RequestId,
    };
  }

  /** 下载生成结果文件（有效期 24 小时，必须转存到本地） */
  async download(url: string, timeoutMs = 180_000): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.request(url, { method: 'GET' }, timeoutMs, /* absolute */ true);
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const res = await this.request(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (await res.json()) as T;
  }

  private async request(
    url: string,
    init: RequestInit,
    timeoutMs = this.options.timeoutMs ?? 60_000,
    absolute = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!absolute) headers.set('Authorization', this.options.apiKey);

    let lastError: unknown;
    // 网络抖动自动重试 2 次（仅针对连接层错误）
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 401) {
          const detail = await readError(res);
          throw new HunyuanApiError(
            detail?.message || 'API Key 无效或已过期，请重新配置。',
            'AuthFailure.InvalidApiKey',
            undefined,
            401,
          );
        }
        if (res.status === 400) {
          const raw = (await res.json().catch(() => null)) as { Msg?: string; Code?: number } | null;
          throw new HunyuanApiError(raw?.Msg || '请求参数不合法', `InvalidParameter.${raw?.Code ?? 1001}`, undefined, 400);
        }
        if (!res.ok) {
          const detail = await readError(res);
          throw new HunyuanApiError(
            detail?.message || `接口返回 HTTP ${res.status}`,
            'InternalError.HttpStatus',
            undefined,
            res.status,
          );
        }
        return res;
      } catch (err) {
        lastError = err;
        if (err instanceof HunyuanApiError) throw err;
        const name = (err as Error)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          log.warn(`请求超时(${attempt + 1}/3): ${url}`);
          continue;
        }
        log.warn(`网络错误(${attempt + 1}/3) ${url}: ${(err as Error).message}`);
        await sleep(500 * (attempt + 1));
      }
    }
    throw new HunyuanApiError(
      `无法连接混元接口: ${(lastError as Error)?.message ?? 'unknown'}`,
      'NetworkError',
    );
  }
}

async function readError(res: Response): Promise<{ message?: string } | null> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error ?? null;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
