<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import { animationApi, type AnimationDirEntry } from '@/api/animation';

const props = withDefaults(
  defineProps<{
    open: boolean;
    startDir: string;
    /** 对话框标题；素材库的 GLB 扫描复用本组件时传自己的标题 */
    title?: string;
    /** 统计并展示的扩展名（不含点）；默认 fbx，扫描模型时传 glb */
    ext?: string;
  }>(),
  { title: '选择动画文件夹', ext: 'fbx' },
);
const emit = defineEmits<{ close: []; pick: [dir: string] }>();

/** 扩展名的大写形式，用于界面文案（FBX / GLB） */
const extLabel = computed(() => props.ext.toUpperCase());

const current = ref('');
const parent = ref<string | null>(null);
const dirs = ref<AnimationDirEntry[]>([]);
const fileCount = ref(0);
const manualPath = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function browse(dir?: string): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const result = await animationApi.browse(dir, props.ext);
    current.value = result.dir;
    parent.value = result.parent;
    dirs.value = result.dirs;
    fileCount.value = result.fileCount;
    manualPath.value = result.dir;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void browse(props.startDir || undefined);
  },
);

const upDisabled = computed(() => !parent.value);

function go(parentDir: string | null): void {
  if (parentDir) void browse(parentDir);
}

function confirmManual(): void {
  const value = manualPath.value.trim();
  if (value) void browse(value);
}

onBeforeUnmount(() => {
  dirs.value = [];
});
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="backdrop" @click.self="emit('close')">
      <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
        <header class="dialog-head">
          <div class="dialog-title">
            <Icon name="folder" :size="15" />
            {{ title }}
            <span class="chip chip-info">只读</span>
          </div>
          <button class="btn btn-ghost btn-icon" type="button" @click="emit('close')">
            <Icon name="close" :size="15" />
          </button>
        </header>

        <div class="path-row">
          <input
            v-model="manualPath"
            class="text-input mono"
            placeholder="直接粘贴绝对路径，例如 D:\sgames\CozyVale\assets\mixamo"
            @keydown.enter="confirmManual"
          />
          <button class="btn" type="button" :disabled="busy" @click="confirmManual">转到</button>
        </div>

        <div class="breadcrumb">
          <button class="btn btn-ghost btn-icon" type="button" :disabled="upDisabled || busy" title="上一级" @click="go(parent)">
            <Icon name="arrowUp" :size="14" />
          </button>
          <span class="mono path-text" :title="current">{{ current }}</span>
          <span class="chip">{{ fileCount }} 个 {{ extLabel }}</span>
        </div>

        <div class="dir-list">
          <p v-if="busy" class="hint">读取中…</p>
          <p v-else-if="error" class="error">{{ error }}</p>
          <p v-else-if="dirs.length === 0" class="hint">该目录下没有子文件夹</p>

          <button
            v-for="entry in dirs"
            :key="entry.path"
            class="dir-item"
            type="button"
            @click="browse(entry.path)"
          >
            <Icon name="folder" :size="14" />
            <span class="dir-name">{{ entry.name }}</span>
            <span v-if="entry.fileCount > 0" class="chip chip-accent">{{ entry.fileCount }} {{ extLabel }}</span>
            <span v-else-if="entry.hidden" class="chip">隐藏</span>
          </button>
        </div>

        <footer class="dialog-foot">
          <p class="hint">
            <Icon name="info" :size="12" />
            只读取 .{{ ext }} 文件，不会写入、修改或锁定该文件夹中的任何文件。
          </p>
          <div class="foot-actions">
            <button class="btn" type="button" @click="emit('close')">取消</button>
            <button class="btn btn-primary" type="button" :disabled="busy" @click="emit('pick', current)">
              使用此文件夹<span v-if="fileCount > 0">（{{ fileCount }} 个 {{ extLabel }}）</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 9, 12, 0.62);
  backdrop-filter: blur(3px);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: 84vh;
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

.path-row {
  display: flex;
  gap: 8px;
  padding: 12px 16px 0;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
}

.path-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: 11px;
}

.dir-list {
  flex: 1;
  min-height: 160px;
  overflow-y: auto;
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dir-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
}

.dir-item:hover {
  background: var(--bg-hover);
}

.dir-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 10px 8px;
  font-size: 11.5px;
  color: var(--text-faint);
}

.error {
  margin: 10px 8px;
  font-size: 12px;
  color: var(--danger);
}

.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.foot-actions {
  display: flex;
  gap: 8px;
}
</style>
