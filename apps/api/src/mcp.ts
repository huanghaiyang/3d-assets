#!/usr/bin/env node
/**
 * MCP（Model Context Protocol）stdio 服务。
 *
 * 直接在进程内调用服务层，不经过 HTTP：动画项目（含回收站）、拼接编排、舞台文档
 * 与 Kimodo 生成/导入/中间产物都能被 MCP 客户端调用；3D 生成任务因为依赖 HTTP
 * 服务的 worker 与内存态，改为转发到本地 API（详见 model_* 工具组）。
 *
 * 安全约定：任何工具都不会返回 .env 里的路径与密钥。返回状态时只给出布尔值与
 * 非敏感字段，错误文本里的绝对路径也会被抹掉。
 *
 * 启动：npm run mcp -w @h3d/api（生产） / npm run mcp:dev -w @h3d/api（开发）
 */

// stdio 上只允许出现 JSON-RPC，日志一律改到 stderr
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  clipsOf,
  countTracks,
  importedOf,
  isNameTaken,
  listProjects,
  listTrash,
  normalizeComposition,
  normalizeName,
  normalizeRecord,
  purgeProject,
  readProject,
  renameProject,
  restoreProject,
  summaryOf,
  trashProject,
  writeProject,
  type SavedProject,
} from './services/animProjects.js';
import {
  importKimodoAnimation,
  kimodoService,
  type KimodoAnimation,
  type KimodoPromptSegment,
} from './services/kimodo.js';
import { enhancePrompt, promptEnhancerReady, refinePrompt } from './services/promptEnhance.js';
import { SOMA_SKELETON } from './services/soma-skeleton.js';
import {
  listStages,
  normalizeStage,
  readStage,
  stageId,
  summaryOf as stageSummaryOf,
  trashStage,
  writeStage,
} from './services/stages.js';
import { config } from './config.js';

