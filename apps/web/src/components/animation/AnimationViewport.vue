<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { FbxPlayer } from '@/viewer/FbxPlayer';
import { useAnimationStore } from '@/stores/animation';
import { formatBytes } from '@/utils/image';

const store = useAnimationStore();
const hostRef = ref<HTMLDivElement | null>(null);
let player: FbxPlayer | null = null;

onMounted(() => {
  if (!hostRef.value) return;
  player = new FbxPlayer(hostRef.value);
  store.attachPlayer(player);
  // 自动加载已记录的文件夹（reload 内部会选中并预览第一个动画）
  void (async () => {
    await store.loadInfo();
    await store.reload();
  })();
});

onBeforeUnmount(() => {
  store.detachPlayer();
  player = null;
  store.dispose();
});

const progress = computed(() => (store.duration > 0 ? (store.currentTime / store.duration) * 100 : 0));

function onSeek(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  store.seek(Math.min(1, Math.max(0, value / 1000)));
}

function formatTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/** 已选骨骼的名字，用于标题下方提示 */
const selectedBoneLabels = computed(() => {
  const byId = new Map(store.boneList.map((bone) => [bone.id, bone.label]));
  return store.selectedBones.map((id) => byId.get(id) ?? id);
});

const selectedBoneText = computed(() => {
  const labels = selectedBoneLabels.value;
  if (labels.length === 0) return '';
  if (labels.length <= 3) return labels.join('、');
  return `${labels.slice(0, 3).join('、')} 等 ${labels.length} 根`;
});

/**
 * 在模型上点选骨骼。
 * 只有"没拖动过"的左键单击才算点选，避免旋转视角时误选。
 */
let downAt: { x: number; y: number } | null = null;

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  downAt = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent): void {
  const start = downAt;
  downAt = null;
  if (!start || event.button !== 0) return;
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
  if (!store.selectedPath) return;
  const id = store.pickBoneAt(event.clientX, event.clientY, event.ctrlKey || event.metaKey || event.shiftKey);
  if (!id && !(event.ctrlKey || event.metaKey || event.shiftKey)) store.clearBoneSelection();
}

function onCanvasLeave(): void {
  store.setHoveredBone(null);
}
</script>

