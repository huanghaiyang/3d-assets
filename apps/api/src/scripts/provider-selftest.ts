/**
 * 生成引擎自测：用 mock 的 fetch 跑通三个引擎的「提交 → 轮询 → 下载 → 转存」链路，
 * 不联网、不消耗任何积分，用来验证适配器字段映射与多步流程（Meshy preview → refine）。
 *
 *   npm run test:providers -w @h3d/api
 */
import { getProvider, listProviders, providerDefaults } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import type { GenerationParams, ProviderMeta } from '../store/types.js';
import { materializeAsset, removeAssetFiles } from '../services/assets.js';
import { withRetry } from '../services/retry.js';
import { parseCreateJobBody, parseParams, ValidationError } from '../routes/validate.js';

type Handler = (url: string, init: RequestInit) => unknown;

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

const requests: Recorded[] = [];
let handlers: { match: RegExp; handler: Handler }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function binary(body: Buffer, contentType = 'application/octet-stream'): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': contentType } });
}

function parseBody(init: RequestInit): unknown {
  const body = init.body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  return body instanceof FormData ? { formData: true } : body;
}

/** 安装 mock fetch（所有适配器都走全局 fetch） */
function installMockFetch(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    requests.push({ url, method: init.method ?? 'GET', body: parseBody(init) });
    const matched = handlers.find((item) => item.match.test(url));
    if (!matched) return json({ message: `mock fetch 未处理: ${url}` }, 500);
    const result = matched.handler(url, init);
    if (result instanceof Response) return result;
    return json(result);
  }) as typeof fetch;
}

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail === undefined ? '' : detail);
  }
}

function lastRequest(): Recorded {
  return requests[requests.length - 1]!;
}

function requestsTo(pattern: RegExp): Recorded[] {
  return requests.filter((item) => pattern.test(item.url));
}

const CTX = { apiKey: 'test-key', baseUrl: 'https://mock.local' };
const TEXT_INPUT = { mode: 'text' as const, prompt: '一只小猫', image: null, views: [] };
const IMAGE_INPUT = {
  mode: 'image' as const,
  prompt: '',
  image: { base64: Buffer.from('fake-image').toString('base64'), name: 'ref.png' },
  views: [],
};

async function testRegistry(): Promise<void> {
  console.log('\n[registry]');
  const list = listProviders();
  check('注册了 3 个引擎', list.length === 3, list.map((item) => item.info.id));
  check('默认引擎是 hunyuan3d', getProvider(undefined).info.id === 'hunyuan3d');
  check('未知引擎会报错', (() => {
    try {
      getProvider('nope');
      return false;
    } catch {
      return true;
    }
  })());
  check('默认参数来自引擎', providerDefaults('tripo3d').provider === 'tripo3d');
}

