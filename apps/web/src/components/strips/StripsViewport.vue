<script setup lang="ts">
/**
 * StripsViewport —— 拼接工作区中栏的 Three.js 容器与视口控件。
 *
 * 职责：把一个 DOM 容器交给 StripsPlayer 挂载 WebGL 场景，并负责其生命周期；
 * 同时提供视口内浮层按钮栏与播放控制条。所有状态都存在 Pinia store 里，
 * 本组件只做「调用 store 方法 / 读取 store 状态」，不做本地业务状态。
 *
 * 与 store 的配合：挂载时 new StripsPlayer(host) 并 store.attachPlayer(player)，
 * 由 store 在后续把基础模型、strips、高亮、显示开关等推给 player；
 * 卸载时 store.detachPlayer() + player.dispose() 释放 GPU 资源。
 *
 * 关键交互：实时混合/烘焙结果切换、仅显示已添加部位、显示骨骼、重置视角、播放/循环/倍速。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { StripsPlayer } from '@/viewer/strips/StripsPlayer';
import { useStripsStore } from '@/stores/strips';

const store = useStripsStore();
/** Three.js 场景的挂载点（player 会把 renderer.domElement 塞进这里） */
const host = ref<HTMLDivElement | null>(null);
/** 倍速下拉可选项 */
const speedOptions = [0.25, 0.5, 1, 1.5, 2];
/**
 * 进度条（range input）的定点刻度上限。
 * HTML range 只能用整数 + max 表达比例，因此把 0~duration 映射到 0~SPEED_MAX，
 * 换算时再还原成秒（见 onSeek / :value）。
 */
const SPEED_MAX = 1000;

let player: StripsPlayer | null = null;

/** 秒 → `分:秒.两位小数`（例如 62.5 → "1:02.50"）；负数按 0 处理 */
function formatTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * 拖动进度条：把 0~SPEED_MAX 的整数还原成秒后交给 store.seek()。
 * store.duration 为 0（尚无内容）时对应进度条 value 恒为 0，不会触发异常。
 */
function onSeek(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  store.seek((value / SPEED_MAX) * store.duration);
}

/**
 * 挂载：创建播放器并交给 store 托管。
 * 此处只新建实例；基础模型/strips 的实际恢复由 store.attachPlayer() 内部完成，
 * 因此本组件无需关心「重新进入页面时恢复现场」的细节。
 */
onMounted(() => {
  if (!host.value) return;
  player = new StripsPlayer(host.value);
  store.attachPlayer(player);
});

/**
 * 卸载：先让 store 断开引用（之后的 store 调用不再打到已销毁的 player），
 * 再 dispose 释放 WebGL 资源，避免反复进出工作区时泄漏上下文。
 */
onBeforeUnmount(() => {
  store.detachPlayer();
  player?.dispose();
  player = null;
});
</script>

<template>
  <div class="viewport">
    <!-- Three.js 画布挂载点，绝对定位铺满整个视口 -->
    <div ref="host" class="canvas"></div>

    <!-- 左上角模式徽标：区分「实时混合」与「烘焙结果」两种预览 -->
    <div class="badge panel" :class="{ baked: store.bakedMode }">
      <Icon :name="store.bakedMode ? 'check' : 'layers'" :size="12" />
      {{ store.bakedMode ? '烘焙预览' : '实时混合' }}
    </div>

    <!-- 右上角按钮栏：前两个是混合/烘焙模式，中间是显示开关，最后是重置视角 -->
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
      <!-- v2：仅显示已添加部位（未分配部位半透明），与检查器/时间轴的部位概念一致 -->
      <button
        class="btn btn-icon"
        :class="{ active: store.showOnlyAdded }"
        type="button"
        :title="store.showOnlyAdded ? '显示全部部位' : '仅显示已添加部位'"
        @click="store.toggleShowOnlyAdded()"
      >
        <Icon :name="store.showOnlyAdded ? 'eye' : 'eyeOff'" :size="14" />
      </button>
      <!-- v2：骨骼叠加层开关，便于核对源动画驱动的骨骼 -->
      <button
        class="btn btn-icon"
        :class="{ active: store.showBones }"
        type="button"
        :title="store.showBones ? '隐藏骨骼' : '显示骨骼'"
        @click="store.toggleBones()"
      >
        <Icon name="bone" :size="14" />
      </button>
      <span class="divider"></span>
      <!-- 重置视角只影响相机，不改动任何编排数据 -->
      <button class="btn btn-icon" type="button" title="重置视角" @click="player?.resetCamera()">
        <Icon name="refresh" :size="14" />
      </button>
    </div>

    <!-- 尚无基础模型时的居中提示；目录加载中与已加载完文案不同 -->
    <div v-if="!store.baseFile" class="notice panel">
      {{ store.catalogLoading ? '正在加载动画库…' : '请在左侧选择基础模型' }}
    </div>

    <!-- 底部播放条：当前时间 / 进度条 / 总时长 / 循环 / 倍速；时间与总时长均来自 store -->
    <div class="playback panel">
      <button class="btn btn-icon" type="button" :title="store.playing ? '暂停' : '播放'" @click="store.togglePlay()">
        <Icon :name="store.playing ? 'pause' : 'play'" :size="15" />
      </button>
      <span class="time mono">{{ formatTime(store.time) }}</span>
      <!-- 比例换算：time/duration → 0~SPEED_MAX；duration 为 0 时兜底为 0 -->
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
      <!-- 倍速：select 的值是字符串，需显式 Number() 转换再进 store -->
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
