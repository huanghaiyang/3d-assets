import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import {
  importKimodoAnimation,
  kimodoService,
  type KimodoConditionedRequest,
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

  /**
   * 真实 pose 约束的双向过渡生成。
   *
   * 两种输入方式：
   * A) 直接传四个 f32 路径：prevRootPath / prevRotPath / nextRootPath / nextRotPath
   * B) 传 prevAnimationId / nextAnimationId：服务端自动从 outputDir 读原始 f32，
   *    按 transitionFrames 切 prev 尾部 / next 头部，写临时 f32 后再喂给 shim。
   *    前端只需要知道两段的 animationId，无需关心底层文件格式。
   */
  app.post('/api/kimodo/generate-conditioned', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return reply.code(400).send({ error: '缺少必填字段：prompt（辅助提示词）' });

    // 过渡段总帧数：8 是扩散模型能稳定生成的下限，300 是单次任务的上限
    // （再长会让单条推理占满显存/CPU 过久，应该拆成多段）
    const frames = Math.round(Number(body.frames) || 0);
    if (!Number.isFinite(frames) || frames < 8 || frames > 300) {
      return reply.code(400).send({ error: 'frames 必须在 8–300 之间' });
    }

    // 约束帧数（首尾各取这么多帧作为 observed 硬约束）：
    // 默认 1 帧 = 只对齐 prev 末帧与 next 首帧；前端过渡场景只用单帧对齐即可，
    // 多帧约束会让首尾过度僵硬，中间过渡失去自然度。
    const transitionFrames = Math.max(1, Math.round(Number(body.transitionFrames) || 1));
    // DDIM 扩散步数：条件生成比纯文本需要更充分收敛，默认 50（文本生成默认 20）
    const steps = Math.round(Number(body.steps) || 50);
    // 随机种子：传了就用，没传由 service 层自己掷，保证结果可复现
    const seed = Number.isFinite(Number(body.seed)) ? Math.round(Number(body.seed)) : undefined;

    // ---- 解析四个 f32 路径 ----
    let prevRootPath: string;
    let prevRotPath: string;
    let nextRootPath: string;
    let nextRotPath: string;

    const hasDirectPaths =
      typeof body.prevRootPath === 'string' &&
      typeof body.prevRotPath === 'string' &&
      typeof body.nextRootPath === 'string' &&
      typeof body.nextRotPath === 'string';
    const hasAnimationIds =
      typeof body.prevAnimationId === 'string' && typeof body.nextAnimationId === 'string';
    /** 方式 B 的约束切片目录名；方式 A 保持 undefined */
    let constraintTag: string | undefined;

    if (hasDirectPaths) {
      // 方式 A：直接路径，做存在性校验
      const check = (key: string, p: string) =>
        fs.existsSync(p) ? null : `${key} 指向的文件不存在：${p}`;
      const errs: string[] = [];
      prevRootPath = body.prevRootPath as string;
      prevRotPath = body.prevRotPath as string;
      nextRootPath = body.nextRootPath as string;
      nextRotPath = body.nextRotPath as string;
      errs.push(check('prevRootPath', prevRootPath)!);
      errs.push(check('prevRotPath', prevRotPath)!);
      errs.push(check('nextRootPath', nextRootPath)!);
      errs.push(check('nextRotPath', nextRotPath)!);
      const filtered = errs.filter(Boolean);
      if (filtered.length) return reply.code(400).send({ error: filtered[0] });
    } else if (hasAnimationIds) {
      // 方式 B：animationId → 服务端自动切帧写临时 f32
      const prevAnimId = body.prevAnimationId as string;
      const nextAnimId = body.nextAnimationId as string;
      const outDir = kimodoService.outputDir;
      const prevJobDir = path.join(outDir, prevAnimId);
      const nextJobDir = path.join(outDir, nextAnimId);

      const missing = fs.existsSync(prevJobDir) ? null : `prevAnimationId=${prevAnimId} 的 job 目录不存在：${prevJobDir}`;
      if (missing) return reply.code(400).send({ error: missing });
      if (!fs.existsSync(nextJobDir)) return reply.code(400).send({ error: `nextAnimationId=${nextAnimId} 的 job 目录不存在` });

      // 辅助：从 f32 文件切 [frameStart, frameEnd) 帧
      // 负数索引：-N = 倒数第 N 帧；frameEnd=0 特例 = 到文件末尾
      const slice = (src: string, perFrame: number, frameStart: number, frameEnd: number) => {
        const buf = fs.readFileSync(src);
        const totalFrames = buf.length / perFrame;
        const start = frameStart < 0 ? Math.max(0, totalFrames + frameStart) : frameStart;
        const end = frameEnd === 0 ? totalFrames
          : (frameEnd < 0 ? Math.max(0, totalFrames + frameEnd) : frameEnd);
        return Buffer.from(buf.subarray(start * perFrame, end * perFrame));
      };

      const makeSlice = (
        jobDir: string, fileName: string, perFrame: number,
        tail: boolean,  // true = 取尾部 transitionFrames 帧, false = 取头部
      ) => {
        const src = path.join(jobDir, fileName);
        if (!fs.existsSync(src)) {
          throw new Error(`${jobDir} 里缺少 ${fileName}`);
        }
        // tail: 倒数 N 帧到末尾 → slice(-N, 0)
        // head: 前 N 帧 → slice(0, N)
        const buf = tail
          ? slice(src, perFrame, -transitionFrames, 0)
          : slice(src, perFrame, 0, transitionFrames);
        return buf;
      };

      // 写临时约束目录（放在输出目录的 _constraints 里，跟 job 并列）
      // tag 格式：prev前6位-next前6位-时间戳(36进制)，既方便排查又避免碰撞
      const tag = `${prevAnimId.slice(0, 6)}-${nextAnimId.slice(0, 6)}-${Date.now().toString(36)}`;
      constraintTag = tag;
      const tmpDir = path.join(outDir, '_constraints', tag);
      fs.mkdirSync(tmpDir, { recursive: true });

      // perFrame 字节数：
      //   root_positions.f32      → 每帧 3 个 float32 (XYZ) = 12 字节
      //   local_rotations_xyzw.f32 → 每帧 30 关节 × 4 分量 (XYZW) × 4 字节 = 480 字节
      // tail=true  取 prev 段尾部 transitionFrames 帧（末帧 = prev 最后一帧）
      // tail=false 取 next 段头部 transitionFrames 帧（首帧 = next 第一帧）
      const prevRootBuf = makeSlice(prevJobDir, 'root_positions.f32', 12, true);
      const prevRotBuf  = makeSlice(prevJobDir, 'local_rotations_xyzw.f32', 30 * 4 * 4, true);
      const nextRootBuf = makeSlice(nextJobDir, 'root_positions.f32', 12, false);
      const nextRotBuf  = makeSlice(nextJobDir, 'local_rotations_xyzw.f32', 30 * 4 * 4, false);

      prevRootPath = path.join(tmpDir, 'prev_root.f32');
      prevRotPath  = path.join(tmpDir, 'prev_rot.f32');
      nextRootPath = path.join(tmpDir, 'next_root.f32');
      nextRotPath  = path.join(tmpDir, 'next_rot.f32');

      fs.writeFileSync(prevRootPath, prevRootBuf);
      fs.writeFileSync(prevRotPath, prevRotBuf);
      fs.writeFileSync(nextRootPath, nextRootBuf);
      fs.writeFileSync(nextRotPath, nextRotBuf);
    } else {
      return reply.code(400).send({
        error: '必须提供 animationId 组合（prevAnimationId + nextAnimationId）或直接路径（四个 .f32 绝对路径）',
      });
    }

    // 舞台位移（米，prev 局部坐标系下的水平向量），可选。
    // 用于把「这段过渡要跨越多远」编码进 next 的 root 约束，
    // 否则两段各自的局部原点都在 0 附近，模型只会生成原地动作。
    const rawDelta = body.rootDelta as { dx?: unknown; dz?: unknown } | undefined;
    let rootDelta: { dx: number; dz: number } | undefined;
    if (rawDelta && typeof rawDelta === 'object') {
      const dx = Number(rawDelta.dx);
      const dz = Number(rawDelta.dz);
      // 太小的位移没有意义（<0.1mm），当作没传，避免生成无谓的临时文件
      if (Number.isFinite(dx) && Number.isFinite(dz) && Math.hypot(dx, dz) > 1e-4) {
        rootDelta = { dx, dz };
      }
    }

    try {
      return kimodoService.submitConditioned({
        prevRootPath, prevRotPath, nextRootPath, nextRotPath,
        frames, transitionFrames, steps, seed,
        prompt,
        rootDelta,
        // 走 animationId 快捷方式时记录来源，产物面板据此展示完整 f32 关联链路
        prevAnimationId: hasAnimationIds ? (body.prevAnimationId as string) : undefined,
        nextAnimationId: hasAnimationIds ? (body.nextAnimationId as string) : undefined,
        constraintTag,
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
