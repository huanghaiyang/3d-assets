<script setup lang="ts">
/**
 * 设置弹窗里的「MCP 客户端」面板。
 *
 * 这里配置的是「本应用去调用外部 MCP 服务」，与 apps/api/src/mcp.ts（本应用作为
 * MCP 服务器）相反。交互分三层：
 *  1. 服务器列表：配置保存在 data/mcp-servers.json，连接状态由内存里的子进程决定；
 *  2. 工具浏览：展开某个服务器时自动连接并读取 tools/list；
 *  3. 工具调试：选一个工具、填 JSON 参数、调用并把原始返回展示出来。
 *
 * 所有耗时动作都用 busyId / loadingTools 加锁，避免重复拉起子进程。
 */
import { onMounted, reactive, ref } from 'vue';
import Icon from './ui/Icon.vue';
import { mcpApi, type McpServerView, type McpToolInfo } from '@/api/mcp';
import { useWorkspaceStore } from '@/stores/workspace';

const store = useWorkspaceStore();

const servers = ref<McpServerView[]>([]);
const loading = ref(false);
/** 正在连接 / 断开 / 删除的服务器 id，用于禁用该卡片上的按钮 */
const busyId = ref<string | null>(null);

/** 当前展开的服务器（同一时间只展开一个） */
const expanded = ref<string | null>(null);
const tools = ref<McpToolInfo[]>([]);
const loadingTools = ref(false);
const activeTool = ref('');
const argsText = ref('{}');
const calling = ref(false);
const result = ref('');
const resultError = ref(false);

/** 新增表单。args 一行一个；env 支持 KEY=VALUE 每行一条 */
const form = reactive({ name: '', command: '', argsText: '', envText: '' });
const adding = ref(false);

function toastError(err: unknown, fallback: string): void {
  store.toast('error', err instanceof Error ? err.message : fallback);
}

/** 重新拉取配置列表（不清空当前展开状态，避免刷新后收起） */
async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const payload = await mcpApi.servers();
    servers.value = payload.servers;
    // 配置被删除后，展开区也要一起收起
    if (expanded.value && !servers.value.some((item) => item.id === expanded.value)) {
      expanded.value = null;
      tools.value = [];
    }
  } catch (err) {
    toastError(err, '读取 MCP 服务器失败');
  } finally {
    loading.value = false;
  }
}

async function connect(id: string): Promise<void> {
  busyId.value = id;
  try {
    const { server } = await mcpApi.connect(id);
    servers.value = servers.value.map((item) => (item.id === id ? server : item));
    store.toast('success', `已连接 ${server.name}（${server.toolCount} 个工具）`);
  } catch (err) {
    toastError(err, '连接失败');
  } finally {
    busyId.value = null;
  }
}

async function disconnect(id: string): Promise<void> {
  busyId.value = id;
  try {
    await mcpApi.disconnect(id);
    servers.value = servers.value.map((item) =>
      item.id === id ? { ...item, connected: false, toolCount: 0, error: null } : item,
    );
    if (expanded.value === id) {
      expanded.value = null;
      tools.value = [];
    }
  } catch (err) {
    toastError(err, '断开失败');
  } finally {
    busyId.value = null;
  }
}

async function remove(id: string): Promise<void> {
  busyId.value = id;
  try {
    await mcpApi.removeServer(id);
    servers.value = servers.value.filter((item) => item.id !== id);
    if (expanded.value === id) {
      expanded.value = null;
      tools.value = [];
    }
  } catch (err) {
    toastError(err, '删除失败');
  } finally {
    busyId.value = null;
  }
}

/** 展开 / 收起某个服务器；展开时自动连接并读取工具 */
async function toggle(id: string): Promise<void> {
  if (expanded.value === id) {
    expanded.value = null;
    tools.value = [];
    return;
  }
  expanded.value = id;
  tools.value = [];
  activeTool.value = '';
  argsText.value = '{}';
  result.value = '';
  resultError.value = false;
  await loadTools(id);
}

