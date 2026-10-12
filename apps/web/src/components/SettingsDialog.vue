<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './ui/Icon.vue';
import { useWorkspaceStore } from '@/stores/workspace';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useWorkspaceStore();
const apiKeyInput = ref('');
const busy = ref(false);
const verifyResult = ref<{ ok: boolean; message: string } | null>(null);

const settings = computed(() => store.settings);

const sourceText = computed(() => {
  switch (settings.value?.apiKeySource) {
    case 'settings':
      return '来自界面设置';
    case 'env':
      return '来自 .env 文件';
    default:
      return '未配置';
  }
});

watch(
  () => props.open,
  (open) => {
    if (open) {
      apiKeyInput.value = '';
      verifyResult.value = null;
    }
  },
);

async function save(): Promise<void> {
  if (!apiKeyInput.value.trim()) {
    store.toast('error', '请先填写 API Key');
    return;
  }
  busy.value = true;
  try {
    await store.saveApiKey(apiKeyInput.value.trim());
    apiKeyInput.value = '';
    verifyResult.value = await store.verifyApiKey();
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '保存失败');
  } finally {
    busy.value = false;
  }
}

async function verify(): Promise<void> {
  busy.value = true;
  try {
    verifyResult.value = await store.verifyApiKey();
  } catch (err) {
    verifyResult.value = { ok: false, message: err instanceof Error ? err.message : '校验失败' };
  } finally {
    busy.value = false;
  }
}

async function clear(): Promise<void> {
  busy.value = true;
  try {
    await store.clearApiKey();
    verifyResult.value = null;
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '清除失败');
  } finally {
    busy.value = false;
  }
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
          <section class="block">
            <div class="row">
              <span class="field-label" style="margin: 0">混元生3D API Key</span>
              <span class="chip" :class="settings?.apiKeyConfigured ? 'chip-success' : 'chip-warn'">
                {{ settings?.apiKeyConfigured ? settings.apiKeyMasked : '未配置' }}
              </span>
            </div>
            <p class="tip">
              在
              <a href="https://console.cloud.tencent.com/ai3d/start" target="_blank" rel="noreferrer">腾讯云混元生3D 控制台</a>
              创建，以 <span class="mono">sk-</span> 开头。当前来源：{{ sourceText }}
            </p>
            <div class="key-row">
              <input
                v-model="apiKeyInput"
                class="text-input mono"
                type="password"
                placeholder="sk-xxxxxxxxxxxxxxxx"
                autocomplete="off"
                @keydown.enter="save"
              />
              <button class="btn btn-primary" type="button" :disabled="busy" @click="save">保存</button>
            </div>
            <div class="actions">
              <button class="btn" type="button" :disabled="busy || !settings?.apiKeyConfigured" @click="verify">
                <Icon name="refresh" :size="13" :class="{ spin: busy }" />
                测试连接
              </button>
              <button
                class="btn btn-danger"
                type="button"
                :disabled="busy || !settings?.apiKeyConfigured"
                @click="clear"
              >
                清除界面中保存的 Key
              </button>
            </div>
            <p v-if="verifyResult" class="verify" :class="verifyResult.ok ? 'ok' : 'bad'">
              <Icon :name="verifyResult.ok ? 'check' : 'alert'" :size="12" />
              {{ verifyResult.message }}
            </p>
          </section>

          <section class="block">
            <span class="field-label">接口信息</span>
            <dl class="info">
              <div><dt>接口域名</dt><dd class="mono">{{ settings?.baseUrl }}</dd></div>
              <div><dt>提交地址</dt><dd class="mono">{{ settings?.baseUrl }}/v1/ai3d/submit</dd></div>
              <div><dt>查询地址</dt><dd class="mono">{{ settings?.baseUrl }}/v1/ai3d/query</dd></div>
              <div><dt>并发上限</dt><dd>{{ settings?.limits.maxConcurrency }} 个任务</dd></div>
              <div><dt>轮询间隔</dt><dd>{{ (settings?.limits.pollIntervalMs ?? 0) / 1000 }} 秒</dd></div>
            </dl>
          </section>

          <section class="block">
            <span class="field-label">数据存放位置</span>
            <p class="tip">
              生成结果会在服务端自动转存到项目根目录的 <span class="mono">data/</span>
              （接口返回的下载地址仅 24 小时有效），素材元数据保存在
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
  width: min(560px, 100%);
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

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tip {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.6;
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
