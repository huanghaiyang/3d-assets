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
</script>

<template>
  <section class="anim-viewport">
    <div ref="hostRef" class="canvas-host" />

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

    <!-- 右上工具 -->
    <div class="overlay overlay-tools">
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
