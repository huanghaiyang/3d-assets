<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import Icon from './ui/Icon.vue';
import { ModelViewer, type MeshStats } from '@/viewer/ModelViewer';
import { pickPreviewTarget } from '@/viewer/assetTarget';
import { useWorkspaceStore, isActive } from '@/stores/workspace';
import { useNow } from '@/composables/useNow';
import { confirmAction } from '@/composables/useConfirm';
import { formatDuration } from '@/utils/image';
import type { Asset, Job } from '@/api/types';

const store = useWorkspaceStore();
const now = useNow(1000);

const containerRef = ref<HTMLDivElement | null>(null);
const viewer = shallowRef<ModelViewer | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const stats = ref<MeshStats | null>(null);

// ===== 自动绑骨（人形 T-pose） =====
/** 当前模型是否自带骨架（已含骨架的模型隐藏绑骨按钮，只保留骨骼显示开关） */
const hasSkeleton = ref(false);
/** 是否已通过 autoRig 完成绑定（决定是否显示「导出 GLB」） */
const rigged = ref(false);
const skeletonOn = ref(false);
const rigging = ref(false);
const rigProgress = ref(0);
/** 模型是否已手动/绑骨流程纠正过朝向（用于按钮 active 状态） */
const orientationCorrected = ref(false);

const asset = computed<Asset | null>(() => store.selectedAsset);
const job = computed<Job | null>(() => store.selectedJob);
const activeJob = computed<Job | null>(() => {
  if (job.value && isActive(job.value.phase)) return job.value;
  return store.jobs.find((item) => isActive(item.phase)) ?? null;
});

const PHASE_TEXT: Record<Job['phase'], string> = {
  queued: '排队中',
  submitting: '提交中',
  running: '生成中',
  downloading: '下载并转存中',
  done: '已完成',
  failed: '生成失败',
  canceled: '已取消',
};

/** 接口不返回百分比，这里按耗时给出一个收敛的估算进度 */
const estimatedProgress = computed(() => {
  const active = activeJob.value;
  if (!active?.startedAt) return 6;
  const elapsed = now.value - new Date(active.startedAt).getTime();
  const estimated = 12 + 83 * (1 - Math.exp(-elapsed / 70_000));
  return Math.min(95, Math.round(estimated));
});

async function loadAsset(target: Asset | null): Promise<void> {
  const instance = viewer.value;
  if (!instance) return;
  loadError.value = null;

  if (!target) {
    instance.clear();
    stats.value = null;
    return;
  }

  const loadTarget = pickPreviewTarget(target);
  if (!loadTarget) {
    instance.clear();
    stats.value = null;
    loadError.value = '该素材没有浏览器可直接预览的格式，请下载后用本地软件打开';
    return;
  }

  loading.value = true;
  // 切换素材时重置绑骨状态（骨架绑定不跨素材保留）
  hasSkeleton.value = false;
  rigged.value = false;
  skeletonOn.value = false;
  orientationCorrected.value = false;
  try {
    stats.value = await instance.load(loadTarget);
    instance.setWireframe(store.wireframe);
    instance.setGrid(store.showGrid);
    instance.setAutoRotate(store.autoRotate);
    hasSkeleton.value = instance.hasSkeleton;
    rigged.value = instance.isRigged;
    // 回填节点树，并按当前选择恢复高亮
    store.setNodeTree(instance.sceneNodes);
    instance.setNodeSelection(store.selectedNodeIds);
  } catch (err) {
    loadError.value = (err as Error).message;
    stats.value = null;
    store.setNodeTree([]);
  } finally {
    loading.value = false;
  }
}

// 素材切换 / 文件集合变化 / 文件被改写（批量修正中心点或朝向）后都要重新加载：
// 改写后的 URL 带 ?v= 版本号，把它并入 key 才能触发重载
const viewKey = computed(() => {
  if (!asset.value) return null;
  const primary = asset.value.files[0]?.primaryUrl ?? '';
  return `${asset.value.id}:${asset.value.files.length}:${primary}`;
});

