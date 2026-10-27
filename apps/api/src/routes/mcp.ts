import type { FastifyInstance } from 'fastify';
import {
  callTool,
  connectServer,
  disconnectServer,
  listServers,
  listTools,
  removeServer,
  shutdownMcpClients,
  upsertServer,
} from '../services/mcpClient.js';

/**
 * 应用内 MCP 客户端的管理接口。
 *
 * 这些路由只负责参数校验与错误转 HTTP 状态码，真正的进程管理在 services/mcpClient.ts：
 *  - GET    /api/mcp/servers              列出配置与连接状态
 *  - POST   /api/mcp/servers              新增 / 更新配置
 *  - DELETE /api/mcp/servers/:id          删除配置并关闭进程
 *  - POST   /api/mcp/servers/:id/connect  拉起进程并握手
 *  - POST   /api/mcp/servers/:id/disconnect
 *  - GET    /api/mcp/servers/:id/tools    列出外部工具
 *  - POST   /api/mcp/servers/:id/call     调用外部工具
 */
export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mcp/servers', async () => ({ servers: await listServers() }));

  app.post('/api/mcp/servers', async (request, reply) => {
    const body = (request.body ?? {}) as {
      id?: unknown;
      name?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
    };
    if (typeof body.command !== 'string' || !body.command.trim()) {
      return reply.code(400).send({ error: '请填写可执行命令' });
    }
    if (body.args !== undefined) {
      if (!Array.isArray(body.args) || body.args.some((item) => typeof item !== 'string')) {
        return reply.code(400).send({ error: 'args 必须是字符串数组' });
      }
    }
    if (body.env !== undefined) {
      if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
        return reply.code(400).send({ error: 'env 必须是「变量名 → 值」的对象' });
      }
      if (Object.values(body.env as Record<string, unknown>).some((item) => typeof item !== 'string')) {
        return reply.code(400).send({ error: 'env 的值必须是字符串' });
      }
    }

    const server = await upsertServer({
      id: typeof body.id === 'string' ? body.id : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      command: body.command,
      args: body.args as string[] | undefined,
      env: body.env as Record<string, string> | undefined,
    });
    return { server };
  });

  app.delete('/api/mcp/servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = await removeServer(id);
    if (!removed) return reply.code(404).send({ error: 'MCP 服务器不存在' });
    return { ok: true };
  });

  app.post('/api/mcp/servers/:id/connect', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const server = await connectServer(id);
      return { server };
    } catch (err) {
      // 502：命令本身没问题，但外部服务启动失败 / 握手失败
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post('/api/mcp/servers/:id/disconnect', async (request) => {
    const { id } = request.params as { id: string };
    disconnectServer(id);
    return { ok: true };
  });

  app.get('/api/mcp/servers/:id/tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { tools: await listTools(id) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post('/api/mcp/servers/:id/tool', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.code(400).send({ error: '请填写要调用的工具名' });
    }
    const args =
      body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? (body.arguments as Record<string, unknown>)
        : {};
    try {
      const result = await callTool(id, body.name, args);
      return { result };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // 服务退出时回收子进程，避免留下孤立的 MCP 服务
  app.addHook('onClose', async () => {
    await shutdownMcpClients();
  });
}
