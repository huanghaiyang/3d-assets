<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Icon from './ui/Icon.vue';
import { downloadUrl } from '@/api/client';
import FolderPicker from './animation/FolderPicker.vue';
import { useWorkspaceStore, isActive } from '@/stores/workspace';
import { useNow } from '@/composables/useNow';
import { confirmAction } from '@/composables/useConfirm';
import { formatDuration } from '@/utils/image';
import type { FolderScanResponse, Job, PivotMode } from '@/api/types';

const store = useWorkspaceStore();
const now = useNow(1000);

type Filter = 'all' | 'active' | 'done' | 'failed';

const filter = ref<Filter>('all');
const keyword = ref('');
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
];

const PHASE_LABEL: Record<Job['phase'], string> = {
  queued: '排队中',
  submitting: '提交中',
  running: '生成中',
  downloading: '转存中',
  done: '完成',
  failed: '失败',
  canceled: '已取消',
};

const filteredJobs = computed(() => {
  const key = keyword.value.trim().toLowerCase();
  return store.jobs.filter((job) => {
    if (filter.value === 'active' && !isActive(job.phase)) return false;
    if (filter.value === 'done' && job.phase !== 'done') return false;
    if (filter.value === 'failed' && job.phase !== 'failed' && job.phase !== 'canceled') return false;
    if (!key) return true;
    return (
      job.name.toLowerCase().includes(key) ||
      job.input.prompt.toLowerCase().includes(key) ||
      job.params.generateType.toLowerCase().includes(key)
    );
  });
});

// ===== 分页：素材多起来后不再把 300 张卡片一次性塞进 DOM =====
const page = ref(1);
const pageSize = ref(12);
const PAGE_SIZES = [12, 24, 48, 96];

const pageCount = computed(() => Math.max(1, Math.ceil(filteredJobs.value.length / pageSize.value)));
const pagedJobs = computed(() =>
  filteredJobs.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);

/** 页码窗口：当前页前后各 2 页，首尾恒显示 */
const pageNumbers = computed(() => {
  const total = pageCount.value;
  const current = page.value;
  const windowSize = 5;
  let start = Math.max(1, current - Math.floor(windowSize / 2));
  const end = Math.min(total, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const numbers: number[] = [];
  for (let value = start; value <= end; value += 1) numbers.push(value);
  return numbers;
});

function goPage(target: number): void {
  page.value = Math.min(pageCount.value, Math.max(1, target));
}

watch([keyword, filter, pageSize], () => {
  page.value = 1;
});

// 任务被删除 / 过滤后页数变少时，把当前页夹回合法范围
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

const counts = computed(() => ({
  all: store.jobs.length,
  active: store.jobs.filter((job) => isActive(job.phase)).length,
  done: store.jobs.filter((job) => job.phase === 'done').length,
  failed: store.jobs.filter((job) => job.phase === 'failed' || job.phase === 'canceled').length,
}));

function thumbnailOf(job: Job): string | null {
  return job.asset?.thumbnailUrl ?? job.input.previewUrl ?? null;
}

function durationOf(job: Job): string {
  if (!job.startedAt) return PHASE_LABEL[job.phase];
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now.value;
  return formatDuration(end - new Date(job.startedAt).getTime());
}

function primaryDownload(job: Job): void {
  const files = job.asset?.files ?? [];
  const preferred = files.find((file) => file.format === 'glb') ?? files.find((file) => file.primaryUrl) ?? files[0];
  if (!preferred) {
    store.toast('error', '该素材还没有可下载的文件');
    return;
  }
  downloadUrl(preferred.primaryUrl ?? preferred.entries[0]?.url ?? '', true);
}

function downloadAll(job: Job): void {
  const files = job.asset?.files ?? [];
  if (files.length === 0) {
    store.toast('error', '该素材还没有可下载的文件');
    return;
  }
  files.forEach((file, index) => {
    const url = file.primaryUrl ?? file.entries[0]?.url;
    if (!url) return;
    window.setTimeout(() => downloadUrl(url, true), index * 400);
  });
}

function startRename(job: Job): void {
  renamingId.value = job.id;
  renameValue.value = job.name;
  void nextTick(() => renameInput.value?.select());
}

/** v-for 内的元素 ref 会收集成数组，这里用函数 ref 拿到单个输入框 */
function setRenameInput(element: unknown): void {
  renameInput.value = (element as HTMLInputElement | null) ?? null;
}

async function commitRename(job: Job): Promise<void> {
  const name = renameValue.value.trim();
  renamingId.value = null;
  if (!name || name === job.name) return;
  await store.rename(job.id, name);
}

function cancelRename(): void {
  renamingId.value = null;
}

async function confirmRemove(job: Job): Promise<void> {
  const ok = await confirmAction({
    title: '删除素材',
    message: `确定删除「${job.name}」？`,
    detail: '本地转存的模型文件会一并删除。',
    confirmText: '删除',
  });
  if (!ok) return;
  await store.remove(job.id);
}

// ===== 上传 / 批量上传 =====
const fileInput = ref<HTMLInputElement | null>(null);
const dragDepth = ref(0);
const dragging = computed(() => dragDepth.value > 0);

const ACCEPT = computed(() =>
  store.uploadInfo.acceptedExtensions.map((ext) => `.${ext}`).join(','),
);
const maxSizeLabel = computed(() => `${Math.round(store.uploadInfo.maxBytes / 1024 / 1024)}MB`);

function openPicker(): void {
  fileInput.value?.click();
}

function onPick(event: Event): void {
  const target = event.target as HTMLInputElement;
  const files = target.files ? Array.from(target.files) : [];
  target.value = '';
  if (files.length > 0) void store.uploadFiles(files);
}

function onDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth.value += 1;
}