watch(viewKey, () => void loadAsset(asset.value));
watch(
  () => store.wireframe,
  (value) => viewer.value?.setWireframe(value),
);
watch(
  () => store.showGrid,
  (value) => viewer.value?.setGrid(value),
);
watch(
  () => store.autoRotate,
  (value) => viewer.value?.setAutoRotate(value),
);
// 节点选择变化 → 同步高亮（加选逻辑在 store 里）
watch(
  () => store.selectedNodeIds,
  (ids) => viewer.value?.setNodeSelection(ids),
  { deep: true },
);

onMounted(() => {
  if (containerRef.value) {
    viewer.value = new ModelViewer(containerRef.value);
    void loadAsset(asset.value);
  }
});

onBeforeUnmount(() => {
  viewer.value?.dispose();
  viewer.value = null;
});

function toggleFullscreen(): void {
  const element = containerRef.value?.parentElement;
  if (!element) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void element.requestFullscreen().catch(() => store.toast('error', '浏览器拒绝了全屏请求'));
}

function retry(): void {
  if (activeJob.value) void store.retry(activeJob.value.id);
}

/**
 * 自动绑骨：从网格几何测量躯干/手臂/腿部走向后拟合骨架，胶囊距离蒙皮。
 * 先弹确认（提示适用条件），确认后分块计算并通过 rigProgress 更新进度条。
 */
async function autoRig(): Promise<void> {
  const instance = viewer.value;
  if (!instance || rigging.value || !stats.value) return;
  const confirmed = await confirmAction({
    title: '自动绑骨（实验）',
    message: '将按模型的实际几何走向自适应拟合 19 根骨骼并计算蒙皮权重。',
    detail:
      '适用于站立人形模型，T-pose / A-pose / 手臂自然下垂都可以；' +
      '仍要求左右对称、脚底贴地。绑定不改变当前外观，可导出 GLB；切换素材后失效。',
    confirmText: '开始绑定',
    danger: false,
  });
  if (!confirmed) return;

  rigging.value = true;
  rigProgress.value = 0;
  try {
    const result = await instance.autoRig((done, total) => {
      rigProgress.value = total > 0 ? Math.round((done / total) * 100) : 0;
    });
    hasSkeleton.value = true;
    rigged.value = true;
    skeletonOn.value = instance.isSkeletonVisible;
    orientationCorrected.value = instance.isOrientationCorrected;
    // 骨骼已进场景，刷新节点树
    store.setNodeTree(instance.sceneNodes);
    // 几何测量失败的部分会回退到模板比例，这里如实告知用户，便于判断绑骨质量
    const fallbackParts = [
      result.fit.torso ? '' : '躯干',
      result.fit.arms ? '' : '手臂',
      result.fit.legs ? '' : '腿部',
    ].filter(Boolean);
    store.toast(
      'success',
      `绑骨完成：${result.bones} 根骨骼 · ${result.vertices.toLocaleString('en-US')} 个顶点` +
        (result.orientation.note ? ` · ${result.orientation.note}` : '') +
        (fallbackParts.length > 0 ? ` · ${fallbackParts.join('/')}回退模板比例` : ''),
    );
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '自动绑骨失败');
  } finally {
    rigging.value = false;
  }
}

/** 单独纠正模型朝向（不依赖绑骨；已纠正时再点一次还原） */
function correctOrientation(): void {
  const instance = viewer.value;
  if (!instance || !stats.value) return;
  try {
    const fix = instance.correctOrientation();
    orientationCorrected.value = instance.isOrientationCorrected;
    if (fix.note) store.toast('success', fix.note);
    else if (fix.yaw === 0) store.toast('info', '模型朝向看起来就对了，无需调整');
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '纠正朝向失败');
  }
}

/** 骨骼连线显示开关（绑骨后或自带骨架的模型可用） */
function toggleSkeleton(): void {
  const instance = viewer.value;
  if (!instance) return;
  instance.setSkeletonVisible(!skeletonOn.value);
  skeletonOn.value = instance.isSkeletonVisible;
}

