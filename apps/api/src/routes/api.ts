import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  FACE_COUNT_DEFAULT,
  FACE_COUNT_MAX,
  FACE_COUNT_MIN,
  GENERATE_TYPES,
  IMAGE_BASE64_MAX_BYTES,
  MODEL_VERSIONS,
  POLYGON_TYPES,
  PROMPT_MAX_CHARS,
  RESULT_FORMATS,
  VIEW_TYPES,
  VIEW_TYPES_31_ONLY,
} from '../hunyuan/types.js';
import { newId } from '../lib/ids.js';
import { createLogger } from '../lib/logger.js';
import type { GenerationWorker } from '../services/worker.js';
import { deletePayload, savePayload, savePreview, loadPreview } from '../services/payload.js';
import { removeAssetFiles, saveThumbnailDataUrl, deriveName } from '../services/assets.js';
import { apiKeySource, maskApiKey, resolveApiKey, verifyApiKey } from '../services/settings.js';
import type { Job, PersistedState } from '../store/types.js';
import { isActivePhase } from '../store/types.js';
import type { Workspace } from '../store/workspace.js';
import {
  DEFAULT_PARAMS,
  parseCreateJobBody,
  parseParams,
  toInputSummary,
  toPayload,
  ValidationError,
} from './validate.js';

const log = createLogger('api');

export interface ApiDeps {
  workspace: Workspace;
  worker: GenerationWorker;
}

const MAX_LISTED_JOBS = 300;

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { workspace, worker } = deps;

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

  app.get('/api/settings', async () => settingsSummary(workspace));

  app.put('/api/settings/api-key', async (request, reply) => {
    const body = (request.body ?? {}) as { apiKey?: unknown };
    if (typeof body.apiKey !== 'string' || body.apiKey.trim().length < 8) {
      return reply.code(400).send({ error: '请填写有效的 API Key' });
    }
    const key = body.apiKey.trim();
    if (!key.startsWith('sk-')) {
      return reply.code(400).send({ error: '混元生3D 的 API Key 以 sk- 开头，请检查是否复制完整' });
    }
    await workspace.mutate((state) => {
      state.settings.apiKey = key;
    });
    log.info('API Key 已更新（来自界面设置）');
    return settingsSummary(workspace);
  });

  app.delete('/api/settings/api-key', async () => {
    await workspace.mutate((state) => {
      state.settings.apiKey = null;
    });
    return settingsSummary(workspace);
  });

  app.post('/api/settings/verify', async () => verifyApiKey(workspace));

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

    log.info(`新任务 ${id} [${parsed.mode}/${parsed.params.generateType}] 已入队`);
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

    // 仅允许在未开始/失败状态下修改生成参数
    let nextParams: Job['params'] | undefined;
    if (body.params && typeof body.params === 'object') {
      if (isActivePhase(job.phase) || job.phase === 'done') {
        return reply.code(409).send({ error: '任务已提交，参数不可修改；请复制参数新建任务' });
      }
      try {
        nextParams = parseParams(body.params as Record<string, unknown>);
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
    const ok = await worker.cancel(id);
    if (!ok) return reply.code(409).send({ error: '任务不在进行中，无法取消' });
    return { ok: true };
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

  app.get('/api/health', async () => ({
    ok: true,
    baseUrl: config.baseUrl,
    apiKeyConfigured: Boolean(resolveApiKey(workspace)),
    maxConcurrency: config.maxConcurrency,
  }));
}

function settingsSummary(workspace: Workspace) {
  const key = resolveApiKey(workspace);
  return {
    apiKeyConfigured: Boolean(key),
    apiKeyMasked: maskApiKey(key),
    apiKeySource: apiKeySource(workspace),
    baseUrl: config.baseUrl,
    defaults: DEFAULT_PARAMS,
    limits: {
      faceCount: { min: FACE_COUNT_MIN, max: FACE_COUNT_MAX, default: FACE_COUNT_DEFAULT },
      promptMaxChars: PROMPT_MAX_CHARS,
      imageMaxBytes: IMAGE_BASE64_MAX_BYTES,
      maxConcurrency: config.maxConcurrency,
      pollIntervalMs: config.pollIntervalMs,
    },
    enums: {
      modelVersions: MODEL_VERSIONS,
      generateTypes: GENERATE_TYPES,
      polygonTypes: POLYGON_TYPES,
      resultFormats: RESULT_FORMATS,
      viewTypes: VIEW_TYPES,
      viewTypes31Only: VIEW_TYPES_31_ONLY,
    },
  };
}
