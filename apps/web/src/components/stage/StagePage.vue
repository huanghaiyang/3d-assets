<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import ActorInspector from './ActorInspector.vue';
import SequenceEditor from './SequenceEditor.vue';
import StageViewport from './StageViewport.vue';
import { useStageStore } from '@/stores/stage';

const store = useStageStore();
const confirmDeleteId = ref<string | null>(null);

onMounted(() => {
  void store.bootstrap();
});

onBeforeUnmount(() => {
  store.detachPlayer();
});

function onNameChange(event: Event): void {
  store.renameStage((event.target as HTMLInputElement).value);
}

function confirmRemove(id: string): void {
  if (confirmDeleteId.value === id) {
    void store.removeStage(id);
    confirmDeleteId.value = null;
    return;
  }
  confirmDeleteId.value = id;
  setTimeout(() => {
    if (confirmDeleteId.value === id) confirmDeleteId.value = null;
  }, 2600);
}
</script>

<template>
  <div class="stage-page">
    <aside class="panel left">
      <div class="stages">
        <div class="stages-head">
          <span class="section-title"><Icon name="layers" :size="12" />舞台</span>
          <div class="head-actions">
            <button class="btn btn-sm" type="button" title="新建舞台" @click="store.newStage()">
              <Icon name="plus" :size="12" />新建
            </button>
            <button
              class="btn btn-sm btn-primary"
              type="button"
              :disabled="!store.doc || store.saving"
              @click="store.saveStage()"
            >
              <Icon name="check" :size="12" />{{ store.saving ? '保存中' : '保存' }}
            </button>
          </div>
        </div>

        <input
          v-if="store.doc"
          class="text-input name-input"
          :value="store.doc.name"
          placeholder="舞台名称"
          @change="onNameChange"
        />

        <div class="stage-list">
          <button
            v-for="item in store.docs"
            :key="item.id"
            class="stage-row"
            :class="{ active: item.id === store.doc?.id }"
            type="button"
            @click="store.openStage(item.id)"
          >
            <span class="stage-name">{{ item.name }}</span>
            <span class="faint mono">{{ item.actorCount }} 角色 · {{ item.segmentCount }} 段</span>
            <span
              class="mini"
              :class="{ danger: confirmDeleteId === item.id }"
              :title="confirmDeleteId === item.id ? '再点一次确认删除' : '删除舞台'"
              @click.stop="confirmRemove(item.id)"
            >
              <Icon name="trash" :size="12" />
            </span>
          </button>
          <div v-if="store.docs.length === 0" class="faint hint">还没有保存过的舞台</div>
        </div>
      </div>

      <ActorInspector />
    </aside>

    <main class="center">
      <StageViewport />
      <div v-if="store.loading" class="loading panel">载入舞台…</div>
    </main>

    <aside class="panel right">
      <SequenceEditor />
    </aside>

    <div class="toasts">
      <div v-for="item in store.toasts" :key="item.id" class="toast" :class="item.kind">{{ item.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.stage-page {
  position: relative;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr) 340px;
  height: 100%;
  min-height: 0;
  gap: 8px;
  padding: 8px;
  background: var(--bg-app);
}

.left,
.right {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.center {
  position: relative;
  min-width: 0;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
}

.stages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
}

.stages-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.head-actions {
  display: flex;
  gap: 4px;
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.btn-sm {
  height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
}

.name-input {
  padding: 5px 8px;
  font-size: 12.5px;
}

.stage-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 168px;
  overflow-y: auto;
}

.stage-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  color: var(--text-dim);
  font-size: 12px;
}

.stage-row:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.stage-row.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.stage-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-faint);
  flex: none;
}

.mini:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.mini.danger {
  background: var(--danger-soft);
  color: var(--danger);
}

.hint {
  font-size: 11.5px;
  padding: 4px 2px;
}

.loading {
  position: absolute;
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
}

.toasts {
  position: absolute;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 20;
  pointer-events: none;
}

.toast {
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  font-size: 12px;
  box-shadow: var(--shadow);
}

.toast.success {
  border-color: rgba(52, 211, 153, 0.5);
  color: var(--success);
}

.toast.error {
  border-color: rgba(248, 113, 113, 0.5);
  color: var(--danger);
}

@media (max-width: 1280px) {
  .stage-page {
    grid-template-columns: 276px minmax(0, 1fr) 320px;
  }
}
</style>