/** 导出绑定后的模型为 GLB（含骨架与蒙皮权重） */
async function exportRigged(): Promise<void> {
  const instance = viewer.value;
  if (!instance) return;
  try {
    const baseName = (job.value?.name ?? 'model').replace(/[\\/:*?"<>|]/g, '_');
    await instance.exportGlb(`${baseName}-rigged.glb`);
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '导出 GLB 失败');
  }
}
</script>

<template>
  <section class="viewport">
    <div ref="containerRef" class="canvas-host" />

    <!-- 左上：当前素材信息 + 网格统计 -->
    <div v-if="stats || job" class="overlay overlay-stats">
      <div class="stats-title">
        <Icon name="cube" :size="13" />
        <span class="ellipsis">{{ job?.name ?? '未选择素材' }}</span>
      </div>
      <div v-if="stats" class="stats-grid">
        <div class="stat"><span class="stat-label">格式</span><span class="stat-value">{{ stats.format.toUpperCase() }}</span></div>
        <div class="stat"><span class="stat-label">三角面</span><span class="stat-value">{{ stats.triangles.toLocaleString('en-US') }}</span></div>
        <div class="stat"><span class="stat-label">顶点</span><span class="stat-value">{{ stats.vertices.toLocaleString('en-US') }}</span></div>
        <div class="stat"><span class="stat-label">网格</span><span class="stat-value">{{ stats.meshes }}</span></div>
        <div v-if="job?.asset?.creditConsumed" class="stat">
          <span class="stat-label">消耗积分</span><span class="stat-value">{{ job.asset.creditConsumed }}</span>
        </div>
      </div>
    </div>

    <!-- 右上：视图工具 -->
    <div class="overlay overlay-tools">
      <button
        class="tool"
        :class="{ active: store.wireframe }"
        type="button"
        title="线框叠加"
        :disabled="!stats"
        @click="store.wireframe = !store.wireframe"
      >
        <Icon name="grid" :size="15" />
      </button>
      <button
        class="tool"
        :class="{ active: store.showGrid }"
        type="button"
        title="显示网格地面"
        @click="store.showGrid = !store.showGrid"
      >
        <Icon name="layers" :size="15" />
      </button>
      <button
        class="tool"
        :class="{ active: store.autoRotate }"
        type="button"
        title="自动旋转"
        :disabled="!stats"
        @click="store.autoRotate = !store.autoRotate"
      >
        <Icon name="rotate" :size="15" />
      </button>
      <button class="tool" type="button" title="重置视角" :disabled="!stats" @click="viewer?.resetView()">
        <Icon name="refresh" :size="15" />
      </button>
      <button class="tool" type="button" title="全屏" @click="toggleFullscreen">
        <Icon name="maximize" :size="15" />
      </button>

      <!-- 绑骨相关：只在已加载模型时出现 -->
      <template v-if="stats">
        <div class="tool-divider" />
        <button
          class="tool"
          :class="{ active: orientationCorrected }"
          type="button"
          :title="orientationCorrected ? '还原模型原始朝向' : '自动纠正模型朝向（贴合人形 +Z 正面）'"
          @click="correctOrientation"
        >
          <Icon name="flip" :size="15" />
        </button>
        <button
          v-if="!hasSkeleton"
          class="tool"
          type="button"
          title="自动绑骨（自适应站姿，实验）"
          :disabled="rigging"
          @click="autoRig"
        >
          <Icon name="bone" :size="15" />
        </button>
        <button
          v-if="hasSkeleton"
          class="tool"
          :class="{ active: skeletonOn }"
          type="button"
          title="显示 / 隐藏骨骼"
          @click="toggleSkeleton"
        >
          <Icon name="bone" :size="15" />
        </button>
        <button
          v-if="rigged"
          class="tool"
          type="button"
          title="导出绑定后的 GLB（含骨架与蒙皮）"
          @click="exportRigged"
        >
          <Icon name="download" :size="15" />
        </button>
      </template>
    </div>

    <!-- 生成中 / 失败提示 -->
    <div v-if="activeJob" class="overlay overlay-status">
      <div class="status-card">
        <div class="status-row">
          <Icon :name="activeJob.phase === 'queued' ? 'clock' : 'refresh'" :size="14" :class="{ spin: activeJob.phase !== 'queued' }" />
          <span class="status-text">{{ PHASE_TEXT[activeJob.phase] }}</span>
          <span class="mono faint">{{ activeJob.remoteJobId ? `JobId ${activeJob.remoteJobId}` : '等待提交' }}</span>
        </div>
        <div class="progress">
          <div class="progress-bar" :style="{ width: `${estimatedProgress}%` }" />
        </div>
        <div class="status-meta">
          <span>已耗时 {{ formatDuration(now - new Date(activeJob.startedAt ?? activeJob.createdAt).getTime()) }}</span>
          <span class="faint">进度为估算值，接口不返回百分比</span>
        </div>
      </div>
    </div>

    <div v-else-if="job?.phase === 'failed'" class="overlay overlay-status">
      <div class="status-card">
        <div class="status-row">
          <Icon name="alert" :size="14" />
          <span class="status-text">生成失败</span>
          <span class="mono faint">{{ job.errorCode }}</span>
        </div>
        <p class="status-error">{{ job.error }}</p>
        <button class="btn" type="button" @click="retry">
          <Icon name="refresh" :size="13" />
          重试
        </button>
      </div>
    </div>

    <!-- 自动绑骨进度（放顶部，避开底部生成状态卡） -->
    <div v-if="rigging" class="overlay overlay-rigging">
      <div class="status-card">
        <div class="status-row">
          <Icon name="bone" :size="14" />
          <span class="status-text">正在自动绑骨</span>
          <span class="mono faint">{{ rigProgress }}%</span>
        </div>
        <div class="progress">
          <div class="progress-bar" :style="{ width: `${rigProgress}%` }" />
        </div>
        <div class="status-meta">
          <span>拟合 T-pose 骨架并计算蒙皮权重…</span>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!asset && !activeJob && !loading" class="overlay overlay-empty">
      <Icon name="cubeOutline" :size="42" />
      <p class="empty-title">工作区还没有模型</p>
      <p class="empty-hint">在左侧输入描述文字或上传参考图，点击「立即生成」开始</p>
    </div>

    <div v-if="loading" class="overlay overlay-empty">
      <Icon name="refresh" :size="30" class="spin" />
      <p class="empty-hint">正在载入模型…</p>
    </div>

    <div v-if="loadError" class="overlay overlay-error">
      <Icon name="alert" :size="14" />
      <span>{{ loadError }}</span>
    </div>

    <div v-if="stats" class="overlay overlay-hint">左键旋转 · 右键平移 · 滚轮缩放</div>
  </section>
</template>

<style scoped>
.viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  background: radial-gradient(circle at 50% 38%, #2a2d36 0%, #1b1d23 48%, #141519 100%);
  overflow: hidden;
}

.canvas-host {
  position: absolute;
  inset: 0;
}

.overlay {
  position: absolute;
  z-index: 2;
}

.overlay-stats {
  top: 14px;
  left: 14px;
  min-width: 168px;
  padding: 9px 11px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(8px);
}

.stats-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 7px;
  color: var(--text);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}

