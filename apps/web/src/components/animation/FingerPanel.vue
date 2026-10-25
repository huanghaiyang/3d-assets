<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import { useAnimationStore } from '@/stores/animation';
import type { FingerPosePreset, FingerSide } from '@/api/animation';

/**
 * 手指骨模块（仅新建动画使用）。
 *
 * 形态库来自现有 Mixamo 动画缓存，左右手分别挑选后，按时间轴区间写入当前片段：
 * 区间内替换成选中的手型，区间外保留原动画；不涉及腕关节和 Kimodo 生成逻辑。
 */
const store = useAnimationStore();

const side = ref<FingerSide>('left');
const leftId = ref<string | null>(null);
const rightId = ref<string | null>(null);
const keyword = ref('');
const start = ref(0);
const end = ref(0);

const hasData = computed(() => !!store.activeNewAnimation?.data);
const activeClip = computed(() => store.selectedClips[store.activeClipIndex] ?? null);
const duration = computed(() => activeClip.value?.duration ?? 0);

const library = computed(() => store.fingerPoses);
const currentList = computed<FingerPosePreset[]>(() => {
  const all = (side.value === 'left' ? library.value?.left : library.value?.right) ?? [];
  const query = keyword.value.trim().toLowerCase();
  if (!query) return all;
  return all.filter(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      item.source.file.toLowerCase().includes(query) ||
      item.source.clip.toLowerCase().includes(query),
  );
});

function findPreset(sideValue: FingerSide, id: string | null): FingerPosePreset | null {
  if (!id || !library.value) return null;
  const list = sideValue === 'left' ? library.value.left : library.value.right;
  return list.find((item) => item.id === id) ?? null;
}

const leftPreset = computed(() => findPreset('left', leftId.value));
const rightPreset = computed(() => findPreset('right', rightId.value));
const hasSelection = computed(() => !!(leftPreset.value || rightPreset.value));

function averageCurl(item: FingerPosePreset): number {
  if (item.curls.length === 0) return 0;
  return item.curls.reduce((sum, value) => sum + value, 0) / item.curls.length;
}

function barHeight(curl: number): string {
  return `${Math.round(4 + Math.min(1, Math.max(0, curl)) * 22)}px`;
}

function curlTitle(item: FingerPosePreset): string {
  const labels = ['拇指', '食指', '中指', '无名指', '小指'];
  return item.curls
    .map((value, index) => `${labels[index] ?? `手指${index + 1}`} ${Math.round(value * 100)}%`)
    .join(' · ');
}

