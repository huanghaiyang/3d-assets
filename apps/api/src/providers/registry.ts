/**
 * 生成引擎注册表。
 *
 * 新增一个三方引擎只需要：
 *   1. 在 providers/ 下实现 GenerationProvider
 *   2. 加到 PROVIDER_IDS（store/types.ts）与这里的 REGISTRY
 *   3. 前端会自动出现引擎选项，参数表单按 capabilities 自动裁剪
 */

import { DEFAULT_PROVIDER_ID, PROVIDER_IDS, type GenerationParams, type ProviderId } from '../store/types.js';
import { hunyuan3dProvider } from './hunyuan3d.js';
import { meshyProvider } from './meshy.js';
import { tripo3dProvider } from './tripo3d.js';
import { ProviderError, type GenerationProvider } from './types.js';

const REGISTRY: Record<ProviderId, GenerationProvider> = {
  hunyuan3d: hunyuan3dProvider,
  tripo3d: tripo3dProvider,
  meshy: meshyProvider,
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** 按 id 取引擎；未知 id 抛 ProviderError（路由会转成 400） */
export function getProvider(id: string | null | undefined): GenerationProvider {
  const key = id && id.trim() ? id.trim() : DEFAULT_PROVIDER_ID;
  if (!isProviderId(key)) {
    throw new ProviderError(
      `未知的生成引擎「${key}」，可选：${PROVIDER_IDS.join(' / ')}`,
      'InvalidParameter.Provider',
    );
  }
  return REGISTRY[key];
}

export function listProviders(): GenerationProvider[] {
  return PROVIDER_IDS.map((id) => REGISTRY[id]);
}

/** 引擎的默认参数（切换引擎时使用） */
export function providerDefaults(id: string | null | undefined): GenerationParams {
  return { ...getProvider(id).info.defaults };
}

export { DEFAULT_PROVIDER_ID };