function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragDepth.value = 0;
  const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
  if (files.length > 0) void store.uploadFiles(files);
}

function statusText(status: string): string {
  if (status === 'pending') return '等待上传';
  if (status === 'uploading') return '上传中';
  if (status === 'done') return '已暂存';
  if (status === 'canceled') return '已取消';
  return '失败';
}

/** 上传进度百分比（整批：已暂存文件按 100% 计） */
const uploadProgress = computed(() => {
  const queue = store.uploadQueue;
  if (queue.length === 0) return 0;
  const total = queue.reduce((sum, item) => {
    if (item.status === 'done') return sum + 100;
    if (item.status === 'uploading') return sum + item.progress;
    return sum;
  }, 0);
  return Math.round(total / queue.length);
});

// ===== 扫描文件夹导入：服务端直接读磁盘，一次导入整个目录的 .glb =====
const SCAN_DIR_KEY = 'h3d.library.scanDir.v1';
const scanOpen = ref(false);
const scanDir = ref('');
const scanRecursive = ref(true);
const scanResult = ref<FolderScanResponse | null>(null);
/** 应用内「选择文件夹」对话框是否打开 */
const picking = ref(false);

// 记住上次扫描过的路径：重复导入同一个素材目录时不用重新输入
try {
  scanDir.value = localStorage.getItem(SCAN_DIR_KEY) ?? '';
} catch {
  /* 隐私模式下 localStorage 不可用，忽略即可 */
}

function toggleScan(): void {
  scanOpen.value = !scanOpen.value;
  if (scanOpen.value) scanResult.value = null;
}

async function runScan(): Promise<void> {
  const dir = scanDir.value.trim();
  if (!dir) {
    store.toast('error', '请选择要扫描的文件夹');
    return;
  }
  const result = await store.scanFolder(dir, scanRecursive.value);
  if (!result) return;
  scanResult.value = result;
  try {
    localStorage.setItem(SCAN_DIR_KEY, dir);
  } catch {
    /* 忽略写入失败 */
  }
}

