<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { StripsPlayer } from '@/viewer/strips/StripsPlayer';
import { useStripsStore } from '@/stores/strips';

const store = useStripsStore();
const host = ref<HTMLDivElement | null>(null);
const speedOptions = [0.25, 0.5, 1, 1.5, 2];
const SPEED_MAX = 1000;

let player: StripsPlayer | null = null;

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
  player = new StripsPlayer(host.value);
  store.attachPlayer(player);
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

    <div class="badge panel" :class="{ baked: store.bakedMode }">
      <Icon :name="store.bakedMode ? 'check' : 'layers'" :size="12" />
      {{ store.bakedMode ? '烘焙预览' : '实时混合' }}
    </div>

    <div class="toolbar panel">
      <button
        class="btn btn-icon"
        :class="{ active: !store.bakedMode }"
        type="button"
        title="实时混合预览"
        :disabled="!store.baked"
        @click="store.setBakedMode(false)"
      >
        <Icon name="layers" :size="14" />
      </button>
      <button
        class="btn btn-icon"
        :class="{ active: store.bakedMode }"
        type="button"
        title="烘焙结果预览"
        :disabled="!store.baked"
        @click="store.setBakedMode(true)"
      >
        <Icon name="check" :size="14" />
      </button>
      <span class="divider"></span>
      <button class="btn btn-icon" type="button" title="重置视角" @click="player?.resetCamera()">
        <Icon name="refresh" :size="14" />
      </button>
    </div>

    <div v-if="!store.baseFile" class="notice panel">
      {{ store.catalogLoading ? '正在加载动画库…' : '请在左侧选择基础模型' }}
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
        :class="{ active: store.loop }"
        type="button"
        title="循环播放"
        @click="store.toggleLoop()"
      >
        <Icon name="repeat" :size="14" />
      </button>
      <select
        class="select-input speed"
        :value="store.speed"
        @change="store.setSpeed(Number(($event.target as HTMLSelectElement).value))"
      >
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

.badge {
  position: absolute;
  left: 12px;
  top: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: rgba(31, 32, 38, 0.86);
  backdrop-filter: blur(6px);
}

.badge.baked {
  color: var(--success);
  border-color: rgba(52, 211, 153, 0.4);
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

.notice {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 10px 18px;
  font-size: 12.5px;
  color: var(--text-dim);
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
