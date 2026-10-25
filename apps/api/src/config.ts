import path from 'node:path';
import dotenv from 'dotenv';
import { apiRoot, repoRoot, webDistDir } from './lib/paths.js';
import { listProviders } from './providers/registry.js';
import { promptProviderPreset } from './services/promptProviders.js';
import { DEFAULT_PROVIDER_ID, type ProviderId } from './store/types.js';

// 依次加载仓库根目录与 apps/api 下的 .env（后者优先覆盖）
dotenv.config({ path: [repoRoot + '/.env', apiRoot + '/.env'] });

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

function rate(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : fallback;
}

export interface ProviderEnvConfig {
  /** .env 里的 Key（界面设置优先） */
  envApiKey: string | null;
  /** .env 里自定义的接口域名 */
  envBaseUrl: string | null;
  defaultBaseUrl: string;
}

/** 各生成引擎的 .env 配置（变量名由各 provider 的 info 声明） */
const providerEnv: Record<string, ProviderEnvConfig> = Object.fromEntries(
  listProviders().map((provider) => [
    provider.info.id,
    {
      envApiKey: text(process.env[provider.info.envKeyName]),
      envBaseUrl: text(process.env[provider.info.envBaseUrlName]),
      defaultBaseUrl: provider.info.defaultBaseUrl,
    } satisfies ProviderEnvConfig,
  ]),
);

/**
 * 提示词转译模型配置解析：
 * 先按 KIMODO_PROMPT_PROVIDER 选厂商预设，再用 KIMODO_PROMPT_* 变量逐项覆盖。
 * 默认 DeepSeek，保持原有 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 配置继续可用。
 */
const promptPreset = promptProviderPreset(text(process.env.KIMODO_PROMPT_PROVIDER) ?? 'deepseek');
const promptApiKey =
  text(process.env.KIMODO_PROMPT_API_KEY) ?? text(process.env[promptPreset.envKey]);
const promptBaseUrl = (
  text(process.env.KIMODO_PROMPT_BASE_URL) ??
  text(process.env[promptPreset.envBaseUrl]) ??
  promptPreset.baseUrl
).replace(/\/+$/, '');
const promptModel = text(process.env.KIMODO_PROMPT_MODEL) ?? promptPreset.model;
const promptVisionModel =
  text(process.env.KIMODO_PROMPT_VISION_MODEL) ?? (promptPreset.visionModel || promptModel);

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int(process.env.PORT, 8788),
  /** 默认生成引擎（可用 .env 的 GENERATION_PROVIDER 覆盖） */
  defaultProvider: ((): ProviderId => {
    const value = text(process.env.GENERATION_PROVIDER);
    const known = listProviders().map((provider) => provider.info.id as string);
    return (value && known.includes(value) ? value : DEFAULT_PROVIDER_ID) as ProviderId;
  })(),
  /** 各引擎的 Key / 接口域名 */
  providers: providerEnv,
  /** 动画预览默认打开的文件夹（只读，绝不写入） */
  animationDir:
    text(process.env.ANIMATION_DIR) || path.resolve(repoRoot, '..', 'CozyVale', 'assets', 'mixamo'),
  /** 远端任务轮询间隔 */
  pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 5000),
  /** 本地并发上限，接口默认提供 3 个并发 */
  maxConcurrency: Math.min(int(process.env.MAX_CONCURRENCY, 3), 3),
  /** Kimodo 文生动作（本地 CPU 推理），路径全部由 .env 指定 */
  kimodo: {
    /** kmd-generate 可执行文件（必填，未配置时功能不可用） */
    generatorExe: text(process.env.KIMODO_GENERATE_EXE),
    /** SOMA RP v1.1 动作模型 GGUF */
    motionModel: text(process.env.KIMODO_MOTION_MODEL),
    /** LLM2Vec 文本编码器 GGUF */
    textBundle: text(process.env.KIMODO_TEXT_BUNDLE),
    /** 生成结果目录，留空用 data/kimodo-output */
    outputDir:
      text(process.env.KIMODO_OUTPUT_DIR) ?? path.resolve(repoRoot, 'data', 'kimodo-output'),
    /** 运行 to_mixamo.py 的 Python 解释器（需要 numpy） */
    python: text(process.env.KIMODO_PYTHON) ?? 'python',
    /** ggml 计算后端，CPU 机器用 cpu */
    backend: text(process.env.KIMODO_BACKEND) ?? 'cpu',
    /** 文本编码器分层驻留块数，留空给生成器默认值 */
    textLayerChunk: text(process.env.KIMODO_TEXT_LAYER_CHUNK),
    /**
     * 提示词转译用的大模型（OpenAI 兼容接口，默认 DeepSeek）。
     * Key 只在服务端读取，绝不返回给前端 / MCP。
     */
    promptProvider: promptPreset.id,
    promptProviderLabel: promptPreset.label,
    promptApiKey,
    promptBaseUrl,
    promptModel,
    /** 带参考图时使用的视觉模型（可与纯文字模型不同） */
    promptVisionModel,
    /** 推理模型会先消耗思考 token，预算留足避免正文被截断 */
    promptMaxTokens: int(process.env.KIMODO_PROMPT_MAX_TOKENS, 1200),
    promptTimeoutMs: int(process.env.KIMODO_PROMPT_TIMEOUT_MS, 120_000),
    /** 转译温度：越低越忠实于原意，默认 0.35 */
    promptTemperature: rate(process.env.KIMODO_PROMPT_TEMPERATURE, 0.35),
  },
  webDistDir,
  repoRoot,
  isProd: process.env.NODE_ENV === 'production',
} as const;

export type AppConfig = typeof config;

/** 取某引擎的 .env 配置（未知引擎回落到默认值） */
export function providerEnvOf(id: string): ProviderEnvConfig {
  return (
    providerEnv[id] ?? {
      envApiKey: null,
      envBaseUrl: null,
      defaultBaseUrl: '',
    }
  );
}