/**
 * 打开应用内已有的「选择文件夹」对话框（与动画工作区共用 FolderPicker 组件），
 * 选中后把绝对路径回填到扫描输入框。
 *
 * 不用系统文件对话框：浏览器弹窗在本地服务进程里异步等待，容易「点了没反应」，
 * 而应用内对话框走普通的 /api/anim/browse 接口，交互与动画工作区完全一致。
 */
function openScanPicker(): void {
  picking.value = true;
}

function onScanDirPicked(dir: string): void {
  picking.value = false;
  if (!dir) return;
  scanDir.value = dir;
  scanResult.value = null;
  try {
    localStorage.setItem(SCAN_DIR_KEY, dir);
  } catch {
    /* 忽略写入失败 */
  }
}

// ===== 多选 + 批量修正（中心点 / 朝向）=====
const selecting = ref(false);
const selectedIds = ref<Set<string>>(new Set());
const pivotMode = ref<PivotMode>('none');
/** 朝向：auto 自动纠正；'0' 不改朝向；其余为额外旋转角度（90 的倍数，叠加在自动结果上） */
const yawMode = ref<'auto' | '0' | '90' | '-90' | '180'>('auto');

const selectedCount = computed(() => selectedIds.value.size);
/** 没有任何实际动作（保持轴心 + 不转朝向）时禁用「应用」 */
const transformDisabled = computed(
  () => selectedCount.value === 0 || store.transforming || (pivotMode.value === 'none' && yawMode.value === '0'),
);

function toggleSelecting(): void {
  selecting.value = !selecting.value;
  if (!selecting.value) selectedIds.value = new Set();
}

