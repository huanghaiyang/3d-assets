import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { extensionOf, safeFileName } from '../lib/ids.js';
import { createLogger } from '../lib/logger.js';
import { storageDir } from '../lib/paths.js';
import type { Workspace } from '../store/workspace.js';
import { fileUrl, pickPrimary } from '../services/assets.js';
import { MAX_SCAN_FILES, importGlbFolder } from '../services/folderImport.js';
import { transformModelFile, type PivotMode } from '../services/glbTransform.js';
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
 * 素材库上传 / 本地导入（右侧面板）：
 *   PUT    /api/library/staging/:batchId?filename=xxx   原始字节流，逐个文件暂存
 *   POST   /api/library/commit                          把一个批次转成素材条目（支持批量）
 *   DELETE /api/library/staging/:batchId                放弃该批次
 *   POST   /api/library/scan-glb                        扫描本地文件夹，一次性导入全部 .glb
 *   POST   /api/library/transform                       批量修正模型中心点 / 朝向（就地改写 GLB/glTF）
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

  /**
   * 扫描本地文件夹并一次性导入其中所有 .glb。
   *
   * 请求体：{ dir: string; recursive?: boolean }
   * - dir 必须是绝对路径（服务端与浏览器可能不在同一工作目录，相对路径含义不明确）；
   * - recursive 默认 true，会递归子目录；
   * - 单次最多导入 MAX_SCAN_FILES 个文件，超出部分通过 overflow 返回。
   *
   * 返回：{ ok, folder, scanned, created, skipped, failed, overflow }
   */
  app.post('/api/library/scan-glb', async (request, reply) => {
    const body = (request.body ?? {}) as { dir?: unknown; recursive?: unknown };
    const dir = typeof body.dir === 'string' ? body.dir : '';
    const recursive = body.recursive !== false;
    try {
      const result = await importGlbFolder(workspace, dir, recursive);
      return { ok: true, limit: MAX_SCAN_FILES, ...result };
    } catch (err) {
      if (err instanceof UploadError) return reply.code(400).send({ error: err.message });
      log.warn(`扫描文件夹失败: ${(err as Error).message}`);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * 批量修正模型中心点 / 朝向。
   *
   * 请求体：{ ids: string[]; pivot?: 'none'|'center'|'bottom'; yaw?: 'auto'|number }
   * - pivot='center'：包围盒中心移到原点；'bottom'：底部中心移到原点；'none'：不动轴心；
   * - yaw='auto'：按几何自动检测并转正（仅处理 90° 的整数倍偏差）；
   * - yaw=number：额外旋转指定角度（必须是 90 的倍数，与 auto 结果叠加）；
   * - 仅 .glb / .gltf 支持就地改写，其它格式返回 skipped。
   *
   * 改写完成后：
   * - 更新文件大小与带 `?v=` 的访问 URL（浏览器缓存了旧模型，必须换 URL 才能看到新朝向）；
   * - 清空 thumbnailUrl，让前端重新生成封面（服务端封面缓存按文件 mtime 自动失效）。
   */
  app.post('/api/library/transform', async (request, reply) => {
    const body = (request.body ?? {}) as {
      ids?: unknown;
      pivot?: unknown;
      yaw?: unknown;
    };
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [];
    if (ids.length === 0) return reply.code(400).send({ error: '请先选择要处理的模型' });
    if (ids.length > 100) return reply.code(400).send({ error: '单次最多批量处理 100 个模型' });

    const pivot: PivotMode =
      body.pivot === 'center' || body.pivot === 'bottom' || body.pivot === 'none'
        ? body.pivot
        : 'none';
    let yaw: 'auto' | number;
    if (body.yaw === 'auto') {
      yaw = 'auto';
    } else {
      const numeric = Number(body.yaw ?? 0);
      if (!Number.isFinite(numeric) || Math.abs(numeric) > 360) {
        return reply.code(400).send({ error: '朝向旋转角度不合法' });
      }
      yaw = Math.round(numeric);
    }
    if (pivot === 'none' && yaw !== 'auto' && yaw === 0) {
      return reply.code(400).send({ error: '没有需要执行的操作' });
    }

    const transformed: Array<{
      id: string;
      name: string;
      yawDeg: number;
      pivot: PivotMode;
      size: [number, number, number];
      /** 是否真正改写了文件；false = 本来就是目标状态，前端不必重建封面 */
      changed: boolean;
    }> = [];
    const skipped: Array<{ id: string; name: string; reason: string }> = [];
    const stamp = Date.now().toString(36);

    for (const id of ids) {
      const job = workspace.findJob(id);
      if (!job?.asset) {
        skipped.push({ id, name: id, reason: '素材不存在' });
        continue;
      }
      const asset = job.asset;
      // 收集该素材下所有可改写的模型文件（zip 里可能包含多个）
      const modelTargets: Array<{ filePath: string; entryName: string }> = [];
      for (const file of asset.files) {
        for (const entry of file.entries) {
          const ext = extensionOf(entry.name);
          if (ext !== 'glb' && ext !== 'gltf') continue;
          const filePath = path.join(storageDir, asset.id, ...entry.name.split('/'));
          const stat = await fs.stat(filePath).catch(() => null);
          if (stat?.isFile()) modelTargets.push({ filePath, entryName: entry.name });
        }
      }
      if (modelTargets.length === 0) {
        skipped.push({ id, name: job.name, reason: '没有可改写的 GLB / glTF 文件' });
        continue;
      }

      let lastYaw = 0;
      let lastSize: [number, number, number] = [0, 0, 0];
      let touched = 0;
      let changed = false;
      let failure: string | null = null;
      for (const target of modelTargets) {
        try {
          const result = await transformModelFile(target.filePath, { pivot, yaw });
          lastYaw = result.yawDeg;
          lastSize = result.size;
          touched += 1;
          if (result.changed) changed = true;
        } catch (err) {
          failure = `${target.entryName}: ${(err as Error).message}`;
          log.warn(`批量变换失败 ${asset.id}/${target.entryName}: ${(err as Error).message}`);
        }
      }
      if (touched === 0) {
        skipped.push({ id, name: job.name, reason: failure ?? '改写失败' });
        continue;
      }

      if (changed) {
        // 文件已被改写：刷新所有文件大小与 URL（加 ?v= 绕过浏览器强缓存）
        const assetDir = path.join(storageDir, asset.id);
        let totalBytes = 0;
        for (const file of asset.files) {
          for (const entry of file.entries) {
            const stat = await fs.stat(path.join(assetDir, ...entry.name.split('/'))).catch(() => null);
            if (stat?.isFile()) entry.size = stat.size;
            entry.url = `${fileUrl(asset.id, entry.name)}?v=${stamp}`;
            totalBytes += entry.size;
          }
          const primary = pickPrimary(file.entries);
          file.primaryUrl = primary?.url ?? null;
          file.materialUrl = file.entries.find((entry) => entry.role === 'material')?.url ?? null;
        }
        asset.bytes = totalBytes;
        // 封面需要按新朝向重新生成；cover 缓存 key 含 mtime，旧缓存不会复用
        asset.thumbnailUrl = null;
        job.updatedAt = new Date().toISOString();
      }
      transformed.push({
        id,
        name: job.name,
        yawDeg: lastYaw,
        pivot,
        size: lastSize,
        changed,
      });
    }

    if (transformed.length > 0) await workspace.mutate(() => undefined);
    log.info(`批量变换完成：成功 ${transformed.length} 个，跳过 ${skipped.length} 个`);
    return { ok: true, transformed, skipped };
  });
}
