import { buildApp } from './app.js';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { resolveApiKey } from './services/settings.js';

const log = createLogger('server');

async function main(): Promise<void> {
  const { app, workspace, worker } = await buildApp();

  worker.start();

  await app.listen({ host: config.host, port: config.port });

  const key = resolveApiKey(workspace);
  log.info(`混元生3D 工作台已启动: http://${config.host}:${config.port}`);
  log.info(`接口域名: ${config.baseUrl}`);
  log.info(
    key
      ? `API Key 已就绪 (${key.slice(0, 6)}****${key.slice(-4)})，最大并发 ${config.maxConcurrency}`
      : '尚未配置 API Key —— 请在界面右上角“设置”中填写，或写入 .env 的 HUNYUAN3D_API_KEY',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在退出…`);
    await worker.stop();
    await workspace.flush();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error(`启动失败: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
