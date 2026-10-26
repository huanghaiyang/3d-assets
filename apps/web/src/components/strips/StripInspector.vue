<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStripsStore } from '@/stores/strips';
import { BODY_PARTS } from '@/viewer/strips/StripParts';
import type { BodyPart } from '@/viewer/strips/StripTypes';

const store = useStripsStore();
const strip = computed(() => store.selectedStrip);
const clipState = computed(() => (strip.value ? store.clipStates[strip.value.id] : undefined));

function onChange(event: Event, key: 'name' | 'start' | 'duration' | 'trimStart'): void {
  if (!strip.value) return;
  const input = event.target as HTMLInputElement;
  if (key === 'name') {
    store.updateStrip(strip.value.id, { name: input.value });
    return;
  }
  store.updateStrip(strip.value.id, { [key]: Number(input.value) || 0 });
}

function setPart(part: BodyPart): void {
  if (strip.value) store.updateStrip(strip.value.id, { part });
}

function setWeight(event: Event): void {
  if (!strip.value) return;
  store.updateStrip(strip.value.id, { weight: Number((event.target as HTMLInputElement).value) / 100 });
}

function toggleMute(): void {
  if (strip.value) store.updateStrip(strip.value.id, { muted: !strip.value.muted });
}

function duplicate(): void {
  if (strip.value) store.duplicateStrip(strip.value.id);
}

function remove(): void {
  if (strip.value) store.removeStrip(strip.value.id);
}

const clipText = computed(() => {
  const state = clipState.value;
  if (!state) return '等待加载';
  if (state.status === 'loading') return '载入来源片段…';
  if (state.status === 'error') return state.message ?? '加载失败';
  return state.duration ? `就绪 · ${state.duration.toFixed(2)}s` : '就绪';
});
</script>

<template>
  <div class="inspector panel">
    <div class="head">
      <span class="section-title"><Icon name="layers" :size="12" />Strip 检查器</span>
      <span v-if="strip" class="faint mono source">{{ store.sourceLabel(strip.source) }}</span>
    </div>

    <div v-if="!strip" class="empty">在时间轴上选中一个 Strip，这里可以调整身体部位、权重与范围</div>

    <template v-else>
      <label class="field">
        <span class="field-label">名称</span>
        <input class="text-input" :value="strip.name" @change="onChange($event, 'name')" />
      </label>

      <div class="field">
        <span class="field-label">身体部位</span>
        <div class="parts">
          <button
            v-for="part in BODY_PARTS"
            :key="part.id"
            class="part"
            :class="{ active: strip.part === part.id }"
            type="button"
            :title="part.hint"
            @click="setPart(part.id)"
          >
            {{ part.label }}
          </button>
        </div>
      </div>

      <div class="field">
        <span class="field-label">混合权重 <span class="mono weight">{{ Math.round(strip.weight * 100) }}%</span></span>
        <input class="range" type="range" min="0" max="100" :value="strip.weight * 100" @input="setWeight" />
      </div>

      <div class="grid2">
        <label class="field">
          <span class="field-label">起点（秒）</span>
          <input class="text-input mono" type="number" min="0" step="0.05" :value="strip.start.toFixed(2)" @change="onChange($event, 'start')" />
        </label>
        <label class="field">
          <span class="field-label">时长（秒）</span>
          <input class="text-input mono" type="number" min="0.2" step="0.05" :value="strip.duration.toFixed(2)" @change="onChange($event, 'duration')" />
        </label>
        <label class="field">
          <span class="field-label">裁剪起点（秒）</span>
          <input class="text-input mono" type="number" min="0" step="0.05" :value="strip.trimStart.toFixed(2)" @change="onChange($event, 'trimStart')" />
        </label>
        <div class="field">
          <span class="field-label">来源状态</span>
          <span class="state" :class="clipState?.status ?? 'idle'">{{ clipText }}</span>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-sm" type="button" @click="toggleMute">
          <Icon :name="strip.muted ? 'ban' : 'eye'" :size="12" />{{ strip.muted ? '取消静音' : '静音' }}
        </button>
        <button class="btn btn-sm" type="button" @click="duplicate">
          <Icon name="copy" :size="12" />复制
        </button>
        <button class="btn btn-sm danger" type="button" @click="remove">
          <Icon name="trash" :size="12" />删除
        </button>
      </div>
    </template>

    <div class="divider"></div>

    <div class="bake">
      <div class="bake-head">
        <span class="section-title"><Icon name="sparkle" :size="12" />烘焙</span>
        <button
          class="btn btn-sm btn-primary"
          type="button"
          :disabled="store.baking || store.strips.length === 0 || !store.baseFile"
          @click="store.bake()"
        >
          <Icon name="check" :size="12" />{{ store.baking ? '烘焙中' : '烘焙' }}
        </button>
      </div>

      <div v-if="store.baked" class="modes">
        <button class="mode" :class="{ active: !store.bakedMode }" type="button" @click="store.setBakedMode(false)">
          实时混合
        </button>
        <button class="mode" :class="{ active: store.bakedMode }" type="button" @click="store.setBakedMode(true)">
          烘焙预览
        </button>
      </div>

      <div v-if="store.baked" class="baked-info faint mono">
        {{ store.baked.data.clips[0]?.tracks.length ?? 0 }} 轨 ·
        {{ store.baked.data.timeline.totalDuration.toFixed(2) }}s · 30fps
      </div>

      <p class="note">烘焙会把当前时间轴上的叠加结果逐帧合成为一条新动画，并切换到烘焙预览。</p>

      <div class="save">
        <input v-model="store.saveName" class="text-input" placeholder="新动画名称" />
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!store.baked || store.saving"
          @click="store.saveBaked()"
        >
          <Icon name="download" :size="12" />{{ store.saving ? '保存中' : '保存为新建动画' }}
        </button>
      </div>
      <p class="note">保存后可在「动画」工作区的「新建动画」列表里找到它。</p>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.empty {
  padding: 14px 2px;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-label {
  font-size: 11.5px;
  color: var(--text-dim);
}

.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.weight {
  float: right;
  color: var(--text);
}

.parts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}

.part {
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 11.5px;
}

.part:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.part.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.range {
  width: 100%;
  accent-color: var(--accent);
}

.grid2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

.state {
  height: 26px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  font-size: 11.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state.ready {
  color: var(--success);
  border-color: rgba(52, 211, 153, 0.4);
}

.state.error {
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.4);
}

.actions {
  display: flex;
  gap: 6px;
}

.btn-sm {
  height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
}

.btn.danger {
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.35);
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 2px 0;
}

.bake {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bake-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modes {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
}

.mode {
  flex: 1;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
}

.mode:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.mode.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.baked-info {
  font-size: 11px;
}

.note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}

.save {
  display: flex;
  gap: 6px;
}

.save .text-input {
  flex: 1;
  min-width: 0;
}

.save .btn {
  flex: none;
  white-space: nowrap;
}
</style>
