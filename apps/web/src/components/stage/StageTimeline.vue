<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStageStore } from '@/stores/stage';
import { buildTimeline } from '@/viewer/stage/SequenceTimeline';
import { resolveSegmentColor } from '@/viewer/stage/segmentColors';
import type { SegmentDef } from '@/viewer/stage/StageTypes';

const store = useStageStore();

/** 缩放到底时每秒的最小像素：再小就拖不准也看不清块了 */
const MIN_PX_PER_SEC = 22;
/** 空舞台/短片段的兜底可视时长 */
const MIN_SPAN = 4;
/** 缩放范围（1 = 正好铺满容器） */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;

const actor = computed(() => store.selectedActor);
const timeline = computed(() => buildTimeline(store.actorSegmentsList));

interface Block {
  segment: SegmentDef;
  index: number;
  start: number;
  end: number;
  length: number;
}

const blocks = computed<Block[]>(() =>
  store.actorSegmentsList.map((segment, index) => {
    const timing = timeline.value.timings[index];
    return {
      segment,
      index,
      start: timing?.start ?? 0,
      end: timing?.end ?? 0,
      length: timing?.length ?? 0,
    };
  }),
);

const totalText = computed(() => timeline.value.total.toFixed(2));

/** 可视时间跨度：跟随该角色总时长，至少铺满 MIN_SPAN 秒 */
const span = computed(() =>
  Math.max(MIN_SPAN, Math.ceil(Math.max(timeline.value.total, store.duration, 0) * 2) / 2 + 0.5),
);

/** 容器的可用宽度：决定「铺满」时的每秒像素 */
const scroller = ref<HTMLDivElement | null>(null);
const available = ref(0);
let observer: ResizeObserver | null = null;

/** 用户缩放倍率：1 = 当前跨度正好铺满容器 */
const zoom = ref(1);
const zoomText = computed(() => `${Math.round(zoom.value * 100)}%`);

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
});

/** 每秒像素：先按容器铺满算出基准比例，再乘用户缩放 */
const pxPerSec = computed(() => {
  const fit = available.value > 0 ? available.value / span.value : 80;
  return Math.max(MIN_PX_PER_SEC, fit * zoom.value);
});

const width = computed(() => span.value * pxPerSec.value);

function setZoom(next: number): void {
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
}

/** 滚轮缩放：按住 Ctrl/Alt 才缩放，普通滚轮仍用于横向滚动 */
function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.altKey) return;
  event.preventDefault();
  const element = scroller.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  // 以光标所在时间为锚点缩放，视觉上不会跳走
  const cursorTime = (element.scrollLeft + (event.clientX - rect.left)) / pxPerSec.value;
  setZoom(zoom.value * (event.deltaY < 0 ? 1.16 : 1 / 1.16));
  void nextTick(() => {
    element.scrollLeft = Math.max(0, cursorTime * pxPerSec.value - (event.clientX - rect.left));
  });
}

/** 刻度：按当前比例选一个不挤的间隔，任意缩放级别都能读出时间 */
const ticks = computed(() => {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];
  const step = candidates.find((value) => value * pxPerSec.value >= 56) ?? 60;
  const digits = step < 1 ? 1 : 0;
  const list: { value: number; label: string }[] = [];
  for (let value = 0; value <= span.value + 1e-6; value += step) {
    list.push({ value, label: value.toFixed(digits) });
  }
  return list;
});

const draggingId = ref<string | null>(null);

interface DragState {
  id: string;
  pointerId: number;
  originX: number;
  originStart: number;
}

let drag: DragState | null = null;

/** 段自己的颜色优先，否则按序号生成（可无限区分） */
function colorOf(block: Block): string {
  return resolveSegmentColor(block.index, block.segment.color);
}

function blockStyle(block: Block): Record<string, string> {
  return {
    left: `${block.start * pxPerSec.value}px`,
    width: `${Math.max(8, block.length * pxPerSec.value - 2)}px`,
    '--seg': colorOf(block),
  };
}

function blockTitle(block: Block): string {
  const kind = block.segment.transition ? '过渡段' : `第 ${block.index + 1} 段`;
  return [
    `${kind} · ${store.sourceLabel(block.segment.source)}`,
    `${block.start.toFixed(2)}s – ${block.end.toFixed(2)}s（${block.length.toFixed(2)}s）`,
    '拖动整块调整时间',
  ].join('\n');
}

/** 点标尺/轨道空白处：把播放头移到点击位置 */
function seekAt(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  store.seek((event.clientX - rect.left) / pxPerSec.value);
}

/** 块只能整体拖动：按下时记下原始起点，移动中按像素差换算成时间 */
function onBlockPointerDown(event: PointerEvent, block: Block): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  if (store.isSegmentLocked(block.segment.id)) {
    store.selectSegment(block.segment.id);
    return;
  }
  const element = event.currentTarget as HTMLElement;
  drag = {
    id: block.segment.id,
    pointerId: event.pointerId,
    originX: event.clientX,
    originStart: block.start,
  };
  draggingId.value = block.segment.id;
  store.selectSegment(block.segment.id);
  try {
    element.setPointerCapture(event.pointerId);
  } catch {
    // 某些合成事件/特殊指针拿不到捕获：仍可继续拖动（光标在块内时事件照常冒泡）
  }
}

