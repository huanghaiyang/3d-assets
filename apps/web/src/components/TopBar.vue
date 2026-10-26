<script setup lang="ts">
import { computed } from 'vue';
import Icon from './ui/Icon.vue';
import { useWorkspaceStore } from '@/stores/workspace';

defineProps<{ settingsOpen: boolean; page: 'workbench' | 'animations' | 'stage' }>();
const emit = defineEmits<{
  'open-settings': [];
  'change-page': [value: 'workbench' | 'animations' | 'stage'];
}>();

const store = useWorkspaceStore();

const active = computed(() => store.activeProviderInfo);
const keyChipClass = computed(() => (active.value?.apiKeyConfigured ? 'chip-success' : 'chip-warn'));
const keyLabel = computed(() => {
  if (!active.value) return '未连接到本地服务';
  if (!active.value.apiKeyConfigured) return `${active.value.label} 未配置 Key`;
  return `${active.value.label} ${active.value.apiKeyMasked ?? '已配置'}`;
});
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo"><Icon name="cube" :size="16" /></span>
      <div class="brand-text">
        <span class="brand-name">3D 生成工作台</span>
        <span class="brand-sub">Hunyuan3D（默认）· Tripo3D · Meshy</span>
      </div>
    </div>

    <nav class="pages">
      <button
        class="page-tab"
        :class="{ active: page === 'workbench' }"
        type="button"
        @click="emit('change-page', 'workbench')"
      >
        <Icon name="cube" :size="13" />
        建模
      </button>
      <button
        class="page-tab"
        :class="{ active: page === 'animations' }"
        type="button"
        @click="emit('change-page', 'animations')"
      >
        <Icon name="film" :size="13" />
        动画
      </button>
      <button
        class="page-tab"
        :class="{ active: page === 'stage' }"
        type="button"
        @click="emit('change-page', 'stage')"
      >
        <Icon name="grid" :size="13" />
        舞台
      </button>
    </nav>

    <div class="right">
      <span class="chip chip-info" title="本地任务队列并发情况">
        <Icon name="layers" :size="11" />
        并发 {{ store.queue.active }}/{{ store.queue.maxConcurrency }}
        <template v-if="store.queue.pending > 0">· 排队 {{ store.queue.pending }}</template>
      </span>

      <span v-if="store.offline" class="chip chip-danger">
        <Icon name="alert" :size="11" />
        本地服务未连接
      </span>

      <button class="key-chip chip" :class="keyChipClass" type="button" @click="emit('open-settings')">
        <Icon name="key" :size="11" />
        {{ keyLabel }}
      </button>

      <button
        class="btn btn-icon"
        :class="{ active: settingsOpen }"
        type="button"
        title="设置"
        @click="emit('open-settings')"
      >
        <Icon name="settings" :size="15" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 52px;
  padding: 0 16px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--accent), #4b7bff);
  color: #fff;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.pages {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-app);
}

.page-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
}

.page-tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.page-tab.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.brand-name {
  font-size: 14px;
  font-weight: 600;
}

.brand-sub {
  font-size: 11px;
  color: var(--text-faint);
}

.right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.key-chip {
  border: none;
  cursor: pointer;
  height: 24px;
}

.key-chip:hover {
  filter: brightness(1.2);
}

.btn-icon.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
  border-color: transparent;
}
</style>
