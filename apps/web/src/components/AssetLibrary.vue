<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import Icon from './ui/Icon.vue';
import { downloadUrl } from '@/api/client';
import { useWorkspaceStore, isActive } from '@/stores/workspace';
import { useNow } from '@/composables/useNow';
import { formatDuration } from '@/utils/image';
import type { Job } from '@/api/types';

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

const visibleJobs = computed(() => {
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
  if (!window.confirm(`确定删除「${job.name}」？本地转存的模型文件会一并删除。`)) return;
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
  return '失败';
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
      <!-- 上传进度 -->
      <div v-if="store.uploadQueue.length > 0" class="upload-panel">
        <div class="upload-head">
          <span class="section-title">
            <Icon name="upload" :size="12" />
            上传中
            {{ store.uploadQueue.filter((item) => item.status === 'done').length }}/{{ store.uploadQueue.length }}
          </span>
          <button class="mini" type="button" title="收起" @click="store.clearUploadQueue()">
            <Icon name="close" :size="11" />
          </button>
        </div>
        <ul class="upload-list">
          <li v-for="item in store.uploadQueue" :key="item.key" class="upload-item" :class="item.status">
            <Icon
              :name="item.status === 'error' ? 'alert' : item.status === 'done' ? 'check' : 'refresh'"
              :size="11"
              :class="{ spin: item.status === 'uploading' }"
            />
            <span class="upload-name" :title="item.name">{{ item.name }}</span>
            <span class="upload-status">{{ item.error ?? statusText(item.status) }}</span>
          </li>
        </ul>
      </div>

      <p v-if="visibleJobs.length === 0" class="empty">
        {{
          store.jobs.length === 0
            ? '还没有素材：可上传本地模型，或在左侧生成一个'
            : '没有匹配的素材'
        }}
      </p>

      <article
        v-for="job in visibleJobs"
        :key="job.id"
        class="card"
        :class="{ selected: store.selectedId === job.id }"
        @click="store.select(job.id)"
      >
        <div class="thumb-wrap">
          <img v-if="thumbnailOf(job)" class="thumb" :src="thumbnailOf(job)!" :alt="job.name" loading="lazy" />
          <div v-else class="thumb placeholder">
            <Icon
              :name="job.input.mode === 'upload' ? 'upload' : job.input.mode === 'text' ? 'text' : 'image'"
              :size="20"
            />
          </div>

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
          <button
            v-if="job.origin !== 'uploaded'"
            class="mini"
            type="button"
            title="用相同参数新建"
            @click.stop="store.reuseParams(job)"
          >
            <Icon name="copy" :size="12" />
          </button>
          <button class="mini danger" type="button" title="删除" @click.stop="confirmRemove(job)">
            <Icon name="trash" :size="12" />
          </button>
        </div>
      </article>
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
  font-size: 10.5px;
  color: var(--text-dim);
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