function onBlockPointerMove(event: PointerEvent): void {
  // 只认当前这一次拖动：同一时刻只有一块在拖，不再挑剔 pointerId
  if (!drag) return;
  const seconds = (event.clientX - drag.originX) / pxPerSec.value;
  store.setSegmentStart(drag.id, drag.originStart + seconds);
}

function onBlockPointerUp(event: PointerEvent): void {
  if (!drag) return;
  const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture?.(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
  drag = null;
  draggingId.value = null;
}
</script>

<template>
  <div class="timeline panel">
    <div class="head">
      <span class="section-title"><Icon name="film" :size="12" />时间轴</span>
      <span class="faint meta">
        <template v-if="actor">
          {{ actor.name }} · {{ blocks.length }} 段 · 总长 {{ totalText }}s
        </template>
        <template v-else>未选角色</template>
      </span>
      <span class="now mono">{{ store.time.toFixed(2) }}s</span>
      <button
        class="btn btn-sm"
        type="button"
        :disabled="!actor || blocks.length === 0 || store.isActorLocked(actor?.id ?? '')"
        title="把当前角色的所有动画块首尾相接，自动对齐每一段的头部和尾部"
        @click="store.seamlessAlign()"
      >
        <Icon name="repeat" :size="12" />一键无缝衔接
      </button>
      <span class="zoom">
        <button class="btn btn-ghost btn-icon zoom-btn" type="button" title="缩小（Ctrl+滚轮）" @click="setZoom(zoom / 1.25)">−</button>
        <span class="zoom-value mono" title="当前缩放比例，双击恢复铺满" @dblclick="setZoom(1)">{{ zoomText }}</span>
        <button class="btn btn-ghost btn-icon zoom-btn" type="button" title="放大（Ctrl+滚轮）" @click="setZoom(zoom * 1.25)">＋</button>
      </span>
    </div>

    <div v-if="!actor" class="empty">选择一个角色后，这里会显示它的动画块</div>

    <div v-else ref="scroller" class="scroller" @wheel="onWheel">
      <div class="content" :style="{ width: `${width}px` }">
        <div class="ruler" @click="seekAt">
          <span
            v-for="tick in ticks"
            :key="tick.value"
            class="tick"
            :class="{ major: tick.label.length > 0 }"
            :style="{ left: `${tick.value * pxPerSec}px` }"
          >
            <span class="tick-label mono">{{ tick.label }}</span>
          </span>
        </div>

        <div class="lane" @click="seekAt">
          <div
            v-for="block in blocks"
            :key="block.segment.id"
            class="block"
            :class="{
              active: block.segment.id === store.selectedSegmentId,
              transition: !!block.segment.transition,
              locked: store.isSegmentLocked(block.segment.id),
              dragging: draggingId === block.segment.id,
            }"
            :style="blockStyle(block)"
            :title="blockTitle(block)"
            @click.stop
            @pointerdown="onBlockPointerDown($event, block)"
            @pointermove="onBlockPointerMove"
            @pointerup="onBlockPointerUp"
            @pointercancel="onBlockPointerUp"
          >
            <span class="block-name">{{ store.sourceLabel(block.segment.source) }}</span>
            <span class="block-time mono">{{ block.start.toFixed(2) }}–{{ block.end.toFixed(2) }}s</span>
          </div>

          <div v-if="blocks.length === 0" class="lane-hint faint">还没有动画，在右侧「动作序列」里添加片段</div>
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
  height: 148px;
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
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

.now {
  color: var(--text-dim);
}

.zoom {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.zoom .zoom-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
}

.zoom-value {
  min-width: 44px;
  text-align: center;
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
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
  overflow-y: hidden;
}

.content {
  position: relative;
  height: 100%;
  min-height: 78px;
}

.ruler {
  position: relative;
  height: 20px;
  border-bottom: 1px solid var(--border);
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

.tick.major {
  background: var(--border-strong);
}

.tick-label {
  position: absolute;
  left: 3px;
  top: 1px;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

.lane {
  position: relative;
  height: 58px;
  margin-top: 4px;
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  cursor: pointer;
}

.block {
  position: absolute;
  top: 7px;
  height: 44px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 0 7px;
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

.block.transition {
  background: rgba(124, 92, 255, 0.2);
}

.block.transition.active {
  background: rgba(124, 92, 255, 0.28);
}

.block.dragging {
  cursor: grabbing;
  box-shadow: var(--shadow);
  z-index: 2;
}

.block.locked {
  cursor: default;
  opacity: 0.6;
}

.block-name {
  font-size: 11.5px;
  color: var(--seg, var(--text));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block-time {
  color: var(--text-faint);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lane-hint {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11.5px;
  pointer-events: none;
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--accent);
  pointer-events: none;
  z-index: 3;
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
