<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import Icon from './ui/Icon.vue';
import McpServersPanel from './McpServersPanel.vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { ProviderId } from '@/api/types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useWorkspaceStore();
const keyInputs = reactive<Record<string, string>>({});
const baseUrlInputs = reactive<Record<string, string>>({});
const verifyResults = reactive<Record<string, { ok: boolean; message: string } | null>>({});
const busyProvider = ref<string | null>(null);

const settings = computed(() => store.settings);
const providers = computed(() => settings.value?.providers ?? []);

const sourceText = (source: 'settings' | 'env' | 'none'): string => {
  switch (source) {
    case 'settings':
      return '来自界面设置';
    case 'env':
      return '来自 .env 文件';
    default:
      return '未配置';
  }
};

function resetInputs(): void {
  for (const provider of providers.value) {
    keyInputs[provider.id] = '';
    baseUrlInputs[provider.id] = provider.baseUrl;
    verifyResults[provider.id] = null;
  }
}

// 每次打开对话框才重置输入；轮询刷新（settings 引号变化）不打断正在输入的内容
watch(
  () => props.open,
  (open) => {
    if (open) resetInputs();
  },
  { immediate: true },
);

// 引擎列表第一次到达时补一次初始值
watch(
  () => providers.value.map((provider) => provider.id).join(','),
  () => {
    if (!props.open) return;
    for (const provider of providers.value) {
      if (keyInputs[provider.id] === undefined) keyInputs[provider.id] = '';
      if (baseUrlInputs[provider.id] === undefined) baseUrlInputs[provider.id] = provider.baseUrl;
    }
  },
);

async function withBusy(providerId: string, task: () => Promise<void>): Promise<void> {
  busyProvider.value = providerId;
  try {
    await task();
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '操作失败');
  } finally {
    busyProvider.value = null;
  }
}

async function save(providerId: ProviderId): Promise<void> {
  const key = (keyInputs[providerId] ?? '').trim();
  if (!key) {
    store.toast('error', '请先填写 API Key');
    return;
  }
  await withBusy(providerId, async () => {
    await store.saveApiKey(key, providerId);
    keyInputs[providerId] = '';
    verifyResults[providerId] = await store.verifyApiKey(providerId);
  });
}

async function verify(providerId: ProviderId): Promise<void> {
  await withBusy(providerId, async () => {
    try {
      verifyResults[providerId] = await store.verifyApiKey(providerId);
    } catch (err) {
      verifyResults[providerId] = { ok: false, message: err instanceof Error ? err.message : '校验失败' };
    }
  });
}

async function clear(providerId: ProviderId): Promise<void> {
  await withBusy(providerId, async () => {
    await store.clearApiKey(providerId);
    verifyResults[providerId] = null;
  });
}

async function saveBaseUrl(providerId: ProviderId): Promise<void> {
  const value = (baseUrlInputs[providerId] ?? '').trim();
  await withBusy(providerId, async () => {
    await store.saveBaseUrl(value, providerId);
  });
}

