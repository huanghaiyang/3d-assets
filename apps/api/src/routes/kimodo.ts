import type { FastifyInstance } from 'fastify';
import {
  importKimodoAnimation,
  kimodoService,
  type KimodoGenerateRequest,
} from '../services/kimodo.js';
import { enhancePrompt, refinePrompt } from '../services/promptEnhance.js';
import { SOMA_SKELETON } from '../services/soma-skeleton.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('kimodo-route');

export async function registerKimodoRoutes(app: FastifyInstance): Promise<void> {
  /** 服务状态：路径是否配置齐全、生成器是否已拉起、是否正在生成 */
  app.get('/api/kimodo/status', async () => kimodoService.status());

  /** SOMA 骨架定义，供前端预览绘制 */
  app.get('/api/kimodo/skeleton', async () => SOMA_SKELETON);

  /**
   * 提示词转译：把中文描述 / 参考图片交给 DeepSeek，返回英文动作提示词。
   * Key 只在服务端 .env 中读取，接口不会返回任何凭据。
   */
  app.post('/api/kimodo/enhance-prompt', async (request, reply) => {
    const body = (request.body ?? {}) as { prompt?: unknown; image?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const image = typeof body.image === 'string' ? body.image : null;
    if (!prompt.trim() && !image) return reply.code(400).send({ error: '请提供描述文字或参考图片' });
    try {
      return await enhancePrompt({ prompt, image });
    } catch (err) {
      log.warn(`提示词转译失败：${(err as Error).message}`);
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * 按用户修改后的动作拆解重新生成英文提示词与分段。
   * 与 enhance-prompt 分开：这里不再重新理解原始意图，步骤就是唯一事实来源。
   */
  app.post('/api/kimodo/refine-prompt', async (request, reply) => {
    const body = (request.body ?? {}) as { steps?: unknown; objects?: unknown; note?: unknown };
    const steps = Array.isArray(body.steps)
      ? body.steps
          .filter((step): step is string => typeof step === 'string')
          .map((step) => step.trim())
          .filter(Boolean)
      : [];
    if (steps.length === 0) return reply.code(400).send({ error: '请先填写至少一个动作步骤' });

    const objects = Array.isArray(body.objects)
      ? body.objects.filter((item): item is string => typeof item === 'string')
      : [];
    const note = typeof body.note === 'string' ? body.note : '';
    try {
      return await refinePrompt({ steps, objects, note });
    } catch (err) {
      log.warn(`按拆解重新生成失败：${(err as Error).message}`);
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** 中间产物清单 + 关联的新建动画（提示词 → 任务 → 动作数据 → Mixamo JSON → 项目） */
  app.get('/api/kimodo/animations/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await kimodoService.artifacts(id);
    if (!result) return reply.code(404).send({ error: '任务不存在' });
    return result;
  });

  /** 读取单个产物的文本内容（JSON 已格式化；.f32 二进制不在此接口） */
  app.get('/api/kimodo/animations/:id/artifact', async (request, reply) => {
    const { id } = request.params as { id: string };
    const key = (request.query as { key?: string }).key?.trim() ?? '';
    const result = kimodoService.readArtifact(id, key);
    if (!result) return reply.code(404).send({ error: '产物不存在或不可查看' });
    return result;
  });

  /** 提交生成任务（后台串行执行，立即返回任务信息） */
  app.post('/api/kimodo/generate', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<KimodoGenerateRequest>;
    const prompt = (body.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: '提示词不能为空' });

    // 分段提示词：只接受数组，单段由服务层再过滤；非法项直接忽略
    const segments = Array.isArray(body.segments)
      ? body.segments
          .filter(
            (item): item is { prompt: string; frames: number } =>
              !!item && typeof item.prompt === 'string' && typeof item.frames === 'number',
          )
          .map((item) => ({ prompt: item.prompt.trim(), frames: Number(item.frames) || 0 }))
          .filter((item) => item.prompt.length > 0)
      : undefined;

    try {
      return kimodoService.submit({
        prompt,
        frames: Number(body.frames) || 150,
        steps: Number(body.steps) || 50,
        seed: body.seed,
        transitionFrames: body.transitionFrames,
        segments,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 任务列表（含历史任务） */
  app.get('/api/kimodo/animations', async () => kimodoService.list());

  /** 单个任务的原始动作数据，供前端预览 */
  app.get('/api/kimodo/animations/:id/root.f32', async (request, reply) => {
    const { id } = request.params as { id: string };
    const buffer = kimodoService.readMotion(id, 'root');
    if (!buffer) return reply.code(404).send({ error: '动作数据不存在' });
    return reply.type('application/octet-stream').header('cache-control', 'no-store').send(buffer);
  });

  app.get('/api/kimodo/animations/:id/rotations.f32', async (request, reply) => {
    const { id } = request.params as { id: string };
    const buffer = kimodoService.readMotion(id, 'rotations');
    if (!buffer) return reply.code(404).send({ error: '动作数据不存在' });
    return reply.type('application/octet-stream').header('cache-control', 'no-store').send(buffer);
  });

  /** 给生成结果添加/修改注释（传空字符串表示清除） */
  app.patch('/api/kimodo/animations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { note?: unknown };
    if (typeof body.note !== 'string') return reply.code(400).send({ error: '注释必须是字符串' });
    const updated = kimodoService.updateNote(id, body.note.slice(0, 200));
    if (!updated) return reply.code(404).send({ error: '任务不存在' });
    return updated;
  });

  /** 删除生成结果 */
  app.delete('/api/kimodo/animations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!kimodoService.remove(id)) return reply.code(400).send({ error: '无法删除该任务' });
    return { ok: true };
  });

  /** 把 SOMA 动作重定向成 Mixamo 动画 JSON（format=fbx-animation-data） */
  app.get('/api/kimodo/import/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = await importKimodoAnimation(
      id,
      (request.query as { clipName?: string }).clipName,
    );
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    return outcome;
  });
}
