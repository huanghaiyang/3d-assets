import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  listStages,
  normalizeStage,
  readStage,
  stageId,
  summaryOf,
  trashStage,
  writeStage,
} from '../services/stages.js';

const MAX_STAGE_BYTES = 4 * 1024 * 1024;

/** 舞台文档的读写接口：只存编排信息，不碰模型与动画数据 */
export async function registerStageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stage/list', async () => ({ stages: await listStages() }));

  app.get('/api/stage/:id', async (request, reply) => {
    const id = stageId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的舞台 ID' });
    const stage = await readStage(id);
    if (!stage) return reply.code(404).send({ error: '舞台不存在' });
    return stage;
  });

  app.post('/api/stage', async (request, reply) => {
    const raw = JSON.stringify(request.body ?? {});
    if (raw.length > MAX_STAGE_BYTES) return reply.code(413).send({ error: '舞台文档过大' });
    const id = randomUUID();
    const stage = normalizeStage(request.body, id);
    if (!stage) return reply.code(400).send({ error: '舞台文档格式不正确' });
    await writeStage(stage);
    return summaryOf(stage);
  });

  app.put('/api/stage/:id', async (request, reply) => {
    const id = stageId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的舞台 ID' });
    const raw = JSON.stringify(request.body ?? {});
    if (raw.length > MAX_STAGE_BYTES) return reply.code(413).send({ error: '舞台文档过大' });
    const stage = normalizeStage(request.body, id);
    if (!stage) return reply.code(400).send({ error: '舞台文档格式不正确' });
    const existing = await readStage(id);
    stage.createdAt = existing?.createdAt ?? stage.createdAt;
    await writeStage(stage);
    return stage;
  });

  app.delete('/api/stage/:id', async (request, reply) => {
    const id = stageId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的舞台 ID' });
    const removed = await trashStage(id);
    if (!removed) return reply.code(404).send({ error: '舞台不存在' });
    return { ok: true };
  });
}