function selectPreset(item: FingerPosePreset): void {
  if (item.side === 'left') {
    leftId.value = leftId.value === item.id ? null : item.id;
  } else {
    rightId.value = rightId.value === item.id ? null : item.id;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function setStart(value: number): void {
  start.value = clamp(value, 0, Math.max(0, end.value - 0.01));
}

function setEnd(value: number): void {
  end.value = clamp(value, Math.min(duration.value, start.value + 0.01), duration.value);
}

function useWholeClip(): void {
  start.value = 0;
  end.value = duration.value;
}

/** 从当前播放位置开始，一直到片尾 */
function useFromPlayback(): void {
  const time = clamp(store.currentTime, 0, Math.max(0, duration.value - 0.01));
  start.value = time;
  end.value = duration.value;
}

watch(
  () => [store.activeClipIndex, duration.value] as const,
  () => {
    start.value = 0;
    end.value = duration.value;
  },
  { immediate: true },
);

function apply(): void {
  const selections: { side: FingerSide; preset: FingerPosePreset }[] = [];
  if (leftPreset.value) selections.push({ side: 'left', preset: leftPreset.value });
  if (rightPreset.value) selections.push({ side: 'right', preset: rightPreset.value });
  store.applyFingerPoseSelection(selections, start.value, end.value);
}

onMounted(() => {
  void store.loadFingerPoses();
});
</script>

<template>
  <div class="finger-panel">
    <div class="scroll">
      <section class="block">
        <span class="field-label">手指骨</span>
        <p class="hint">
          形态从现有 Mixamo 动画中采样并去重，左右手可分别选择。应用时只替换选中片段、选中时间段内的手指骨，
          区间外与其它骨骼保持不变。
        </p>
      </section>

      <section v-if="!hasData" class="block empty-state">
        <Icon name="bone" :size="20" />
        <p>当前新建动画还没有动画数据。</p>
        <p class="hint">先在「信息」里导入动画 JSON，或生成并导入 kimodo 动画，再回来设置手型。</p>
      </section>

      <template v-else>
        <section class="block">
          <div class="clip-line">
            <Icon name="play" :size="11" />
            <span class="clip-name" :title="activeClip?.name">{{ activeClip?.name || '当前片段' }}</span>
            <span class="mono faint">{{ duration.toFixed(2) }}s</span>
          </div>

          <div class="range-card">
            <div class="range-title">
              <span>替换区间</span>
              <span class="mono">{{ start.toFixed(2) }} – {{ end.toFixed(2) }} 秒</span>
            </div>
            <label class="range-row">
              <span class="range-label">起点</span>
              <input
                class="range"
                type="range"
                min="0"
                :max="Math.max(0, duration)"
                step="0.01"
                :value="start"
                @input="setStart(Number(($event.target as HTMLInputElement).value))"
              />
              <input
                class="range-number mono"
                type="number"
                min="0"
                :max="Math.max(0, end - 0.01)"
                step="0.01"
                :value="start"
                @change="setStart(Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <label class="range-row">
              <span class="range-label">终点</span>
              <input
                class="range"
                type="range"
                :min="Math.min(duration, start + 0.01)"
                :max="Math.max(0, duration)"
                step="0.01"
                :value="end"
                @input="setEnd(Number(($event.target as HTMLInputElement).value))"
              />
              <input
                class="range-number mono"
                type="number"
                :min="Math.min(duration, start + 0.01)"
                :max="Math.max(0, duration)"
                step="0.01"
                :value="end"
                @change="setEnd(Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <div class="range-actions">
              <button class="mini-btn" type="button" @click="useWholeClip">整个片段</button>
              <button class="mini-btn" type="button" @click="useFromPlayback">从当前播放时间</button>
            </div>
          </div>
        </section>

        <section class="block">
          <span class="field-label">当前选择</span>
          <div class="selection">
            <button class="sel-card" type="button" @click="side = 'left'">
              <span class="sel-side">左手</span>
              <span class="sel-name" :class="{ none: !leftPreset }">{{ leftPreset?.name ?? '未选择' }}</span>
            </button>
            <button class="sel-card" type="button" @click="side = 'right'">
              <span class="sel-side">右手</span>
              <span class="sel-name" :class="{ none: !rightPreset }">{{ rightPreset?.name ?? '未选择' }}</span>
            </button>
          </div>
        </section>

        <section class="block library">
          <div class="library-head">
            <span class="field-label">形态库</span>
            <button
              class="mini-btn"
              type="button"
              :disabled="store.fingerPosesLoading"
              title="重新扫描 data/cache/motion 里的 Mixamo 动画"
              @click="store.loadFingerPoses(true)"
            >
              <Icon name="refresh" :size="11" :class="{ spinning: store.fingerPosesLoading }" />
              {{ store.fingerPosesLoading ? '采样中…' : '重新提取' }}
            </button>
          </div>

          <p v-if="library?.available" class="hint">
            扫描 {{ library.scanned }} 个片段，左手 {{ library.left.length }} 种、右手 {{ library.right.length }} 种。
          </p>
          <p v-else-if="library?.message" class="hint warn">{{ library.message }}</p>
          <p v-if="store.fingerPosesError" class="hint warn">{{ store.fingerPosesError }}</p>

          <div class="side-tabs">
            <button class="side-tab" :class="{ active: side === 'left' }" type="button" @click="side = 'left'">
              左手
              <span class="chip">{{ library?.left.length ?? 0 }}</span>
            </button>
            <button class="side-tab" :class="{ active: side === 'right' }" type="button" @click="side = 'right'">
              右手
              <span class="chip">{{ library?.right.length ?? 0 }}</span>
            </button>
          </div>

          <input v-model="keyword" class="search" type="search" placeholder="搜索形态名 / 来源动画" />

          <div v-if="store.fingerPosesLoading && !library" class="loading">
            <Icon name="refresh" :size="14" class="spinning" />
            <span>正在从现有动画里采样手型…</span>
          </div>

          <div v-else class="pose-list">
            <button
              v-for="item in currentList"
              :key="item.id"
              class="pose"
              :class="{
                active:
                  (side === 'left' && item.id === leftId) || (side === 'right' && item.id === rightId),
              }"
              type="button"
              :title="`${curlTitle(item)}\n来源：${item.source.file} @ ${item.source.time.toFixed(2)}s`"
              @click="selectPreset(item)"
            >
              <span class="curls" aria-hidden="true">
                <i v-for="(curl, index) in item.curls" :key="index" :style="{ height: barHeight(curl) }" />
              </span>
              <span class="pose-body">
                <span class="pose-name">
                  {{ item.name }}
                  <small class="mono">{{ Math.round(averageCurl(item) * 100) }}%</small>
                </span>
                <span class="pose-src">{{ item.source.file }} · {{ item.source.time.toFixed(2) }}s</span>
              </span>
              <span class="pose-samples mono" :title="`在动画库中出现 ${item.samples} 次`">
                ×{{ item.samples }}
              </span>
            </button>
            <p v-if="currentList.length === 0" class="hint">没有匹配的形态，换个关键词试试。</p>
          </div>
        </section>
      </template>
    </div>

    <footer v-if="hasData" class="apply-bar">
      <span class="apply-range mono">{{ start.toFixed(2) }} – {{ end.toFixed(2) }}s</span>
      <button class="btn apply-btn" type="button" :disabled="!hasSelection" @click="apply">
        <Icon name="check" :size="13" />
        应用手型
      </button>
    </footer>
  </div>
</template>

<style scoped>
.finger-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}

