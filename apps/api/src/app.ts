import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAnimationRoutes } from './routes/animation.js';
import { registerFileRoutes } from './routes/files.js';
import { registerKimodoRoutes } from './routes/kimodo.js';
import { registerLibraryRoutes } from './routes/library.js';
import { sweepStorage } from './services/assets.js';
import { sweepCoverCache } from './services/covers.js';
import { sweepStaging } from './services/uploads.js';
import { GenerationWorker } from './services/worker.js';
import { Workspace } from './store/workspace.js';

const log = createLogger('app');
const gzipAsync = promisify(gzip);

/** 只压缩 JSON / 文本，且跳过素材文件（模型本身已经是压缩格式） */
const COMPRESSIBLE = /^(application\/json|text\/)/i;

export interface AppContext {
  app: FastifyInstance;
  workspace: Workspace;
  worker: GenerationWorker;
}

export async function buildApp(): Promise<AppContext> {
  const workspace = await Workspace.open();

  // 状态是从损坏文件/备份恢复来的：这时任务记录可能不全，绝不能按“无对应任务”清理素材目录
  if (workspace.recoveredFromCorrupt) {
    log.warn('本次启动发生过状态恢复，已跳过素材目录清理（保护已有模型文件）');
  } else {
    // 清理没有任务记录或已经空掉的素材目录
    const swept = await sweepStorage(workspace).catch(() => 0);
    if (swept > 0) log.info(`已清理 ${swept} 个残留素材目录`);
  }

  // 兜底清理浏览器中途关闭留下的上传暂存（超过 24h）
  const stagingSwept = await sweepStaging().catch(() => 0);
  if (stagingSwept > 0) log.info(`已清理 ${stagingSwept} 个过期上传暂存目录`);

  // 封面磁盘缓存在项目内 data/cache/covers（gitignore），只清 30 天前的
  const coversSwept = await sweepCoverCache().catch(() => 0);
  if (coversSwept > 0) log.info(`已清理 ${coversSwept} 个过期封面缓存`);

  const worker = new GenerationWorker(workspace, {
    pollIntervalMs: config.pollIntervalMs,
    maxConcurrency: config.maxConcurrency,
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024, // 允许较大的 base64 图片请求体
  });

  // /api/state 每次轮询都要下载全部任务元数据，gzip 能省掉约 80% 流量
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET') return payload;
    if (request.url.startsWith('/files/')) return payload;
    if (reply.getHeader('content-encoding')) return payload;
    const contentType = String(reply.getHeader('content-type') ?? '');
    if (!COMPRESSIBLE.test(contentType)) return payload;
    const accept = String(request.headers['accept-encoding'] ?? '');
    if (!accept.includes('gzip')) return payload;
    const buffer = Buffer.isBuffer(payload)
      ? payload
      : typeof payload === 'string'
        ? Buffer.from(payload)
        : null;
    if (!buffer || buffer.length < 1024) return payload;
    const compressed = await gzipAsync(buffer);
    reply.removeHeader('content-length');
    reply.header('content-encoding', 'gzip');
    reply.header('vary', 'accept-encoding');
    return compressed;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) log.error(`${request.method} ${request.url} 处理失败: ${error.message}`);
    reply.code(status).send({ error: error.message });
  });

  // 上传接口需要接收原始字节流（逐个文件流式落盘，不整体进内存）
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  await app.register(registerApiRoutes, { workspace, worker });
  await app.register(registerLibraryRoutes, { workspace });
  await app.register(registerAnimationRoutes, {
    getDirs: () => workspace.animationDirs,
    setDirs: async (dirs) => {
      await workspace.mutate((state) => {
        state.animationDirs = dirs;
      });
    },
  });
  await app.register(registerFileRoutes);
  await app.register(registerKimodoRoutes);

  // 生产模式下由同一个服务托管构建好的前端
  const indexPath = path.join(config.webDistDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      index: ['index.html'],
      wildcard: true,
    });
    log.info(`已挂载前端静态资源: ${config.webDistDir}`);
  }

  app.setNotFoundHandler((request, reply) => {
    const wantsHtml = request.headers.accept?.includes('text/html');
    if (request.method === 'GET' && wantsHtml && fs.existsSync(indexPath)) {
      return reply.type('text/html').send(fs.readFileSync(indexPath, 'utf8'));
    }
    return reply.code(404).send({ error: `未找到路由 ${request.method} ${request.url}` });
  });

  return { app, workspace, worker };
}
