<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import AnimationGrid from './AnimationGrid.vue';
import AnimationViewport from './AnimationViewport.vue';
import AnimationInfo from './AnimationInfo.vue';
import AnimationDataDialog from './AnimationDataDialog.vue';
import FolderPicker from './FolderPicker.vue';
import KimodoPanel from './KimodoPanel.vue';
import { useAnimationStore } from '@/stores/animation';

const store = useAnimationStore();
const pickerOpen = ref(false);

/** 选择器返回的文件夹：作为「新增」加入记录列表并重新扫描 */
function onPick(dir: string): void {
  pickerOpen.value = false;
  void store.addDir(dir);
}

/**
 * 标签优先用服务端给的（同名文件夹会被消歧成 `上级/名称`）；
 * 没有 FBX 的文件夹不会出现在 folderOptions 里，这里做同样的消歧兜底。
 */
const dirLabels = computed(() => {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const dir of store.dirs) {
    let label = store.folderOptions.find((option) => option.value === dir)?.label;
    if (!label) {
      const parts = dir.split(/[\\/]/).filter(Boolean);
      label = parts[parts.length - 1] ?? dir;
      if (used.has(label) && parts.length >= 2) label = `${parts[parts.length - 2]}/${label}`;
    }
    used.add(label);
    map.set(dir, label);
  }
  return map;
});

function labelOf(dir: string): string {
  return dirLabels.value.get(dir) ?? dir;
}
</script>

<template>
  <div class="anim-page">
    <div class="anim-body">
      <div class="folder-bar">
        <button class="btn" type="button" @click="pickerOpen = true">
          <Icon name="folder" :size="13" />
          添加文件夹
        </button>
        <button class="btn" type="button" :disabled="store.loading" @click="store.reload()">
          <Icon name="refresh" :size="13" :class="{ spin: store.loading }" />
          重新扫描
        </button>
        <button
          class="btn"
          type="button"
          :disabled="store.viewLoading"
          title="以动画库中的模型新建动画：去掉自带动画，只保留模型与绑定姿态，可导入动画 JSON 并保存"
          @click="store.createNewAnimation()"
        >
          <Icon name="plus" :size="13" />
          新建动画
        </button>

        <div class="chips">
          <span
            v-for="dir in store.dirs"
            :key="dir"
            class="dir-chip"
            :class="{ missing: store.missingDirs.includes(dir) }"
            :title="dir"
          >
            <Icon name="folder" :size="10" />
            <span class="chip-text">{{ labelOf(dir) }}</span>
            <button
              v-if="store.dirs.length > 1"
              class="chip-remove"
              type="button"
              title="移除该文件夹"
              @click="store.removeDir(dir)"
            >
              <Icon name="close" :size="10" />
            </button>
          </span>
        </div>

        <span class="chip chip-info">
          <Icon name="lock" :size="10" />
          只读
        </span>
        <span class="chip">{{ store.files.length }} 个 FBX</span>
      </div>

      <KimodoPanel />

      <div class="columns">
        <AnimationGrid />
        <AnimationViewport />
        <AnimationInfo />
      </div>
    </div>

    <FolderPicker :open="pickerOpen" :start-dir="store.dirs[0] ?? ''" @close="pickerOpen = false" @pick="onPick" />

    <AnimationDataDialog :open="store.dataDialogOpen" @close="store.closeAnimationData()" />

    <div class="toasts">
      <TransitionGroup name="toast">
        <div v-for="item in store.toasts" :key="item.id" class="toast" :class="`toast-${item.kind}`">
          <Icon :name="item.kind === 'error' ? 'alert' : 'info'" :size="13" />
          <span>{{ item.text }}</span>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.anim-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.anim-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.folder-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.chips {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow-x: auto;
  padding: 2px 0;
}

.chips::-webkit-scrollbar {
  height: 5px;
}

.dir-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 22px;
  padding: 0 4px 0 7px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11px;
  max-width: 190px;
}

.dir-chip.missing {
  border-color: rgba(248, 113, 113, 0.5);
  color: var(--danger);
}

.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.65;
}

.chip-remove:hover {
  background: var(--danger-soft);
  opacity: 1;
}

.columns {
  display: grid;
  grid-template-columns: 380px minmax(0, 1fr) 300px;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

@media (max-width: 1440px) {
  .columns {
    grid-template-columns: 340px minmax(0, 1fr) 282px;
  }
}

@media (max-width: 1180px) {
  .columns {
    grid-template-columns: 300px minmax(0, 1fr) 260px;
  }
}

.toasts {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 340px;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
  font-size: 12px;
}

.toast-error {
  border-color: rgba(248, 113, 113, 0.45);
  color: #fecaca;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>