async function testHunyuan(): Promise<void> {
  console.log('\n[hunyuan3d]');
  const provider = getProvider('hunyuan3d');
  let queryCount = 0;
  handlers = [
    {
      match: /\/v1\/ai3d\/submit$/,
      handler: () => ({ Response: { JobId: 'hy-1', RequestId: 'req-1' } }),
    },
    {
      match: /\/v1\/ai3d\/query$/,
      handler: () => {
        queryCount += 1;
        if (queryCount === 1) return { Response: { Status: 'RUN', RequestId: 'req-2' } };
        return {
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [{ Type: 'GLB', Url: 'https://cdn.local/hy.glb', PreviewImageUrl: 'https://cdn.local/hy.png' }],
            ResultCreditConsumed: 20,
            ResultCreditDetails: '{"GenerateType-Normal":20}',
          },
        };
      },
    },
    { match: /cdn\.local\/hy\.glb$/, handler: () => binary(Buffer.from('glTF-bytes')) },
    { match: /cdn\.local\/hy\.png$/, handler: () => binary(Buffer.from('png-bytes'), 'image/png') },
  ];

  const params: GenerationParams = {
    ...provider.info.defaults,
    provider: 'hunyuan3d',
    model: '3.0',
    generateType: 'Normal',
    faceCount: 50_000,
    enablePbr: true,
    resultFormat: 'GLB',
  };
  const submitted = await provider.submit(CTX, params, TEXT_INPUT);
  check('提交返回 JobId', submitted.remoteJobId === 'hy-1', submitted);
  const submitBody = lastRequest().body as Record<string, unknown>;
  check('提交体是 PascalCase', submitBody.Model === '3.0' && submitBody.Prompt === '一只小猫' && submitBody.EnablePBR === true, submitBody);

  const first = await provider.query(CTX, submitted.remoteJobId, {});
  check('第一次轮询 RUN', first.status === 'RUN', first.status);
  const done = await provider.query(CTX, submitted.remoteJobId, {});
  check('第二次轮询 DONE', done.status === 'DONE', done);
  check('结果文件映射', done.files?.length === 1 && done.files[0]?.url.endsWith('hy.glb'), done.files);
  check('积分透出', done.creditConsumed === 20);

  const downloaded = await provider.download(CTX, done.files![0]!.url);
  check('下载结果文件', downloaded.buffer.toString() === 'glTF-bytes');

  // 图生3D：base64 直接进请求体，不带 Prompt
  const imageSubmitted = await provider.submit(CTX, { ...params, resultFormat: null }, IMAGE_INPUT);
  check('图生3D 提交成功', imageSubmitted.remoteJobId === 'hy-1');
  const imageBody = lastRequest().body as Record<string, unknown>;
  check('图片走 ImageBase64 且无 Prompt', typeof imageBody.ImageBase64 === 'string' && imageBody.Prompt === undefined, imageBody);
}

async function testTripo(): Promise<void> {
  console.log('\n[tripo3d]');
  const provider = getProvider('tripo3d');
  let status: 'queued' | 'running' | 'success' = 'queued';
  handlers = [
    {
      match: /\/upload$/,
      handler: () => ({ code: 0, data: { image_token: 'tok-1' } }),
    },
    {
      match: /\/task$/,
      handler: () => ({ code: 0, data: { task_id: 'tripo-1' } }),
    },
    {
      match: /\/task\/tripo-1/,
      handler: () => {
        if (status === 'queued') {
          status = 'running';
          return { code: 0, data: { task_id: 'tripo-1', status: 'queued', progress: 0 } };
        }
        if (status === 'running') {
          status = 'success';
          return { code: 0, data: { task_id: 'tripo-1', status: 'running', progress: 50 } };
        }
        return {
          code: 0,
          data: {
            task_id: 'tripo-1',
            status: 'success',
            progress: 100,
            output: { model: 'https://cdn.local/tripo.glb', pbr_model: 'https://cdn.local/tripo-pbr.glb' },
            credits_consumed: 30,
          },
        };
      },
    },
    { match: /cdn\.local\/tripo/, handler: () => binary(Buffer.from('tripo-glb')) },
    { match: /\/user\/balance$/, handler: () => ({ code: 0, data: { balance: 1234 } }) },
  ];

  const params = parseParams(
    { provider: 'tripo3d', model: 'v2.5-20250123', faceCount: 99_999, generateType: 'Normal', resultFormat: 'GLB' },
    provider,
  );
  check('Tripo 面数被收窄到 20000', params.faceCount === 20_000, params.faceCount);

  const submitted = await provider.submit(CTX, params, TEXT_INPUT);
  const body = lastRequest().body as Record<string, unknown>;
  check('文生3D 走 text_to_model', body.type === 'text_to_model' && body.prompt === '一只小猫', body);
  check('面数映射到 face_limit', body.face_limit === 20_000, body.face_limit);
  check('贴图 / PBR 参数', body.texture === true && body.pbr === false, body);

  const first = await provider.query(CTX, submitted.remoteJobId, {});
  check('queued → WAIT', first.status === 'WAIT', first.status);
  const second = await provider.query(CTX, submitted.remoteJobId, {});
  check('running → RUN', second.status === 'RUN', second.status);
  const third = await provider.query(CTX, submitted.remoteJobId, {});
  check('success → DONE', third.status === 'DONE', third.status);
  check('优先使用 pbr_model', Boolean(third.files?.[0]?.url.endsWith('tripo-pbr.glb')), third.files);
  check('积分透出', third.creditConsumed === 30);

  // 图生3D：先上传拿 file_token
  const imageSubmitted = await provider.submit(CTX, params, IMAGE_INPUT);
  check('图生3D 提交成功', imageSubmitted.remoteJobId === 'tripo-1');
  const uploadReq = requestsTo(/\/upload$/).pop();
  check(
    '上传接口是 multipart',
    Boolean(uploadReq?.body && typeof uploadReq.body === 'object' && (uploadReq.body as { formData?: boolean }).formData === true),
  );
  const imageBody = lastRequest().body as Record<string, unknown>;
  const file = imageBody.file as { file_token?: string } | undefined;
  check('图生3D 带 file_token', imageBody.type === 'image_to_model' && file?.file_token === 'tok-1', imageBody);

  const verify = await provider.verify(CTX);
  check('余额校验通过', verify.ok && verify.message.includes('1234'), verify);
}

