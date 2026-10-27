<script setup lang="ts">
/**
 * StripTimeline —— 拼接工作区底部的时间轴（5 条 lane 对应 5 个身体部位）。
 *
 * 定位：把 store.strips 以「部位 → 轨道块」的形式可视化，并承担拖动/裁剪交互；
 * 它是编排数据最直观的编辑面板，右侧检查器负责精细数值，两者改的是同一份 store。
 *
 * 核心换算：像素 ↔ 秒由 pxPerSec 决定。时间轴宽度铺满底部工作栏（v2 需求），
 * 即 pxPerSec = 可用宽度 / 总时长，所以总时长变化时整条轴会整体缩放；
 * 所有拖动/裁剪把指针位移（px）除以 pxPerSec 得到秒。
 *
 * 数据流：store.strips / store.span / store.time / store.selectedId 为输入；
 * store.updateStrip() / store.seek() / store.selectStrip() / store.setHoverPart() 为输出。
 * 父组件 StripsPage 只负责把它放在 grid 第二行（跨满整行）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStripsStore, MAX_STRIP_TRACKS } from '@/stores/strips';
import { BODY_PARTS } from '@/viewer/strips/StripParts';
import type { BodyPart, StripDef } from '@/viewer/strips/StripTypes';
import { resolveSegmentColor } from '@/viewer/stage/segmentColors';

const store = useStripsStore();

/** 左侧部位标签列宽（时间 0 从这里开始） */
const LABEL_WIDTH = 56;
/** 滚动容器引用，仅用于测量可用宽度 */
const scroller = ref<HTMLDivElement | null>(null);
/** 可用的整行宽度（px），由 ResizeObserver 持续更新；0 表示尚未测量 */
const available = ref(0);
let observer: ResizeObserver | null = null;

/**
 * 测量时间轴可用宽度。
 * 只观察 scroller（时间轴实际可视区），窗口缩放、侧栏变化都会自动重算，
 * 从而保证「总宽铺满底部工作栏」始终成立，无需监听 window.resize。
 */
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

/** 卸载时断开观察者并清理可能仍在进行的拖动监听 */
onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  stopDrag();
});

/**
 * 时间轴铺满整个底部工作栏：每秒像素 = 可用宽度 / 总时长。
 * 总时长取 store.duration（由播放器决定），但 store.span 才是编排的默认总长；
 * 这里设 0.5s 下限避免除零，另留 8px/s 下限防止极短片段被拉得无法点击；
 * 尚未测量（available = 0）时用 600px 兜底，保证首次渲染块位置合理。
 */
const pxPerSec = computed(() => {
  const span = Math.max(0.5, store.duration);
  const track = available.value > 0 ? available.value - LABEL_WIDTH - 12 : 600;
  return Math.max(8, track / span);
});

/** 内容层宽度：与可用宽度一致，使 ruler/lanes/playhead 共用同一坐标系 */
const contentWidth = computed(() => Math.max(available.value, 0));
/** 去掉标签列与右侧 12px 留白后的实际轨道宽度 */
const trackWidth = computed(() => Math.max(0, available.value - LABEL_WIDTH - 12));

/**
 * 时间刻度：候选步长中选第一个「步长 * 每秒像素 >= 54」的值，
 * 保证相邻标签不重叠；步长 < 1s 时显示一位小数，否则取整秒。
 * 循环上界带 1e-6 容差，避免浮点累加导致最后一格漏画或多画。
 */
const ticks = computed(() => {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];
  const step = candidates.find((value) => value * pxPerSec.value >= 54) ?? 60;
  const digits = step < 1 ? 1 : 0;
  const list: { value: number; label: string }[] = [];
  for (let value = 0; value <= store.duration + 1e-6; value += step) {
    list.push({ value, label: value.toFixed(digits) });
  }
  return list;
});

/** 某条 lane（身体部位）上所有占用了该部位的 Strip，可能为空 */
function stripsOf(part: BodyPart): StripDef[] {
  return store.strips.filter((strip) => strip.parts.includes(part));
}

/** 该部位当前被哪条 Strip 占用（用于空 lane 上显示「已叠加」）；没有则返回 null */
function ownerName(part: BodyPart): string | null {
  return store.ownerOfPart(part)?.name ?? null;
}

/**
 * 块的颜色：优先用 Strip 自身 color，否则按加入顺序从配色板取色。
 * index 传的是 `store.strips.indexOf(strip)`，保证同一条 Strip 在各 lane 颜色一致。
 */
