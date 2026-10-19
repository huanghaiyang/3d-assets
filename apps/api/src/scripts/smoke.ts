/**
 * 端到端冒烟测试：直接调用某个生成引擎提交一个任务并轮询到结束。
 *
 *   npm run smoke -- --prompt "一只低多边形小猫" --faces 5000 --yes
 *   npm run smoke -- --provider tripo3d --prompt "一只小猫" --yes
 *   npm run smoke -- --provider meshy --yes
 *
 * 注意：这会真实消耗账号积分，请确认后再执行。
 */
import { config, providerEnvOf, type ProviderEnvConfig } from '../config.js';
import { getProvider } from '../providers/registry.js';
import type { ProviderContext } from '../providers/types.js';
import { deriveName, materializeAsset } from '../services/assets.js';
import { FACE_COUNT_DEFAULT, type GenerationParams, type ProviderMeta } from '../store/types.js';
import { parseParams } from '../routes/validate.js';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function resolveContext(env: ProviderEnvConfig): ProviderContext | null {
  const apiKey = arg('api-key') ?? env.envApiKey;
  if (!apiKey) return null;
  return { apiKey, baseUrl: arg('base-url') ?? env.envBaseUrl ?? env.defaultBaseUrl };
}

async function main(): Promise<void> {
  const provider = getProvider(arg('provider', 'hunyuan3d'));
  const env = providerEnvOf(provider.info.id);
  const ctx = resolveContext(env);
  if (!ctx) {
    console.error(`缺少 API Key：请在 .env 设置 ${provider.info.envKeyName}，或传 --api-key`);
    process.exit(1);
  }

  const prompt = arg('prompt', '一个低多边形的白色陶瓷小猫摆件')!;
  const faces = Number.parseInt(arg('faces', String(FACE_COUNT_DEFAULT))!, 10);

  let params: GenerationParams;
  try {
    params = parseParams(
      {
        provider: provider.info.id,
        model: arg('model', provider.info.defaults.model),
        faceCount: faces,
        generateType: 'Normal',
        resultFormat: arg('format', 'GLB'),
      },
      provider,
    );
  } catch (err) {
    console.error('参数不合法:', (err as Error).message);
    process.exit(1);
  }

  if (!hasFlag('yes')) {
    console.log('将提交真实生成任务（会消耗账号积分）:');
    console.log({ provider: provider.info.id, baseUrl: ctx.baseUrl, params, prompt });
    console.log('确认无误请追加 --yes 参数重新执行。');
    process.exit(0);
  }

  console.log(`[1/3] 提交任务 [${provider.info.label}]: "${prompt}"`);
  const submitted = await provider.submit(ctx, params, { mode: 'text', prompt, image: null, views: [] });
  let remoteJobId = submitted.remoteJobId;
  let meta: ProviderMeta = { ...(submitted.meta ?? {}) };
  console.log(`      remoteJobId=${remoteJobId} requestId=${submitted.requestId ?? '-'}`);

  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    const result = await provider.query(ctx, remoteJobId, meta);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    if (result.nextRemoteJobId) remoteJobId = result.nextRemoteJobId;
    meta = { ...meta, ...(result.meta ?? {}) };

    if (result.status === 'WAIT' || result.status === 'RUN') {
      console.log(`[2/3] ${result.remoteStatus ?? result.status} … 已等待 ${seconds}s`);
      continue;
    }
    if (result.status === 'FAIL') {
      console.error(`[2/3] 任务失败: ${result.errorCode} ${result.errorMessage ?? ''}`);
      process.exit(2);
    }
    console.log(`[2/3] DONE，耗时 ${seconds}s，消耗积分 ${result.creditConsumed ?? '未知'}`);
    for (const file of result.files ?? []) {
      console.log(`      ${file.type}: ${file.url}`);
    }

    const asset = await materializeAsset({
      download: (url) => provider.download(ctx, url),
      jobId: `smoke_${remoteJobId}`,
      name: deriveName(prompt, 'text'),
      prompt,
      mode: 'text',
      params,
      files: result.files ?? [],
      creditConsumed: result.creditConsumed ?? null,
      creditDetails: result.creditDetails ?? null,
    });
    console.log(`[3/3] 已转存 ${asset.files.length} 组文件，共 ${(asset.bytes / 1024).toFixed(1)}KB`);
    for (const file of asset.files) {
      console.log(
        `      ${file.type}${file.wasZip ? ' (zip)' : ''} 主文件=${file.primaryUrl ?? '无'} 条目=${file.entries.length}`,
      );
    }
    console.log(`      缩略图=${asset.thumbnailUrl ?? '无'}`);
    return;
  }
}

main().catch((err: unknown) => {
  console.error('冒烟测试失败:', (err as Error).stack ?? err);
  process.exit(1);
});
