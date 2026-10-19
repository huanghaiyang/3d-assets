import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAnimationRoutes } from './routes/animation.js';
import { registerFileRoutes } from './routes/files.js';
import { registerLibraryRoutes } from './routes/library.js';
import { sweepStorage } from './services/assets.js';
import { GenerationWorker } from './services/worker.js';
import { Workspace } from './store/workspace.js';

const log = createLogger('app');

export interface AppContext {
  app: FastifyInstance;
  workspace: Workspace;
  worker: GenerationWorker;
}

export async function buildApp(): Promise<AppContext> {
  const workspace = await Workspace.open();

  // 清理没有任务记录或已经空掉的素材目录
  const swept = await sweepStorage(workspace).catch(() => 0);
  if (swept > 0) log.info(`已清理 ${swept} 个残留素材目录`);

  const worker = new GenerationWorker(workspace, {
    pollIntervalMs: config.pollIntervalMs,
    maxConcurrency: config.maxConcurrency,
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024, // 允许较大的 base64 图片请求体
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
