import { buildApp } from './app.js';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { listProviders } from './providers/registry.js';
import { activeProvider, maskApiKey, providerCredential } from './services/settings.js';

const log = createLogger('server');

async function main(): Promise<void> {
  const { app, workspace, worker } = await buildApp();

  worker.start();

  await app.listen({ host: config.host, port: config.port });

  const active = activeProvider(workspace);
  log.info(`3D 生成工作台已启动: http://${config.host}:${config.port}`);
  for (const provider of listProviders()) {
    const { apiKey, baseUrl, source } = providerCredential(workspace, provider.info.id);
    const keyText = apiKey
      ? `API Key 已就绪 (${maskApiKey(apiKey)}${source === 'env' ? ' 来自 .env' : ''})`
      : `尚未配置 API Key（.env 变量 ${provider.info.envKeyName}）`;
    log.info(`${provider.info.label}${provider.info.id === active ? '（当前默认）' : ''}: ${keyText} · ${baseUrl}`);
  }
  log.info(`最大并发 ${config.maxConcurrency}，轮询间隔 ${config.pollIntervalMs}ms`);

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
