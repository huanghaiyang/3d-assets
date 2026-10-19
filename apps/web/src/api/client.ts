import type {
  CommitUploadResponse,
  CreateJobBody,
  Job,
  ProviderId,
  ProviderSummary,
  SettingsSummary,
  StateResponse,
  UploadInfo,
  VerifyResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new ApiError(`无法连接本地服务：${(err as Error).message}`, 0);
  }

  const text = await response.text();
  const payload = text ? (safeParse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

function providerQuery(provider?: ProviderId | null): string {
  return provider ? `?provider=${encodeURIComponent(provider)}` : '';
}

export const api = {
  state: (limit = 300) => request<StateResponse>(`/api/state?limit=${limit}`),
  settings: () => request<SettingsSummary>('/api/settings'),
  providers: () => request<{ providers: ProviderSummary[] }>('/api/providers'),

  saveApiKey: (provider: ProviderId, apiKey: string) =>
    request<SettingsSummary>(`/api/settings/api-key${providerQuery(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey, provider }),
    }),
  clearApiKey: (provider: ProviderId) =>
    request<SettingsSummary>(`/api/settings/api-key${providerQuery(provider)}`, { method: 'DELETE' }),
  saveBaseUrl: (provider: ProviderId, baseUrl: string) =>
    request<SettingsSummary>(`/api/settings/base-url${providerQuery(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ baseUrl, provider }),
    }),
  setActiveProvider: (provider: ProviderId) =>
    request<SettingsSummary>('/api/settings/active-provider', {
      method: 'PUT',
      body: JSON.stringify({ provider }),
    }),
  verifyApiKey: (provider?: ProviderId | null) =>
    request<VerifyResponse>(`/api/settings/verify${providerQuery(provider)}`, {
      method: 'POST',
      body: JSON.stringify(provider ? { provider } : {}),
    }),

  createJob: (body: CreateJobBody) => request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  retryJob: (id: string) =>
    request<{ ok: boolean; mode: 'resume' | 'resubmit'; message: string }>(`/api/jobs/${id}/retry`, {
      method: 'POST',
      body: '{}',
    }),
  cancelJob: (id: string) =>
    request<{ ok: boolean; remote: 'ok' | 'unsupported' | 'failed' | 'not-submitted'; message: string }>(
      `/api/jobs/${id}/cancel`,
      { method: 'POST', body: '{}' },
    ),
  deleteJob: (id: string) => request<{ ok: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' }),
  renameJob: (id: string, name: string) =>
    request<Job>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  uploadThumbnail: (id: string, dataUrl: string) =>
    request<{ ok: boolean; thumbnailUrl?: string; skipped?: boolean }>(`/api/jobs/${id}/thumbnail`, {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    }),
  /** 后端 worker 子线程渲染封面（不占浏览器主线程；失败时回退到 uploadThumbnail） */
  generateCover: (id: string, options: { size?: number; force?: boolean } = {}) =>
    request<{
      ok: boolean;
      thumbnailUrl?: string;
      reason?: string;
      cached?: boolean;
      format?: string;
      engine?: string;
      regenerated?: boolean;
    }>(`/api/jobs/${id}/cover`, {
      method: 'POST',
      body: JSON.stringify({ size: options.size ?? 256, force: options.force === true }),
    }),

  // ===== 素材库上传 =====
  uploadInfo: () => request<UploadInfo>('/api/library/upload-info'),
  /**
   * 逐个文件以原始字节流暂存（服务端流式落盘，批量上传即多次调用）。
   * 用 XHR 而不是 fetch：只有 XHR 能拿到上传进度，并且可以中途 abort（取消整批上传）。
   */
  stageFile: (
    batchId: string,
    file: File,
    options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
  ) => uploadWithProgress(batchId, file, options),
  commitUpload: (batchId: string) =>
    request<CommitUploadResponse>('/api/library/commit', {
      method: 'POST',
      body: JSON.stringify({ batchId }),
    }),
  abortUpload: (batchId: string) =>
    request<{ ok: boolean }>(`/api/library/staging/${encodeURIComponent(batchId)}`, { method: 'DELETE' }),
};

function uploadWithProgress(
  batchId: string,
  file: File,
  options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal },
): Promise<{ ok: boolean; name: string; size: number }> {
  return new Promise((resolve, reject) => {
    const url = `/api/library/staging/${encodeURIComponent(batchId)}?filename=${encodeURIComponent(file.name)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      const text = xhr.responseText;
      let payload: Record<string, unknown> = {};
      try {
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        payload = { error: text.slice(0, 300) };
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as { ok: boolean; name: string; size: number });
        return;
      }
      const message = typeof payload.error === 'string' ? payload.error : `请求失败（HTTP ${xhr.status}）`;
      reject(new ApiError(message, xhr.status));
    });
    xhr.addEventListener('error', () => reject(new ApiError('无法连接本地服务', 0)));
    xhr.addEventListener('timeout', () => reject(new ApiError('上传超时', 0)));
    xhr.addEventListener('abort', () => {
      const error = new Error('上传已取消');
      error.name = 'AbortError';
      reject(error);
    });
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    try {
      xhr.send(file);
    } catch (err) {
      reject(new ApiError(`上传失败：${(err as Error).message}`, 0));
    }
  });
}

/** 触发浏览器下载；asAttachment=true 时带上 download=1 让服务端返回附件响应头 */
export function downloadUrl(url: string, asAttachment = false): void {
  if (!url) return;
  const link = document.createElement('a');
  link.href = asAttachment ? `${url}${url.includes('?') ? '&' : '?'}download=1` : url;
  if (asAttachment) link.download = '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
