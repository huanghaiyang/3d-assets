/**
 * 三方引擎通用的 HTTP 客户端：超时、网络重试、错误归一化。
 *
 * 各引擎的鉴权头、请求体、错误信封都不一样，这里只负责“把 HTTP 层变得可控”，
 * 具体的请求构造与响应对齐交给适配器。
 */

import { createLogger } from '../lib/logger.js';
import { ProviderError } from './types.js';

const log = createLogger('provider-http');

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  timeoutMs?: number;
  /** 仅对网络层错误重试的次数（默认 2） */
  retries?: number;
  /** 日志用的接口标签，如 'Tripo submit' */
  label?: string;
}

export interface HttpTextResult {
  response: Response;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_SNIPPET = 300;

/** 发起请求并读取文本响应；HTTP 非 2xx 抛 ProviderError */
export async function httpText(url: string, options: HttpOptions = {}): Promise<HttpTextResult> {
  const response = await httpRaw(url, options);
  const text = await response.text().catch(() => '');
  return { response, text };
}

/** 发起请求并解析 JSON；HTTP 非 2xx 抛 ProviderError */
export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<{ data: T; response: Response }> {
  const { response, text } = await httpText(url, options);
  if (!text) return { data: {} as T, response };
  try {
    return { data: JSON.parse(text) as T, response };
  } catch {
    throw new ProviderError(
      `${options.label ?? '接口'}返回了无法解析的响应：${text.slice(0, MAX_ERROR_SNIPPET)}`,
      'InternalError.BadResponse',
      { httpStatus: response.status },
    );
  }
}

/** 下载二进制（结果文件 / 缩略图） */
export async function httpBuffer(
  url: string,
  options: HttpOptions = {},
): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await httpRaw(url, { ...options, timeoutMs: options.timeoutMs ?? 180_000 });
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType };
}

/** 原始请求（只在状态码检查后返回 Response） */
export async function httpRaw(url: string, options: HttpOptions = {}): Promise<Response> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;

      const snippet = await response.text().catch(() => '');
      throw mapHttpError(response.status, snippet, options.label);
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError) throw err;
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        log.warn(`${options.label ?? url} 超时（${attempt + 1}/${retries + 1}）`);
        continue;
      }
      log.warn(`${options.label ?? url} 网络错误（${attempt + 1}/${retries + 1}）：${(err as Error).message}`);
      await sleep(400 * (attempt + 1));
    }
  }

  throw new ProviderError(
    `无法连接${options.label ?? '远端接口'}：${(lastError as Error)?.message ?? 'unknown'}`,
    'NetworkError',
  );
}

/** 把 HTTP 状态码映射成统一错误码 */
function mapHttpError(status: number, snippet: string, label?: string): ProviderError {
  const detail = extractMessage(snippet);
  if (status === 401 || status === 403) {
    return new ProviderError(detail || 'API Key 无效或已过期，请重新配置。', 'AuthFailure.InvalidApiKey', {
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new ProviderError(detail || '请求过于频繁（限流），请稍后重试。', 'RateLimited', { httpStatus: status });
  }
  if (status === 404) {
    return new ProviderError(detail || '远端资源不存在', 'NotFound', { httpStatus: status });
  }
  if (status >= 400 && status < 500) {
    return new ProviderError(detail || `${label ?? '接口'}请求参数不合法（HTTP ${status}）`, 'InvalidParameter', {
      httpStatus: status,
    });
  }
  return new ProviderError(detail || `${label ?? '接口'}返回 HTTP ${status}`, 'InternalError.HttpStatus', {
    httpStatus: status,
  });
}

/** 从各种错误信封里尽力取出人类可读的 message */
export function extractMessage(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const candidates = [
      body.message,
      body.msg,
      body.error,
      body.detail,
      body.error_message,
      (body.error as Record<string, unknown> | undefined)?.message,
      (body.data as Record<string, unknown> | undefined)?.message,
      (body.data as Record<string, unknown> | undefined)?.error_message,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    /* 非 JSON，直接截断原文 */
  }
  return text.slice(0, MAX_ERROR_SNIPPET);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 由 base64 与文件名推断图片 MIME / 扩展名 */
export function imageMimeOf(name: string | null, defaultMime = 'image/png'): string {
  const ext = (name ?? '').split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'png') return 'image/png';
  return defaultMime;
}

/** 把 base64 转成 data URI（Meshy 这类要求 URL/DataURI 的引擎使用） */
export function toDataUri(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}
