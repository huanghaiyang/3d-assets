import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getProvider, listProviders, providerDefaults } from '../providers/registry.js';
import type { GenerationProvider } from '../providers/types.js';
import { VIEW_TYPES_31_ONLY } from '../hunyuan/types.js';
import { newId } from '../lib/ids.js';
import { createLogger } from '../lib/logger.js';
import type { GenerationWorker } from '../services/worker.js';
import { deletePayload, savePayload, savePreview, loadPreview } from '../services/payload.js';
import { removeAssetFiles, saveThumbnailDataUrl, saveThumbnailBuffer, pickCoverSourcePath, deriveName } from '../services/assets.js';
import { getCoverRenderer } from '../services/covers.js';
import {
  activeProvider,
  maskApiKey,
  providerCredential,
  verifyProviderKey,
} from '../services/settings.js';
import {
  DEFAULT_PARAMS,
  FACE_COUNT_DEFAULT,
  FACE_COUNT_MAX,
  FACE_COUNT_MIN,
  GENERATE_TYPES,
  IMAGE_BASE64_MAX_BYTES,
  POLYGON_TYPES,
  PROMPT_MAX_CHARS,
  PROVIDER_IDS,
  RESULT_FORMATS,
  VIEW_TYPES,
  type Job,
  type PersistedState,
} from '../store/types.js';
import { isActivePhase } from '../store/types.js';
import type { Workspace } from '../store/workspace.js';
import { parseCreateJobBody, parseParams, toInputSummary, toPayload, ValidationError } from './validate.js';

const log = createLogger('api');

export interface ApiDeps {
  workspace: Workspace;
  worker: GenerationWorker;
}

