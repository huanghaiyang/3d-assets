import { request } from './client';

/**
 * 应用内 MCP 客户端的前端接口封装。
 *
 * 后端会在用户点击「连接」或读取工具列表时，用 stdio 拉起配置里的命令，
 * 因此这里的请求可能耗时几秒；调用工具的上限是 120 秒（见 services/mcpClient.ts）。
 */

/** 服务器视图：环境变量只回传键名，值（可能含密钥）不会下发到浏览器 */
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

/** 外部 MCP 服务器暴露的工具描述 */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** 新增 / 更新服务器；id 为空表示新建 */
export interface McpServerInput {
  id?: string;
  name?: string;
  command: string;
  args?: string[];
  /** 不传表示保持原值；传对象表示整组替换 */
  env?: Record<string, string>;
}

export const mcpApi = {
  servers: () => request<{ servers: McpServerView[] }>('/api/mcp/servers'),

  saveServer: (body: McpServerInput) =>
    request<{ server: McpServerView }>('/api/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeServer: (id: string) =>
    request<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  connect: (id: string) =>
    request<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(id)}/connect`, {
      method: 'POST',
      body: '{}',
    }),

  disconnect: (id: string) =>
    request<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}/disconnect`, {
      method: 'POST',
      body: '{}',
    }),

  tools: (id: string) =>
    request<{ tools: McpToolInfo[] }>(`/api/mcp/servers/${encodeURIComponent(id)}/tools`),

  callTool: (id: string, name: string, args: Record<string, unknown>) =>
    request<{ result: unknown }>(`/api/mcp/servers/${encodeURIComponent(id)}/tool`, {
      method: 'POST',
      body: JSON.stringify({ name, arguments: args }),
    }),
};
