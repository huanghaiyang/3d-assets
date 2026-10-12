import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { extensionOf, safeFileName } from '../lib/ids.js';
import { createLogger } from '../lib/logger.js';
import type { Workspace } from '../store/workspace.js';
import {
  ACCEPTED_UPLOAD_EXT,
  MAX_UPLOAD_BYTES,
  UploadError,
  assertValidBatchId,
  commitBatch,
  discardBatch,
  ensureStagingDir,
} from '../services/uploads.js';

const log = createLogger('library');

export interface LibraryDeps {
  workspace: Workspace;
}

/**
 * 素材库上传（右侧面板）：
 *   PUT    /api/library/staging/:batchId?filename=xxx   原始字节流，逐个文件暂存
 *   POST   /api/library/commit                          把一个批次转成素材条目（支持批量）
 *   DELETE /api/library/staging/:batchId                放弃该批次
 */
export async function registerLibraryRoutes(app: FastifyInstance, deps: LibraryDeps): Promise<void> {
  const { workspace } = deps;

  app.get('/api/library/upload-info', async () => ({
    acceptedExtensions: ACCEPTED_UPLOAD_EXT,
    maxBytes: MAX_UPLOAD_BYTES,
    hint: '.obj/.gltf 需与 .mtl、贴图一起选择，或直接上传 .zip 压缩包',
  }));

  app.put(
    '/api/library/staging/:batchId',
    { bodyLimit: MAX_UPLOAD_BYTES + 1024 * 1024 },
    async (request, reply) => {
      const { batchId } = request.params as { batchId: string };
      try {
        assertValidBatchId(batchId);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const rawName = String((request.query as { filename?: string }).filename ?? '');
      const fileName = safeFileName(rawName, '');
      if (!fileName) return reply.code(400).send({ error: '缺少 filename 参数' });

      const ext = extensionOf(fileName);
      if (!ACCEPTED_UPLOAD_EXT.includes(ext)) {
        return reply.code(415).send({ error: `不支持的文件类型 .${ext || '(无扩展名)'}` });
      }

      const stream = request.body as Readable | undefined;
      if (!stream || typeof (stream as Readable).pipe !== 'function') {
        return reply.code(400).send({ error: '请求体必须是原始文件字节流' });
      }

      const dir = await ensureStagingDir(batchId);
      const staged = path.join(dir, `${randomBytes(4).toString('hex')}__${fileName}`);
      try {
        await pipeline(stream, createWriteStream(staged));
      } catch (err) {
        await fs.rm(staged, { force: true });
        log.warn(`暂存失败 ${fileName}: ${(err as Error).message}`);
        return reply.code(500).send({ error: `写入失败：${(err as Error).message}` });
      }

      const stat = await fs.stat(staged).catch(() => null);
      if (!stat || stat.size === 0) {
        await fs.rm(staged, { force: true });
        return reply.code(400).send({ error: `${fileName} 是空文件` });
      }
      if (stat.size > MAX_UPLOAD_BYTES) {
        await fs.rm(staged, { force: true });
        return reply.code(413).send({ error: `${fileName} 超过单文件上限` });
      }

      log.debug(`已暂存 ${fileName} (${stat.size}B) -> ${batchId}`);
      return { ok: true, name: fileName, size: stat.size };
    },
  );

  app.post('/api/library/commit', async (request, reply) => {
    const body = (request.body ?? {}) as { batchId?: unknown };
    const batchId = typeof body.batchId === 'string' ? body.batchId : '';
    try {
      assertValidBatchId(batchId);
      const result = await commitBatch(workspace, batchId);
      return { ok: true, created: result.jobs, warnings: result.warnings };
    } catch (err) {
      if (err instanceof UploadError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/library/staging/:batchId', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    try {
      assertValidBatchId(batchId);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    await discardBatch(batchId);
    return { ok: true };
  });
}
