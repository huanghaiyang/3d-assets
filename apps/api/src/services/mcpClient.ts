import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { joinData, repoRoot } from '../lib/paths.js';

/**
 * 应用内 MCP 客户端：通过 stdio 拉起外部 MCP 服务器并调用其工具。
 *
 * 与 `src/mcp.ts` 的区别：
 *  - `src/mcp.ts` 是「本工作台作为 MCP 服务器」被 Trae / Cursor / Claude 调用；
 *  - 本文件是反向的「本工作台作为 MCP 客户端」，让界面可以接入任意 MCP 服务器
 *    （例如自建的文件系统、素材库、第三方生成服务）。
 *
 * 配置持久化在 `data/mcp-servers.json`（gitignore），进程只在用户点击「连接」或
 * 首次调用工具时启动，不会随应用启动而拉起任意命令。
 *
 * 安全约定：
 *  - 接口只返回环境变量的「键名」，绝不回传值（可能含 API Key）；
 *  - 命令与参数由用户自己填写，属于本地可信配置，但仍按原样记录、不做 shell 展开。
 */

export interface McpServerConfig {
  /** 稳定 id，用于路由定位；创建后不再变化 */
  id: string;
  /** 展示名 */
  name: string;
  /** 可执行文件（node / npx / python ...） */
  command: string;
  /** 传给可执行文件的参数 */
  args: string[];
  /** 追加到子进程的环境变量（值不会通过接口返回） */
  env: Record<string, string>;
}

/** 列表接口使用的视图：只暴露环境变量键名与运行状态 */
export interface McpServerView {
  id: string;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  connected: boolean;
  toolCount: number;
  error: string | null;
}

/** `tools/list` 返回的工具描述（透传，不做裁剪） */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const CONFIG_FILE = joinData('mcp-servers.json');
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'h3d-workbench', version: '1.0.0' };
/** 单次 JSON-RPC 请求超时；工具调用可能很慢，给更长的上限 */
const REQUEST_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_ERROR_TEXT = 800;

/** 内存里的连接实例：同一配置复用同一条子进程 */
const clients = new Map<string, StdioMcpClient>();

/**
 * 一个 stdio MCP 连接。
 *
 * 生命周期：connect() → initialize 握手 → tools/list → 可反复 callTool → dispose()。
 * 子进程退出时会把所有挂起请求按失败处理，避免调用方永久等待。
 */
class StdioMcpClient {
  readonly config: McpServerConfig;
  tools: McpToolInfo[] = [];
  lastError: string | null = null;

  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.ready && this.child !== null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.dispose();
    this.lastError = null;

    const child = spawn(this.config.command, this.config.args, {
      // 继承服务进程环境，再叠加用户配置；cwd 固定仓库根，方便使用相对路径命令
      env: { ...process.env, ...this.config.env },
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));

    // 只保留最后一段 stderr，用于界面展示启动失败原因（不写入 stdout）
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) this.lastError = text.slice(0, MAX_ERROR_TEXT);
    });
    child.on('error', (err) => {
      this.lastError = err.message.slice(0, MAX_ERROR_TEXT);
      this.ready = false;
      this.child = null;
      this.failAll(new Error(`MCP 进程启动失败：${err.message}`));
    });
    child.on('exit', (code, signal) => {
      const message = `MCP 进程已退出（code=${code ?? '-'}，signal=${signal ?? '-'}）`;
      if (this.child === child) {
        this.ready = false;
        this.child = null;
        this.lastError = this.lastError ?? message;
      }
      this.failAll(new Error(this.lastError ?? message));
    });

    try {
      await this.request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        REQUEST_TIMEOUT_MS,
      );
      this.notify('notifications/initialized', {});
      const listed = (await this.request('tools/list', {}, REQUEST_TIMEOUT_MS)) as { tools?: unknown };
      this.tools = Array.isArray(listed?.tools)
        ? listed.tools.filter((item): item is McpToolInfo => {
            if (!item || typeof item !== 'object') return false;
            return typeof (item as McpToolInfo).name === 'string';
          })
        : [];
      this.ready = true;
    } catch (err) {
      this.dispose();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();
    return this.request('tools/call', { name, arguments: args }, TOOL_TIMEOUT_MS);
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      child.stdin.end();
      child.kill();
    }
    this.failAll(new Error('MCP 连接已关闭'));
  }

  /** 解析一行 stdout；只有带 id 的响应才会唤醒挂起请求，通知类消息直接忽略 */
  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      // 非 JSON 输出（有些服务会往 stdout 打日志）忽略即可，不污染调用方
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      const detail = typeof message.error.message === 'string' ? message.error.message : '未知错误';
      waiter.reject(new Error(detail.slice(0, MAX_ERROR_TEXT)));
      return;
    }
    waiter.resolve(message.result);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error('MCP 进程未运行'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)}s）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** 连接断开时让所有等待中的请求失败，避免请求悬挂 */
  private failAll(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

// ------------------------------------------------------------------ 配置持久化

/** 配置文件写入必须串行，避免两次「新增服务器」互相覆盖 */
let configWriteChain: Promise<unknown> = Promise.resolve();

function serializeConfigWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = configWriteChain.then(task, task);
  configWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) return null;
  if (typeof value.command !== 'string' || !value.command.trim()) return null;
  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === 'string')
    : [];
  const env: Record<string, string> = {};
  if (value.env && typeof value.env === 'object') {
    for (const [key, entry] of Object.entries(value.env as Record<string, unknown>)) {
      if (typeof entry === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = entry;
    }
  }
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : value.command,
    command: value.command.trim(),
    args,
    env,
  };
}

