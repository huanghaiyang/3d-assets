<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import VueJsonPretty from 'vue-json-pretty';
import 'vue-json-pretty/lib/styles.css';
import Icon from '../ui/Icon.vue';
import { useAnimationStore } from '@/stores/animation';
import type { AnimationData } from '@/viewer/FbxPlayer';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useAnimationStore();

/** 是否把每个关键帧的时间与数值写进预览（关闭后只保留轨迹摘要） */
const includeKeyframes = ref(true);
const copied = ref(false);

/** 虚拟滚动区域高度：跟随预览容器的实际高度，避免空白或底部被裁切 */
const previewRef = ref<HTMLElement | null>(null);
const previewHeight = ref(400);
let previewObserver: ResizeObserver | null = null;

function measurePreview(): void {
  const el = previewRef.value;
  if (!el) return;
  previewHeight.value = Math.max(200, Math.floor(el.clientHeight));
  previewObserver?.disconnect();
  previewObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    previewHeight.value = Math.max(200, Math.floor(entry.contentRect.height));
  });
  previewObserver.observe(el);
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      previewObserver?.disconnect();
      previewObserver = null;
      return;
    }
    includeKeyframes.value = true;
    copied.value = false;
    void nextTick(measurePreview);
  },
);

onBeforeUnmount(() => previewObserver?.disconnect());

/** 预览用数据：关闭关键帧选项时去掉 times / values，避免渲染巨大的数值数组 */
const displayData = computed<AnimationData | null>(() => {
  const data = store.extractedData;
  if (!data) return null;
  if (includeKeyframes.value) return data;
  return {
    ...data,
    clips: data.clips.map((clip) => ({
      ...clip,
      tracks: clip.tracks.map((track) => {
        const summary = { ...track };
        delete summary.times;
        delete summary.values;
        return summary;
      }),
    })),
  };
});

const jsonText = computed(() => (displayData.value ? JSON.stringify(displayData.value, null, 2) : ''));

/** vue-json-pretty 的 data 需要可索引对象类型 */
const prettyData = computed<Record<string, unknown> | null>(() =>
  displayData.value ? (displayData.value as unknown as Record<string, unknown>) : null,
);

const summary = computed(() => {
  const data = store.extractedData;
  if (!data) return null;
  return {
    joints: data.skeleton.jointCount,
    clips: data.timeline.clipCount,
    tracks: data.clips.reduce((sum, clip) => sum + clip.tracks.length, 0),
    keyframes: data.clips.reduce((sum, clip) => sum + clip.keyframes, 0),
    duration: data.timeline.longestDuration,
    fps: data.timeline.fps,
  };
});

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

