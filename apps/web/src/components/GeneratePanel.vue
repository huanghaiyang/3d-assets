<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './ui/Icon.vue';
import ImageDropzone from './ImageDropzone.vue';
import MultiViewInput from './MultiViewInput.vue';
import GenerationSettings from './GenerationSettings.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { InputMode, ViewType } from '@/api/types';
import type { PreparedImage } from '@/utils/image';

const store = useWorkspaceStore();
const showSettings = ref(true);

const modeOptions = [
  { value: 'text', label: '文生3D' },
  { value: 'image', label: '图生3D' },
  { value: 'multiview', label: '多视角' },
];

const promptMax = computed(() => store.settings?.limits.promptMaxChars ?? 1024);
const promptOver = computed(() => store.prompt.length > promptMax.value);

const viewTypes = computed<ViewType[]>(() => store.settings?.enums.viewTypes ?? ['left', 'right', 'back']);
const version31Only = computed<ViewType[]>(() => store.settings?.enums.viewTypes31Only ?? []);

const canSubmit = computed(() => store.canSubmit && !promptOver.value);

const EXAMPLES = [
  '一只低多边形的白色陶瓷小猫摆件',
  '科幻风格的机械头盔，金属质感',
  '卡通风格的小房子，红瓦屋顶',
  '写实风格的运动鞋，细节丰富',
];

function onImageError(message: string): void {
  store.toast('error', message);
}

function onViewsUpdate(value: Partial<Record<ViewType, PreparedImage>>): void {
  const current = store.views;
  for (const key of Object.keys(current) as ViewType[]) {
    if (!value[key]) store.setView(key, null);
  }
  for (const key of Object.keys(value) as ViewType[]) {
    store.setView(key, value[key] ?? null);
  }
}

function useExample(example: string): void {
  store.setMode('text');
  store.prompt = example;
}
</script>

<template>
  <aside class="generate-panel">
    <header class="panel-head">
      <div class="title">
        <Icon name="sparkle" :size="15" />
        <span>生成模型</span>
      </div>
      <span v-if="store.queue.active > 0" class="chip chip-info">
        <Icon name="clock" :size="11" class="spin" />
        {{ store.queue.active }} 个进行中
      </span>
    </header>

    <div class="panel-body">
      <SegmentedControl :model-value="store.mode" :options="modeOptions" @update:model-value="(v: string) => store.setMode(v as InputMode)" />

      <!-- 输入区 -->
      <section class="block">
        <template v-if="store.mode === 'text'">
          <div class="row">
            <span class="field-label" style="margin: 0">描述文字</span>
            <span class="mono" :class="promptOver ? 'danger-text' : 'faint'">{{ store.prompt.length }}/{{ promptMax }}</span>
          </div>
          <textarea
            v-model="store.prompt"
            class="textarea-input"
            rows="5"
            placeholder="例如：一只低多边形的白色陶瓷小猫摆件，坐姿，表面光滑"
          />
          <div class="examples">
            <button v-for="example in EXAMPLES" :key="example" type="button" class="example" @click="useExample(example)">
              {{ example }}
            </button>
          </div>
        </template>

        <template v-else-if="store.mode === 'image'">
          <span class="field-label">参考图</span>
          <ImageDropzone
            :model-value="store.image"
            @update:model-value="store.setImage"
            @error="onImageError"
          />
          <template v-if="store.params.generateType === 'Sketch'">
            <div class="row" style="margin-top: 2px">
              <span class="field-label" style="margin: 0">补充描述（Sketch 模式可与图片同时使用）</span>
              <span class="mono faint">{{ store.prompt.length }}/{{ promptMax }}</span>
            </div>
            <input v-model="store.prompt" class="text-input" placeholder="例如：做成卡通风格，表面光滑" />
          </template>
          <p v-else class="mode-tip">
            当前为 {{ store.params.generateType }} 模式，仅使用参考图；若要图文同时输入，请把「生成类型」切换为 Sketch。
          </p>
        </template>

        <template v-else>
          <MultiViewInput
            :model-value="store.views"
            :view-types="viewTypes"
            :version-31-only="version31Only"
            :model="store.params.model"
            @update:model-value="onViewsUpdate"
            @error="onImageError"
          />
        </template>
      </section>

      <!-- 生成设置 -->
      <section class="block">
        <button class="collapse" type="button" @click="showSettings = !showSettings">
          <span class="section-title">
            <Icon name="settings" :size="13" />
            生成设置
          </span>
          <Icon name="chevron" :size="14" :class="{ rotated: showSettings }" />
        </button>
        <div v-if="showSettings" class="settings-wrap">
          <GenerationSettings />
        </div>
        <p v-else class="summary">
          {{ store.params.model }} · {{ store.params.generateType }} ·
          {{ store.params.generateType === 'LowPoly' ? store.params.polygonType : store.params.faceCount.toLocaleString('en-US') + ' 面' }}
          <template v-if="store.params.enablePbr"> · PBR</template>
        </p>
      </section>
    </div>

    <footer class="panel-foot">
      <p v-if="!store.settings?.apiKeyConfigured" class="warn-line">
        <Icon name="alert" :size="12" />
        尚未配置 API Key，点击右上角「设置」填写
      </p>
      <button class="generate-btn" type="button" :disabled="!canSubmit" @click="store.submit()">
        <Icon :name="store.submitting ? 'refresh' : 'sparkle'" :size="15" :class="{ spin: store.submitting }" />
        {{ store.submitting ? '提交中…' : '立即生成' }}
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.generate-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
  font-size: 13px;
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
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

.danger-text {
  color: var(--danger);
}

.examples {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.example {
  text-align: left;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-faint);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.example:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.collapse {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
}

.rotated {
  transform: rotate(180deg);
}

.settings-wrap {
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.summary {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}

.mode-tip {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}

.panel-foot {
  padding: 12px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.warn-line {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  font-size: 11px;
  color: var(--warn);
}

.generate-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 40px;
  border: none;
  border-radius: var(--radius);
  background: linear-gradient(135deg, var(--accent), #5b3fd6);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  transition: filter 0.15s ease, opacity 0.15s ease;
}

.generate-btn:hover:not(:disabled) {
  filter: brightness(1.12);
}

.generate-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
</style>