<template>
  <section class="anim-viewport">
    <div
      ref="hostRef"
      class="canvas-host"
      :class="{ picking: store.showSkeleton }"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointerleave="onCanvasLeave"
    />

    <!-- 顶部标题 -->
    <div class="overlay overlay-title">
      <span class="now-playing">
        {{ store.selectedFile?.relative ?? '未选择动画' }}
      </span>
      <span v-if="store.selectedStats" class="chip">
        {{ store.selectedStats.bones }} 骨骼 · {{ store.selectedStats.triangles.toLocaleString('en-US') }} 三角面
      </span>
      <span v-if="store.selectedFile" class="chip">{{ formatBytes(store.selectedFile.size) }}</span>
    </div>

    <!-- 已选骨骼 -->
    <div v-if="selectedBoneText" class="overlay overlay-bones">
      <Icon name="bone" :size="12" />
      <span class="bone-text">{{ selectedBoneText }}</span>
      <button class="bone-clear" type="button" title="清除骨骼选择" @click="store.clearBoneSelection()">
        <Icon name="close" :size="11" />
      </button>
    </div>

    <!-- 右上工具 -->
    <div class="overlay overlay-tools">
      <button
        class="tool"
        :class="{ active: store.showSkeleton }"
        type="button"
        :disabled="store.boneList.length === 0"
        title="显示骨骼（可在模型上直接点选骨骼）"
        @click="store.setSkeletonVisible(!store.showSkeleton)"
      >
        <Icon name="bone" :size="15" />
      </button>
      <button
        class="tool"
        :class="{ active: store.mirror }"
        type="button"
        title="左右镜像"
        @click="store.setMirror(!store.mirror)"
      >
        <Icon name="flip" :size="15" />
      </button>
      <button
        class="tool"
        :class="{ active: store.inPlace }"
        type="button"
        title="原地播放（去掉根骨骼水平位移）"
        @click="store.setInPlace(!store.inPlace)"
      >
        <Icon name="repeat" :size="15" />
      </button>
      <button
        class="tool"
        :class="{ active: store.showGrid }"
        type="button"
        title="显示网格地面"
        @click="store.setGridView(!store.showGrid)"
      >
        <Icon name="layers" :size="15" />
      </button>
      <button class="tool" type="button" title="重置视角" @click="store.resetView()">
        <Icon name="refresh" :size="15" />
      </button>
    </div>

    <!-- 加载 / 错误 -->
    <div v-if="store.viewLoading" class="overlay overlay-state">
      <Icon name="refresh" :size="26" class="spin" />
      <p>正在解析 FBX…</p>
    </div>
    <div v-else-if="store.viewError" class="overlay overlay-state error">
      <Icon name="alert" :size="22" />
      <p>{{ store.viewError }}</p>
    </div>
    <div v-else-if="!store.selectedPath" class="overlay overlay-state">
      <Icon name="film" :size="34" />
      <p class="empty-title">从左侧选择一个动画开始预览</p>
      <p class="empty-hint">文件夹内容只读，不会被修改或锁定</p>
    </div>

    <!-- 底部播放控制 -->
    <div class="overlay overlay-controls">
      <div class="timeline">
        <span class="mono time">{{ formatTime(store.currentTime) }}</span>
        <input
          class="scrubber"
          type="range"
          min="0"
          max="1000"
          :value="Math.round(progress * 10)"
          :disabled="!store.selectedPath || store.duration <= 0"
          aria-label="播放进度"
          @input="onSeek"
        />
        <span class="mono time">{{ formatTime(store.duration) }}</span>
      </div>
      <div class="buttons">
        <button class="btn btn-icon" type="button" :disabled="!store.selectedPath" title="播放/暂停" @click="store.togglePlay()">
          <Icon :name="store.playing ? 'pause' : 'play'" :size="15" />
        </button>
        <div class="speeds">
          <button
            v-for="value in SPEEDS"
            :key="value"
            class="speed"
            :class="{ active: store.speed === value }"
            type="button"
            @click="store.setSpeed(value)"
          >
            {{ value }}×
          </button>
        </div>
        <span v-if="store.selectedClips.length > 1" class="chip chip-info">
          {{ store.selectedClips.length }} 个片段
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.anim-viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  background: radial-gradient(circle at 50% 36%, #2b2f38 0%, #1b1d23 50%, #131418 100%);
  overflow: hidden;
}

.canvas-host {
  position: absolute;
  inset: 0;
}

/* 显示骨骼时给出"可点选"的光标提示 */
.canvas-host.picking {
  cursor: crosshair;
}

.overlay {
  position: absolute;
  z-index: 2;
}

.overlay-title {
  top: 14px;
  left: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 90px);
}

.overlay-bones {
  top: 44px;
  left: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 90px);
  padding: 4px 6px 4px 9px;
  border-radius: 999px;
  background: rgba(251, 191, 36, 0.14);
  border: 1px solid rgba(251, 191, 36, 0.4);
  color: #fcd34d;
  font-size: 11.5px;
}

.bone-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bone-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.75;
}

.bone-clear:hover {
  background: rgba(251, 191, 36, 0.25);
  opacity: 1;
}

.tool:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.now-playing {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overlay-tools {
  top: 14px;
  right: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(8px);
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
}

.tool:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tool.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.overlay-state {
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-faint);
  pointer-events: none;
}

.overlay-state.error {
  color: var(--danger);
}

.empty-title {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--text-dim);
}

.empty-hint {
  margin: 0;
  font-size: 11.5px;
}

.overlay-controls {
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: min(620px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(10px);
}

.timeline {
  display: flex;
  align-items: center;
  gap: 10px;
}

.time {
  color: var(--text-dim);
  flex: none;
  width: 46px;
  text-align: center;
}

.scrubber {
  flex: 1;
  min-width: 0;
  height: 4px;
  appearance: none;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #4b3fb0);
  outline: none;
}

.scrubber:disabled {
  background: var(--border);
  opacity: 0.6;
}

.scrubber::-webkit-slider-thumb {
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent);
  cursor: pointer;
}

.buttons {
  display: flex;
  align-items: center;
  gap: 10px;
}

.speeds {
  display: flex;
  gap: 3px;
}

.speed {
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-dim);
  font-size: 11px;
}

.speed:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.speed.active {
  border-color: var(--accent);
  color: var(--accent-hover);
  background: var(--accent-soft);
}
</style>
