<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './ui/Icon.vue';
import { downloadUrl } from '@/api/client';
import { useWorkspaceStore, isActive } from '@/stores/workspace';
import { useNow } from '@/composables/useNow';
import { formatDuration } from '@/utils/image';

const store = useWorkspaceStore();
const now = useNow(1000);
const exportOpen = ref(false);

const job = computed(() => store.selectedJob);
const asset = computed(() => store.selectedAsset);
const active = computed(() => (job.value && isActive(job.value.phase) ? job.value : null));

const PHASE_TEXT: Record<string, string> = {
  queued: '排队中',
  submitting: '提交中',
  running: '生成中',
  downloading: '转存中',
  done: '已完成',
  failed: '生成失败',
  canceled: '已取消',
};

const elapsed = computed(() => {
  if (!job.value?.startedAt) return null;
  const end = job.value.finishedAt ? new Date(job.value.finishedAt).getTime() : now.value;
  return formatDuration(end - new Date(job.value.startedAt).getTime());
});

const exportableFiles = computed(() => asset.value?.files ?? []);

function exportFile(url: string | null): void {
  if (!url) {
    store.toast('error', '该文件不可下载');
    return;
  }
  exportOpen.value = false;
  downloadUrl(url, true);
}

function toggleExport(): void {
  if (exportableFiles.value.length === 0) {
    store.toast('error', '还没有可导出的文件');
    return;
  }
  exportOpen.value = !exportOpen.value;
}
</script>

<template>
  <footer class="taskbar">
    <div class="left">
      <template v-if="job">
        <span class="status-dot" :class="`dot-${job.phase}`" />
        <span class="name">{{ job.name }}</span>
        <span class="chip" :class="active ? 'chip-info' : job.phase === 'done' ? 'chip-success' : 'chip-danger'">
          {{ PHASE_TEXT[job.phase] ?? job.phase }}
        </span>
        <span v-if="elapsed" class="meta">
          <Icon name="clock" :size="11" />
          {{ elapsed }}
        </span>
        <span v-if="job.remoteJobId" class="meta mono faint">JobId {{ job.remoteJobId }}</span>
        <span v-if="job.asset?.creditConsumed" class="meta">积分 {{ job.asset.creditConsumed }}</span>
      </template>
      <template v-else>
        <span class="meta faint">未选择素材 · 共 {{ store.totalJobs }} 个生成记录</span>
      </template>
    </div>

    <div class="right">
      <template v-if="active">
        <button class="btn" type="button" @click="store.cancel(active.id)">
          <Icon name="ban" :size="13" />
          取消
        </button>
      </template>
      <template v-else-if="job && (job.phase === 'failed' || job.phase === 'canceled')">
        <button class="btn" type="button" @click="store.retry(job.id)">
          <Icon name="refresh" :size="13" />
          {{ job.remoteFailed ? '重新生成（再次计费）' : '重试（续查远端任务）' }}
        </button>
      </template>

      <button
        v-if="job && job.phase === 'done' && job.origin !== 'uploaded'"
        class="btn"
        type="button"
        @click="store.reuseParams(job)"
      >
        <Icon name="copy" :size="13" />
        复用参数
      </button>

      <div class="export">
        <button class="btn btn-primary" type="button" :disabled="exportableFiles.length === 0" @click="toggleExport">
          <Icon name="download" :size="13" />
          导出
          <Icon name="chevron" :size="12" />
        </button>
        <div v-if="exportOpen" class="export-menu" @mouseleave="exportOpen = false">
          <p class="export-title">选择要下载的文件</p>
          <button
            v-for="file in exportableFiles"
            :key="file.type"
            type="button"
            class="export-item"
            @click="exportFile(file.primaryUrl ?? file.entries[0]?.url ?? null)"
          >
            <Icon name="cube" :size="13" />
            <span class="export-name">{{ file.type }}<span v-if="file.wasZip" class="faint"> (zip)</span></span>
            <span class="mono faint">{{ file.entries.length }} 项</span>
          </button>
          <button
            v-for="file in exportableFiles.flatMap((item) =>
              item.entries.filter((entry) => entry.role !== 'model').slice(0, 4),
            )"
            :key="file.url"
            type="button"
            class="export-item sub"
            @click="exportFile(file.url)"
          >
            <Icon :name="file.role === 'texture' ? 'image' : 'layers'" :size="12" />
            <span class="export-name">{{ file.name }}</span>
          </button>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.taskbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  padding: 0 16px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
}

.left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}

.dot-queued,
.dot-submitting,
.dot-running,
.dot-downloading {
  background: #60a5fa;
  box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.18);
}

.dot-done {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}

.dot-failed {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-soft);
}

.name {
  font-weight: 600;
  font-size: 13px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim);
}

.right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.export {
  position: relative;
}

.export-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 260px;
  padding: 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
  z-index: 20;
  max-height: 320px;
  overflow-y: auto;
}

.export-title {
  margin: 2px 4px 6px;
  font-size: 11px;
  color: var(--text-faint);
}

.export-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
}

.export-item:hover {
  background: var(--bg-hover);
}

.export-item.sub {
  color: var(--text-dim);
  font-size: 11px;
  padding-left: 16px;
}

.export-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
