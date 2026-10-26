<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStripsStore } from '@/stores/strips';
import { BODY_PARTS } from '@/viewer/strips/StripParts';
import type { StripDef } from '@/viewer/strips/StripTypes';
import { resolveSegmentColor } from '@/viewer/stage/segmentColors';

const store = useStripsStore();

const scroller = ref<HTMLDivElement | null>(null);
const available = ref(0);
let observer: ResizeObserver | null = null;

onMounted(() => {
  const element = scroller.value;
  if (!element) return;
  available.value = element.clientWidth;
  observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry) available.value = entry.contentRect.width;
  });
  observer.observe(element);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  stopDrag();
});

/** 每秒像素：短片铺满容器，长片保留横向滚动 */
const pxPerSec = computed(() => {
  const span = Math.max(1, store.duration);
  const fit = available.value > 0 ? (available.value - 24) / span : 80;
  return Math.max(48, Math.min(180, fit));
});

const contentWidth = computed(() => Math.max(available.value, store.duration * pxPerSec.value + 24));

const ticks = computed(() => {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];
  const step = candidates.find((value) => value * pxPerSec.value >= 60) ?? 60;
  const digits = step < 1 ? 1 : 0;
  const list: { value: number; label: string }[] = [];
  for (let value = 0; value <= store.duration + 1e-6; value += step) {
    list.push({ value, label: value.toFixed(digits) });
  }
  return list;
});

function partLabel(id: StripDef['part']): string {
  return BODY_PARTS.find((part) => part.id === id)?.label ?? id;
}

function colorOf(strip: StripDef, index: number): string {
  return resolveSegmentColor(index, strip.color);
}

function blockStyle(strip: StripDef, index: number): Record<string, string> {
  return {
    left: `${strip.start * pxPerSec.value}px`,
    width: `${Math.max(28, strip.duration * pxPerSec.value - 2)}px`,
    '--seg': colorOf(strip, index),
  };
}

function blockTitle(strip: StripDef): string {
  return [
    strip.name,
    `${partLabel(strip.part)} · 权重 ${Math.round(strip.weight * 100)}%`,
    `${strip.start.toFixed(2)}s – ${(strip.start + strip.duration).toFixed(2)}s`,
    '拖动整块改起点；拖左右边缘裁剪范围',
  ].join('\n');
}

/** 点标尺或空白轨道：把播放头移到点击位置 */
function seekAt(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  store.seek((event.clientX - rect.left) / pxPerSec.value);
}

type DragMode = 'move' | 'start' | 'end';

interface DragState {
  id: string;
  mode: DragMode;
  originX: number;
  start0: number;
  duration0: number;
  trim0: number;
}

let drag: DragState | null = null;
const draggingId = ref<string | null>(null);

function onWindowMove(event: PointerEvent): void {
  if (!drag) return;
  const dx = (event.clientX - drag.originX) / pxPerSec.value;
  if (drag.mode === 'move') {
    store.updateStrip(drag.id, { start: Math.max(0, drag.start0 + dx) });
    return;
  }
  if (drag.mode === 'end') {
    store.updateStrip(drag.id, { duration: drag.duration0 + dx });
    return;
  }
  // 拖左边缘：同时推进起点与片段内裁剪点，块内容保持对齐
  const minDelta = Math.max(-drag.trim0, -drag.start0);
  const maxDelta = drag.duration0 - 0.2;
  const delta = Math.min(maxDelta, Math.max(minDelta, dx));
  store.updateStrip(drag.id, {
    start: drag.start0 + delta,
    duration: drag.duration0 - delta,
    trimStart: drag.trim0 + delta,
  });
}

function stopDrag(): void {
  window.removeEventListener('pointermove', onWindowMove);
  window.removeEventListener('pointerup', stopDrag);
  drag = null;
  draggingId.value = null;
}

function beginDrag(event: PointerEvent, strip: StripDef, mode: DragMode): void {
  if (event.button !== 0) return;
  event.preventDefault();
  store.selectStrip(strip.id);
  drag = {
    id: strip.id,
    mode,
    originX: event.clientX,
    start0: strip.start,
    duration0: strip.duration,
    trim0: strip.trimStart,
  };
  draggingId.value = strip.id;
  window.addEventListener('pointermove', onWindowMove);
  window.addEventListener('pointerup', stopDrag);
}
</script>

