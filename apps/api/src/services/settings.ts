import { config } from '../config.js';
import { Hunyuan3DClient, HunyuanApiError } from '../hunyuan/client.js';
import type { Workspace } from '../store/workspace.js';

export type ApiKeySource = 'settings' | 'env' | 'none';

/** 界面中填写的 Key 优先于 .env */
export function resolveApiKey(workspace: Workspace): string | null {
  const fromSettings = workspace.settings.apiKey?.trim();
  if (fromSettings) return fromSettings;
  return config.envApiKey;
}

export function apiKeySource(workspace: Workspace): ApiKeySource {
  if (workspace.settings.apiKey?.trim()) return 'settings';
  if (config.envApiKey) return 'env';
  return 'none';
}

export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 10) return `${key.slice(0, 3)}****`;
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

export interface VerifyResult {
  ok: boolean;
  message: string;
  requestId?: string;
}

/**
 * 验证 API Key 是否可用。
 * 用一个不存在的 JobId 调查询接口：返回“任务不存在”说明鉴权通过。
 */
export async function verifyApiKey(workspace: Workspace): Promise<VerifyResult> {
  const apiKey = resolveApiKey(workspace);
  if (!apiKey) return { ok: false, message: '尚未配置 API Key' };
  try {
    const client = new Hunyuan3DClient({ apiKey, baseUrl: config.baseUrl });
    await client.queryJob('0');
    return { ok: true, message: 'API Key 有效（接口返回异常任务状态）' };
  } catch (err) {
    if (err instanceof HunyuanApiError) {
      if (err.code === 'FailedOperation.JobNotFound') {
        return { ok: true, message: 'API Key 有效，接口连通正常' };
      }
      return { ok: false, message: err.message, requestId: err.requestId };
    }
    return { ok: false, message: (err as Error).message };
  }
}