async function testMeshy(): Promise<void> {
  console.log('\n[meshy]');
  const provider = getProvider('meshy');
  let previewStatus: 'PENDING' | 'SUCCEEDED' = 'PENDING';
  let refineStatus: 'IN_PROGRESS' | 'SUCCEEDED' = 'IN_PROGRESS';
  handlers = [
    {
      match: /\/text-to-3d$/,
      handler: (_url, init) => {
        const body = JSON.parse(String(init.body)) as { mode?: string; preview_task_id?: string };
        if (body.mode === 'refine') {
          check('refine 携带 preview_task_id', body.preview_task_id === 'ms-1', body);
          return { result: 'ms-2' };
        }
        return { result: 'ms-1' };
      },
    },
    {
      match: /\/text-to-3d\/ms-1$/,
      handler: () => {
        if (previewStatus === 'PENDING') {
          previewStatus = 'SUCCEEDED';
          return { id: 'ms-1', status: 'PENDING', progress: 10 };
        }
        return {
          id: 'ms-1',
          status: 'SUCCEEDED',
          progress: 100,
          model_urls: { glb: 'https://cdn.local/ms-preview.glb' },
          thumbnail_url: 'https://cdn.local/ms.png',
        };
      },
    },
    {
      match: /\/text-to-3d\/ms-2$/,
      handler: () => {
        if (refineStatus === 'IN_PROGRESS') {
          refineStatus = 'SUCCEEDED';
          return { id: 'ms-2', status: 'IN_PROGRESS', progress: 40 };
        }
        return {
          id: 'ms-2',
          status: 'SUCCEEDED',
          progress: 100,
          model_urls: {
            glb: 'https://cdn.local/ms.glb',
            fbx: 'https://cdn.local/ms.fbx',
            obj: 'https://cdn.local/ms.obj',
            usdz: 'https://cdn.local/ms.usdz',
          },
          thumbnail_url: 'https://cdn.local/ms.png',
        };
      },
    },
    {
      match: /\/image-to-3d$/,
      handler: () => ({ result: 'ms-img-1' }),
    },
    {
      match: /\/image-to-3d\/ms-img-1$/,
      handler: () => ({
        id: 'ms-img-1',
        status: 'SUCCEEDED',
        progress: 100,
        model_urls: { glb: 'https://cdn.local/ms-img.glb' },
      }),
    },
    { match: /cdn\.local\/ms/, handler: () => binary(Buffer.from('meshy-glb')) },
    { match: /\/text-to-3d\?page_size=1$/, handler: () => ({ result: [] }) },
  ];

  // 文生3D：preview → refine 两阶段
  const params = parseParams(
    { provider: 'meshy', model: 'meshy-5', faceCount: 32_000, generateType: 'Normal', resultFormat: 'GLB' },
    provider,
  );
  const submitted = await provider.submit(CTX, params, TEXT_INPUT);
  const submitBody = lastRequest().body as Record<string, unknown>;
  check('文生3D 先提交 preview', submitBody.mode === 'preview' && submitBody.prompt === '一只小猫', submitBody);
  check('面数映射到 target_polycount', submitBody.target_polycount === 32_000, submitBody.target_polycount);
  check('preview 元信息落 meta', submitted.meta?.needsRefine === true && submitted.meta?.kind === 'text', submitted.meta);

  let remoteId = submitted.remoteJobId;
  let meta: ProviderMeta = { ...(submitted.meta ?? {}) };
  const first = await provider.query(CTX, remoteId, meta);
  check('preview 排队 → WAIT', first.status === 'WAIT', first.status);

  const previewDone = await provider.query(CTX, remoteId, meta);
  check('preview 完成自动提交 refine', previewDone.nextRemoteJobId === 'ms-2' && previewDone.status === 'RUN', previewDone);
  remoteId = previewDone.nextRemoteJobId!;
  meta = { ...meta, ...(previewDone.meta ?? {}) };

  const refineRunning = await provider.query(CTX, remoteId, meta);
  check('refine 进行中 → RUN', refineRunning.status === 'RUN', refineRunning.status);

  const refineDone = await provider.query(CTX, remoteId, meta);
  check('refine 完成 → DONE', refineDone.status === 'DONE', refineDone);
  check('结果文件按格式映射', Boolean(refineDone.files?.[0]?.url.endsWith('ms.glb')), refineDone.files);

  // 白模：不做 refine
  const geometryParams = parseParams(
    { provider: 'meshy', generateType: 'Geometry', faceCount: 30_000 },
    provider,
  );
  const geometryJob = await provider.submit(CTX, geometryParams, TEXT_INPUT);
  check('白模不触发 refine', geometryJob.meta?.needsRefine === false, geometryJob.meta);

  // 图生3D
  const imageJob = await provider.submit(CTX, params, IMAGE_INPUT);
  const imageBody = lastRequest().body as Record<string, unknown>;
  check('图生3D 传 data URI', typeof imageBody.image_url === 'string' && String(imageBody.image_url).startsWith('data:image/'), imageBody);
  const imageDone = await provider.query(CTX, imageJob.remoteJobId, imageJob.meta ?? {});
  check('图生3D 直接 DONE', Boolean(imageDone.status === 'DONE' && imageDone.files?.length === 1), imageDone);

  const verify = await provider.verify(CTX);
  check('Key 校验通过', verify.ok, verify);
}