.stats-grid {
  display: grid;
  grid-template-columns: auto auto;
  gap: 3px 12px;
}

.stat {
  display: contents;
}

.stat-label {
  font-size: 11px;
  color: var(--text-faint);
}

.stat-value {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text);
  text-align: right;
}

.overlay-tools {
  top: 14px;
  right: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(8px);
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
}

.tool:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.tool.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.tool:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}

/* 视图工具与绑骨工具之间的分隔线 */
.tool-divider {
  height: 1px;
  margin: 2px 4px;
  background: rgba(255, 255, 255, 0.08);
}

/* 绑骨进度放顶部居中，避开 bottom: 46px 的生成状态卡 */
.overlay-rigging {
  left: 50%;
  top: 64px;
  transform: translateX(-50%);
  width: min(360px, calc(100% - 40px));
}

.overlay-status {
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  width: min(420px, calc(100% - 40px));
}

.status-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
}

.status-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}

.status-text {
  font-weight: 600;
}

.status-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
  line-height: 1.5;
  word-break: break-word;
}

.progress {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-app);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #59c2ff);
  transition: width 0.6s ease;
}

.status-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-dim);
}

.overlay-empty {
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-faint);
  pointer-events: none;
}

.empty-title {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--text-dim);
}

.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}

.overlay-error {
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: calc(100% - 40px);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: rgba(248, 113, 113, 0.16);
  border: 1px solid rgba(248, 113, 113, 0.4);
  color: #fecaca;
  font-size: 12px;
}

.overlay-hint {
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--text-faint);
  background: rgba(22, 23, 27, 0.6);
  padding: 4px 10px;
  border-radius: 999px;
  pointer-events: none;
}
</style>
