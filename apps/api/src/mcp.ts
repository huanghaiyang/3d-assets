#!/usr/bin/env node
/**
 * MCP（Model Context Protocol）stdio 服务。
 *
 * 直接在进程内调用服务层，不经过 HTTP：动画项目（含回收站）与 Kimodo 生成/导入/
 * 中间产物都能被 MCP 客户端调用。
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
} from './services/kimodo.js';
import { enhancePrompt, promptEnhancerReady } from './services/promptEnhance.js';

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
    promptModel: status.promptModel,
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
    description: '提交一次文生动作任务（后台串行执行，立即返回排队中的任务）',
    inputSchema: objectSchema(
      {
        prompt: { type: 'string', description: '英文动作提示词' },
        frames: { type: 'number', description: '帧数，默认 60（8–300）' },
        steps: { type: 'number', description: '扩散步数，默认 20' },
        seed: { type: 'number', description: '随机种子，<=0 或留空表示随机' },
        transitionFrames: { type: 'number', description: '首尾过渡帧，默认 5' },
      },
      ['prompt'],
    ),
    handler: (args) => {
      const job = kimodoService.submit({
        prompt: requireString(args, 'prompt'),
        frames: readNumber(args, 'frames') ?? 60,
        steps: readNumber(args, 'steps') ?? 20,
        seed: readNumber(args, 'seed'),
        transitionFrames: readNumber(args, 'transitionFrames'),
      });
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
      if (!promptEnhancerReady()) throw new Error('服务端未配置 DEEPSEEK_API_KEY');
      return enhancePrompt({
        prompt: readString(args, 'prompt'),
        image: readString(args, 'image'),
      });
    },
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
          '该服务管理 3D 工作台的「新建动画」项目（含回收站）与 Kimodo 文生动作生成。' +
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
