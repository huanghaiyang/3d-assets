<script setup lang="ts">
import { computed } from 'vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import ToggleSwitch from './ui/ToggleSwitch.vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { GenerateType, ProviderId, ResultFormat } from '@/api/types';

const store = useWorkspaceStore();

/** 引擎自己的能力（决定表单显示哪些参数） */
const caps = computed(() => store.providerCapabilities);
const active = computed(() => store.activeProviderInfo);

const MIN = computed(() =>
  Math.max(store.settings?.limits.faceCount.min ?? 3_000, caps.value.faceCountRange?.min ?? 0),
);
const MAX = computed(() =>
  Math.min(
    store.settings?.limits.faceCount.max ?? 1_500_000,
    caps.value.faceCountRange?.max ?? Number.POSITIVE_INFINITY,
  ),
);

// ===== 生成引擎 =====
const providerOptions = computed(() =>
  store.providers.map((provider) => ({
    value: provider.id,
    label: provider.label,
    hint: provider.apiKeyConfigured ? provider.vendor : `${provider.vendor} · 未配置 Key`,
  })),
);

function setProvider(value: string): void {
  void store.setProvider(value as ProviderId);
}

// ===== 模型版本（由引擎提供） =====
const modelOptions = computed(() =>
  store.providerModels.map((model) => ({
    value: model.value,
    label: model.label || '默认',
    hint: model.hint ?? '',
  })),
);

function setModel(value: string): void {
  store.setModel(value);
}

// ===== 生成类型 =====
const GENERATE_TYPE_HINTS: Record<GenerateType, string> = {
  Normal: '带纹理的标准模型，适合渲染与展示',
  LowPoly: '智能拓扑后的低面数模型，适合游戏',
  Geometry: '不含纹理的白模，适合后续自行贴图',
  Sketch: '草图 / 线稿输入，可同时给提示词',
};

const generateTypes = computed<GenerateType[]>(() => caps.value.generateTypes);

/** 混元 3.1 不支持智能拓扑 / 草图 */
function typeDisabled(type: GenerateType): boolean {
  return active.value?.id === 'hunyuan3d' && store.params.model === '3.1' && (type === 'LowPoly' || type === 'Sketch');
}

function setGenerateType(type: GenerateType): void {
  store.setGenerateType(type);
}

// ===== 面数 =====
const faceSlider = computed({
  get: () => {
    const min = MIN.value;
    const max = MAX.value;
    if (max <= min) return 0;
    const ratio = store.params.faceCount / min;
    return Math.round((100 * Math.log(ratio)) / Math.log(max / min));
  },
  set: (value: number) => {
    const min = MIN.value;
    const max = MAX.value;
    const next = Math.round(min * Math.pow(max / min, value / 100));
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

const facePresets = computed(() => {
  const candidates = [3_000, 10_000, 30_000, 100_000, 300_000, 800_000, 1_000_000];
  const list = candidates.filter((value) => value >= MIN.value && value <= MAX.value);
  return (list.length > 0 ? list : [MIN.value]).slice(0, 4);
});

function onFaceInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(raw)) return;
  store.setParams({ faceCount: clampFaces(Math.round(raw)) });
}

// ===== 多边形类型 =====
const polygonOptions = [
  { value: 'triangle', label: '三角面', hint: '通用，兼容性最好' },
  { value: 'quadrilateral', label: '四边形混合', hint: '面片更规整，便于后续编辑' },
];

function setPolygonType(value: string): void {
  store.setPolygonType(value as 'triangle' | 'quadrilateral');
}

// ===== 输出格式 =====
const FORMAT_LABELS: Record<string, string> = {
  GLB: '仅 GLB（单文件，便于网页预览）',
  OBJ: '仅 OBJ（zip 打包）',
  STL: '仅 STL（3D 打印）',
  FBX: '仅 FBX（DCC 软件）',
  USDZ: '仅 USDZ（AR 预览）',
};

const formatOptions = computed(() => [
  { value: 'default', label: '默认（引擎推荐格式）' },
  ...caps.value.formats.map((format) => ({ value: format, label: FORMAT_LABELS[format] ?? format })),
]);

function onFormatChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  store.setResultFormat(value === 'default' ? null : (value as ResultFormat));
}

const isLowPoly = computed(() => store.params.generateType === 'LowPoly');
const isGeometry = computed(() => store.params.generateType === 'Geometry');
const supportsLowPoly = computed(() => caps.value.generateTypes.includes('LowPoly'));
</script>

<template>
  <div class="settings">
    <section class="block">
      <div class="row">
        <span class="field-label" style="margin: 0">生成引擎</span>
        <span class="hint">{{ active?.vendor ?? '' }}</span>
      </div>
      <SegmentedControl
        :model-value="store.params.provider"
        :options="providerOptions"
        size="sm"
        @update:model-value="setProvider"
      />
      <p v-if="active && !active.apiKeyConfigured" class="tip warn">
        尚未配置 {{ active.label }} 的 API Key，可在右上角「设置」中填写。
      </p>
    </section>

    <section class="block">
      <div class="row">
        <span class="field-label" style="margin: 0">模型版本</span>
        <span class="hint">{{ modelOptions.length > 1 ? '按引擎提供' : '引擎默认' }}</span>
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
          v-for="type in generateTypes"
          :key="type"
          type="button"
          class="type-card"
          :class="{
            active: store.params.generateType === type,
            disabled: typeDisabled(type),
          }"
          :disabled="typeDisabled(type)"
          :title="GENERATE_TYPE_HINTS[type]"
          @click="setGenerateType(type)"
        >
          <span class="type-name">{{ type }}</span>
          <span class="type-hint">{{ GENERATE_TYPE_HINTS[type] }}</span>
        </button>
      </div>
    </section>

    <section v-if="caps.faceCount" class="block">
      <div class="row">
        <span class="field-label" style="margin: 0">面数</span>
        <span class="mono" :class="{ faint: isLowPoly }">
          {{ isLowPoly ? '智能拓扑自动决定' : store.params.faceCount.toLocaleString('en-US') }}
        </span>
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
      <p class="hint">当前引擎面数范围：{{ MIN.toLocaleString('en-US') }} ~ {{ MAX.toLocaleString('en-US') }}</p>
    </section>

    <section v-if="caps.pbr" class="block">
      <ToggleSwitch
        :model-value="store.params.enablePbr"
        label="PBR 材质"
        :hint="isGeometry ? '白模模式下不适用' : '生成金属度 / 粗糙度贴图'"
        :disabled="isGeometry"
        @update:model-value="(value: boolean) => store.setParams({ enablePbr: value })"
      />
    </section>

    <section v-if="supportsLowPoly && isLowPoly" class="block">
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
        <option v-for="option in formatOptions" :key="option.value" :value="option.value">
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

.tip {
  margin: 0;
  font-size: 11px;
  color: var(--warn);
  line-height: 1.5;
}

.tip.warn {
  color: var(--warn);
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
</style>