function toggleSelected(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

/** 只选中当前页，避免翻页时误把其它页的素材一起处理 */
function selectCurrentPage(): void {
  selectedIds.value = new Set(pagedJobs.value.map((job) => job.id));
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

function onCardClick(job: Job): void {
  // 多选模式下点卡片是勾选，不切换视口
  if (selecting.value) {
    toggleSelected(job.id);
    return;
  }
  store.select(job.id);
}

async function applyTransform(): Promise<void> {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  const yaw: 'auto' | number = yawMode.value === 'auto' ? 'auto' : Number(yawMode.value);
  const result = await store.batchTransform(ids, pivotMode.value, yaw);
  if (!result) return;
  // 成功的已刷新；失败 / 跳过的保留选中状态，方便单独处理
  const failedIds = new Set(result.skipped.map((item) => item.id));
  selectedIds.value = new Set(ids.filter((id) => failedIds.has(id)));
  if (selectedIds.value.size === 0 && result.transformed.length > 0) selecting.value = false;
}

</script>

<template>
  <aside
    class="library"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <header class="panel-head">
      <div class="title">
        <Icon name="layers" :size="15" />
        <span>素材库</span>
        <span class="chip">{{ store.jobs.length }}</span>
      </div>
      <div class="head-actions">
        <span v-if="store.thumbnailTask" class="chip chip-info" :title="store.thumbnailTask.current ?? ''">
          <Icon name="refresh" :size="11" class="spin" />
          缩略图 {{ store.thumbnailTask.done }}/{{ store.thumbnailTask.total }}
        </span>
        <button
          v-else-if="store.thumbnailsMissing.length > 0"
          class="btn thumb-btn"
          type="button"
          title="为缺少预览图的素材渲染缩略图"
          @click="store.fillMissingThumbnails()"
        >
          <Icon name="image" :size="12" />
          补全缩略图 {{ store.thumbnailsMissing.length }}
        </button>
        <button
          class="btn scan-btn"
          type="button"
          title="扫描本地文件夹，一次导入其中所有 .glb"
          @click="toggleScan"
        >
          <Icon name="folder" :size="12" />
          扫描
        </button>
        <button
          class="btn upload-btn"
          type="button"
          :disabled="store.uploading"
          title="上传本地模型，可一次选择多个文件批量导入"
          @click="openPicker"
        >
          <Icon :name="store.uploading ? 'refresh' : 'upload'" :size="13" :class="{ spin: store.uploading }" />
          {{ store.uploading ? '上传中' : '上传' }}
        </button>
      </div>
      <input
        ref="fileInput"
        class="file-input"
        type="file"
        multiple
        :accept="ACCEPT"
        @change="onPick"
      />
    </header>

    <div class="toolbar">
      <div class="search">
        <Icon name="search" :size="13" />
        <input v-model="keyword" class="search-input" type="search" placeholder="搜索名称 / 提示词" />
      </div>
      <div class="filters">
        <button
          v-for="item in FILTERS"
          :key="item.value"
          type="button"
          class="filter"
          :class="{ active: filter === item.value }"
          @click="filter = item.value"
        >
          {{ item.label }}
          <span class="filter-count">{{ counts[item.value] }}</span>
        </button>
      </div>
    </div>

    <div class="list">
      <!-- 扫描文件夹导入：服务端直接读磁盘，一次导入整个目录的 GLB -->
      <div v-if="scanOpen" class="scan-panel">
        <div class="upload-head">
          <span class="section-title">
            <Icon name="folder" :size="12" />
            扫描文件夹导入 GLB
          </span>
          <button class="mini" type="button" title="收起" @click="toggleScan">
            <Icon name="close" :size="11" />
          </button>
        </div>
        <div class="scan-row">
          <input
            v-model="scanDir"
            class="scan-input"
            type="text"
            spellcheck="false"
            placeholder="选择或填写文件夹绝对路径，例如 D:\models\characters"
            @keydown.enter="runScan"
          />
          <button
            class="btn scan-pick"
            type="button"
            :disabled="store.scanning"
            title="打开应用内的文件夹选择器，浏览并选中要扫描的目录"
            @click="openScanPicker"
          >
            <Icon name="folder" :size="12" />
            选择…
          </button>
        </div>
        <label class="scan-option">
          <input v-model="scanRecursive" type="checkbox" />
          递归子目录
        </label>
        <button class="btn scan-run" type="button" :disabled="store.scanning" @click="runScan">
          <Icon :name="store.scanning ? 'refresh' : 'search'" :size="12" :class="{ spin: store.scanning }" />
          {{ store.scanning ? '扫描中…' : '开始扫描并导入' }}
        </button>
        <p class="scan-hint">
          只导入 .glb；同一路径重复扫描会自动跳过已导入的模型，单次最多 500 个。
          「选择…」打开应用内的文件夹选择器，可直接浏览磁盘目录。
        </p>
        <div v-if="scanResult" class="scan-result">
          <p class="mono" :title="scanResult.folder">{{ scanResult.folder }}</p>
          <p>
            发现 {{ scanResult.scanned }} 个 · 导入 {{ scanResult.created.length }} · 跳过
            {{ scanResult.skipped }} · 失败 {{ scanResult.failed.length }}
            <template v-if="scanResult.overflow > 0"> · 超上限 {{ scanResult.overflow }}</template>
          </p>
          <ul v-if="scanResult.failed.length > 0" class="scan-failed">
            <li v-for="item in scanResult.failed.slice(0, 5)" :key="item.path" :title="item.path">
              {{ item.name }}：{{ item.error }}
            </li>
          </ul>
        </div>
      </div>

      <!-- 批量修正中心点 / 朝向（多选） -->
      <div class="batch-bar" :class="{ active: selecting }">
        <div class="batch-head">
          <button class="mini batch-toggle" :class="{ on: selecting }" type="button" @click="toggleSelecting">
            <Icon :name="selecting ? 'check' : 'grid'" :size="11" />
            {{ selecting ? '退出多选' : '批量修正' }}
          </button>
          <template v-if="selecting">
            <span class="batch-count">已选 {{ selectedCount }}</span>
            <button class="mini" type="button" title="选中当前页全部素材" @click="selectCurrentPage">全选本页</button>
            <button class="mini" type="button" title="清空选择" @click="clearSelection">清空</button>
          </template>
        </div>
        <template v-if="selecting">
          <div class="batch-controls">
            <label class="batch-field">
              <span>中心点</span>
              <select v-model="pivotMode" class="batch-select">
                <option value="none">保持不动</option>
                <option value="center">包围盒中心</option>
                <option value="bottom">底部中心（贴地）</option>
              </select>
            </label>
            <label class="batch-field">
              <span>朝向</span>
              <select v-model="yawMode" class="batch-select">
                <option value="auto">自动纠正</option>
                <option value="0">不修改</option>
                <option value="90">+90°</option>
                <option value="-90">-90°</option>
                <option value="180">180°</option>
              </select>
            </label>
          </div>
          <button class="btn batch-apply" type="button" :disabled="transformDisabled" @click="applyTransform">
            <Icon :name="store.transforming ? 'refresh' : 'rotate'" :size="12" :class="{ spin: store.transforming }" />
            {{ store.transforming ? '处理中…' : `应用到 ${selectedCount} 个模型` }}
          </button>
          <p class="batch-hint">
            直接改写模型文件（只调整根节点变换，不破坏骨骼与材质）；完成后会自动重渲染封面。
          </p>
        </template>
      </div>

      <!-- 上传进度 -->
      <div v-if="store.uploadQueue.length > 0" class="upload-panel">
        <div class="upload-head">
          <span class="section-title">
            <Icon name="upload" :size="12" />
            {{ store.uploading ? '上传中' : '上传结果' }}
            {{ store.uploadQueue.filter((item) => item.status === 'done').length }}/{{ store.uploadQueue.length }}
            <span v-if="store.uploading" class="mono faint">{{ uploadProgress }}%</span>
          </span>
          <div class="upload-actions">
            <button
              v-if="store.uploading"
              class="mini danger"
              type="button"
              title="取消本次上传（已暂存文件会清理）"
              @click="store.cancelUpload()"
            >
              <Icon name="ban" :size="11" />
              取消
            </button>
            <button v-else class="mini" type="button" title="收起" @click="store.clearUploadQueue()">
              <Icon name="close" :size="11" />
            </button>
          </div>
        </div>
        <ul class="upload-list">
          <li v-for="item in store.uploadQueue" :key="item.key" class="upload-item" :class="item.status">
            <Icon
              :name="
                item.status === 'error'
                  ? 'alert'
                  : item.status === 'done'
                    ? 'check'
                    : item.status === 'canceled'
                      ? 'ban'
                      : 'refresh'
              "
              :size="11"
              :class="{ spin: item.status === 'uploading' }"
            />
            <span class="upload-name" :title="item.name">{{ item.name }}</span>
            <span v-if="item.status === 'uploading'" class="upload-status mono">{{ item.progress }}%</span>
            <span v-else class="upload-status">{{ item.error ?? statusText(item.status) }}</span>
            <span v-if="item.status === 'uploading'" class="upload-bar">
              <span class="upload-bar-fill" :style="{ width: `${item.progress}%` }" />
            </span>
          </li>
        </ul>
      </div>

      <p v-if="filteredJobs.length === 0" class="empty">
        {{
          store.jobs.length === 0
            ? '还没有素材：可上传本地模型，或在左侧生成一个'
            : '没有匹配的素材'
        }}
      </p>

      <article
        v-for="job in pagedJobs"
        :key="job.id"
        class="card"
        :class="{
          selected: store.selectedId === job.id,
          picking: selecting,
          picked: selectedIds.has(job.id),
        }"
        @click="onCardClick(job)"
      >
        <div class="thumb-wrap">
          <img v-if="thumbnailOf(job)" class="thumb" :src="thumbnailOf(job)!" :alt="job.name" loading="lazy" />
          <div v-else class="thumb placeholder">
            <Icon
              :name="job.input.mode === 'upload' ? 'upload' : job.input.mode === 'text' ? 'text' : 'image'"
              :size="20"
            />
          </div>

          <!-- 多选勾选标记（点卡片任意位置都能切换） -->
          <span v-if="selecting" class="pick" :class="{ on: selectedIds.has(job.id) }">
            <Icon v-if="selectedIds.has(job.id)" name="check" :size="10" />
          </span>

          <span v-if="job.origin === 'uploaded'" class="badge badge-upload">
            <Icon name="upload" :size="10" />
            上传
          </span>
          <span v-else-if="isActive(job.phase)" class="badge badge-active">
            <Icon name="refresh" :size="10" class="spin" />
            {{ PHASE_LABEL[job.phase] }}
          </span>
          <span v-else-if="job.phase === 'failed'" class="badge badge-failed">失败</span>
          <span v-else-if="job.phase === 'canceled'" class="badge">已取消</span>
          <span v-else class="badge badge-done">
            <Icon name="check" :size="10" />
            完成
          </span>
        </div>

        <div class="card-body">
          <input
            v-if="renamingId === job.id"
            :ref="setRenameInput"
            v-model="renameValue"
            class="rename-input"
            @click.stop
            @keydown.enter="commitRename(job)"
            @keydown.esc="cancelRename"
            @blur="commitRename(job)"
          />
          <p v-else class="card-name" :title="job.name" @dblclick.stop="startRename(job)">{{ job.name }}</p>
          <p class="card-meta">
            <template v-if="job.origin === 'uploaded'">
              <span>{{ (job.asset?.files[0]?.format ?? 'file').toUpperCase() }}</span>
              <span>{{ job.asset?.files[0]?.entries.length ?? 0 }} 项</span>
            </template>
            <template v-else>
              <span>{{ durationOf(job) }}</span>
              <span v-if="job.asset">{{ job.asset.files.length }} 个文件</span>
              <span v-else class="faint">
                {{ store.providerLabel(job.params.provider) }} · {{ job.params.model || '默认' }}
              </span>
            </template>
          </p>
        </div>

        <div class="card-actions">
          <button
            v-if="isActive(job.phase)"
            class="mini"
            type="button"
            title="取消任务"
            @click.stop="store.cancel(job.id)"
          >
            <Icon name="ban" :size="12" />
          </button>
          <button
            v-else-if="job.phase === 'failed' || job.phase === 'canceled'"
            class="mini"
            type="button"
            title="重试"
            @click.stop="store.retry(job.id)"
          >
            <Icon name="refresh" :size="12" />
          </button>
          <template v-else-if="job.asset">
            <button class="mini" type="button" title="下载主文件" @click.stop="primaryDownload(job)">
              <Icon name="download" :size="12" />
            </button>
            <button class="mini" type="button" title="下载全部文件" @click.stop="downloadAll(job)">
              <Icon name="layers" :size="12" />
            </button>
          </template>
          <!-- 显式重命名入口：双击名称同样可以改名 -->
          <button class="mini" type="button" title="重命名" @click.stop="startRename(job)">
            <Icon name="edit" :size="12" />
          </button>
          <button
            v-if="job.origin !== 'uploaded'"
            class="mini"
            type="button"
            title="用相同参数新建"
            @click.stop="store.reuseParams(job)"
          >
            <Icon name="copy" :size="12" />
          </button>
          <button
            v-if="job.asset"
            class="mini"
            type="button"
            :disabled="store.regeneratingCovers.has(job.id)"
            :title="store.regeneratingCovers.has(job.id) ? '封面生成中…' : '重新生成封面（后端渲染）'"
            @click.stop="store.regenerateCover(job.id)"
          >
            <Icon name="refresh" :size="12" :class="{ spin: store.regeneratingCovers.has(job.id) }" />
          </button>
          <button class="mini danger" type="button" title="删除" @click.stop="confirmRemove(job)">
            <Icon name="trash" :size="12" />
          </button>
        </div>
      </article>
    </div>

    <!-- 分页：只渲染当前页的卡片，素材多了也不会把 DOM / 图片请求打满 -->
    <div v-if="filteredJobs.length > 0" class="pager">
      <select v-model.number="pageSize" class="page-size" aria-label="每页数量">
        <option v-for="size in PAGE_SIZES" :key="size" :value="size">每页 {{ size }}</option>
      </select>
      <div class="page-buttons">
        <button class="page-btn" type="button" :disabled="page <= 1" title="上一页" @click="goPage(page - 1)">
          <Icon name="chevronRight" :size="12" class="flip" />
        </button>
        <button
          v-for="value in pageNumbers"
          :key="value"
          class="page-btn"
          :class="{ active: value === page }"
          type="button"
          @click="goPage(value)"
        >
          {{ value }}
        </button>
        <button class="page-btn" type="button" :disabled="page >= pageCount" title="下一页" @click="goPage(page + 1)">
          <Icon name="chevronRight" :size="12" />
        </button>
      </div>
      <span class="page-info mono">{{ page }}/{{ pageCount }} · 共 {{ filteredJobs.length }}</span>
    </div>

    <!-- 拖拽上传提示 -->
    <div v-if="dragging" class="drop-overlay">
      <Icon name="upload" :size="26" />
      <p class="drop-title">松开即可上传</p>
      <p class="drop-hint">
        支持 {{ store.uploadInfo.acceptedExtensions.slice(0, 8).map((e) => e.toUpperCase()).join(' / ') }}
        等，单文件 ≤ {{ maxSizeLabel }}，可多选批量上传
      </p>
      <p class="drop-hint faint">{{ store.uploadInfo.hint }}</p>
    </div>

    <!-- 应用内文件夹选择器（与动画工作区共用同一个组件，这里统计 .glb 数量） -->
    <FolderPicker
      :open="picking"
      :start-dir="scanDir"
      title="选择要扫描的文件夹"
      ext="glb"
      @close="picking = false"
      @pick="onScanDirPicked"
    />
  </aside>
</template>

<style scoped>
.library {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.title {
  min-width: 0;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.thumb-btn {
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-dim);
}

.upload-btn {
  height: 26px;
  padding: 0 9px;
  font-size: 12px;
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-hover);
}

.upload-btn:hover:not(:disabled) {
  background: rgba(124, 92, 255, 0.26);
  border-color: transparent;
}

.scan-btn {
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-dim);
}

