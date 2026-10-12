import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { storageDir } from '../lib/paths.js';
import { createLogger } from '../lib/logger.js';
import { safeFileName } from '../lib/ids.js';

const log = createLogger('files');

const MIME_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  fbx: 'application/octet-stream',
  stl: 'model/stl',
  usdz: 'model/vnd.usdz+zip',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  tga: 'image/x-tga',
  bmp: 'image/bmp',
  ktx2: 'image/ktx2',
  bin: 'application/octet-stream',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/**
 * 本地素材文件服务：/files/<jobId>/<相对路径>
 * 生成的模型会被转存到 data/storage 下，24 小时后也能继续访问与下载。
 */
export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/files/:jobId/*', async (request, reply) => {
    const params = request.params as { jobId: string; '*': string };
    const jobId = safeFileName(decodeURIComponent(params.jobId), '');
    const relative = decodeURIComponent(params['*'] ?? '');

    if (!jobId || !relative || relative.includes('\0')) {
      return reply.code(400).send({ error: '非法路径' });
    }

    const root = path.resolve(storageDir, jobId);
    const target = path.resolve(root, relative);
    // 防止路径穿越
    if (target !== root && !target.startsWith(root + path.sep)) {
      return reply.code(403).send({ error: '禁止访问' });
    }

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return reply.code(404).send({ error: '文件不存在' });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: '文件不存在' });

    const ext = path.extname(target).slice(1).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const query = request.query as { download?: string };
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    };
    if (query.download === '1') {
      const base = path.basename(target);
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(base)}"; filename*=UTF-8''${encodeURIComponent(base)}`;
      headers['Cache-Control'] = 'no-store';
    }

    log.debug(`GET /files/${jobId}/${relative} -> ${stat.size}B`);
    return reply.headers(headers).send(await fs.readFile(target));
  });
}