const MAX_LISTED_JOBS = 300;

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { workspace, worker } = deps;

  /** 从 query/body 解析目标引擎；未指定时用当前默认引擎 */
  const resolveRequestProvider = (request: { query?: unknown; body?: unknown }): GenerationProvider | null => {
    const query = (request.query ?? {}) as { provider?: unknown };
    const body = (request.body ?? {}) as { provider?: unknown };
    const raw = typeof query.provider === 'string' ? query.provider : typeof body.provider === 'string' ? body.provider : null;
    if (raw === null) return getProvider(activeProvider(workspace));
    return getProviderOptional(raw);
  };

  /** 前端唯一轮询入口：一次拿到任务列表 + 设置摘要 + 队列状态 */
  app.get('/api/state', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Number.parseInt(query.limit ?? '', 10) || MAX_LISTED_JOBS, MAX_LISTED_JOBS);
    const jobs = [...workspace.jobs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const active = jobs.filter((job) => isActivePhase(job.phase));
    return {
      serverTime: Date.now(),
      jobs: jobs.slice(0, limit),
      totalJobs: jobs.length,
      assets: jobs.filter((job) => job.asset).length,
      queue: {
        active: active.length,
        pending: jobs.filter((job) => job.phase === 'queued').length,
        maxConcurrency: config.maxConcurrency,
        running: worker.activeCount,
      },
      api: settingsSummary(workspace),
    };
  });

  /** 可选生成引擎清单（含能力、模型、Key 状态） */
  app.get('/api/providers', async () => ({ providers: listProviders().map((provider) => providerSummary(workspace, provider)) }));

  app.get('/api/settings', async () => settingsSummary(workspace));

  app.put('/api/settings/api-key', async (request, reply) => {
    const provider = resolveRequestProvider(request);
    if (!provider) return reply.code(400).send({ error: '未知的生成引擎' });
    const body = (request.body ?? {}) as { apiKey?: unknown };
    if (typeof body.apiKey !== 'string' || body.apiKey.trim().length < 8) {
      return reply.code(400).send({ error: '请填写有效的 API Key' });
    }
    const key = body.apiKey.trim();
    const prefix = provider.info.keyPrefix;
    if (prefix && !key.startsWith(prefix)) {
      return reply.code(400).send({ error: `${provider.info.label} 的 API Key 以 ${prefix} 开头，请检查是否复制完整` });
    }
    await workspace.mutate((state) => {
      const current = state.settings.providers[provider.info.id] ?? { apiKey: null, baseUrl: null };
      state.settings.providers[provider.info.id] = { ...current, apiKey: key };
      // 只保存凭据；默认引擎由「切换引擎 / 设为默认引擎」显式修改
    });
    log.info(`${provider.info.label} API Key 已更新（来自界面设置）`);
    return settingsSummary(workspace);
  });

  app.delete('/api/settings/api-key', async (request) => {
    const provider = resolveRequestProvider(request);
    if (provider) {
      await workspace.mutate((state) => {
        const current = state.settings.providers[provider.info.id];
        if (current) state.settings.providers[provider.info.id] = { ...current, apiKey: null };
      });
    }
    return settingsSummary(workspace);
  });

  /** 自定义接口域名（代理 / 私有化部署）；空字符串表示恢复默认 */
  app.put('/api/settings/base-url', async (request, reply) => {
    const provider = resolveRequestProvider(request);
    if (!provider) return reply.code(400).send({ error: '未知的生成引擎' });
    const body = (request.body ?? {}) as { baseUrl?: unknown };
    const raw = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    if (raw && !/^https?:\/\//i.test(raw)) {
      return reply.code(400).send({ error: '接口域名需以 http:// 或 https:// 开头' });
    }
    await workspace.mutate((state) => {
      const current = state.settings.providers[provider.info.id] ?? { apiKey: null, baseUrl: null };
      state.settings.providers[provider.info.id] = { ...current, baseUrl: raw || null };
    });
    return settingsSummary(workspace);
  });

  /** 切换界面默认引擎 */
  app.put('/api/settings/active-provider', async (request, reply) => {
    const body = (request.body ?? {}) as { provider?: unknown };
    if (typeof body.provider !== 'string') return reply.code(400).send({ error: '缺少 provider' });
    const provider = getProviderOptional(body.provider);
    if (!provider) return reply.code(400).send({ error: `未知的生成引擎：${body.provider}` });
    await workspace.mutate((state) => {
      state.settings.activeProvider = provider.info.id;
    });
    return settingsSummary(workspace);
  });

  app.post('/api/settings/verify', async (request) => {
    const provider = resolveRequestProvider(request);
    if (!provider) return { ok: false, message: '未知的生成引擎' };
    return verifyProviderKey(workspace, provider.info.id);
  });

  app.post('/api/jobs', async (request, reply) => {
    let parsed;
    try {
      parsed = parseCreateJobBody(request.body);
    } catch (err) {
      if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const id = newId('j');
    const now = new Date().toISOString();
    const job: Job = {
      id,
      createdAt: now,
      updatedAt: now,
      name: deriveName(parsed.prompt, parsed.mode, parsed.imageName),
      origin: 'generated',
      phase: 'queued',
      params: parsed.params,
      input: toInputSummary(parsed, id),
      remoteJobId: null,
      remoteStatus: null,
      providerMeta: {},
      requestId: null,
      error: null,
      errorCode: null,
      creditConsumed: null,
      creditDetails: null,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      remoteFailed: false,
      asset: null,
    };

    await savePayload(id, toPayload(parsed));
    if (parsed.previewDataUrl) await savePreview(id, parsed.previewDataUrl);
    await workspace.mutate((state: PersistedState) => {
      state.jobs.unshift(job);
    });

    log.info(`新任务 ${id} [${parsed.params.provider}/${parsed.mode}/${parsed.params.generateType}] 已入队`);
    void worker.tick();
    return reply.code(201).send(job);
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = workspace.findJob(id);
    if (!job) return reply.code(404).send({ error: '任务不存在' });
    return job;
  });

  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = workspace.findJob(id);
    if (!job) return reply.code(404).send({ error: '任务不存在' });
    if (isActivePhase(job.phase)) {
      return reply.code(409).send({ error: '任务进行中，请先取消再删除' });
    }
    await workspace.mutate((state) => {
      state.jobs = state.jobs.filter((item) => item.id !== id);
    });
    await Promise.all([removeAssetFiles(id), deletePayload(id)]);
    return { ok: true };
  });

  app.patch('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown; params?: unknown };
    const job = workspace.findJob(id);
    if (!job) return reply.code(404).send({ error: '任务不存在' });

    let nextName: string | undefined;
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return reply.code(400).send({ error: '名称不能为空' });
      nextName = name.slice(0, 80);
    }

    // 仅允许在未开始/失败状态下修改生成参数（含切换生成引擎）
    let nextParams: Job['params'] | undefined;
    if (body.params && typeof body.params === 'object') {
      if (isActivePhase(job.phase) || job.phase === 'done') {
        return reply.code(409).send({ error: '任务已提交，参数不可修改；请复制参数新建任务' });
      }
      const rawParams = body.params as Record<string, unknown>;
      const provider = getProviderOptional(String(rawParams.provider ?? job.params.provider));
      if (!provider) return reply.code(400).send({ error: '未知的生成引擎' });
      try {
        nextParams = parseParams(rawParams, provider);
      } catch (err) {
        if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    }

    await workspace.mutate((state) => {
      const target = state.jobs.find((item) => item.id === id);
      if (!target) return;
      if (nextName !== undefined) {
        target.name = nextName;
        if (target.asset) target.asset.name = nextName;
      }
      if (nextParams) target.params = nextParams;
      target.updatedAt = new Date().toISOString();
    });
    return workspace.findJob(id);
  });

  app.post('/api/jobs/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const mode = await worker.retry(id);
      return { ok: true, mode, message: mode === 'resume' ? '已续查远端任务（不重复计费）' : '已重新提交生成任务' };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post('/api/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await worker.cancel(id);
    if (!result.canceled) return reply.code(409).send({ error: result.message });
    return { ok: true, remote: result.remote, message: result.message };
  });

  /**
   * 后端子线程渲染素材封面（不占用浏览器主线程）。
   * 浏览器渲染路径仍保留：这里失败时前端会回退到 POST /api/jobs/:id/thumbnail。
   */
  app.post('/api/jobs/:id/cover', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = workspace.findJob(id);
    if (!job?.asset) return reply.code(404).send({ error: '素材不存在' });
    if (job.asset.thumbnailUrl) return { ok: true, thumbnailUrl: job.asset.thumbnailUrl, cached: true };

    const body = (request.body ?? {}) as { size?: unknown };
    const size = Math.min(512, Math.max(96, Number(body.size) || 256));
    const source = await pickCoverSourcePath(id, job.asset);
    if (!source) return { ok: false, reason: '该素材没有可渲染的模型文件（或格式不支持服务端封面）' };

    try {
      const startedAt = Date.now();
      const result = await getCoverRenderer().renderWithMeta({ filePath: source.filePath, size });
      const saved = await saveThumbnailBuffer(id, result.png);
      if (!saved) return { ok: false, reason: '封面写入失败' };
      await workspace.mutate((state) => {
        const target = state.jobs.find((item) => item.id === id);
        if (target?.asset) target.asset.thumbnailUrl = saved;
      });
      log.info(
        `服务端封面生成成功 ${id} (${source.format}, ${result.engine}, ${Date.now() - startedAt}ms)`,
      );
      return { ok: true, thumbnailUrl: saved, format: source.format, engine: result.engine };
    } catch (err) {
      log.warn(`服务端封面生成失败 ${id}: ${(err as Error).message}`);
      return { ok: false, reason: (err as Error).message };
    }
  });

  /** 浏览器渲染的缩略图回填（远端未返回预览图时使用） */
  app.post('/api/jobs/:id/thumbnail', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = workspace.findJob(id);
    if (!job?.asset) return reply.code(404).send({ error: '素材不存在' });
    if (job.asset.thumbnailUrl) return { ok: true, skipped: true };
    const body = (request.body ?? {}) as { dataUrl?: unknown };
    if (typeof body.dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/i.test(body.dataUrl)) {
      return reply.code(400).send({ error: '缩略图必须是 png/jpeg 的 data URL' });
    }
    if (body.dataUrl.length > 2_000_000) return reply.code(413).send({ error: '缩略图过大' });

    const saved = await saveThumbnailDataUrl(id, body.dataUrl);
    if (!saved) return reply.code(500).send({ error: '缩略图写入失败' });
    await workspace.mutate((state) => {
      const target = state.jobs.find((item) => item.id === id);
      if (target?.asset) target.asset.thumbnailUrl = saved;
    });
    return { ok: true, thumbnailUrl: saved };
  });

  /** 输入预览图（上传时的压缩图） */
  app.get('/api/jobs/:id/preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const preview = await loadPreview(id);
    if (!preview) return reply.code(404).send({ error: '没有预览图' });
    return reply
      .header('Content-Type', preview.mime)
      .header('Cache-Control', 'public, max-age=86400')
      .send(preview.buffer);
  });

  app.get('/api/health', async () => {
    const providers = listProviders().map((provider) => ({
      id: provider.info.id,
      label: provider.info.label,
      apiKeyConfigured: Boolean(providerCredential(workspace, provider.info.id).apiKey),
    }));
    const active = activeProvider(workspace);
    const activeInfo = getProvider(active);
    return {
      ok: true,
      provider: active,
      baseUrl: providerCredential(workspace, active).baseUrl,
      apiKeyConfigured: Boolean(providerCredential(workspace, active).apiKey),
      label: activeInfo.info.label,
      providers,
      maxConcurrency: config.maxConcurrency,
    };
  });
}