/* ===== 扫描文件夹导入 ===== */
.scan-panel {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
}

/* 路径输入框与「选择…」按钮同一行 */
.scan-row {
  display: flex;
  gap: 6px;
}

.scan-row .scan-input {
  flex: 1;
  min-width: 0;
}

/* 调起系统文件夹选择窗口 */
.scan-pick {
  flex: none;
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
  white-space: nowrap;
}

.scan-input {
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
  font-size: 11px;
  outline: none;
}

.scan-input:focus {
  border-color: var(--accent);
}

.scan-option {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--text-dim);
}

.scan-run {
  height: 26px;
  font-size: 11.5px;
}

.scan-hint {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-faint);
}

.scan-result {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 6px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  font-size: 10px;
  color: var(--text-dim);
}

.scan-result p {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scan-failed {
  margin: 0;
  padding-left: 14px;
  color: var(--danger);
}

.scan-failed li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 批量修正中心点 / 朝向 ===== */
.batch-bar {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
}

.batch-bar.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.batch-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.batch-head .mini {
  flex: none;
  width: auto;
  padding: 0 6px;
  gap: 3px;
}

.batch-toggle.on {
  border-color: var(--accent);
  background: transparent;
  color: var(--accent-hover);
}

.batch-count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-dim);
  white-space: nowrap;
}