const SERVER_INFO = { name: 'h3d-3d-workbench', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

// ------------------------------------------------------------------ 脱敏

/** 抹掉绝对路径与疑似凭据，避免 .env 内容通过错误文本穿透出去 */
function scrub(text: unknown): string {
  return String(text ?? '')
    .replace(/[A-Za-z]:\\[^\s"';]+/g, '<路径>')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, '$1<已隐藏>')
    .slice(0, 2000);
}

/** 任务对象对外只暴露生成参数与状态，错误文本脱敏 */
function publicJob(job: KimodoAnimation): Record<string, unknown> {
  return {
    id: job.id,
    prompt: job.prompt,
    frames: job.frames,
    steps: job.steps,
    seed: job.seed,
    status: job.status,
    createdAt: job.createdAt,
    durationMs: job.durationMs ?? null,
    note: job.note ?? null,
    segments: job.segments ?? null,
    startedAt: job.startedAt ?? null,
    etaMs: job.etaMs ?? null,
    loadMs: job.loadMs ?? null,
    error: job.error ? scrub(job.error) : null,
  };
}

/** Kimodo 状态：不返回可执行文件 / 模型 / 输出目录，也不返回任何密钥 */
function publicStatus(): Record<string, unknown> {
  const status = kimodoService.status();
  return {
    ready: status.ready,
    running: status.running,
    busy: status.busy,
    queued: status.queued,
    backend: status.backend,
    promptProvider: status.promptProvider,
    promptProviderLabel: status.promptProviderLabel,
    promptModel: status.promptModel,
    promptVisionModel: status.promptVisionModel,
    promptModelReady: status.promptModelReady,
    error: status.error ? scrub(status.error) : null,
  };
}

// ------------------------------------------------------------------ 参数读取

type Args = Record<string, unknown>;

function readString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function readBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function requireString(args: Args, key: string): string {
  const value = readString(args, key)?.trim();
  if (!value) throw new Error(`缺少参数 ${key}`);
  return value;
}

/** 读取分段提示词数组，过滤非法项；空数组返回 undefined */
function readSegments(args: Args): KimodoPromptSegment[] | undefined {
  const raw = args.segments;
  if (!Array.isArray(raw)) return undefined;
  const segments = raw
    .filter(
      (item): item is { prompt: unknown; frames: unknown } =>
        !!item && typeof item === 'object' && 'prompt' in item,
    )
    .map((item) => ({
      prompt: typeof item.prompt === 'string' ? item.prompt.trim() : '',
      frames: typeof item.frames === 'number' ? Math.round(item.frames) : Number(item.frames) || 0,
    }))
    .filter((item) => item.prompt.length > 0);
  return segments.length > 0 ? segments : undefined;
}

/** 项目 JSON 里记录的基础模型信息（不校验磁盘，MCP 只读写项目数据） */
interface ProjectInput {
  name?: string;
  basePath?: string;
  baseName?: string;
  data?: unknown;
  imported?: unknown;
}

/**
 * 写操作串行化：重名检查与落盘必须在一个队列里，
 * 否则并发调用会「同时检查通过、同时写入」而绕过查重。
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function doCreateProject(args: Args): Promise<Record<string, unknown>> {
  const name = normalizeName(requireString(args, 'name'));
  if (await isNameTaken(name)) throw new Error(`名称「${name}」已被使用`);
  const now = new Date().toISOString();
  const input: ProjectInput = {
    name,
    basePath: readString(args, 'basePath') ?? '',
    baseName: readString(args, 'baseName') ?? '',
    data: args.data ?? null,
    imported: args.imported ?? null,
  };
  const record = normalizeRecord({ ...input, createdAt: now, updatedAt: now }, randomUUID());
  if (!record) throw new Error('项目数据不合法');
  await writeProject(record);
  return { project: record };
}

function createProject(args: Args): Promise<Record<string, unknown>> {
  return serializeWrite(() => doCreateProject(args));
}

async function doSaveProject(args: Args): Promise<Record<string, unknown>> {
  const id = requireString(args, 'id');
  const record = await readProject(id);
  if (!record) throw new Error(`项目 ${id} 不存在`);

  const name = readString(args, 'name');
  if (name !== undefined) {
    const normalized = normalizeName(name);
    if (!normalized) throw new Error('名称不能为空');
    if (await isNameTaken(normalized, id)) throw new Error(`名称「${normalized}」已被使用`);
    record.name = normalized;
  }
  if (args.data !== undefined) record.data = args.data;
  if (args.imported !== undefined) record.imported = importedOf(args.imported);
  record.updatedAt = new Date().toISOString();

  const next = normalizeRecord(record, id);
  if (!next) throw new Error('项目数据不合法');
  await writeProject(next);
  return { project: next };
}

function saveProject(args: Args): Promise<Record<string, unknown>> {
  return serializeWrite(() => doSaveProject(args));
}

function renameProjectTool(args: Args): Promise<Record<string, unknown>> {
  const id = requireString(args, 'id');
  const name = requireString(args, 'name');
  return serializeWrite(async () => {
    const result = await renameProject(id, name);
    if ('error' in result) throw new Error(result.error);
    return { project: result.project };
  });
}

// ------------------------------------------------------------------ 舞台 / 拼接 / 3D 任务

/** 舞台 ID 与路由层同一套规则（1–80 位 [A-Za-z0-9_-]），避免拼出目录穿越路径 */
function requireStageId(args: Args): string {
  const id = stageId(requireString(args, 'id'));
  if (!id) throw new Error('无效的舞台 ID');
  return id;
}

/** 从参数里挑出可写入舞台文档的字段；未提供的字段保持原值（save 时用于合并） */
function stageFields(args: Args): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const name = readString(args, 'name');
  if (name !== undefined) fields.name = name;
  if (args.actors !== undefined) fields.actors = args.actors;
  if (args.segments !== undefined) fields.segments = args.segments;
  const loop = readBoolean(args, 'loop');
  if (loop !== undefined) fields.loop = loop;
  return fields;
}

function createStage(args: Args): Promise<Record<string, unknown>> {
  return serializeWrite(async () => {
    const stage = normalizeStage(stageFields(args), randomUUID());
    if (!stage) throw new Error('舞台文档格式不正确');
    await writeStage(stage);
    return { stage: stageSummaryOf(stage) };
  });
}

function saveStage(args: Args): Promise<Record<string, unknown>> {
  const id = requireStageId(args);
  return serializeWrite(async () => {
    const existing = await readStage(id);
    if (!existing) throw new Error(`舞台 ${id} 不存在`);
    // 合并而不是整体替换：调用方只想改角色/片段里的一项时不必回传完整文档
    const stage = normalizeStage({ ...existing, ...stageFields(args) }, id);
    if (!stage) throw new Error('舞台文档格式不正确');
    stage.createdAt = existing.createdAt;
    await writeStage(stage);
    return { stage: stageSummaryOf(stage) };
  });
}

/** 拼接编排校验：tracks 必须是数组，否则视为脏数据（与后端 compositionOf 一致） */
function requireComposition(raw: unknown): NonNullable<SavedProject['composition']> {
  const composition = normalizeComposition(raw, null);
  if (!composition) throw new Error('composition 不合法：必须包含 tracks 数组');
  return composition;
}

function createStripsProject(args: Args): Promise<Record<string, unknown>> {
  return serializeWrite(async () => {
    const name = normalizeName(requireString(args, 'name'));
    if (await isNameTaken(name)) throw new Error(`名称「${name}」已被使用`);
    const composition = requireComposition(args.composition);
    const now = new Date().toISOString();
    const record = normalizeRecord(
      {
        name,
        basePath: readString(args, 'basePath') ?? composition.basePath ?? '',
        baseName: readString(args, 'baseName') ?? composition.baseName ?? '',
        data: args.data ?? null,
        composition,
        createdAt: now,
        updatedAt: now,
      },
      randomUUID(),
    );
    if (!record) throw new Error('项目数据不合法');
    await writeProject(record);
    return { project: summaryOf(record) };
  });
}

function saveStripsProject(args: Args): Promise<Record<string, unknown>> {
  const id = requireString(args, 'id');
  return serializeWrite(async () => {
    const record = await readProject(id);
    if (!record) throw new Error(`项目 ${id} 不存在`);

    if (args.composition !== undefined) {
      record.composition = requireComposition(args.composition);
    } else if (!record.composition) {
      throw new Error('该项目不是拼接动画（没有 composition）；请改用 animation_save_project');
    }
    if (args.data !== undefined) record.data = args.data;
    if (args.basePath !== undefined) record.basePath = readString(args, 'basePath') ?? '';
    if (args.baseName !== undefined) record.baseName = readString(args, 'baseName') ?? '';

    const name = readString(args, 'name');
    if (name !== undefined) {
      const normalized = normalizeName(name);
      if (!normalized) throw new Error('名称不能为空');
      if (await isNameTaken(normalized, id)) throw new Error(`名称「${normalized}」已被使用`);
      record.name = normalized;
    }
    record.updatedAt = new Date().toISOString();

    const next = normalizeRecord(record, id);
    if (!next) throw new Error('项目数据不合法');
    await writeProject(next);
    return { project: summaryOf(next) };
  });
}

/**
 * 3D 生成任务属于 HTTP 服务的运行态（state.json + worker），
 * MCP 独立进程直接写会与正在运行的服务互相覆盖，因此这里统一转发到本地 API。
 */
const API_BASE = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `无法连接本地 API（${API_BASE}）：${(err as Error).message}。请先运行 npm run dev:api 或 npm start`,
    );
  }
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 300) };
    }
  }
  if (!response.ok) {
    const message = (payload as { error?: unknown }).error;
    throw new Error(typeof message === 'string' ? message : `请求失败（HTTP ${response.status}）`);
  }
  return payload as T;
}