function colorOf(strip: StripDef, index: number): string {
  return resolveSegmentColor(index, strip.color);
}

/**
 * 生成块的绝对定位样式。
 * left / width 都由「秒 * pxPerSec」换算成 px；width 至少 28px 以便仍能点到，
 * 并减去 2px 作为块之间的视觉间隙；`--seg` 供 CSS 画左侧色条与标题颜色。
 */
function blockStyle(strip: StripDef, index: number): Record<string, string> {
  return {
    left: `${strip.start * pxPerSec.value}px`,
    width: `${Math.max(28, strip.duration * pxPerSec.value - 2)}px`,
    '--seg': colorOf(strip, index),
  };
}

/** hover 提示：名称、部位、权重百分比、时间范围（秒，保留两位）以及操作说明 */
function blockTitle(strip: StripDef): string {
  const parts = strip.parts
    .map((part) => BODY_PARTS.find((item) => item.id === part)?.label ?? part)
    .join('、');
  return [
    strip.name,
    `${parts} · 权重 ${Math.round(strip.weight * 100)}%`,
    `${strip.start.toFixed(2)}s – ${(strip.start + strip.duration).toFixed(2)}s`,
    '拖动整块改起点；拖左右边缘裁剪范围',
  ].join('\n');
}

/**
 * 点标尺或空白轨道：把播放头移到点击位置。
 * 减去 LABEL_WIDTH 是因为 lane 标签列不属于时间坐标；负值（点在标签上）按 0 处理。
 */
function seekAt(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const x = event.clientX - rect.left - LABEL_WIDTH;
  store.seek(Math.max(0, x) / pxPerSec.value);
}

/** 拖动模式：整块平移 / 拖左边缘 / 拖右边缘 */
type DragMode = 'move' | 'start' | 'end';

/**
 * 拖拽会话快照。originX 记录按下时的指针横坐标，其余字段保存起始值，
 * 后续所有位移都基于快照计算增量（而不是在过程中读当前值），避免累积误差。
 */
interface DragState {
  id: string;
  mode: DragMode;
  originX: number;
  start0: number;
  duration0: number;
  trim0: number;
}

let drag: DragState | null = null;
/** 正在拖动的 Strip id，仅用于给对应块加 .dragging 样式 */
const draggingId = ref<string | null>(null);

/**
 * 指针移动：把像素增量 dx 除以 pxPerSec 得到秒增量后写回 store。
 * - move：只改 start，且不小于 0（不能拖到时间原点左侧）；
 * - end：只改 duration，store.updateStrip 内部会 clamp 到 0.2~60s；
 * - start（拖左边缘）：同时推进 start 与 trimStart、反向缩短 duration。
 *   minDelta 取 max(-trim0, -start0)，保证裁剪点与起点都不会变成负数；
 *   maxDelta 留 0.2s，保证块不会被拖成零宽。
 */
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

/** 结束拖拽：移出 window 级监听并清空会话与高亮标记（可重复调用） */
function stopDrag(): void {
  window.removeEventListener('pointermove', onWindowMove);
  window.removeEventListener('pointerup', stopDrag);
  drag = null;
  draggingId.value = null;
}

