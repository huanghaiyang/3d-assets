<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
// 3D 舞台（three.js + 多角色序列编排）同理，切到「舞台」页签时才拉取
const StagePage = defineAsyncComponent(() => import('./components/stage/StagePage.vue'));
// 拼接（Strips 多片段按身体部位叠加混合）同理
const StripsPage = defineAsyncComponent(() => import('./components/strips/StripsPage.vue'));

const store = useWorkspaceStore();
const settingsOpen = ref(false);
const page = ref<'workbench' | 'animations' | 'stage' | 'strips'>('workbench');
/** 动画页是异步组件，首次切换时显示占位，避免空白无反馈 */
const animationLoaded = ref(false);
const stageLoaded = ref(false);
const stripsLoaded = ref(false);

function changePage(value: 'workbench' | 'animations' | 'stage' | 'strips'): void {
  page.value = value;
  if (value === 'animations') animationLoaded.value = true;
  if (value === 'stage') stageLoaded.value = true;
  if (value === 'strips') stripsLoaded.value = true;
}

onMounted(() => store.startPolling());
onBeforeUnmount(() => store.stopPolling());

// 其它页面（舞台「去编辑」）可以请求跳转；消费后立刻清空，避免重复触发
watch(
  () => store.pageRequest,
  (request) => {
    if (!request) return;
    changePage(request);
    store.pageRequest = null;
  },
);
</script>

<template>
  <div
    class="app"
    :class="
      page === 'animations'
        ? 'app-anim'
        : page === 'stage'
          ? 'app-stage'
          : page === 'strips'
            ? 'app-strips'
            : 'app-workbench'
    "
  >
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
    <main v-else-if="page === 'animations'" class="anim-host">
      <AnimationPage v-if="animationLoaded" />
    </main>
    <main v-else-if="page === 'stage'" class="stage-host">
      <StagePage v-if="stageLoaded" />
    </main>
    <main v-else class="strips-host">
      <StripsPage v-if="stripsLoaded" />
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

.app-stage {
  grid-template-rows: 52px minmax(0, 1fr);
}

.app-strips {
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

.stage-host {
  min-height: 0;
  overflow: hidden;
}

.strips-host {
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
