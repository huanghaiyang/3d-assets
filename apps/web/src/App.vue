<script setup lang="ts">
/**
 * 应用根组件：四个工作区的页面外壳与切换入口。
 *
 * - 负责工作台 / 动画 / 舞台 / 拼接之间的页面切换，以及非工作台页面的懒加载；
 * - 工作台常驻（生成面板 + 视口 + 素材库 + 底部任务栏），其它页面按需挂载；
 * - 持有全局设置弹窗、确认框与 toast 容器，页面内部只通过 store 的 `pageRequest` 请求跳转。
 */
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
import { confirmAction } from './composables/useConfirm';

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
/** 舞台页首次切入后才挂载，避免一进入应用就加载 three.js 舞台场景 */
const stageLoaded = ref(false);
/** 拼接页同理；挂载后由 StripsPage 自己 bootstrap（首次拉素材，之后靠 store 现场恢复） */
const stripsLoaded = ref(false);

/**
 * 切换工作区页面（顶栏页签、舞台「去编辑」、动画库「编辑拼接」都走这里）。
 *
 * @param value 目标页面：`workbench` 生成工作台 / `animations` 动画 / `stage` 舞台 / `strips` 拼接
 * @returns 页面切换完成后 resolve；如果用户在离开确认里选了「留在拼接」，函数提前返回、页面不变
 *
 * 为什么是 async：从拼接区切走前可能需要弹出全局确认框，而 `confirmAction` 以 Promise
 * 等待用户点选，只有确认后才允许改 `page`，否则必须停在拼接页保住未保存的编排。
 *
 * 副作用：把目标页的 `*Loaded` 标记置真（异步组件首次挂载），从而触发对应 chunk 的懒加载。
 * 边界：只有在「当前是拼接页、目标不是拼接页」时才检查脏状态，其它方向的切换不打断用户。
 * 关闭浏览器 / 刷新由 StripsPage 里的 beforeunload 兜底，这里不处理。
 * 失败路径：strips store 用动态 import 引入（避免 App 首屏把拼接逻辑打进主包）；
 * 未做 try/catch，导入或确认框异常会向上冒泡且 `page` 保持原值。
 */
async function changePage(value: 'workbench' | 'animations' | 'stage' | 'strips'): Promise<void> {
  // 离开拼接工作区时：有未保存的编排修改先确认（关闭浏览器由 beforeunload 兜底）
  if (page.value === 'strips' && value !== 'strips') {
    const { useStripsStore } = await import('./stores/strips');
    if (useStripsStore().hasUnsavedChanges) {
      const ok = await confirmAction({
        title: '离开拼接工作区',
        message: '当前拼接编排有未保存的修改，确定离开吗？',
        detail: '未保存的修改会丢失；已保存的拼接动画可以在「动画」工作区的「拼接动画」里再次打开修改。',
        confirmText: '仍然离开',
        cancelText: '留在拼接',
        danger: false,
      });
      if (!ok) return;
    }
  }
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
    void changePage(request);
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
    <!-- 顶栏：页签切换交给 changePage；离开拼接区时这里可能先弹出确认框 -->
    <TopBar
      :settings-open="settingsOpen"
      :page="page"
      @change-page="changePage"
      @open-settings="settingsOpen = true"
    />

    <!-- 工作台：三栏常驻布局，只有这一页显示底部 TaskBar -->
    <main v-if="page === 'workbench'" class="workbench">
      <GeneratePanel />
      <ViewportPanel />
      <WorkbenchSidePanel />
    </main>
    <!--
      动画页：首帧由 animationLoaded 把关。
      组件本身随 main 卸载，但 store 里的列表 / 选中态保留，切回来可立即恢复。
    -->
    <main v-else-if="page === 'animations'" class="anim-host">
      <AnimationPage v-if="animationLoaded" />
    </main>
    <!-- 舞台页同样首次进入才挂载，切回时不再经过占位帧 -->
    <main v-else-if="page === 'stage'" class="stage-host">
      <StagePage v-if="stageLoaded" />
    </main>
    <!--
      拼接页：末位分支（v-else）承接剩余情况，即当前只有 strips 一种。
      挂载时 StripsPage 会注册 beforeunload 并 bootstrap，卸载只移除监听、不销毁编排。
    -->
    <main v-else class="strips-host">
      <StripsPage v-if="stripsLoaded" />
    </main>

    <!-- 任务栏只属于工作台；其它页面隐藏，避免挤占动画/拼接的时间轴高度 -->
    <TaskBar v-if="page === 'workbench'" />
    <!-- 全局单例弹层：设置、toast、确认框，不随页面切换重建 -->
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