async function readConfigs(): Promise<McpServerConfig[]> {
  const text = await fs.readFile(CONFIG_FILE, 'utf8').catch(() => null);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeConfig)
      .filter((item): item is McpServerConfig => item !== null);
  } catch {
    // 配置文件损坏时按空列表处理，避免整个 MCP 面板打不开
    return [];
  }
}

async function writeConfigs(configs: McpServerConfig[]): Promise<void> {
  await fs.mkdir(joinData(), { recursive: true });
  const temp = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(configs, null, 2), 'utf8');
  await fs.rename(temp, CONFIG_FILE);
}

function viewOf(config: McpServerConfig): McpServerView {
  const client = clients.get(config.id);
  return {
    id: config.id,
    name: config.name,
    command: config.command,
    args: config.args,
    envKeys: Object.keys(config.env),
    connected: client?.connected ?? false,
    toolCount: client?.tools.length ?? 0,
    error: client?.lastError ?? null,
  };
}

/** 读取某个配置；不存在返回 null（路由层转 404） */
async function findConfig(id: string): Promise<McpServerConfig | null> {
  const configs = await readConfigs();
  return configs.find((item) => item.id === id) ?? null;
}

// ------------------------------------------------------------------ 对外 API

export async function listServers(): Promise<McpServerView[]> {
  return (await readConfigs()).map(viewOf);
}

export interface UpsertServerInput {
  id?: string;
  name?: string;
  command: string;
  args?: string[];
  /** 传 undefined 表示保持原有环境变量；传 {} 表示清空 */
  env?: Record<string, string>;
}

/** 新增或更新一个服务器配置；命令 / 参数变化会断开已有连接 */
export async function upsertServer(input: UpsertServerInput): Promise<McpServerView> {
  const command = (input.command ?? '').trim();
  if (!command) throw new Error('请填写可执行命令');
  const args = Array.isArray(input.args) ? input.args.filter((item) => typeof item === 'string') : [];

  return serializeConfigWrite(async () => {
    const configs = await readConfigs();
    const id = input.id && /^[A-Za-z0-9_-]{1,64}$/.test(input.id) ? input.id : randomUUID();
    const index = configs.findIndex((item) => item.id === id);
    const previous = index >= 0 ? configs[index]! : null;

    const env: Record<string, string> = {};
    if (input.env && typeof input.env === 'object') {
      for (const [key, value] of Object.entries(input.env)) {
        if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
      }
    }
    const next: McpServerConfig = {
      id,
      name:
        (input.name ?? previous?.name ?? command).trim().slice(0, 80) ||
        command,
      command,
      args,
      env: input.env === undefined ? (previous?.env ?? {}) : env,
    };

    if (index >= 0) configs[index] = next;
    else configs.push(next);
    await writeConfigs(configs);

    // 命令或参数变了就丢弃旧进程，下次连接会用新配置重新拉起
    const changed =
      !previous ||
      previous.command !== next.command ||
      previous.args.join('\u0000') !== next.args.join('\u0000') ||
      JSON.stringify(previous.env) !== JSON.stringify(next.env);
    if (changed) {
      clients.get(id)?.dispose();
      clients.delete(id);
    }
    return viewOf(next);
  });
}

export async function removeServer(id: string): Promise<boolean> {
  clients.get(id)?.dispose();
  clients.delete(id);
  return serializeConfigWrite(async () => {
    const configs = await readConfigs();
    const next = configs.filter((item) => item.id !== id);
    if (next.length === configs.length) return false;
    await writeConfigs(next);
    return true;
  });
}

/** 建立连接（已连接则直接复用）；失败时保留错误信息供界面展示 */
export async function connectServer(id: string): Promise<McpServerView> {
  const config = await findConfig(id);
  if (!config) throw new Error('MCP 服务器不存在');
  let client = clients.get(id);
  if (!client) {
    client = new StdioMcpClient(config);
    clients.set(id, client);
  }
  try {
    await client.connect();
  } catch (err) {
    client.lastError = (err as Error).message;
    throw err;
  }
  return viewOf(config);
}

export function disconnectServer(id: string): McpServerView | null {
  const client = clients.get(id);
  client?.dispose();
  clients.delete(id);
  return null;
}

/** 列出工具：未连接时自动建立连接，调用方无需先手动 connect */
export async function listTools(id: string): Promise<McpToolInfo[]> {
  const config = await findConfig(id);
  if (!config) throw new Error('MCP 服务器不存在');
  const client = await ensureClient(config);
  return client.tools;
}

/** 调用外部工具；返回 MCP 原始结果（content 数组等） */
export async function callTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = name.trim();
  if (!tool) throw new Error('请填写工具名');
  const config = await findConfig(id);
  if (!config) throw new Error('MCP 服务器不存在');
  const client = await ensureClient(config);
  return client.callTool(tool, args);
}

async function ensureClient(config: McpServerConfig): Promise<StdioMcpClient> {
  let client = clients.get(config.id);
  if (!client) {
    client = new StdioMcpClient(config);
    clients.set(config.id, client);
  }
  if (!client.connected) await client.connect();
  return client;
}

/** 应用退出时关闭所有子进程（由路由层挂到 Fastify onClose） */
export async function shutdownMcpClients(): Promise<void> {
  for (const [, client] of clients) client.dispose();
  clients.clear();
}
