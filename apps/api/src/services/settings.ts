import { providerEnvOf } from '../config.js';
import { getProvider } from '../providers/registry.js';
import type { ProviderContext, ProviderVerifyResult } from '../providers/types.js';
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS, type ProviderId } from '../store/types.js';
import type { Workspace } from '../store/workspace.js';

export type ApiKeySource = 'settings' | 'env' | 'none';

/** 校验并归一化引擎 id（未知值回落到默认引擎） */
export function toProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as ProviderId;
  }
  return DEFAULT_PROVIDER_ID;
}

/** 当前界面选中的引擎 */
export function activeProvider(workspace: Workspace): ProviderId {
  return toProviderId(workspace.settings.activeProvider);
}

/** 某个引擎的凭据：界面设置优先，其次 .env */
export function providerCredential(
  workspace: Workspace,
  id: ProviderId,
): { apiKey: string | null; baseUrl: string; source: ApiKeySource } {
  const env = providerEnvOf(id);
  const stored = workspace.settings.providers?.[id];
  const fromSettings = stored?.apiKey?.trim() || null;
  const apiKey = fromSettings ?? env.envApiKey;
  const baseUrl = (stored?.baseUrl?.trim() || env.envBaseUrl || env.defaultBaseUrl).replace(/\/+$/, '');
  return { apiKey, baseUrl, source: fromSettings ? 'settings' : env.envApiKey ? 'env' : 'none' };
}

export function resolveProviderKey(workspace: Workspace, id: ProviderId): string | null {
  return providerCredential(workspace, id).apiKey;
}

export function apiKeySource(workspace: Workspace, id: ProviderId): ApiKeySource {
  return providerCredential(workspace, id).source;
}

export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 10) return `${key.slice(0, 3)}****`;
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

/** 构造调用引擎所需的上下文；没有 Key 时返回 null */
export function providerContext(workspace: Workspace, id: ProviderId): ProviderContext | null {
  const { apiKey, baseUrl } = providerCredential(workspace, id);
  if (!apiKey) return null;
  return { apiKey, baseUrl };
}

export interface VerifyResult extends ProviderVerifyResult {}

/** 校验某个引擎的 Key / 连通性 */
export async function verifyProviderKey(workspace: Workspace, id: ProviderId): Promise<VerifyResult> {
  const provider = getProvider(id);
  const ctx = providerContext(workspace, id);
  if (!ctx) {
    return {
      ok: false,
      message: `尚未配置${provider.info.label}的 API Key（可写入 .env 的 ${provider.info.envKeyName}）`,
    };
  }
  try {
    return await provider.verify(ctx);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