async function loadTools(id: string): Promise<void> {
  loadingTools.value = true;
  try {
    const payload = await mcpApi.tools(id);
    tools.value = payload.tools;
    // tools/list 成功说明连接已经建立，顺手刷新状态
    servers.value = servers.value.map((item) =>
      item.id === id ? { ...item, connected: true, toolCount: payload.tools.length, error: null } : item,
    );
    if (payload.tools.length === 1 && payload.tools[0]) pickTool(payload.tools[0]);
  } catch (err) {
    resultError.value = true;
    result.value = err instanceof Error ? err.message : '读取工具失败';
  } finally {
    loadingTools.value = false;
  }
}

/** 按 inputSchema 生成一份带默认值的参数骨架，减少手写 JSON 的成本 */
function sampleValue(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return '';
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  switch (value.type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

function pickTool(tool: McpToolInfo): void {
  activeTool.value = tool.name;
  result.value = '';
  resultError.value = false;
  const schema = tool.inputSchema;
  if (schema && typeof schema === 'object') {
    const properties = (schema as { properties?: Record<string, unknown> }).properties;
    if (properties) {
      const skeleton: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(properties)) skeleton[key] = sampleValue(raw);
      argsText.value = JSON.stringify(skeleton, null, 2);
      return;
    }
  }
  argsText.value = '{}';
}

async function call(serverId: string): Promise<void> {
  if (!activeTool.value) {
    store.toast('error', '请先选择一个工具');
    return;
  }
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsText.value || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('参数必须是 JSON 对象');
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    store.toast('error', `参数解析失败：${(err as Error).message}`);
    return;
  }

  calling.value = true;
  resultError.value = false;
  try {
    const payload = await mcpApi.callTool(serverId, activeTool.value, args);
    const text = JSON.stringify(payload.result, null, 2);
    result.value = text.length > 8000 ? `${text.slice(0, 8000)}\n…（已截断）` : text;
  } catch (err) {
    resultError.value = true;
    result.value = err instanceof Error ? err.message : '调用失败';
  } finally {
    calling.value = false;
  }
}

/** 参数既支持「一行一个」也支持 JSON 数组，便于从别处直接粘贴 */
function parseArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      /* 不是合法 JSON 时回落到按行拆分 */
    }
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** KEY=VALUE 每行一条；忽略空行与 # 注释 */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = trimmed.slice(index + 1).trim();
  }
  return env;
}

async function addServer(): Promise<void> {
  const command = form.command.trim();
  if (!command) {
    store.toast('error', '请填写可执行命令');
    return;
  }
  adding.value = true;
  try {
    const { server } = await mcpApi.saveServer({
      name: form.name.trim() || undefined,
      command,
      args: parseArgs(form.argsText),
      env: parseEnv(form.envText),
    });
    servers.value = [...servers.value, server];
    form.name = '';
    form.command = '';
    form.argsText = '';
    form.envText = '';
    store.toast('success', `已保存 ${server.name}`);
  } catch (err) {
    toastError(err, '保存失败');
  } finally {
    adding.value = false;
  }
}

/** 一键填入本工作台自带的 stdio MCP 服务（需要先构建 API） */
function fillBuiltin(): void {
  form.name = '3D 工作台内置 MCP';
  form.command = 'node';
  form.argsText = 'apps/api/dist/mcp.js';
  form.envText = '';
}

onMounted(refresh);
</script>