async function makeDefault(providerId: ProviderId): Promise<void> {
  await withBusy(providerId, async () => {
    await store.setProvider(providerId);
  });
}
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="设置">
        <header class="dialog-head">
          <div class="dialog-title">
            <Icon name="settings" :size="15" />
            设置
          </div>
          <button class="btn btn-ghost btn-icon" type="button" @click="emit('close')">
            <Icon name="close" :size="15" />
          </button>
        </header>

        <div class="dialog-body">
          <p class="tip intro">
            默认使用混元生3D，也可以切换到其它第三方生成引擎；每个引擎的 API Key 独立保存，
            界面里填写的 Key 优先于 <span class="mono">.env</span>。
          </p>

          <section
            v-for="provider in providers"
            :key="provider.id"
            class="block provider"
            :class="{ active: provider.id === settings?.activeProvider }"
          >
            <div class="row">
              <div class="provider-title">
                <span class="field-label" style="margin: 0">{{ provider.label }}</span>
                <span class="chip chip-info">{{ provider.vendor }}</span>
                <span v-if="provider.id === settings?.activeProvider" class="chip chip-accent">当前默认</span>
              </div>
              <span class="chip" :class="provider.apiKeyConfigured ? 'chip-success' : 'chip-warn'">
                {{ provider.apiKeyConfigured ? provider.apiKeyMasked : '未配置' }}
              </span>
            </div>
            <p class="tip">
              {{ provider.keyHint }}；<a :href="provider.docsUrl" target="_blank" rel="noreferrer">打开控制台</a>。
              当前来源：{{ sourceText(provider.apiKeySource) }}（.env 变量 <span class="mono">{{ provider.envKeyName }}</span>）
            </p>
            <div class="key-row">
              <input
                v-model="keyInputs[provider.id]"
                class="text-input mono"
                type="password"
                :placeholder="`${provider.keyPrefix ?? ''}xxxxxxxxxxxxxxxx`"
                autocomplete="off"
                @keydown.enter="save(provider.id)"
              />
              <button
                class="btn btn-primary"
                type="button"
                :disabled="busyProvider === provider.id"
                @click="save(provider.id)"
              >
                保存
              </button>
            </div>
            <div class="actions">
              <button
                class="btn"
                type="button"
                :disabled="busyProvider === provider.id || !provider.apiKeyConfigured"
                @click="verify(provider.id)"
              >
                <Icon name="refresh" :size="13" :class="{ spin: busyProvider === provider.id }" />
                测试连接
              </button>
              <button
                class="btn btn-danger"
                type="button"
                :disabled="busyProvider === provider.id || !provider.apiKeyConfigured"
                @click="clear(provider.id)"
              >
                清除界面中的 Key
              </button>
              <button
                v-if="provider.id !== settings?.activeProvider"
                class="btn"
                type="button"
                :disabled="busyProvider === provider.id"
                @click="makeDefault(provider.id)"
              >
                设为默认引擎
              </button>
            </div>
            <details class="advanced">
              <summary>接口域名（代理 / 私有化部署时修改）</summary>
              <div class="key-row">
                <input
                  v-model="baseUrlInputs[provider.id]"
                  class="text-input mono"
                  type="text"
                  :placeholder="provider.defaultBaseUrl"
                  @keydown.enter="saveBaseUrl(provider.id)"
                />
                <button class="btn" type="button" :disabled="busyProvider === provider.id" @click="saveBaseUrl(provider.id)">
                  保存
                </button>
              </div>
              <p class="tip">留空恢复默认：<span class="mono">{{ provider.defaultBaseUrl }}</span></p>
            </details>
            <p v-if="verifyResults[provider.id]" class="verify" :class="verifyResults[provider.id]!.ok ? 'ok' : 'bad'">
              <Icon :name="verifyResults[provider.id]!.ok ? 'check' : 'alert'" :size="12" />
              {{ verifyResults[provider.id]!.message }}
            </p>
          </section>

          <McpServersPanel />

          <section class="block">
            <span class="field-label">运行信息</span>
            <dl class="info">
              <div><dt>并发上限</dt><dd>{{ settings?.limits.maxConcurrency }} 个任务</dd></div>
              <div><dt>轮询间隔</dt><dd>{{ (settings?.limits.pollIntervalMs ?? 0) / 1000 }} 秒</dd></div>
              <div><dt>当前引擎</dt><dd>{{ settings?.active?.label }}</dd></div>
            </dl>
          </section>

          <section class="block">
            <span class="field-label">数据存放位置</span>
            <p class="tip">
              生成结果会在服务端自动转存到项目根目录的 <span class="mono">data/</span>
              （各引擎返回的下载地址通常仅 24 小时有效），素材元数据保存在
              <span class="mono">data/state.json</span>，界面里的草稿存在浏览器本地。
            </p>
          </section>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 9, 12, 0.62);
  backdrop-filter: blur(3px);
}

.dialog {
  width: min(620px, 100%);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.dialog-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel-2);
}

.provider.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.provider-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tip {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.6;
}

.tip.intro {
  font-size: 12px;
}

.tip a {
  color: var(--accent-hover);
}

.key-row {
  display: flex;
  gap: 8px;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.advanced {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.advanced summary {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text-dim);
}

.verify {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
}

.verify.ok {
  color: var(--success);
}

.verify.bad {
  color: var(--danger);
}

.info {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.info > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.info dt {
  font-size: 12px;
  color: var(--text-faint);
  flex: none;
}

.info dd {
  margin: 0;
  font-size: 12px;
  text-align: right;
  word-break: break-all;
}
</style>