// ------------------------------------------------------------------ 工具定义

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Args) => Promise<unknown> | unknown;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const idProperty = { type: 'string', description: '项目 / 任务 ID' };
const nameProperty = { type: 'string', description: '名称（最长 80 字，不能与现有项目重名）' };

const tools: ToolDefinition[] = [
  {
    name: 'animation_list_projects',
    description: '列出「新建动画」项目（不含动画数据，只给摘要）',
    inputSchema: objectSchema({}),
    handler: async () => ({ projects: await listProjects() }),
  },
  {
    name: 'animation_get_project',
    description: '读取单个新建动画项目；includeData 为 true 时一并返回动画数据',
    inputSchema: objectSchema(
      { id: idProperty, includeData: { type: 'boolean', description: '是否返回完整动画数据' } },
      ['id'],
    ),
    handler: async (args) => {
      const record = await readProject(requireString(args, 'id'));
      if (!record) throw new Error('项目不存在');
      if (readBoolean(args, 'includeData')) return { project: record };
      return { project: summaryOf(record) };
    },
  },
  {
    name: 'animation_create_project',
    description: '创建新建动画项目；可选传入 basePath/baseName 与 fbx-animation-data 格式的 data',
    inputSchema: objectSchema({
      name: nameProperty,
      basePath: { type: 'string', description: '基础模型 FBX 的绝对路径' },
      baseName: { type: 'string', description: '基础模型文件名' },
      data: { type: 'object', description: 'fbx-animation-data 动画数据' },
      imported: { type: 'object', description: '导入摘要 { name, clipCount, trackCount }' },
    }, ['name']),
    handler: createProject,
  },
  {
    name: 'animation_save_project',
    description: '把动画数据写入已有项目（可顺带改名，重名会失败）',
    inputSchema: objectSchema(
      {
        id: idProperty,
        data: { type: 'object', description: 'fbx-animation-data 动画数据' },
        imported: { type: 'object', description: '导入摘要 { name, clipCount, trackCount }' },
        name: nameProperty,
      },
      ['id'],
    ),
    handler: saveProject,
  },
  {
    name: 'animation_rename_project',
    description: '重命名新建动画项目（大小写不敏感查重）',
    inputSchema: objectSchema({ id: idProperty, name: nameProperty }, ['id', 'name']),
    handler: renameProjectTool,
  },
  {
    name: 'animation_delete_project',
    description: '把项目移入回收站（软删除，可用 animation_restore_project 恢复）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) => {
      const id = requireString(args, 'id');
      return serializeWrite(async () => {
        const ok = await trashProject(id);
        if (!ok) throw new Error('项目不存在');
        return { ok: true, trashed: true };
      });
    },
  },
  {
    name: 'animation_list_trash',
    description: '列出回收站里的项目',
    inputSchema: objectSchema({}),
    handler: async () => ({ projects: await listTrash() }),
  },
  {
    name: 'animation_restore_project',
    description: '从回收站恢复项目；重名时自动加「(恢复)」后缀',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) => {
      const id = requireString(args, 'id');
      return serializeWrite(async () => {
        const result = await restoreProject(id);
        if (!result) throw new Error('回收站里没有该项目');
        return { ok: true, renamed: result.renamed, project: result.project };
      });
    },
  },
  {
    name: 'animation_purge_project',
    description: '彻底删除回收站项目（不可恢复）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) => {
      const id = requireString(args, 'id');
      return serializeWrite(async () => {
        const ok = await purgeProject(id);
        if (!ok) throw new Error('回收站里没有该项目');
        return { ok: true };
      });
    },
  },
  // ---------------------------------------------------------------- Kimodo 工具组
  // 生成器是单进程串行推理，所以这里只负责「提交任务」或查询，不等待生成完成；
  // 所有返回值都经过 publicStatus / publicJob / scrub，绝不暴露 .env 里的路径与密钥。
  {
    name: 'kimodo_status',
    description: 'Kimodo 生成器状态（不返回任何 .env 路径或密钥）',
    inputSchema: objectSchema({}),
    handler: () => publicStatus(),
  },
  {
    name: 'kimodo_generate',
    description:
      '提交一次文生动作任务（后台串行执行，立即返回排队中的任务）。支持单段 prompt 或多段 segments（至少 2 段，段间自动过渡）',
    inputSchema: objectSchema(
      {
        prompt: { type: 'string', description: '英文动作提示词（单段模式）' },
        frames: { type: 'number', description: '帧数，默认 60（8–300）' },
        steps: { type: 'number', description: '扩散步数，默认 20' },
        seed: { type: 'number', description: '随机种子，<=0 或留空表示随机' },
        transitionFrames: { type: 'number', description: '首尾过渡帧，默认 5' },
        segments: {
          type: 'array',
          description:
            '复合动作分段：[{ prompt, frames }]，至少 2 段才生效；提供后忽略顶层 prompt',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: '该段英文动作提示词' },
              frames: { type: 'number', description: '该段帧数' },
            },
            required: ['prompt', 'frames'],
          },
        },
      },
      ['prompt'],
    ),
    handler: (args) => {
      const segments = readSegments(args);
      const job = kimodoService.submit({
        prompt: requireString(args, 'prompt'),
        frames: readNumber(args, 'frames') ?? 60,
        steps: readNumber(args, 'steps') ?? 20,
        seed: readNumber(args, 'seed'),
        transitionFrames: readNumber(args, 'transitionFrames'),
        segments,
      });
      return { task: publicJob(job) };
    },
  },
  {
    name: 'kimodo_get_animation',
    description: '读取单个 Kimodo 生成任务（含状态、进度、注释、分段等）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) => {
      const job = kimodoService.get(requireString(args, 'id'));
      if (!job) throw new Error('任务不存在');
      return { task: publicJob(job) };
    },
  },
  {
    name: 'kimodo_list_animations',
    description: '列出 Kimodo 生成任务（含历史任务）',
    inputSchema: objectSchema({}),
    handler: () => ({ animations: kimodoService.list().map(publicJob) }),
  },
  {
    name: 'kimodo_update_note',
    description: '给生成结果添加 / 修改注释（传空字符串表示清除）',
    inputSchema: objectSchema(
      {
        id: idProperty,
        note: { type: 'string', description: '注释内容（最长 200 字，空串清除）' },
      },
      ['id', 'note'],
    ),
    handler: (args) => {
      const id = requireString(args, 'id');
      const note = readString(args, 'note') ?? '';
      const updated = kimodoService.updateNote(id, note.slice(0, 200));
      if (!updated) throw new Error('任务不存在');
      return { task: publicJob(updated) };
    },
  },
  {
    name: 'kimodo_delete_animation',
    description: '删除生成结果（生成中的任务不可删除）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) => {
      const ok = kimodoService.remove(requireString(args, 'id'));
      if (!ok) throw new Error('无法删除该任务（任务不存在或正在生成中）');
      return { ok: true };
    },
  },
  {
    name: 'kimodo_import_animation',
    description:
      '把生成结果重定向为 Mixamo 动画 JSON。给 projectId 时直接写入该新建动画项目；includeData 控制是否返回完整数据',
    inputSchema: objectSchema(
      {
        id: idProperty,
        clipName: { type: 'string', description: '片段名，默认取提示词' },
        projectId: { type: 'string', description: '可选：写入这个新建动画项目' },
        includeData: { type: 'boolean', description: '是否返回完整动画数据' },
      },
      ['id'],
    ),
    handler: async (args) => {
      const id = requireString(args, 'id');
      // 真正做骨架重定向的是 Python 脚本；成功后才把结果写进指定项目，
      // 写项目同样走写队列，避免与并发的重命名/删除互相覆盖。
      const outcome = await importKimodoAnimation(id, readString(args, 'clipName'));
      if (!outcome.ok) throw new Error(outcome.error);

      const clips = clipsOf(outcome.data);
      const summary = {
        clipName: outcome.clipName,
        clipCount: clips.length,
        trackCount: countTracks(clips),
      };

      const projectId = readString(args, 'projectId');
      let project: SavedProject | null = null;
      if (projectId) {
        project = await serializeWrite(async () => {
          const record = await readProject(projectId);
          if (!record) throw new Error(`项目 ${projectId} 不存在`);
          record.data = outcome.data;
          record.imported = {
            name: outcome.clipName,
            clipCount: summary.clipCount,
            trackCount: summary.trackCount,
          };
          record.updatedAt = new Date().toISOString();
          const next = normalizeRecord(record, projectId);
          if (!next) throw new Error('项目数据不合法');
          await writeProject(next);
          return next;
        });
      }

      if (readBoolean(args, 'includeData')) {
        return { ok: true, ...summary, data: outcome.data, project };
      }
      return { ok: true, ...summary, project };
    },
  },
  {
    name: 'kimodo_list_artifacts',
    description: '列出一次生成的中间产物与关联的新建动画（提示词 → 任务 → 数据 → Mixamo JSON → 项目）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: async (args) => {
      const result = await kimodoService.artifacts(requireString(args, 'id'));
      if (!result) throw new Error('任务不存在');
      return {
        task: publicJob(result.task),
        artifacts: result.artifacts.map((item) => ({ ...item, file: item.file })),
        relations: result.relations,
      };
    },
  },
  {
    name: 'kimodo_read_artifact',
    description: '读取中间产物的文本内容（key 可选 prompt / meta / mixamo）',
    inputSchema: objectSchema(
      {
        id: idProperty,
        key: {
          type: 'string',
          enum: ['prompt', 'meta', 'mixamo'],
          description: '产物类型',
        },
      },
      ['id', 'key'],
    ),
    handler: (args) => {
      const result = kimodoService.readArtifact(requireString(args, 'id'), requireString(args, 'key'));
      if (!result) throw new Error('产物不存在或不可查看');
      return result;
    },
  },
  {
    name: 'kimodo_enhance_prompt',
    description: '用服务端配置的大模型把描述 / 参考图片转译成英文动作提示词（不暴露密钥）',
    inputSchema: objectSchema({
      prompt: { type: 'string', description: '中文或英文的动作描述' },
      image: { type: 'string', description: '可选：参考图片的 data URL（data:image/png;base64,...）' },
    }),
    handler: async (args) => {
      const prompt = readString(args, 'prompt') ?? '';
      const image = readString(args, 'image');
      if (!prompt.trim() && !image) throw new Error('请提供描述文字或参考图片');
      if (!promptEnhancerReady()) {
        throw new Error(
          '服务端未配置提示词模型：请设置 KIMODO_PROMPT_PROVIDER 与对应的 API Key（默认 DeepSeek 用 DEEPSEEK_API_KEY）',
        );
      }
      return enhancePrompt({ prompt, image });
    },
  },
  {
    name: 'kimodo_refine_prompt',
    description:
      '按用户修改后的动作拆解步骤重新生成英文提示词与分段。步骤是唯一事实来源，模型只负责转译身体动力学英文',
    inputSchema: objectSchema(
      {
        steps: {
          type: 'array',
          description: '按时间顺序的中文动作步骤（至少 1 条）',
          items: { type: 'string' },
        },
        objects: {
          type: 'array',
          description: '可选：原描述里的物体名，仅用于提示模型不要写物体接触',
          items: { type: 'string' },
        },
        note: { type: 'string', description: '可选：上次转译的说明，帮助模型保持上下文' },
      },
      ['steps'],
    ),
    handler: async (args) => {
      const steps = Array.isArray(args.steps)
        ? args.steps
            .filter((step): step is string => typeof step === 'string')
            .map((step) => step.trim())
            .filter(Boolean)
        : [];
      if (steps.length === 0) throw new Error('请先填写至少一个动作步骤');
      const objects = Array.isArray(args.objects)
        ? args.objects.filter((item): item is string => typeof item === 'string')
        : [];
      if (!promptEnhancerReady()) {
        throw new Error(
          '服务端未配置提示词模型：请设置 KIMODO_PROMPT_PROVIDER 与对应的 API Key',
        );
      }
      return refinePrompt({ steps, objects, note: readString(args, 'note') });
    },
  },
  {
    name: 'kimodo_skeleton',
    description: '返回 SOMA RP v1.1 骨架定义（关节名、父子关系、T-pose 偏移）',
    inputSchema: objectSchema({}),
    handler: () => SOMA_SKELETON,
  },
  // ---------------------------------------------------------------- 舞台工具组
  // 舞台是纯编排文档（角色 + 片段序列），磁盘读写走 stages.ts 的原子写入，
  // 因此可以和运行中的 HTTP 服务共用同一份数据，不需要额外转一层 HTTP。
  {
    name: 'stage_list',
    description: '列出舞台项目摘要（角色数 / 片段数，不含完整文档）',
    inputSchema: objectSchema({}),
    handler: async () => ({ stages: await listStages() }),
  },
  {
    name: 'stage_get',
    description: '读取一份完整舞台文档（角色、片段序列、循环设置）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: async (args) => {
      const stage = await readStage(requireStageId(args));
      if (!stage) throw new Error('舞台不存在');
      return { stage };
    },
  },
  {
    name: 'stage_create',
    description:
      '创建舞台。片段来源支持 fbx-clip / kimodo / anim-project；结构非法（缺 actorId 对应角色等）的条目会被后端丢弃',
    inputSchema: objectSchema({
      name: { type: 'string', description: '舞台名称，默认「未命名舞台」' },
      actors: {
        type: 'array',
        description: '角色 [{ id, name, kind: fbx|soma, modelPath?, transform: { x, z, yaw }, visible }]',
        items: { type: 'object' },
      },
      segments: {
        type: 'array',
        description:
          '片段 [{ id, actorId, source, trimStart, trimEnd, start?, color?, pose?, transition? }]',
        items: { type: 'object' },
      },
      loop: { type: 'boolean', description: '是否循环播放，默认 true' },
    }),
    handler: createStage,
  },
  {
    name: 'stage_save',
    description: '更新舞台：只传要修改的字段（actors / segments 整组替换），其余保持原值',
    inputSchema: objectSchema(
      {
        id: idProperty,
        name: { type: 'string', description: '新名称（≤ 80 字）' },
        actors: { type: 'array', items: { type: 'object' }, description: '完整角色数组（整组替换）' },
        segments: { type: 'array', items: { type: 'object' }, description: '完整片段数组（整组替换）' },
        loop: { type: 'boolean', description: '是否循环播放' },
      },
      ['id'],
    ),
    handler: saveStage,
  },
  {
    name: 'stage_delete',
    description: '把舞台移入回收站（data/stages-trash，暂未提供恢复工具）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) => {
      const id = requireStageId(args);
      return serializeWrite(async () => {
        const ok = await trashStage(id);
        if (!ok) throw new Error('舞台不存在');
        return { ok: true };
      });
    },
  },
  // ---------------------------------------------------------------- 拼接工作区工具组
  // 拼接项目 = 普通动画项目 + composition（基础模型 + 最多 5 条 Strip 轨道）。
  // 这里复用 animProjects 的写入队列与查重规则，避免绕过名称唯一性约束。
  {
    name: 'strips_list_projects',
    description: '列出拼接动画项目（带 composition 的项目，最多 5 条 Strip）',
    inputSchema: objectSchema({}),
    handler: async () => ({
      projects: (await listProjects()).filter((item) => item.kind === 'strips'),
    }),
  },
  {
    name: 'strips_get_project',
    description: '读取拼接项目；includeData 为 true 时同时返回烘焙后的动画数据',
    inputSchema: objectSchema(
      { id: idProperty, includeData: { type: 'boolean', description: '是否返回完整动画数据' } },
      ['id'],
    ),
    handler: async (args) => {
      const record = await readProject(requireString(args, 'id'));
      if (!record) throw new Error('项目不存在');
      if (!record.composition) throw new Error('该项目不是拼接动画（没有 composition）');
      return readBoolean(args, 'includeData') ? { project: record } : { project: summaryOf(record) };
    },
  },
  {
    name: 'strips_create_project',
    description:
      '创建拼接动画项目：composition 必须包含 tracks 数组（前端 StripDef 数组，最多 5 条，对应 5 个身体部位）',
    inputSchema: objectSchema(
      {
        name: nameProperty,
        composition: {
          type: 'object',
          description: '拼接编排 { version?, basePath, baseName, tracks: [], duration }',
        },
        basePath: { type: 'string', description: '基础模型 FBX 绝对路径（缺省取 composition.basePath）' },
        baseName: { type: 'string', description: '基础模型文件名' },
        data: { type: 'object', description: '已烘焙的 fbx-animation-data（可选）' },
      },
      ['name', 'composition'],
    ),
    handler: createStripsProject,
  },
  {
    name: 'strips_save_project',
    description: '更新拼接项目：可替换 composition / 烘焙数据 / 基础模型，或改名（重名会失败）',
    inputSchema: objectSchema(
      {
        id: idProperty,
        composition: { type: 'object', description: '新的拼接编排（必须含 tracks 数组）' },
        data: { type: 'object', description: '新的 fbx-animation-data 烘焙数据' },
        basePath: { type: 'string', description: '基础模型 FBX 绝对路径' },
        baseName: { type: 'string', description: '基础模型文件名' },
        name: nameProperty,
      },
      ['id'],
    ),
    handler: saveStripsProject,
  },
  // ---------------------------------------------------------------- 3D 生成任务（HTTP 代理）
  // 任务运行态由 HTTP 服务持有（state.json + worker），MCP 独立进程直接写会互相覆盖，
  // 因此这些工具统一转发到本地 API；服务没启动时会返回明确的启动提示。
  {
    name: 'model_providers',
    description: '列出可用 3D 生成引擎及其 Key 配置状态（不含密钥）',
    inputSchema: objectSchema({}),
    handler: () => apiRequest('/api/providers'),
  },
  {
    name: 'model_list_jobs',
    description: '列出 3D 生成任务（默认最近 30 条，最多 300），并返回队列状态',
    inputSchema: objectSchema({
      limit: { type: 'number', description: '返回条数，默认 30，最多 300' },
    }),
    handler: async (args) => {
      const limit = Math.min(300, Math.max(1, Math.round(readNumber(args, 'limit') ?? 30)));
      const state = await apiRequest<{ jobs: unknown[]; totalJobs: number; queue: unknown }>(
        `/api/state?limit=${limit}`,
      );
      return { totalJobs: state.totalJobs, queue: state.queue, jobs: state.jobs };
    },
  },
  {
    name: 'model_get_job',
    description: '读取单个 3D 生成任务（状态、参数、资产文件）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) => apiRequest(`/api/jobs/${encodeURIComponent(requireString(args, 'id'))}`),
  },
  {
    name: 'model_create_job',
    description:
      '提交 3D 生成任务（text / image / multiview）。任务交给本地 API 的 worker 执行，需要服务正在运行',
    inputSchema: objectSchema(
      {
        mode: { type: 'string', enum: ['text', 'image', 'multiview'], description: '输入模式，默认 text' },
        prompt: { type: 'string', description: '文生模式必填的描述文字' },
        imageBase64: { type: 'string', description: '图生模式单张参考图（base64 或 data URL）' },
        imageName: { type: 'string', description: '参考图文件名（仅展示）' },
        views: {
          type: 'array',
          description: '多视角图片 [{ viewType, imageBase64, name }]',
          items: { type: 'object' },
        },
        previewDataUrl: { type: 'string', description: '可选：输入图预览（data:image/...;base64,...）' },
        provider: { type: 'string', description: '引擎 id（hunyuan3d / tripo3d / meshy），缺省用默认引擎' },
        params: {
          type: 'object',
          description:
            '生成参数 { model?, generateType?, faceCount?, enablePbr?, polygonType?, resultFormat? }',
        },
      },
      ['mode'],
    ),
    handler: (args) => {
      const body: Record<string, unknown> = {
        mode: requireString(args, 'mode'),
        prompt: readString(args, 'prompt') ?? '',
      };
      for (const key of ['imageBase64', 'imageName', 'previewDataUrl', 'provider'] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      if (args.views !== undefined) body.views = args.views;
      if (args.params !== undefined) body.params = args.params;
      return apiRequest('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    },
  },
  {
    name: 'model_cancel_job',
    description: '取消进行中的 3D 生成任务（会尽量同步取消远端任务）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) =>
      apiRequest(`/api/jobs/${encodeURIComponent(requireString(args, 'id'))}/cancel`, {
        method: 'POST',
        body: '{}',
      }),
  },
  {
    name: 'model_delete_job',
    description: '删除已结束的 3D 生成任务及其本地素材文件（进行中的任务需先取消）',
    inputSchema: objectSchema({ id: idProperty }, ['id']),
    handler: (args) =>
      apiRequest(`/api/jobs/${encodeURIComponent(requireString(args, 'id'))}`, { method: 'DELETE' }),
  },
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

// ------------------------------------------------------------------ JSON-RPC

interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id: string | number | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: string | number | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleCall(message: RpcMessage): Promise<void> {
  const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = toolMap.get(name);
  if (!tool) {
    replyError(message.id, -32602, `未知工具：${name || '(空)'}`);
    return;
  }
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Args;
  try {
    const result = await tool.handler(args);
    reply(message.id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false,
    });
  } catch (err) {
    reply(message.id, {
      content: [{ type: 'text', text: JSON.stringify({ error: scrub((err as Error).message) }, null, 2) }],
      isError: true,
    });
  }
}

async function handleMessage(message: RpcMessage): Promise<void> {
  const method = message.method ?? '';
  switch (method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '该服务管理 3D 工作台：动画项目（含回收站）、拼接动画项目（composition）、' +
          '舞台文档、Kimodo 文生动作，以及 3D 生成任务（model_* 转发到本地 API，需服务已启动）。' +
          '所有工具都不会返回 .env 中的路径或密钥。',
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      reply(message.id, {});
      return;
    case 'tools/list':
      reply(message.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    case 'tools/call':
      await handleCall(message);
      return;
    default:
      replyError(message.id, -32601, `未实现的方法：${method}`);
  }
}

function main(): void {
  /** 正在处理的请求；stdin 结束时等它们写完响应再退出 */
  const inFlight = new Set<Promise<void>>();

  function track(task: Promise<void>): void {
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      replyError(null, -32700, '无法解析 JSON');
      return;
    }
    if (Array.isArray(parsed)) {
      // 批量请求：逐条处理，通知类没有响应
      for (const item of parsed as RpcMessage[]) track(handleMessage(item));
      return;
    }
    track(handleMessage(parsed as RpcMessage));
  });

  const shutdown = (): void => {
    kimodoService.shutdown();
    process.exit(0);
  };
  process.stdin.on('end', () => {
    void Promise.allSettled([...inFlight]).then(shutdown);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.error(`[mcp] ${SERVER_INFO.name} ${SERVER_INFO.version} 已启动，等待 JSON-RPC 请求`);
}

// 版本信息只在 stderr 输出，避免污染 stdio
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version === 'string') SERVER_INFO.version = pkg.version;
} catch {
  /* 读不到就用默认版本号 */
}

main();