.batch-controls {
  display: flex;
  gap: 6px;
}

.batch-field {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-dim);
}

.batch-select {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 10.5px;
}

.batch-apply {
  height: 24px;
  font-size: 11px;
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-hover);
}

.batch-apply:hover:not(:disabled) {
  background: rgba(124, 92, 255, 0.26);
}

.batch-hint {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-faint);
}

.file-input {
  display: none;
}

/* ===== 上传进度 ===== */
.upload-panel {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
}

.upload-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.upload-head .mini {
  flex: none;
  width: 18px;
  height: 18px;
}

.upload-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 取消上传按钮带文字，宽一点 */
.upload-head .upload-actions .mini:first-child {
  width: auto;
  padding: 0 6px;
  gap: 3px;
}

.upload-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 96px;
  overflow-y: auto;
}

.upload-item {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  font-size: 10.5px;
  color: var(--text-dim);
}

.upload-bar {
  flex: 0 0 100%;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}

.upload-bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.15s linear;
}

.upload-item.error {
  color: var(--danger);
}

.upload-item.done {
  color: var(--success);
}

.upload-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-status {
  flex: none;
  max-width: 44%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}

/* ===== 拖拽上传覆盖层 ===== */
.drop-overlay {
  position: absolute;
  inset: 8px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  text-align: center;
  border: 2px dashed var(--accent);
  border-radius: var(--radius);
  background: rgba(124, 92, 255, 0.14);
  backdrop-filter: blur(4px);
  pointer-events: none;
  color: var(--accent-hover);
}

