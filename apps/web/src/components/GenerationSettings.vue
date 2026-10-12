<script setup lang="ts">
import { computed } from 'vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import ToggleSwitch from './ui/ToggleSwitch.vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { GenerateType, ModelVersion, ResultFormat } from '@/api/types';

const store = useWorkspaceStore();

const MIN = computed(() => store.settings?.limits.faceCount.min ?? 3000);
const MAX = computed(() => store.settings?.limits.faceCount.max ?? 1_500_000);

const GENERATE_TYPE_HINTS: Record<GenerateType, string> = {
  Normal: '带纹理的标准模型，适合渲染与展示',
  LowPoly: '智能拓扑后的低面数模型，适合游戏',
  Geometry: '不含纹理的白模，适合后续自行贴图',
  Sketch: '草图 / 线稿输入，可同时给提示词',
};

const RESULT_FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: 'default', label: '默认（OBJ + GLB，推荐）' },
  { value: 'GLB', label: '仅 GLB（单文件，便于网页预览）' },
  { value: 'OBJ', label: '仅 OBJ（zip 打包）' },
  { value: 'STL', label: '仅 STL（3D 打印）' },
  { value: 'FBX', label: '仅 FBX（DCC 软件）' },
  { value: 'USDZ', label: '仅 USDZ（AR 预览）' },
];

const modelOptions = computed(() => [
  { value: '3.0', label: '3.0', hint: '支持全部生成类型（含智能拓扑 / 草图）' },
  { value: '3.1', label: '3.1', hint: '几何质量更好，但不支持智能拓扑与草图' },
]);

const polygonOptions = [
  { value: 'triangle', label: '三角面', hint: '通用，兼容性最好' },
  { value: 'quadrilateral', label: '四边形混合', hint: '面片更规整，便于后续编辑' },
];

const facePresets = [10_000, 100_000, 300_000, 800_000];

/** 面数跨度很大，滑块按对数映射 */
const faceSlider = computed({
  get: () => {
    const ratio = store.params.faceCount / MIN.value;
    return Math.round((100 * Math.log(ratio)) / Math.log(MAX.value / MIN.value));
  },
  set: (value: number) => {
    const next = Math.round(MIN.value * Math.pow(MAX.value / MIN.value, value / 100));
    store.setParams({ faceCount: clampFaces(next) });
  },
});

function clampFaces(value: number): number {
  return Math.min(MAX.value, Math.max(MIN.value, value));
}

function formatFaces(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString('en-US');
}

function onFaceInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(raw)) return;
  store.setParams({ faceCount: clampFaces(Math.round(raw)) });
}

function setModel(value: string): void {
  store.setModel(value as ModelVersion);
}

function setGenerateType(value: GenerateType): void {
  store.setGenerateType(value);
}

function setPolygonType(value: string): void {
  store.setPolygonType(value as 'triangle' | 'quadrilateral');
}

function onFormatChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  store.setResultFormat(value === 'default' ? null : (value as ResultFormat));
}

const isLowPoly = computed(() => store.params.generateType === 'LowPoly');
const isGeometry = computed(() => store.params.generateType === 'Geometry');
</script>

<template>
  <div class="settings">
    <section class="block">
      <div class="row">
        <span class="field-label" style="margin: 0">模型版本</span>
        <span class="hint">3.1 更精细</span>
      </div>
      <SegmentedControl
        :model-value="store.params.model"
        :options="modelOptions"
        size="sm"
        @update:model-value="setModel"
      />
    </section>

    <section class="block">
      <span class="field-label">生成类型</span>
      <div class="type-grid">
        <button
          v-for="type in ['Normal', 'LowPoly', 'Geometry', 'Sketch'] as GenerateType[]"
          :key="type"
          type="button"
          class="type-card"
          :class="{
            active: store.params.generateType === type,
            disabled: store.params.model === '3.1' && (type === 'LowPoly' || type === 'Sketch'),
          }"
          :disabled="store.params.model === '3.1' && (type === 'LowPoly' || type === 'Sketch')"
          :title="GENERATE_TYPE_HINTS[type]"
          @click="setGenerateType(type)"
        >
          <span class="type-name">{{ type }}</span>
          <span class="type-hint">{{ GENERATE_TYPE_HINTS[type] }}</span>
        </button>
      </div>
    </section>

    <section class="block">
      <div class="row">
        <span class="field-label" style="margin: 0">面数</span>
        <span class="mono" :class="{ faint: isLowPoly }">{{ isLowPoly ? '智能拓扑自动决定' : store.params.faceCount.toLocaleString('en-US') }}</span>
      </div>
      <input
        v-model.number="faceSlider"
        class="slider"
        type="range"
        min="0"
        max="100"
        step="1"
        :disabled="isLowPoly"
        aria-label="生成面数"
      />
      <div class="preset-row">
        <button
          v-for="preset in facePresets"
          :key="preset"
          type="button"
          class="preset"
          :class="{ active: store.params.faceCount === preset }"
          :disabled="isLowPoly"
          @click="store.setParams({ faceCount: preset })"
        >
          {{ formatFaces(preset) }}
        </button>
        <input
          class="text-input face-input mono"
          type="number"
          :min="MIN"
          :max="MAX"
          :value="store.params.faceCount"
          :disabled="isLowPoly"
          aria-label="面数数值"
          @change="onFaceInput"
        />
      </div>
    </section>

    <section class="block">
      <ToggleSwitch
        :model-value="store.params.enablePbr"
        label="PBR 材质"
        :hint="isGeometry ? '白模模式下不适用' : '生成金属度 / 粗糙度贴图'"
        :disabled="isGeometry"
        @update:model-value="(value: boolean) => store.setParams({ enablePbr: value })"
      />
    </section>

    <section v-if="isLowPoly" class="block">
      <span class="field-label">多边形类型</span>
      <SegmentedControl
        :model-value="store.params.polygonType"
        :options="polygonOptions"
        size="sm"
        @update:model-value="setPolygonType"
      />
    </section>

    <section class="block">
      <span class="field-label">输出格式</span>
      <select class="select-input" :value="store.params.resultFormat ?? 'default'" @change="onFormatChange">
        <option v-for="option in RESULT_FORMAT_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <p v-if="store.params.resultFormat && store.params.resultFormat !== 'GLB' && store.params.resultFormat !== 'OBJ'" class="tip">
        该格式在浏览器中无法直接预览，生成后仍可下载（缩略图由接口返回）。
      </p>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.hint {
  font-size: 11px;
  color: var(--text-faint);
}

.type-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.type-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 8px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.type-card:hover:not(.disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.type-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.type-card.disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.type-name {
  font-size: 12px;
  font-weight: 600;
}

.type-hint {
  font-size: 10px;
  color: var(--text-faint);
  line-height: 1.35;
}

.slider {
  width: 100%;
  height: 4px;
  appearance: none;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #4b3fb0);
  outline: none;
}

.slider:disabled {
  background: var(--border);
  opacity: 0.6;
}

.slider::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent);
  cursor: pointer;
}

.preset-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.preset {
  flex: 1;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-dim);
  font-size: 11px;
}

.preset:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.preset.active {
  border-color: var(--accent);
  color: var(--accent-hover);
  background: var(--accent-soft);
}

.preset:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.face-input {
  width: 86px;
  flex: none;
  height: 24px;
  padding: 0 6px;
  text-align: right;
}

.tip {
  margin: 0;
  font-size: 11px;
  color: var(--warn);
}
</style>