/**
 * 开始拖拽。
 * 只响应鼠标左键；preventDefault 阻止文本选择/原生拖拽。
 * 按下即先选中该 Strip，让右侧检查器同步切换；监听挂在 window 上，
 * 保证指针移出块甚至移出时间轴后仍能继续拖动。
 */
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
    <!-- 头部摘要：槽位用量、总长（store.span = 最长源动画）、当前播放时间与操作提示 -->
    <div class="head">
      <span class="section-title"><Icon name="film" :size="12" />Strips 时间轴</span>
      <span class="faint meta mono">
        {{ store.strips.length }}/{{ MAX_STRIP_TRACKS }} 源动画 · 总长 {{ store.span.toFixed(2) }}s
      </span>
      <span class="now mono">{{ store.time.toFixed(2) }}s</span>
      <span class="hint faint">拖动块移动 · 拖左右边缘裁剪 · 同一动画可占多个部位</span>
    </div>

    <!-- 没有任何 Strip 时不渲染坐标轴：scroller 未挂载，available 保持 0，pxPerSec 走 600px 兜底 -->
    <div v-if="store.strips.length === 0" class="empty">
      还没有 Strip，在左侧点动画来源右侧的加号加入时间轴
    </div>

    <!-- scroller 是宽度测量对象；content 宽度 = available，保证整条轴铺满底部工作栏 -->
    <div v-else ref="scroller" class="scroller">
      <div class="content" :style="{ width: `${contentWidth}px` }">
        <!-- 标尺：左侧留 LABEL_WIDTH 空白与 lane 标签对齐；刻度绝对定位在 tick.value * pxPerSec -->
        <div class="ruler" @click="seekAt">
          <span class="ruler-pad" :style="{ width: `${LABEL_WIDTH}px` }"></span>
          <span
            v-for="tick in ticks"
            :key="tick.value"
            class="tick"
            :style="{ left: `${LABEL_WIDTH + tick.value * pxPerSec}px` }"
          >
            <span class="tick-label mono">{{ tick.label }}</span>
          </span>
        </div>

        <div class="lanes">
          <!-- 5 条 lane 一一对应 BODY_PARTS（头颈/躯干/左臂/右臂/下肢）；
               悬停 lane 会让模型对应部位外发光，点击空白处则移动播放头 -->
          <div
            v-for="part in BODY_PARTS"
            :key="part.id"
            class="lane"
            @click="seekAt"
            @mouseenter="store.setHoverPart(part.id)"
            @mouseleave="store.setHoverPart(null)"
          >
            <span class="lane-label" :title="part.hint">{{ part.label }}</span>
            <div class="lane-track" :style="{ width: `${trackWidth}px` }">
              <span v-if="stripsOf(part.id).length === 0" class="lane-empty faint">
                {{ ownerName(part.id) ? '已叠加' : '空闲部位' }}
              </span>
              <div
                v-for="strip in stripsOf(part.id)"
                :key="`${part.id}-${strip.id}`"
                class="block"
                :class="{
                  active: strip.id === store.selectedId,
                  muted: strip.muted,
                  dragging: draggingId === strip.id,
                  pending: store.clipStates[strip.id]?.status === 'loading',
                  broken: store.clipStates[strip.id]?.status === 'error',
                }"
                :style="blockStyle(strip, store.strips.indexOf(strip))"
                :title="blockTitle(strip)"
                @click.stop
                @pointerdown="beginDrag($event, strip, 'move')"
              >
                <!-- 左右各 6px 的手柄：.stop 阻止触发整块平移，转入 start/end 裁剪模式 -->
                <span class="handle left" title="拖这里调整范围起点" @pointerdown.stop="beginDrag($event, strip, 'start')"></span>
                <span class="block-name">{{ strip.name }}</span>
                <span class="block-meta mono">
                  权重 {{ Math.round(strip.weight * 100) }}% ·
                  {{ strip.start.toFixed(2) }}–{{ (strip.start + strip.duration).toFixed(2) }}s
                </span>
                <span class="handle right" title="拖这里调整范围终点" @pointerdown.stop="beginDrag($event, strip, 'end')"></span>
              </div>
            </div>
          </div>
        </div>

        <!-- 播放头：贯穿标尺与所有 lane 的竖线，left = LABEL_WIDTH + time * pxPerSec -->
        <div class="playhead" :style="{ left: `${LABEL_WIDTH + store.time * pxPerSec}px` }"></div>
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
  height: 208px;
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
  overflow: hidden;
}

.content {
  position: relative;
  min-height: 100%;
}

.ruler {
  position: relative;
  height: 18px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  cursor: pointer;
  user-select: none;
}

.ruler-pad {
  display: inline-block;
  height: 100%;
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
  top: 0;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

.lanes {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 0 6px;
}

.lane {
  position: relative;
  display: flex;
  align-items: stretch;
  height: 27px;
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  cursor: pointer;
}

.lane-label {
  flex: none;
  width: 56px;
  display: flex;
  align-items: center;
  padding-left: 6px;
  font-size: 10.5px;
  color: var(--text-dim);
  border-right: 1px solid var(--border);
  user-select: none;
}

.lane-track {
  position: relative;
  flex: none;
  height: 100%;
}

.lane-empty {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  pointer-events: none;
}

.block {
  position: absolute;
  top: 3px;
  height: 21px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--seg, #60a5fa);
  border-radius: 4px;
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
  flex: none;
  max-width: 34%;
  font-size: 10.5px;
  color: var(--seg, var(--text));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block-meta {
  color: var(--text-faint);
  font-size: 9.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
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
