import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../lib/logger.js';
import { dataDir, repoRoot } from '../lib/paths.js';

const log = createLogger('kimodo');

/**
 * Kimodo 本地服务管理器。
 *
 * 不随应用启动，由用户在界面上手动启停。底层启动的是 kimodo.cpp 的 Go demo
 * （kimodo-demo.exe），它内部再用 --server 模式拉起 kmd-generate 做真正的生成。
 */
export class KimodoService {
  private process: ChildProcess | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;

  readonly port = 8090;
  /** demo 二进制 */
  readonly demoExe = path.resolve(repoRoot, '..', '..', 'thirdparty', 'kimodo.cpp', 'kimodo-demo.exe');
  /** kimodo.cpp 仓库根 */
  readonly repoRoot = path.resolve(repoRoot, '..', '..', 'thirdparty', 'kimodo.cpp');
  /** 生成器 */
  readonly generator = path.join(this.repoRoot, 'build-win', 'Release', 'kmd-generate.exe');
  /** 生成器依赖的 DLL 目录（ggml 等），需加入 PATH 否则 EXE 无法加载 */
  readonly generatorDllDir = path.join(this.repoRoot, 'build-win', 'bin', 'Release');
  /** 动作模型 */
  readonly motionModel = path.join(this.repoRoot, 'models', 'kimodo-soma-rp-v1.1-f32.gguf');
  /** 文本编码器（Q4_K_M） */
  readonly textBundle = path.join(this.repoRoot, 'text', 'Llama-3-Kimodo-Q4_K_M.gguf');
  /** 生成结果目录（在项目 data 下，不污染 kimodo 仓库） */
  readonly outputDir = path.join(dataDir, 'kimodo-output');

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  status(): KimodoStatus {
    return {
      running: this.isRunning,
      port: this.port,
      url: this.url,
      pid: this.process?.pid ?? null,
      startedAt: this.startedAt,
      error: this.lastError,
      outputDir: this.outputDir,
    };
  }

  async start(): Promise<KimodoStatus> {
    if (this.isRunning) return this.status();

    // 启动前做一次必要文件存在性检查，给出明确报错而不是让 demo 静默失败
    const missing: string[] = [];
    for (const [label, file] of [
      ['kimodo-demo.exe', this.demoExe],
      ['kmd-generate.exe', this.generator],
      ['soma-rp-v1.1 模型', this.motionModel],
      ['文本编码器', this.textBundle],
    ] as const) {
      if (!fs.existsSync(file)) missing.push(`${label}（${file}）`);
    }
    if (missing.length > 0) {
      this.lastError = `缺少依赖文件：${missing.join('；')}`;
      log.error(this.lastError);
      return this.status();
    }

    fs.mkdirSync(this.outputDir, { recursive: true });

    const args = [
      '-addr', `127.0.0.1:${this.port}`,
      '-generator', this.generator,
      '-soma-rp-model', this.motionModel,
      '-text-q4-mixed-bundle', this.textBundle,
      '-output', this.outputDir,
    ];

    log.info(`启动 kimodo demo: ${this.demoExe} ${args.join(' ')}`);
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${this.generatorDllDir}${path.delimiter}${env[pathKey] ?? ''}`;
    env.KIMODO_BACKEND = 'cpu';
    env.KIMODO_TEXT_LAYER_CHUNK = '8';
    this.process = spawn(this.demoExe, args, {
      cwd: this.repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk) => {
      log.info(`[demo] ${chunk.toString().trim()}`);
    });
    this.process.stderr?.on('data', (chunk) => {
      log.warn(`[demo] ${chunk.toString().trim()}`);
    });
    this.process.on('error', (err) => {
      this.lastError = err.message;
      log.error(`kimodo demo 启动失败: ${err.message}`);
    });
    this.process.on('exit', (code, signal) => {
      log.info(`kimodo demo 退出 code=${code} signal=${signal}`);
      this.process = null;
      this.startedAt = null;
    });

    // 等端口就绪（最多 6 秒）
    const ready = await waitForPort(this.port, 6000);
    if (!ready) {
      this.lastError = 'kimodo demo 已启动但端口未就绪';
      log.warn(this.lastError);
    } else {
      this.lastError = null;
      this.startedAt = Date.now();
      log.info(`kimodo demo 已就绪: ${this.url}`);
    }
    return this.status();
  }

  async stop(): Promise<KimodoStatus> {
    if (!this.process) return this.status();
    const proc = this.process;
    this.process = null;
    this.startedAt = null;
    try {
      // 先优雅退出，不行再杀整个进程树
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (proc.exitCode === null) {
        killProcessTree(proc.pid);
      }
    } catch (err) {
      log.warn(`停止 kimodo demo 时出错: ${(err as Error).message}`);
    }
    return this.status();
  }
}

export interface KimodoStatus {
  running: boolean;
  port: number;
  url: string;
  pid: number | null;
  startedAt: number | null;
  error: string | null;
  outputDir: string;
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      import('node:net').then(({ connect }) => {
        const socket = connect({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          if (Date.now() - start > timeoutMs) resolve(false);
          else setTimeout(check, 200);
        });
      });
    };
    check();
  });
}

/** Windows 下杀整个进程树（demo 会再拉起 kmd-generate 子进程） */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

export const kimodoService = new KimodoService();