<template>
  <div class="timeline panel">
    <div class="head">
      <span class="section-title"><Icon name="film" :size="12" />Strips 时间轴</span>
      <span class="faint meta">
        {{ store.strips.length }} 个 Strip · 总长 {{ store.duration.toFixed(2) }}s
      </span>
      <span class="now mono">{{ store.time.toFixed(2) }}s</span>
      <span class="hint faint">拖动块移动 · 拖左右边缘裁剪 · 多块重叠即混合</span>
    </div>

    <div v-if="store.strips.length === 0" class="empty">
      还没有 Strip，在左侧点一个动画来源加入时间轴
    </div>

    <div v-else ref="scroller" class="scroller">
      <div class="content" :style="{ width: `${contentWidth}px` }">
        <div class="ruler" @click="seekAt">
          <span
            v-for="tick in ticks"
            :key="tick.value"
            class="tick"
            :style="{ left: `${tick.value * pxPerSec}px` }"
          >
            <span class="tick-label mono">{{ tick.label }}</span>
          </span>
        </div>

        <div class="lanes">
          <div
            v-for="(strip, index) in store.strips"
            :key="strip.id"
            class="lane"
            @click="seekAt"
          >
            <div
              class="block"
              :class="{
                active: strip.id === store.selectedId,
                muted: strip.muted,
                dragging: draggingId === strip.id,
                pending: store.clipStates[strip.id]?.status === 'loading',
                broken: store.clipStates[strip.id]?.status === 'error',
              }"
              :style="blockStyle(strip, index)"
              :title="blockTitle(strip)"
              @click.stop
              @pointerdown="beginDrag($event, strip, 'move')"
            >
              <span class="handle left" title="拖这里调整范围起点" @pointerdown.stop="beginDrag($event, strip, 'start')"></span>
              <span class="block-name">{{ strip.name }}</span>
              <span class="block-meta mono">
                {{ partLabel(strip.part) }} · {{ Math.round(strip.weight * 100) }}% ·
                {{ strip.start.toFixed(2) }}–{{ (strip.start + strip.duration).toFixed(2) }}s
              </span>
              <span class="handle right" title="拖这里调整范围终点" @pointerdown.stop="beginDrag($event, strip, 'end')"></span>
            </div>
          </div>
        </div>

        <div class="playhead" :style="{ left: `${store.time * pxPerSec}px` }"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 212px;
  padding: 8px 10px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.meta {
  font-size: 11.5px;
}

.now {
  color: var(--text-dim);
  margin-left: auto;
}

.head .hint {
  font-size: 11px;
  white-space: nowrap;
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-faint);
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: auto;
}

.content {
  position: relative;
  min-height: 100%;
}

.ruler {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  cursor: pointer;
  user-select: none;
}

.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
}

.tick-label {
  position: absolute;
  left: 3px;
  top: 1px;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

.lanes {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0 10px;
}

.lane {
  position: relative;
  height: 42px;
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  cursor: pointer;
}

.block {
  position: absolute;
  top: 4px;
  height: 34px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--seg, #60a5fa);
  border-radius: 5px;
  background: var(--bg-elevated);
  color: var(--text);
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.block:hover {
  background: var(--bg-hover);
}

.block.active {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.block.dragging {
  cursor: grabbing;
  box-shadow: var(--shadow);
  z-index: 3;
}

.block.muted {
  opacity: 0.45;
  filter: grayscale(0.5);
}

.block.pending {
  opacity: 0.6;
  background-image: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.05) 0 6px,
    transparent 6px 12px
  );
}

.block.broken {
  border-color: var(--danger);
}

.block-name {
  font-size: 11.5px;
  color: var(--seg, var(--text));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block-meta {
  color: var(--text-faint);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: ew-resize;
  background: transparent;
}

.handle:hover {
  background: rgba(255, 255, 255, 0.16);
}

.handle.left {
  left: 0;
}

.handle.right {
  right: 0;
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--accent);
  pointer-events: none;
  z-index: 4;
}

.playhead::before {
  content: '';
  position: absolute;
  left: -3px;
  top: 0;
  border: 3.5px solid transparent;
  border-top-color: var(--accent);
}
</style>