async function copyJson(): Promise<void> {
  if (!jsonText.value) return;
  try {
    await navigator.clipboard.writeText(jsonText.value);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch (err) {
    store.toast('error', `复制失败：${(err as Error).message}`);
  }
}

function downloadJson(): void {
  if (!jsonText.value) return;
  const base = (store.selectedFile?.name ?? 'animation').replace(/\.fbx$/i, '');
  const blob = new Blob([jsonText.value], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${base}.animation.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="backdrop" @click.self="emit('close')">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="动画数据 JSON 预览">
        <header class="dialog-head">
          <div class="dialog-title">
            <Icon name="text" :size="15" />
            动画数据
            <span class="chip chip-accent">JSON</span>
            <span v-if="store.selectedFile" class="file-name mono" :title="store.selectedFile.relative">
              {{ store.selectedFile.relative }}
            </span>
          </div>
          <button class="btn btn-ghost btn-icon" type="button" title="关闭" @click="emit('close')">
            <Icon name="close" :size="15" />
          </button>
        </header>

        <div v-if="summary" class="summary">
          <span class="chip">{{ formatCount(summary.joints) }} 关节</span>
          <span class="chip">{{ summary.clips }} 个片段</span>
          <span class="chip">{{ formatCount(summary.tracks) }} 条轨迹</span>
          <span class="chip">{{ formatCount(summary.keyframes) }} 个关键帧</span>
          <span class="chip">最长 {{ summary.duration.toFixed(2) }} 秒</span>
          <span v-if="summary.fps !== null" class="chip">{{ summary.fps }} fps</span>
        </div>

        <div class="toolbar">
          <label class="toggle">
            <input v-model="includeKeyframes" type="checkbox" class="checkbox" :disabled="!store.extractedData" />
            <span>包含关键帧数值</span>
            <small>关闭后只保留轨迹摘要（时间范围、采样间隔）</small>
          </label>
          <div class="actions">
            <button class="btn" type="button" :disabled="!jsonText" @click="copyJson">
              <Icon :name="copied ? 'check' : 'copy'" :size="13" />
              {{ copied ? '已复制' : '复制 JSON' }}
            </button>
            <button class="btn" type="button" :disabled="!jsonText" @click="downloadJson">
              <Icon name="download" :size="13" />
              下载 JSON
            </button>
          </div>
        </div>

        <div ref="previewRef" class="preview">
          <div v-if="store.dataExtracting" class="state">
            <Icon name="refresh" :size="24" class="spin" />
            <p>正在提取动画数据…</p>
          </div>
          <div v-else-if="store.dataError" class="state error">
            <Icon name="alert" :size="22" />
            <p>{{ store.dataError }}</p>
          </div>
          <div v-else-if="!store.extractedData" class="state">
            <Icon name="text" :size="28" />
            <p>没有可预览的数据</p>
          </div>
          <VueJsonPretty
            v-else
            class="tree"
            :data="prettyData"
            :deep="2"
            :collapsed-node-length="200"
            :show-length="true"
            :show-icon="true"
            :virtual="true"
            :height="previewHeight"
            :item-height="22"
            theme="dark"
          />
        </div>

        <footer class="dialog-foot">
          <p class="hint">
            <Icon name="info" :size="12" />
            只包含关节层级、动画轨迹与时间线；网格、蒙皮权重、材质与贴图不会导出。
          </p>
          <span v-if="jsonText" class="mono size">{{ formatCount(jsonText.length) }} 字符</span>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 65;
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
  width: min(980px, 100%);
  height: min(920px, calc(100vh - 48px));
  max-height: calc(100vh - 48px);
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
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 600;
}

.file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-weight: 400;
}

.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px 0;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  cursor: pointer;
}

.toggle small {
  color: var(--text-faint);
  font-size: 10.5px;
}

.checkbox {
  flex: none;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  cursor: pointer;
}

.actions {
  display: flex;
  gap: 8px;
}

.preview {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-app);
  display: flex;
  flex-direction: column;
}

.state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-faint);
  font-size: 12px;
}

.state p {
  margin: 0;
}

.state.error {
  color: var(--danger);
}

.tree {
  flex: none;
  padding: 6px 16px 10px;
}

.tree :deep(.vjs-tree) {
  font-family: var(--mono);
  font-size: 12px;
  color: #cfd2da;
}

.tree :deep(.vjs-tree-node) {
  line-height: 22px;
  border-radius: 3px;
}

.tree :deep(.vjs-tree-node:hover),
.tree :deep(.vjs-tree-node.is-highlight) {
  background: rgba(124, 92, 255, 0.14);
}

.tree :deep(.vjs-tree-brackets),
.tree :deep(.vjs-colon),
.tree :deep(.vjs-comment) {
  color: var(--text-dim);
}

.tree :deep(.vjs-key) {
  color: #9cdcfe;
}

.tree :deep(.vjs-value-string) {
  color: #ce9178;
}

.tree :deep(.vjs-value-number) {
  color: #b5cea8;
}

.tree :deep(.vjs-value-boolean) {
  color: #d19a66;
}

.tree :deep(.vjs-value-null),
.tree :deep(.vjs-value-undefined) {
  color: #c586c0;
}

.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}

.size {
  flex: none;
  color: var(--text-faint);
}
</style>
