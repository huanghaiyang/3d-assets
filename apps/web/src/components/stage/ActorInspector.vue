<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStageStore } from '@/stores/stage';
import type { ActorKind } from '@/viewer/stage/StageTypes';

const store = useStageStore();

const fbxFiles = computed(() => store.files.slice(0, 400));

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
        <button class="btn btn-sm" type="button" @click="add('fbx')">
          <Icon name="plus" :size="12" />FBX
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
        <span class="actor-actions">
          <span
            class="mini"
            :title="actor.visible ? '隐藏' : '显示'"
            @click.stop="store.toggleActorVisible(actor.id)"
          >
            <Icon :name="actor.visible ? 'eye' : 'eyeOff'" :size="12" />
          </span>
          <span class="mini" title="删除角色" @click.stop="store.removeActor(actor.id)">
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
          :value="store.selectedActor.name"
          @change="store.updateActorName(store.selectedActor!.id, ($event.target as HTMLInputElement).value)"
        />
      </label>

      <label v-if="store.selectedActor.kind === 'fbx'" class="field">
        <span class="field-label">模型 · {{ actorModelName(store.selectedActor.modelPath) }}</span>
        <select
          class="select-input"
          :value="store.selectedActor.modelPath ?? ''"
          @change="store.updateActorModel(store.selectedActor!.id, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="file in fbxFiles" :key="file.path" :value="file.path">{{ file.relative }}</option>
        </select>
      </label>

      <div class="grid-3">
        <label class="field">
          <span class="field-label">X</span>
          <input class="text-input" type="number" step="0.1" :value="store.selectedActor.transform.x" @change="onNumberInput('x', $event)" />
        </label>
        <label class="field">
          <span class="field-label">Z</span>
          <input class="text-input" type="number" step="0.1" :value="store.selectedActor.transform.z" @change="onNumberInput('z', $event)" />
        </label>
        <label class="field">
          <span class="field-label">朝向 °</span>
          <input class="text-input" type="number" step="5" :value="yawDegrees" @change="onNumberInput('yaw', $event)" />
        </label>
      </div>
      <p class="hint">也可以在视口里直接拖拽选中的角色（移动 X/Z 或绕 Y 旋转）</p>
    </template>
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
</style>
