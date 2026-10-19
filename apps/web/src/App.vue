<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import TopBar from './components/TopBar.vue';
import GeneratePanel from './components/GeneratePanel.vue';
import ViewportPanel from './components/ViewportPanel.vue';
import WorkbenchSidePanel from './components/WorkbenchSidePanel.vue';
import TaskBar from './components/TaskBar.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import ToastStack from './components/ToastStack.vue';
import AnimationPage from './components/animation/AnimationPage.vue';
import { useWorkspaceStore } from './stores/workspace';

const store = useWorkspaceStore();
const settingsOpen = ref(false);
const page = ref<'workbench' | 'animations'>('workbench');

onMounted(() => store.startPolling());
onBeforeUnmount(() => store.stopPolling());
</script>

<template>
  <div class="app" :class="page === 'animations' ? 'app-anim' : 'app-workbench'">
    <TopBar
      :settings-open="settingsOpen"
      :page="page"
      @change-page="(value) => (page = value)"
      @open-settings="settingsOpen = true"
    />

    <main v-if="page === 'workbench'" class="workbench">
      <GeneratePanel />
      <ViewportPanel />
      <WorkbenchSidePanel />
    </main>
    <main v-else class="anim-host">
      <AnimationPage />
    </main>

    <TaskBar v-if="page === 'workbench'" />
    <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
    <ToastStack />
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