.hint.warn {
  color: #e0a030;
}

.faint {
  color: var(--text-faint);
}

.empty-state {
  align-items: center;
  padding: 22px 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  text-align: center;
  color: var(--text-dim);
}

.empty-state p {
  margin: 0;
  font-size: 12px;
}

.clip-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-dim);
}

.clip-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

.range-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
}

.range-title {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.range-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.range-label {
  flex: none;
  width: 26px;
  font-size: 11px;
  color: var(--text-faint);
}

.range {
  flex: 1;
  min-width: 0;
  height: 4px;
  appearance: none;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #4b3fb0);
  outline: none;
}

.range::-webkit-slider-thumb {
  appearance: none;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent);
  cursor: pointer;
}

.range-number {
  flex: none;
  width: 48px;
  padding: 3px 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: 11px;
  text-align: right;
}

.range-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 10.5px;
}

.mini-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.mini-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.selection {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.sel-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  text-align: left;
}

.sel-card:hover {
  background: var(--bg-hover);
}

.sel-side {
  font-size: 10.5px;
  color: var(--text-faint);
}

.sel-name {
  font-size: 12px;
  color: var(--accent-hover);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sel-name.none {
  color: var(--text-faint);
}

.library {
  min-height: 0;
}

.library-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.side-tabs {
  display: flex;
  gap: 4px;
}

.side-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
}

.side-tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.side-tab.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
  font-weight: 600;
}

.chip {
  display: inline-flex;
  align-items: center;
  height: 15px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-panel-2);
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 400;
}

.search {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 11.5px;
  outline: none;
}

.search:focus {
  border-color: var(--accent);
}

.loading {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 14px 4px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.pose-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 4px;
}

.pose {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  text-align: left;
}

.pose:hover {
  background: var(--bg-hover);
}

.pose.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.curls {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 28px;
}

.curls i {
  width: 4px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.8;
}

.pose-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.pose-name {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text);
}

.pose-name small {
  color: var(--text-faint);
  font-size: 9.5px;
}

.pose-src {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-faint);
}

.pose-samples {
  flex: none;
  font-size: 9.5px;
  color: var(--text-faint);
}

.apply-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.apply-range {
  flex: 1;
  font-size: 11px;
  color: var(--text-faint);
}

.apply-btn {
  flex: none;
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
