<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './ui/Icon.vue';
import { formatBytes, imageFileFromClipboard, prepareImageFile, type PreparedImage } from '@/utils/image';

const props = withDefaults(
  defineProps<{
    modelValue: PreparedImage | null;
    label?: string;
    hint?: string;
    /** 紧凑模式用于多视角小格 */
    compact?: boolean;
    enablePaste?: boolean;
  }>(),
  { label: '上传参考图', hint: '拖拽 / 点击上传 / Ctrl+V 粘贴', compact: false, enablePaste: true },
);

const emit = defineEmits<{
  'update:modelValue': [value: PreparedImage | null];
  error: [message: string];
}>();

const dragging = ref(false);
const busy = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

async function handleFiles(files: FileList | File[] | null): Promise<void> {
  const file = files ? (Array.from(files)[0] ?? null) : null;
  if (!file) return;
  busy.value = true;
  try {
    emit('update:modelValue', await prepareImageFile(file));
  } catch (err) {
    emit('error', (err as Error).message);
  } finally {
    busy.value = false;
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragging.value = false;
  void handleFiles(event.dataTransfer?.files ?? null);
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  dragging.value = true;
}

function onDragLeave(): void {
  dragging.value = false;
}

function onPick(): void {
  inputRef.value?.click();
}

function onInputChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  void handleFiles(target.files);
  target.value = '';
}

function onPaste(event: ClipboardEvent): void {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  const file = imageFileFromClipboard(event);
  if (file) {
    event.preventDefault();
    void handleFiles([file]);
  }
}

onMounted(() => {
  if (props.enablePaste) document.addEventListener('paste', onPaste);
});

onBeforeUnmount(() => {
  if (props.enablePaste) document.removeEventListener('paste', onPaste);
});
</script>

<template>
  <div
    class="dropzone"
    :class="{ dragging, 'has-image': Boolean(modelValue), compact }"
    @click="onPick"
    @drop="onDrop"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
  >
    <input ref="inputRef" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onInputChange" />

    <template v-if="modelValue">
      <img class="preview" :src="modelValue.dataUrl" :alt="modelValue.name" />
      <div class="meta">
        <span class="mono">{{ modelValue.width }}×{{ modelValue.height }}</span>
        <span class="mono">{{ formatBytes(modelValue.bytes) }}</span>
      </div>
      <button class="remove" type="button" title="移除" @click.stop="emit('update:modelValue', null)">
        <Icon name="close" :size="13" />
      </button>
    </template>

    <template v-else>
      <Icon :name="busy ? 'refresh' : 'upload'" :size="compact ? 16 : 20" :class="{ spin: busy }" />
      <span v-if="!compact" class="title">{{ busy ? '处理中…' : label }}</span>
      <span v-if="!compact" class="hint">{{ hint }}</span>
    </template>
  </div>
</template>

<style scoped>
.dropzone {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  aspect-ratio: 1 / 1;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: repeating-conic-gradient(#26272e 0% 25%, #22232a 0% 50%) 50% / 16px 16px;
  color: var(--text-dim);
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.dropzone.compact {
  aspect-ratio: 1 / 1;
  gap: 2px;
  border-radius: var(--radius-sm);
}

.dropzone:hover {
  border-color: var(--accent);
  color: var(--text);
}

.dropzone.dragging {
  border-color: var(--accent);
  color: var(--accent-hover);
  background: var(--accent-soft);
}

.dropzone.has-image {
  border-style: solid;
  border-color: var(--border);
  background: #101116;
}

.preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.meta {
  position: absolute;
  left: 6px;
  bottom: 6px;
  display: flex;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.62);
  color: #d9dae0;
  backdrop-filter: blur(4px);
}

.remove {
  position: absolute;
  right: 6px;
  top: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
}

.remove:hover {
  background: var(--danger);
}

.title {
  font-size: 12px;
  font-weight: 500;
}

.hint {
  font-size: 11px;
  color: var(--text-faint);
  text-align: center;
  padding: 0 10px;
}
</style>
