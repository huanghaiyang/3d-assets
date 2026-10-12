import path from 'node:path';
import dotenv from 'dotenv';
import { apiRoot, repoRoot, webDistDir } from './lib/paths.js';

// 依次加载仓库根目录与 apps/api 下的 .env（后者优先覆盖）
dotenv.config({ path: [repoRoot + '/.env', apiRoot + '/.env'] });

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int(process.env.PORT, 8787),
  /** 腾讯混元生3D OpenAI 兼容接口域名 */
  baseUrl: process.env.HUNYUAN3D_BASE_URL ?? 'https://api.ai3d.cloud.tencent.com',
  /** 来自 .env 的 API Key（界面中填写的优先级更高） */
  envApiKey: (process.env.HUNYUAN3D_API_KEY ?? '').trim() || null,
  /** 动画预览默认打开的文件夹（只读，绝不写入） */
  animationDir:
    (process.env.ANIMATION_DIR ?? '').trim() || path.resolve(repoRoot, '..', 'CozyVale', 'assets', 'mixamo'),
  /** 远端任务轮询间隔 */
  pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 5000),
  /** 本地并发上限，接口默认提供 3 个并发 */
  maxConcurrency: Math.min(int(process.env.MAX_CONCURRENCY, 3), 3),
  webDistDir,
  repoRoot,
  isProd: process.env.NODE_ENV === 'production',
} as const;

export type AppConfig = typeof config;
