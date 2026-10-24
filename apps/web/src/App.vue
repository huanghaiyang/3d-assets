<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue';
import TopBar from './components/TopBar.vue';
import GeneratePanel from './components/GeneratePanel.vue';
import ViewportPanel from './components/ViewportPanel.vue';
import WorkbenchSidePanel from './components/WorkbenchSidePanel.vue';
import TaskBar from './components/TaskBar.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import ToastStack from './components/ToastStack.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import { useWorkspaceStore } from './stores/workspace';

// 动画预览页（FBX 播放器 + 骨骼/节点树）只在真正用时才加载，首屏包体因此小一半
const AnimationPage = defineAsyncComponent(() => import('./components/animation/AnimationPage.vue'));

const store = useWorkspaceStore();
const settingsOpen = ref(false);
const page = ref<'workbench' | 'animations'>('workbench');
/** 动画页是异步组件，首次切换时显示占位，避免空白无反馈 */
const animationLoaded = ref(false);

function changePage(value: 'workbench' | 'animations'): void {
  page.value = value;
  if (value === 'animations') animationLoaded.value = true;
}

onMounted(() => store.startPolling());
onBeforeUnmount(() => store.stopPolling());
</script>

<template>
  <div class="app" :class="page === 'animations' ? 'app-anim' : 'app-workbench'">
    <TopBar
      :settings-open="settingsOpen"
      :page="page"
      @change-page="changePage"
      @open-settings="settingsOpen = true"
    />

    <main v-if="page === 'workbench'" class="workbench">
      <GeneratePanel />
      <ViewportPanel />
      <WorkbenchSidePanel />
    </main>
    <main v-else class="anim-host">
      <AnimationPage v-if="animationLoaded" />
    </main>

    <TaskBar v-if="page === 'workbench'" />
    <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
    <ToastStack />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.app {
  display: grid;
  height: 100vh;
  overflow: hidden;
}

.app-workbench {
  grid-template-rows: 52px minmax(0, 1fr) 56px;
}

.app-anim {
  grid-template-rows: 52px minmax(0, 1fr);
}

.workbench {
  display: grid;
  /* 左：生成面板（可压缩）；中：视口（自适应）；右：素材库（固定 300px，两列卡片） */
  grid-template-columns: 320px minmax(0, 1fr) 300px;
  min-height: 0;
  overflow: hidden;
}

.anim-host {
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 1280px) {
  /* 窗口变窄时只压缩左侧面板，素材库保持固定宽度，保证每行稳定两列 */
  .workbench {
    grid-template-columns: 292px minmax(0, 1fr) 300px;
  }
}

@media (max-width: 1024px) {
  .workbench {
    grid-template-columns: 264px minmax(0, 1fr) 300px;
  }
}
</style>