.drop-title {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.drop-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}

.title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
  font-size: 13px;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-faint);
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
}

.search-input::-webkit-search-cancel-button {
  filter: invert(0.6);
}

.filters {
  display: flex;
  gap: 4px;
}

.filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
}

.filter:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.filter.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.filter-count {
  font-family: var(--mono);
  font-size: 10px;
  opacity: 0.8;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px;
  display: grid;
  /* 固定两列：minmax(0, 1fr) 允许轨道收缩，避免长名称撑宽后把第二列挤出面板 */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  align-content: start;
}

.empty {
  grid-column: 1 / -1;
  margin: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
}

/* ===== 分页 ===== */
.pager {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel-2);
}

.page-size {
  flex: none;
  height: 22px;
  padding: 0 4px;
  font-size: 10.5px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}

.page-buttons {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 0;
}

.page-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 10.5px;
}

.page-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.page-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.page-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.page-btn .flip {
  transform: rotate(180deg);
}

.page-info {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel-2);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
  /* 新增卡片自动换行到下一行 */
  grid-column: auto;
}

.card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.card.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 多选模式：点卡片即勾选 */
.card.picked {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.pick {
  position: absolute;
  right: 4px;
  top: 4px;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.55);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
}

.pick.on {
  border-color: var(--accent);
  background: var(--accent);
}

.thumb-wrap {
  position: relative;
  aspect-ratio: 1 / 1;
  width: 100%;
  min-width: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #14151a;
}

.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  background: repeating-conic-gradient(#22232a 0% 25%, #1c1d23 0% 50%) 50% / 12px 12px;
}

.badge {
  position: absolute;
  left: 4px;
  top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  background: rgba(0, 0, 0, 0.66);
  color: #e5e7eb;
  backdrop-filter: blur(4px);
}

.badge-active {
  color: #bfdbfe;
}

.badge-upload {
  color: #ddd6fe;
}

.badge-done {
  color: #86efac;
}

.badge-failed {
  color: #fca5a5;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.card-name {
  margin: 0;
  font-size: 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  margin: 0;
  min-width: 0;
  font-size: 10px;
  color: var(--text-faint);
}

.card-meta > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rename-input {
  width: 100%;
  min-width: 0;
  height: 18px;
  padding: 0 3px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg-app);
  font-size: 11px;
  outline: none;
}

.card-actions {
  display: flex;
  gap: 3px;
  min-width: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.card:hover .card-actions,
.card.selected .card-actions {
  opacity: 1;
}

.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  min-width: 0;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-dim);
}

.mini:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.mini.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.4);
}
</style>