async function testValidation(): Promise<void> {
  console.log('\n[validation / capabilities]');
  const expectFail = (name: string, fn: () => unknown): void => {
    try {
      fn();
      check(name, false, '应当抛错但没有');
    } catch (err) {
      check(name, err instanceof ValidationError, (err as Error).message);
    }
  };

  expectFail('Meshy 不支持 Sketch', () =>
    parseParams({ provider: 'meshy', generateType: 'Sketch' }, getProvider('meshy')),
  );
  expectFail('Tripo 不支持 OBJ 输出', () =>
    parseParams({ provider: 'tripo3d', resultFormat: 'OBJ' }, getProvider('tripo3d')),
  );
  expectFail('混元 3.1 不支持 LowPoly', () =>
    parseParams({ provider: 'hunyuan3d', model: '3.1', generateType: 'LowPoly' }, getProvider('hunyuan3d')),
  );
  expectFail('Meshy 不支持多视角输入', () =>
    parseCreateJobBody({
      mode: 'multiview',
      params: { provider: 'meshy' },
      views: [{ viewType: 'left', imageBase64: Buffer.from('x').toString('base64') }],
    }),
  );

  const meshyMultiview = getProvider('meshy').info.capabilities;
  check('Meshy 能力声明含多视角=false', meshyMultiview.multiview === false);
  check('Meshy 支持格式含 USDZ', meshyMultiview.formats.includes('USDZ'));

  const parsed = parseCreateJobBody({ mode: 'text', prompt: '小猫', params: { provider: 'tripo3d' } });
  check('创建任务默认用指定引擎', parsed.params.provider === 'tripo3d' && parsed.provider.info.id === 'tripo3d');
}

