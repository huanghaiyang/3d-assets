<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStageStore } from '@/stores/stage';
import { animationApi } from '@/api/animation';
import type { ActorKind } from '@/viewer/stage/StageTypes';

const store = useStageStore();

/** 模型选择器：用封面网格代替原生下拉，避免盲选 */
const modelPickerOpen = ref(false);
const modelKeyword = ref('');
const modelOptions = computed(() => {
  const query = modelKeyword.value.trim().toLowerCase();
  const list = query
    ? store.files.filter((file) => file.relative.toLowerCase().includes(query))
    : store.files;
  return list.slice(0, 120);
});

function modelCover(path: string): string {
  return animationApi.animationCoverUrl(path, 192, 0.35);
}

function chooseModel(path: string): void {
  const actor = store.selectedActor;
  if (!actor) return;
  modelPickerOpen.value = false;
  if (actor.modelPath === path) return;
  store.updateActorModel(actor.id, path);
}

const actorLocked = computed(() =>
  store.selectedActorId ? store.isActorLocked(store.selectedActorId) : false,
);

const yawDegrees = computed(() => {
  const yaw = store.selectedActor?.transform.yaw ?? 0;
  return ((yaw * 180) / Math.PI).toFixed(1);
});

function actorModelName(path: string | undefined): string {
  if (!path) return '未选择模型';
  return store.files.find((file) => file.path === path)?.name ?? path.split(/[\\/]/).pop() ?? path;
}

function add(kind: ActorKind): void {
  store.addActor(kind);
}

function setTransform(axis: 'x' | 'z' | 'yaw', value: number): void {
  const actor = store.selectedActor;
  if (!actor) return;
  const transform = { ...actor.transform };
  transform[axis] = axis === 'yaw' ? (value * Math.PI) / 180 : value;
  store.updateActorTransform(actor.id, transform);
}

function onNumberInput(axis: 'x' | 'z' | 'yaw', event: Event): void {
  setTransform(axis, Number((event.target as HTMLInputElement).value) || 0);
}
</script>

