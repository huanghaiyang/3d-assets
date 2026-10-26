<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { StagePlayer } from '@/viewer/stage/StagePlayer';
import { useStageStore } from '@/stores/stage';

const store = useStageStore();
const host = ref<HTMLDivElement | null>(null);
const speedOptions = [0.25, 0.5, 1, 1.5, 2];
const SPEED_MAX = 1000;

let player: StagePlayer | null = null;

function formatTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function onSeek(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  store.seek((value / SPEED_MAX) * store.duration);
}

onMounted(() => {
  if (!host.value) return;
  player = new StagePlayer(host.value);
  store.attachPlayer(player);
  player.setGizmoMode(store.gizmoMode);
});

onBeforeUnmount(() => {
  store.detachPlayer();
  player?.dispose();
  player = null;
});
</script>

<template>
  <div class="viewport">
    <div ref="host" class="canvas"></div>

    <div class="toolbar panel">
      <button
        class="btn btn-icon"
        :class="{ active: store.gizmoMode === 'translate' }"
        type="button"
        title="移动（X/Z）"
        @click="store.setGizmoMode('translate')"
      >
        <Icon name="pose" :size="14" />
      </button>
      <button
        class="btn btn-icon"
        :class="{ active: store.gizmoMode === 'rotate' }"
        type="button"
        title="旋转（Y）"
        @click="store.setGizmoMode('rotate')"
      >
        <Icon name="rotate" :size="14" />
      </button>
      <span class="divider"></span>
      <button
        class="btn btn-icon"
        :class="{ active: store.onionSkin }"
        type="button"
        title="洋葱皮（选中角色的前后帧残影）"
        @click="store.setOnionSkin(!store.onionSkin)"
      >
        <Icon name="layers" :size="14" />
      </button>
      <button
        class="btn btn-icon"
        :class="{ active: store.showPath }"
        type="button"
        title="路径曲线（选中角色的整条时间线轨迹）"
        @click="store.setShowPath(!store.showPath)"
      >
        <Icon name="flip" :size="14" />
      </button>
      <span class="divider"></span>
      <button class="btn btn-icon" type="button" title="重置视角" @click="player?.resetCamera()">
        <Icon name="refresh" :size="14" />
      </button>
    </div>

    <div class="playback panel">
      <button class="btn btn-icon" type="button" :title="store.playing ? '暂停' : '播放'" @click="store.togglePlay()">
        <Icon :name="store.playing ? 'pause' : 'play'" :size="15" />
      </button>
      <span class="time mono">{{ formatTime(store.time) }}</span>
      <input
        class="seek"
        type="range"
        min="0"
        :max="SPEED_MAX"
        :value="store.duration > 0 ? (store.time / store.duration) * SPEED_MAX : 0"
        @input="onSeek"
      />
      <span class="time mono faint">{{ formatTime(store.duration) }}</span>
      <button
        class="btn btn-icon"
        :class="{ active: store.doc?.loop }"
        type="button"
        title="循环播放"
        @click="store.setLoop(!store.doc?.loop)"
      >
        <Icon name="repeat" :size="14" />
      </button>
      <select class="select-input speed" :value="store.speed" @change="store.setSpeed(Number(($event.target as HTMLSelectElement).value))">
        <option v-for="value in speedOptions" :key="value" :value="value">{{ value }}×</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  height: 100%;
  min-width: 0;
  background: radial-gradient(circle at 50% 18%, #1c2333 0%, #121620 62%, #0d1017 100%);
  overflow: hidden;
}

.canvas {
  position: absolute;
  inset: 0;
}

.toolbar {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: rgba(31, 32, 38, 0.86);
  backdrop-filter: blur(6px);
}

.toolbar .btn.active {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-hover);
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}

.playback {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(640px, calc(100% - 32px));
  padding: 6px 10px;
  background: rgba(31, 32, 38, 0.9);
  backdrop-filter: blur(6px);
}

.time {
  font-size: 11px;
  min-width: 52px;
  text-align: center;
}

.seek {
  flex: 1;
  min-width: 60px;
  accent-color: var(--accent);
}

.speed {
  width: 72px;
  height: 28px;
  padding: 0 6px;
}

.playback .btn.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
  border-color: transparent;
}
</style>
