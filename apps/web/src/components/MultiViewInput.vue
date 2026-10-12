<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './ui/Icon.vue';
import { imageFileFromClipboard, prepareImageFile, type PreparedImage } from '@/utils/image';
import type { ViewType } from '@/api/types';

const props = defineProps<{
  modelValue: Partial<Record<ViewType, PreparedImage>>;
  viewTypes: ViewType[];
  /** 3.1 才支持的视角，在界面上标注 */
  version31Only: ViewType[];
  model: '3.0' | '3.1';
}>();

const emit = defineEmits<{
  'update:modelValue': [value: Partial<Record<ViewType, PreparedImage>>];
  error: [message: string];
}>();

const VIEW_LABELS: Record<ViewType, string> = {
  left: '左视',
  right: '右视',
  back: '后视',
  top: '顶视',
  bottom: '底视',
  left_front: '左前 45°',
  right_front: '右前 45°',
};

const activeSlot = ref<ViewType | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const busy = ref(false);

const filledCount = computed(() => Object.keys(props.modelValue).length);

function labelOf(viewType: ViewType): string {
  return VIEW_LABELS[viewType] ?? viewType;
}

function isRestricted(viewType: ViewType): boolean {
  return props.version31Only.includes(viewType) && props.model !== '3.1';
}

function openPicker(viewType: ViewType): void {
  if (isRestricted(viewType)) {
    emit('error', `${labelOf(viewType)}画面仅支持模型版本 3.1，请先切换到 3.1`);
    return;
  }
  activeSlot.value = viewType;
  inputRef.value?.click();
}

async function accept(file: File | null): Promise<void> {
  if (!file || !activeSlot.value) return;
  busy.value = true;
  try {
    const prepared = await prepareImageFile(file);
    emit('update:modelValue', { ...props.modelValue, [activeSlot.value]: prepared });
  } catch (err) {
    emit('error', (err as Error).message);
  } finally {
    busy.value = false;
    activeSlot.value = null;
  }
}

function onInputChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  void accept(target.files?.[0] ?? null);
  target.value = '';
}

function remove(viewType: ViewType): void {
  const next = { ...props.modelValue };
  delete next[viewType];
  emit('update:modelValue', next);
}

function onPaste(event: ClipboardEvent): void {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  const file = imageFileFromClipboard(event);
  if (!file) return;
  const freeSlot = props.viewTypes.find((viewType) => !props.modelValue[viewType] && !isRestricted(viewType));
  if (!freeSlot) return;
  event.preventDefault();
  activeSlot.value = freeSlot;
  void accept(file);
}

onMounted(() => document.addEventListener('paste', onPaste));
onBeforeUnmount(() => document.removeEventListener('paste', onPaste));
</script>

<template>
  <div class="multiview">
    <div class="head">
      <span class="field-label" style="margin: 0">多视角参考图</span>
      <span class="chip" :class="filledCount > 0 ? 'chip-accent' : ''">{{ filledCount }}/{{ viewTypes.length }}</span>
    </div>
    <p class="tip">至少 1 张即可提交；视角越完整，模型几何越准确。</p>

    <div class="grid">
      <div
        v-for="viewType in viewTypes"
        :key="viewType"
        class="slot"
        :class="{ filled: Boolean(modelValue[viewType]), restricted: isRestricted(viewType) }"
        @click="openPicker(viewType)"
      >
        <img v-if="modelValue[viewType]" class="thumb" :src="modelValue[viewType]!.dataUrl" :alt="labelOf(viewType)" />
        <template v-else>
          <Icon :name="isRestricted(viewType) ? 'ban' : 'plus'" :size="14" />
          <span class="slot-label">{{ labelOf(viewType) }}</span>
          <span v-if="isRestricted(viewType)" class="slot-badge">3.1</span>
        </template>
        <button
          v-if="modelValue[viewType]"
          type="button"
          class="slot-remove"
          title="移除"
          @click.stop="remove(viewType)"
        >
          <Icon name="close" :size="11" />
        </button>
        <span v-if="modelValue[viewType]" class="slot-name">{{ labelOf(viewType) }}</span>
      </div>
    </div>

    <input ref="inputRef" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onInputChange" />
    <p v-if="busy" class="tip"><Icon name="refresh" :size="12" class="spin" /> 正在处理图片…</p>
  </div>
</template>

<style scoped>
.multiview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tip {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  display: flex;
  align-items: center;
  gap: 5px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.slot {
  position: relative;
  aspect-ratio: 1 / 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  font-size: 10px;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.slot:hover {
  border-color: var(--accent);
  color: var(--text);
}

.slot.filled {
  border-style: solid;
  border-color: var(--accent);
  color: var(--text);
}

.slot.restricted {
  opacity: 0.45;
  cursor: not-allowed;
}

.thumb {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.slot-label {
  line-height: 1;
}

.slot-name {
  position: absolute;
  left: 3px;
  bottom: 3px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.66);
  color: #fff;
  font-size: 9px;
}

.slot-badge {
  position: absolute;
  right: 3px;
  top: 3px;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 9px;
}

.slot-remove {
  position: absolute;
  right: 3px;
  top: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.66);
  color: #fff;
  z-index: 1;
}

.slot-remove:hover {
  background: var(--danger);
}
</style>