<template>
  <section class="mcp-panel">
    <div class="row">
      <span class="field-label">MCP 客户端（接入外部工具服务）</span>
      <div class="actions">
        <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">
          <Icon name="refresh" :size="13" :class="{ spin: loading }" />
          刷新
        </button>
      </div>
    </div>
    <p class="tip">
      这里让工作台以 MCP 客户端身份连接外部服务（stdio），用于浏览和调试它们暴露的工具。
      配置保存在 <span class="mono">data/mcp-servers.json</span>，环境变量只显示键名、不回传值。
      若要反过来让 Trae / Cursor 调用本工作台，请使用 <span class="mono">.trae/mcp.json</span>。
    </p>

    <p v-if="!loading && servers.length === 0" class="tip">还没有配置任何 MCP 服务器。</p>

    <div v-for="server in servers" :key="server.id" class="server">
      <div class="row">
        <div class="server-title">
          <span class="name">{{ server.name }}</span>
          <span class="chip" :class="server.connected ? 'chip-success' : 'chip-warn'">
            {{ server.connected ? `已连接 · ${server.toolCount} 个工具` : '未连接' }}
          </span>
        </div>
        <div class="actions">
          <button
            v-if="!server.connected"
            class="btn"
            type="button"
            :disabled="busyId === server.id"
            @click="connect(server.id)"
          >
            连接
          </button>
          <button
            v-else
            class="btn"
            type="button"
            :disabled="busyId === server.id"
            @click="disconnect(server.id)"
          >
            断开
          </button>
          <button
            class="btn btn-ghost btn-icon"
            type="button"
            :disabled="busyId === server.id"
            title="删除配置"
            @click="remove(server.id)"
          >
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </div>
      <p class="cmd mono">{{ server.command }} {{ server.args.join(' ') }}</p>
      <p v-if="server.envKeys.length > 0" class="tip mono">
        环境变量：{{ server.envKeys.join('、') }}（值不显示）
      </p>
      <p v-if="server.error" class="err">
        <Icon name="alert" :size="12" />
        {{ server.error }}
      </p>

      <button class="btn btn-ghost toggle" type="button" @click="toggle(server.id)">
        <Icon :name="expanded === server.id ? 'chevronDown' : 'chevronRight'" :size="13" />
        {{ expanded === server.id ? '收起工具与调试' : '展开工具与调试' }}
      </button>

      <div v-if="expanded === server.id" class="tools">
        <p v-if="loadingTools" class="tip">正在连接并读取工具列表…</p>
        <p v-else-if="tools.length === 0" class="tip">这个服务没有暴露工具。</p>
        <template v-else>
          <div class="tool-chips">
            <button
              v-for="tool in tools"
              :key="tool.name"
              class="chip chip-tool"
              :class="{ 'chip-accent': activeTool === tool.name }"
              type="button"
              :title="tool.description ?? tool.name"
              @click="pickTool(tool)"
            >
              {{ tool.name }}
            </button>
          </div>
          <p v-if="activeTool" class="tip">
            {{ tools.find((item) => item.name === activeTool)?.description ?? '' }}
          </p>
          <textarea v-model="argsText" class="text-input mono" rows="4" spellcheck="false" />
          <div class="row">
            <span class="tip">参数为 JSON 对象；默认值按工具 inputSchema 生成，可直接改。</span>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="calling || !activeTool"
              @click="call(server.id)"
            >
              {{ calling ? '调用中…' : '调用' }}
            </button>
          </div>
          <pre v-if="result" class="result mono" :class="{ bad: resultError }">{{ result }}</pre>
        </template>
      </div>
    </div>

    <details class="add">
      <summary>添加 MCP 服务器</summary>
      <div class="form">
        <input v-model="form.name" class="text-input" type="text" placeholder="展示名（可选）" />
        <input v-model="form.command" class="text-input mono" type="text" placeholder="命令，例如 node 或 npx" />
        <textarea
          v-model="form.argsText"
          class="text-input mono"
          rows="2"
          spellcheck="false"
          placeholder="参数，一行一个；也可直接粘贴 JSON 数组"
        />
        <textarea
          v-model="form.envText"
          class="text-input mono"
          rows="2"
          spellcheck="false"
          placeholder="环境变量 KEY=VALUE，一行一条（可选）"
        />
        <div class="row">
          <button class="btn btn-ghost" type="button" @click="fillBuiltin">填入内置 MCP 服务</button>
          <button class="btn btn-primary" type="button" :disabled="adding" @click="addServer">
            保存
          </button>
        </div>
        <p class="tip">
          内置服务的命令为 <span class="mono">node apps/api/dist/mcp.js</span>，需要先执行
          <span class="mono">npm run build -w @h3d/api</span>；开发时可用
          <span class="mono">npx tsx apps/api/src/mcp.ts</span>。
        </p>
      </div>
    </details>
  </section>
</template>

<style scoped>
.mcp-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel-2);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.server {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}

.server-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.name {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
  word-break: break-all;
}

.tip {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.6;
}

.err {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11.5px;
  color: var(--danger);
  word-break: break-all;
}

.toggle {
  align-self: flex-start;
  padding: 4px 8px;
}

.tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.tool-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 132px;
  overflow-y: auto;
}

.chip-tool {
  cursor: pointer;
  border: 1px solid var(--border);
  background: transparent;
}

.result {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-all;
}

.result.bad {
  color: var(--danger);
  border-color: var(--danger);
}

.add {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}

.add summary {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text-dim);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
}
</style>