// ===== 汇总 =====

function providerSummary(workspace: Workspace, provider: GenerationProvider) {
  const { apiKey, baseUrl, source } = providerCredential(workspace, provider.info.id);
  return {
    id: provider.info.id,
    label: provider.info.label,
    vendor: provider.info.vendor,
    docsUrl: provider.info.docsUrl,
    keyHint: provider.info.keyHint,
    keyPrefix: provider.info.keyPrefix,
    envKeyName: provider.info.envKeyName,
    envBaseUrlName: provider.info.envBaseUrlName,
    defaultBaseUrl: provider.info.defaultBaseUrl,
    baseUrl,
    capabilities: provider.info.capabilities,
    models: provider.info.models,
    defaults: provider.info.defaults,
    apiKeyConfigured: Boolean(apiKey),
    apiKeyMasked: maskApiKey(apiKey),
    apiKeySource: source,
  };
}

function settingsSummary(workspace: Workspace) {
  const active = activeProvider(workspace);
  const providers = listProviders().map((provider) => providerSummary(workspace, provider));
  const activeSummary = providers.find((item) => item.id === active) ?? providers[0]!;
  return {
    activeProvider: active,
    /** 当前引擎的摘要（前端表单直接用它） */
    active: activeSummary,
    providers,
    limits: {
      faceCount: { min: FACE_COUNT_MIN, max: FACE_COUNT_MAX, default: FACE_COUNT_DEFAULT },
      promptMaxChars: PROMPT_MAX_CHARS,
      imageMaxBytes: IMAGE_BASE64_MAX_BYTES,
      maxConcurrency: config.maxConcurrency,
      pollIntervalMs: config.pollIntervalMs,
    },
    defaults: providerDefaults(active) ?? DEFAULT_PARAMS,
    enums: {
      providers: PROVIDER_IDS,
      generateTypes: GENERATE_TYPES,
      polygonTypes: POLYGON_TYPES,
      resultFormats: RESULT_FORMATS,
      viewTypes: VIEW_TYPES,
      viewTypes31Only: VIEW_TYPES_31_ONLY,
    },
  };
}

// ===== 请求里解析引擎 =====

function getProviderOptional(id: string | null | undefined): GenerationProvider | null {
  try {
    return getProvider(id);
  } catch {
    return null;
  }
}