async function testMaterialize(): Promise<void> {
  console.log('\n[asset materialize]');
  const jobId = `selftest_${Date.now().toString(36)}`;
  try {
    const asset = await materializeAsset({
      download: async () => ({ buffer: Buffer.from('glb-binary'), contentType: 'model/gltf-binary' }),
      jobId,
      name: '自测模型',
      prompt: 'selftest',
      mode: 'text',
      params: { ...providerDefaults('hunyuan3d'), provider: 'hunyuan3d' },
      files: [{ type: 'GLB', url: 'https://cdn.local/x.glb', previewImageUrl: null }],
      creditConsumed: 1,
      creditDetails: null,
    });
    check('转存出主模型文件', asset.files.length === 1 && Boolean(asset.files[0]?.primaryUrl), asset.files);
    check('统计字节数', asset.bytes === 'glb-binary'.length, asset.bytes);
  } finally {
    await removeAssetFiles(jobId);
  }
}

async function testRetry(): Promise<void> {
  console.log('\n[retry / cancel]');
  const silent = { onRetry: () => {} };

  let calls = 0;
  const value = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new ProviderError('网络抖动', 'NetworkError');
      return 'ok';
    },
    { attempts: 4, baseDelayMs: 5, ...silent },
  );
  check('可重试错误重试后成功', value === 'ok' && calls === 3, { calls });

  let exhausted = 0;
  let threw = false;
  try {
    await withRetry(
      async () => {
        exhausted += 1;
        throw new ProviderError('一直失败', 'NetworkError');
      },
      { attempts: 3, baseDelayMs: 5, ...silent },
    );
  } catch {
    threw = true;
  }
  check('重试耗尽后抛出原错误', threw && exhausted === 3, { exhausted, threw });

  let nonRetryCalls = 0;
  try {
    await withRetry(
      async () => {
        nonRetryCalls += 1;
        throw new ProviderError('参数错误', 'InvalidParameter.Foo');
      },
      { attempts: 3, baseDelayMs: 5, ...silent },
    );
  } catch {
    /* 预期抛出 */
  }
  check('不可重试错误只尝试一次', nonRetryCalls === 1, nonRetryCalls);
}

async function testCancel(): Promise<void> {
  check('混元引擎没有远端取消接口（契约可选）', getProvider('hunyuan3d').cancel === undefined);

  handlers = [
    {
      match: /\/task\/tripo-cancel\/cancel$/,
      handler: (_url, init) => {
        check('Tripo 取消用 POST /task/{id}/cancel', (init.method ?? '') === 'POST');
        return { code: 0, data: {} };
      },
    },
    { match: /\/task\/tripo-gone\/cancel$/, handler: () => json({ message: 'not found' }, 404) },
  ];
  check('Tripo 取消成功返回 true', (await getProvider('tripo3d').cancel!(CTX, 'tripo-cancel', {})) === true);
  check('Tripo 404 视为不支持（返回 false）', (await getProvider('tripo3d').cancel!(CTX, 'tripo-gone', {})) === false);

  handlers = [
    {
      match: /\/text-to-3d\/ms-cancel$/,
      handler: (_url, init) => {
        check('Meshy 取消用 DELETE /{kind}/{id}', (init.method ?? '') === 'DELETE');
        return { ok: true };
      },
    },
    { match: /\/image-to-3d\/ms-gone$/, handler: () => json({ message: 'method not allowed' }, 405) },
  ];
  check(
    'Meshy 文生任务取消成功返回 true',
    (await getProvider('meshy').cancel!(CTX, 'ms-cancel', { kind: 'text' })) === true,
  );
  check(
    'Meshy 405 视为不支持（返回 false）',
    (await getProvider('meshy').cancel!(CTX, 'ms-gone', { kind: 'image' })) === false,
  );
}

async function main(): Promise<void> {
  installMockFetch();
  console.log('生成引擎自测（mock 网络，不消耗积分）');
  await testRegistry();
  await testHunyuan();
  await testTripo();
  await testMeshy();
  await testValidation();
  await testMaterialize();
  await testRetry();
  await testCancel();

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('自测异常退出:', (err as Error).stack ?? err);
  process.exit(1);
});
