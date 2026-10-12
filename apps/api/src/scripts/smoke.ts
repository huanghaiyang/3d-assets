/**
 * 端到端冒烟测试：直接调用混元生3D 接口提交一个任务并轮询到结束。
 *
 *   npm run smoke -- --prompt "一只低多边形小猫" --faces 5000 --yes
 *
 * 注意：这会真实消耗账号积分，请确认后再执行。
 */
import { config } from '../config.js';
import { Hunyuan3DClient } from '../hunyuan/client.js';
import { materializeAsset, deriveName } from '../services/assets.js';
import { FACE_COUNT_DEFAULT } from '../hunyuan/types.js';
import type { GenerationParams } from '../store/types.js';

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

async function main(): Promise<void> {
  const apiKey = config.envApiKey ?? process.env.HUNYUAN3D_API_KEY ?? null;
  if (!apiKey) {
    console.error('缺少 API Key：请设置环境变量 HUNYUAN3D_API_KEY 或写入 .env');
    process.exit(1);
  }

  const prompt = arg('prompt', '一个低多边形的白色陶瓷小猫摆件')!;
  const faces = Number.parseInt(arg('faces', String(FACE_COUNT_DEFAULT))!, 10);
  const model = (arg('model', '3.0') as '3.0' | '3.1') ?? '3.0';

  if (!hasFlag('yes')) {
    console.log('将提交真实生成任务（会消耗账号积分）:');
    console.log({ baseUrl: config.baseUrl, model, prompt, faceCount: faces });
    console.log('确认无误请追加 --yes 参数重新执行。');
    process.exit(0);
  }

  const client = new Hunyuan3DClient({ apiKey, baseUrl: config.baseUrl });
  console.log(`[1/3] 提交任务: "${prompt}" (model=${model}, faceCount=${faces})`);
  const submit = await client.submitJob({
    Model: model,
    Prompt: prompt,
    FaceCount: faces,
    GenerateType: 'Normal',
    EnablePBR: false,
    ResultFormat: 'GLB',
  });
  console.log(`      JobId=${submit.jobId} RequestId=${submit.requestId}`);

  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    const result = await client.queryJob(submit.jobId);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    if (result.status === 'WAIT' || result.status === 'RUN') {
      console.log(`[2/3] ${result.status} … 已等待 ${seconds}s`);
      continue;
    }
    if (result.status === 'FAIL') {
      console.error(`[2/3] 任务失败: ${result.errorCode} ${result.errorMessage}`);
      process.exit(2);
    }
    console.log(`[2/3] DONE，耗时 ${seconds}s，消耗积分 ${result.creditConsumed ?? '未知'}`);
    for (const file of result.files) {
      console.log(`      ${file.Type}: ${file.Url}`);
    }

    const params: GenerationParams = {
      model,
      generateType: 'Normal',
      faceCount: faces,
      enablePbr: false,
      polygonType: 'triangle',
      resultFormat: 'GLB',
    };
    const asset = await materializeAsset({
      client,
      jobId: `smoke_${submit.jobId}`,
      name: deriveName(prompt, 'text'),
      prompt,
      mode: 'text',
      params,
      files: result.files,
      creditConsumed: result.creditConsumed ?? null,
      creditDetails: result.creditDetails ?? null,
    });
    console.log(`[3/3] 已转存 ${asset.files.length} 组文件，共 ${(asset.bytes / 1024).toFixed(1)}KB`);
    for (const file of asset.files) {
      console.log(`      ${file.type}${file.wasZip ? ' (zip)' : ''} 主文件=${file.primaryUrl ?? '无'} 条目=${file.entries.length}`);
    }
    console.log(`      缩略图=${asset.thumbnailUrl ?? '无'}`);
    return;
  }
}

main().catch((err: unknown) => {
  console.error('冒烟测试失败:', (err as Error).stack ?? err);
  process.exit(1);
});