<template>
  <div class="inspector">
    <div class="head">
      <span class="section-title"><Icon name="layers" :size="12" />角色</span>
      <div class="add">
        <button
          class="btn btn-sm"
          type="button"
          :disabled="store.catalogLoading"
          :title="store.catalogLoading ? '动画库加载中，请稍候' : '添加 FBX 角色'"
          @click="add('fbx')"
        >
          <Icon name="plus" :size="12" />{{ store.catalogLoading ? '加载中' : 'FBX' }}
        </button>
        <button class="btn btn-sm" type="button" @click="add('soma')">
          <Icon name="plus" :size="12" />Soma
        </button>
      </div>
    </div>

    <div v-if="store.doc?.actors.length === 0" class="empty">还没有角色，先添加一个</div>

    <div class="actors">
      <button
        v-for="actor in store.doc?.actors ?? []"
        :key="actor.id"
        class="actor"
        :class="{ active: actor.id === store.selectedActorId }"
        type="button"
        @click="store.selectActor(actor.id)"
      >
        <span class="dot" :class="actor.kind"></span>
        <span class="actor-name">{{ actor.name }}</span>
        <span class="chip" :class="actor.kind === 'fbx' ? 'chip-info' : 'chip-accent'">
          {{ actor.kind === 'fbx' ? 'FBX' : 'Soma' }}
        </span>
        <span v-if="store.isActorLocked(actor.id)" class="chip">锁定</span>
        <span class="actor-actions">
          <span
            class="mini"
            :class="{ disabled: store.isActorLocked(actor.id) }"
            :title="store.isActorLocked(actor.id) ? '过渡动画生成中，角色已锁定' : actor.visible ? '隐藏' : '显示'"
            @click.stop="store.toggleActorVisible(actor.id)"
          >
            <Icon :name="actor.visible ? 'eye' : 'eyeOff'" :size="12" />
          </span>
          <span
            class="mini"
            :class="{ disabled: store.isActorLocked(actor.id) }"
            :title="store.isActorLocked(actor.id) ? '过渡动画生成中，角色已锁定' : '删除角色'"
            @click.stop="store.removeActor(actor.id)"
          >
            <Icon name="trash" :size="12" />
          </span>
        </span>
      </button>
    </div>

    <template v-if="store.selectedActor">
      <div class="head sub">
        <span class="section-title"><Icon name="grid" :size="12" />摆放</span>
      </div>

      <label class="field">
        <span class="field-label">名称</span>
        <input
          class="text-input"
          :disabled="actorLocked"
          :value="store.selectedActor.name"
          @change="store.updateActorName(store.selectedActor!.id, ($event.target as HTMLInputElement).value)"
        />
      </label>

      <div v-if="store.selectedActor.kind === 'fbx'" class="field">
        <span class="field-label">模型</span>
        <button
          class="model-current"
          type="button"
          :disabled="store.catalogLoading || actorLocked"
          :title="store.catalogLoading ? '动画库加载中…' : '点击选择模型（带封面预览）'"
          @click="modelPickerOpen = true"
        >
          <img
            v-if="store.selectedActor.modelPath"
            class="model-cover"
            :src="modelCover(store.selectedActor.modelPath)"
            :alt="actorModelName(store.selectedActor.modelPath)"
          />
          <span v-else class="model-cover placeholder"><Icon name="cube" :size="14" /></span>
          <span class="model-name">{{ actorModelName(store.selectedActor.modelPath) }}</span>
          <Icon name="chevronDown" :size="12" />
        </button>
      </div>

      <div class="grid-3">
        <label class="field">
          <span class="field-label">X</span>
          <input class="text-input" type="number" step="0.1" :disabled="actorLocked" :value="store.selectedActor.transform.x" @change="onNumberInput('x', $event)" />
        </label>
        <label class="field">
          <span class="field-label">Z</span>
          <input class="text-input" type="number" step="0.1" :disabled="actorLocked" :value="store.selectedActor.transform.z" @change="onNumberInput('z', $event)" />
        </label>
        <label class="field">
          <span class="field-label">朝向 °</span>
          <input class="text-input" type="number" step="5" :disabled="actorLocked" :value="yawDegrees" @change="onNumberInput('yaw', $event)" />
        </label>
      </div>
      <p v-if="actorLocked" class="hint locked">过渡动画生成期间，该角色已锁定：不能删除、移动或换模型</p>
      <p v-else class="hint">也可以在视口里直接拖拽选中的角色（移动 X/Z 或绕 Y 旋转）</p>
    </template>

    <Teleport to="body">
      <div v-if="modelPickerOpen" class="picker-mask" @click.self="modelPickerOpen = false">
        <div class="picker panel">
          <div class="picker-head">
            <span class="section-title"><Icon name="cube" :size="12" />选择模型</span>
            <button class="btn btn-icon" type="button" title="关闭" @click="modelPickerOpen = false">
              <Icon name="close" :size="13" />
            </button>
          </div>
          <input v-model="modelKeyword" class="text-input" type="search" placeholder="搜索模型文件名" />
          <p v-if="store.catalogLoading" class="hint">动画库加载中…</p>
          <div v-else class="picker-grid">
            <button
              v-for="file in modelOptions"
              :key="file.path"
              class="model-card"
              :class="{ active: file.path === store.selectedActor?.modelPath }"
              type="button"
              :title="file.relative"
              @click="chooseModel(file.path)"
            >
              <div class="model-card-cover">
                <img :src="modelCover(file.path)" :alt="file.name" loading="lazy" />
              </div>
              <span class="model-card-name">{{ file.relative }}</span>
            </button>
            <p v-if="modelOptions.length === 0" class="hint">没有匹配的模型</p>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.head.sub {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.add {
  display: flex;
  gap: 4px;
}

.btn-sm {
  height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
}

.empty {
  padding: 14px 8px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}

.actors {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.actor {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  text-align: left;
}

.actor:hover {
  background: var(--bg-hover);
}

.actor.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}

.dot.fbx {
  background: #60a5fa;
}

.dot.soma {
  background: var(--accent-hover);
}

.actor-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.actor-actions {
  display: flex;
  gap: 2px;
}

.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-faint);
}

.mini:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.mini.disabled {
  opacity: 0.3;
  pointer-events: none;
}

.model-current {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 38px;
  padding: 3px 8px 3px 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
}

.model-current:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.model-current:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.model-cover {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  object-fit: cover;
  flex: none;
  background: #171922;
}

.model-cover.placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
}

.model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 6, 12, 0.62);
}

.picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(720px, 92vw);
  max-height: 78vh;
  padding: 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-panel);
  box-shadow: var(--shadow);
}

.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.model-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  text-align: left;
}

.model-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.model-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.model-card-cover {
  aspect-ratio: 1 / 1;
  border-radius: 4px;
  overflow: hidden;
  background: #171922;
}

.model-card-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.model-card-name {
  font-size: 10.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field {
  display: block;
}

.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.5;
}

.hint.locked {
  color: var(--accent-hover);
}
</style>
