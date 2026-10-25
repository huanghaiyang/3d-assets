<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import { useAnimationStore } from '@/stores/animation';
import type { NewAnimationProject } from '@/stores/animation';
import { highlightSegments } from '@/utils/fuzzy';
import type { AnimationFile } from '@/api/animation';
import { confirmAction } from '@/composables/useConfirm';

const store = useAnimationStore();
const listRef = ref<HTMLDivElement | null>(null);
let observer: IntersectionObserver | null = null;

/** 只渲染当前页，因此观察器天然只给当前页生成封面 */
const files = computed(() => store.pagedFiles);

function setupObserver(): void {
  observer?.disconnect();
  if (!listRef.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        // 动画库卡片是文件路径，新建动画卡片是 project:<id>（由 store 区分）
        const key = (entry.target as HTMLElement).dataset.path;
        if (key) store.requestCover(key);
      }
    },
    { root: listRef.value, rootMargin: '120px' },
  );
  for (const card of listRef.value.querySelectorAll('.anim-card')) observer.observe(card);
}

watch(files, () => {
  requestAnimationFrame(setupObserver);
});

// 新建动画的封面 key 会随「保存/新增/删除」变化（basePath → project:<id>），重新观察一遍
watch(
  () => store.newAnimations,
  () => {
    requestAnimationFrame(setupObserver);
  },
);

onMounted(() => setupObserver());

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

function pick(file: AnimationFile): void {
  void store.select(file);
}

// ===== 新建动画：内联改名 =====
const renamingId = ref<string | null>(null);
const renameDraft = ref('');

/** 输入框挂载后立即聚焦并全选，减少一次点击 */
function focusRenameInput(el: unknown): void {
  if (!(el instanceof HTMLInputElement)) return;
  el.focus();
  el.select();
}

function startRename(project: NewAnimationProject): void {
  renamingId.value = project.id;
  renameDraft.value = project.name;
}

function cancelRename(): void {
  renamingId.value = null;
}

/** Enter / 失焦提交；重名或为空时保留输入框便于继续修改 */
async function commitRename(project: NewAnimationProject): Promise<void> {
  if (renamingId.value !== project.id) return;
  const name = renameDraft.value;
  renamingId.value = null;
  const ok = await store.renameNewAnimation(project.id, name);
  if (!ok) {
    renamingId.value = project.id;
    renameDraft.value = name;
  }
}

function formatDeleted(value?: string): string {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 只有新建动画允许删除；原有 FBX 卡片没有删除入口 */
async function removeProject(project: NewAnimationProject): Promise<void> {
  const detail = project.saved
    ? '已保存的项目会移入回收站，之后仍可恢复。'
    : '该动画尚未保存，移除后无法找回。';
  const ok = await confirmAction({
    title: project.saved ? '移入回收站' : '移除新建动画',
    message: `确定删除「${project.name}」？`,
    detail,
    confirmText: project.saved ? '移入回收站' : '移除',
  });
  if (!ok) return;
  store.deleteNewAnimation(project.id);
}

/** 彻底删除回收站里的项目（不可恢复） */
async function purgeProject(project: NewAnimationProject): Promise<void> {
  const ok = await confirmAction({
    title: '彻底删除',
    message: `确定彻底删除「${project.name}」？`,
    detail: '该项目的数据文件会从回收站中永久移除，无法再恢复。',
    confirmText: '彻底删除',
  });
  if (!ok) return;
  void store.purgeFromTrash(project.id);
}

/** 卡片角标：新建 / 未保存 / 已保存 */
function projectStatus(project: NewAnimationProject): string {
  if (project.dirty) return project.saved ? '未保存' : '新建';
  return '已保存';
}

function isSelected(file: AnimationFile): boolean {
  return store.selectedPath === file.path;
}

function thumbOf(file: AnimationFile): string | undefined {
  return store.thumbnails[file.path];
}

/** 名称按模糊命中位置切段，命中处高亮 */
function nameSegments(file: AnimationFile): { text: string; hit: boolean }[] {
  const indices = store.matchIndices.get(file.path);
  if (!indices || indices.length === 0) return [{ text: file.relative, hit: false }];
  return highlightSegments(file.relative, indices);
}

const searching = computed(() => store.keyword.trim().length > 0);

/** 页码窗口：当前页附近最多 7 个 */
const pageItems = computed(() => {
  const total = store.totalPages;
  const current = store.page;
  const items: number[] = [];
  const start = Math.max(1, Math.min(current - 3, total - 6));
  const end = Math.min(total, Math.max(current + 3, 7));
  for (let index = start; index <= end; index += 1) items.push(index);
  return items;
});

function onPageSize(event: Event): void {
  store.setPageSize(Number((event.target as HTMLSelectElement).value));
}
</script>

<template>
  <aside class="anim-library">
    <header class="head">
      <div class="title">
        <Icon name="film" :size="15" />
        <span>动画库</span>
        <span class="chip">{{ store.filteredFiles.length }}</span>
      </div>
      <div class="actions">
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          :disabled="store.refreshingCovers"
          :title="store.refreshingCovers ? '正在重新生成封面…' : '重新生成本页封面（服务端重渲染并覆盖缓存）'"
          @click="store.refreshPageCovers()"
        >
          <Icon name="refresh" :size="14" :class="{ spin: store.refreshingCovers }" />
        </button>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          title="加载本页封面（后端渲染，缓存于服务端）"
          @click="store.generatePageThumbnails()"
        >
          <Icon name="image" :size="14" />
        </button>
      </div>
    </header>

    <div class="toolbar">
      <div class="search">
        <Icon name="search" :size="13" />
        <input
          v-model="store.keyword"
          class="search-input"
          type="search"
          placeholder="模糊搜索：缩写 cuw、多词 standard walk"
        />
        <button v-if="searching" class="search-clear" type="button" title="清空" @click="store.keyword = ''">
          <Icon name="close" :size="11" />
        </button>
      </div>
      <div class="filter-row">
        <select v-if="store.folderOptions.length > 1" v-model="store.folderFilter" class="folder-select">
          <option :value="store.ALL_FOLDERS">全部文件夹（{{ store.files.length }}）</option>
          <option v-for="option in store.folderOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>        <span class="page-info">第 {{ store.page }}/{{ store.totalPages }} 页 · 本页 {{ files.length }} 个</span>
      </div>
    </div>

    <div ref="listRef" class="grid-wrap">
      <section v-if="store.newAnimations.length > 0" class="new-section">
        <div class="section-head">
          <Icon name="plus" :size="11" />
          <span>新建动画</span>
          <span class="chip">{{ store.newAnimations.length }}</span>
        </div>
        <div class="grid">
          <div
            v-for="project in store.newAnimations"
            :key="project.id"
            class="anim-card new-card"
            :class="{ active: store.activeNewAnimationId === project.id }"
            :data-path="store.projectCoverKey(project)"
            :title="`模型 ${project.baseName}${project.imported ? ` · ${project.imported.name}` : ' · 无动画数据'}`"
          >
            <button class="card-select" type="button" @click="store.selectNewAnimation(project.id)">
              <div class="thumb">
                <img
                  v-if="store.thumbnails[store.projectCoverKey(project)]"
                  :src="store.thumbnails[store.projectCoverKey(project)]"
                  :alt="project.name"
                />
                <div v-else class="thumb-placeholder">
                  <Icon name="film" :size="18" />
                </div>
                <span class="new-badge" :class="{ dirty: project.dirty }">{{ projectStatus(project) }}</span>
              </div>
            </button>
            <form
              v-if="renamingId === project.id"
              class="rename-form"
              @submit.prevent="commitRename(project)"
            >
              <input
                :ref="focusRenameInput"
                v-model="renameDraft"
                class="rename-input"
                type="text"
                maxlength="80"
                placeholder="输入新名称"
                @keydown.esc.stop.prevent="cancelRename"
                @blur="commitRename(project)"
              />
            </form>
            <template v-else>
              <span class="name" :title="project.name">{{ project.name }}</span>
              <span class="name-sub" :title="project.baseName">
                {{ project.baseName }} · {{ project.imported ? project.imported.name : '无动画数据' }}
              </span>
            </template>
            <div class="card-actions">
              <button
                class="card-icon"
                type="button"
                :disabled="store.isRefreshingCover(store.projectCoverKey(project))"
                title="重新生成封面（按当前动画数据取姿势）"
                @click.stop="store.refreshProjectCover(project)"
              >
                <Icon
                  name="refresh"
                  :size="12"
                  :class="{ spin: store.isRefreshingCover(store.projectCoverKey(project)) }"
                />
              </button>
              <button class="card-icon" type="button" title="重命名" @click.stop="startRename(project)">
                <Icon name="edit" :size="12" />
              </button>
              <button class="card-icon" type="button" title="移入回收站" @click.stop="removeProject(project)">
                <Icon name="trash" :size="12" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="store.trashOpen" class="new-section trash-section">
        <div class="section-head">
          <Icon name="trash" :size="11" />
          <span>回收站</span>
          <span class="chip">{{ store.trashProjects.length }}</span>
          <span class="section-hint">可只读预览 · 恢复后回到新建动画</span>
        </div>
        <p v-if="store.trashLoading" class="state">读取回收站…</p>
        <p v-else-if="store.trashProjects.length === 0" class="state">回收站是空的</p>
        <div v-else class="trash-list">
          <div
            v-for="item in store.trashProjects"
            :key="item.id"
            class="trash-item"
            :class="{ previewing: store.trashPreviewId === item.id }"
          >
            <div class="trash-main">
              <span class="name" :title="item.name">
                {{ item.name }}
                <span v-if="store.trashPreviewId === item.id" class="preview-badge">预览中</span>
              </span>
              <span class="name-sub" :title="item.baseName">
                {{ item.baseName }} · 删除于 {{ formatDeleted(item.deletedAt) }}
              </span>
            </div>
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              title="在 3D 视口中只读预览（不恢复、不可编辑）"
              :disabled="!item.hasData"
              @click="store.previewTrashProject(item.id)"
            >
              <Icon name="play" :size="12" />
            </button>
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              title="恢复到新建动画"
              @click="store.restoreFromTrash(item.id)"
            >
              <Icon name="restore" :size="12" />
            </button>
            <button
              class="btn btn-ghost btn-icon danger"
              type="button"
              title="彻底删除（不可恢复）"
              @click="purgeProject(item)"
            >
              <Icon name="trash" :size="12" />
            </button>
          </div>
        </div>
      </section>

      <p v-if="store.loading" class="state">扫描文件夹中…</p>
      <p v-else-if="store.loadError" class="state error">{{ store.loadError }}</p>
      <p v-else-if="store.filteredFiles.length === 0" class="state">
        {{
          store.files.length === 0
            ? '这些文件夹里没有 .fbx 文件'
            : `没有匹配「${store.keyword}」的动画`
        }}
      </p>
      <p v-if="store.truncated" class="state warn">文件过多，仅显示前一部分</p>

      <div class="grid">
        <div
          v-for="file in files"
          :key="file.path"
          class="anim-card"
          :class="{ active: isSelected(file) }"
          role="button"
          tabindex="0"
          :data-path="file.path"
          :title="`${file.sourceLabel} / ${file.relative}`"
          @click="pick(file)"
          @keydown.enter.prevent="pick(file)"
          @keydown.space.prevent="pick(file)"
        >
          <div class="thumb">
            <img v-if="thumbOf(file)" :src="thumbOf(file)" :alt="file.name" />
            <div v-else class="thumb-placeholder">
              <Icon name="film" :size="18" />
            </div>
            <span v-if="store.folderOptions.length > 1" class="folder-badge">{{ file.sourceLabel }}</span>
            <span v-if="isSelected(file)" class="playing-badge">
              <Icon name="play" :size="9" />
              预览中
            </span>
            <!-- 单张封面重渲染：悬浮显示，不影响整页批量刷新 -->
            <button
              class="cover-refresh"
              type="button"
              :disabled="store.isRefreshingCover(file.path)"
              title="重新生成这张封面"
              @click.stop="store.refreshCover(file.path)"
            >
              <Icon name="refresh" :size="11" :class="{ spin: store.isRefreshingCover(file.path) }" />
            </button>
          </div>
          <span class="name" :title="file.relative">
            <span
              v-for="(segment, index) in nameSegments(file)"
              :key="index"
              :class="{ 'name-hit': segment.hit }"
              >{{ segment.text }}</span
            >
          </span>
        </div>
      </div>
    </div>

    <footer class="pager">
      <button class="pager-btn" type="button" :disabled="store.page <= 1" title="第一页" @click="store.setPage(1)">«</button>
      <button
        class="pager-btn"
        type="button"
        :disabled="store.page <= 1"
        title="上一页"
        @click="store.setPage(store.page - 1)"
      >
        ‹
      </button>
      <button
        v-for="item in pageItems"
        :key="item"
        class="pager-btn"
        :class="{ active: item === store.page }"
        type="button"
        @click="store.setPage(item)"
      >
        {{ item }}
      </button>
      <button
        class="pager-btn"
        type="button"
        :disabled="store.page >= store.totalPages"
        title="下一页"
        @click="store.setPage(store.page + 1)"
      >
        ›
      </button>
      <button
        class="pager-btn"
        type="button"
        :disabled="store.page >= store.totalPages"
        title="最后一页"
        @click="store.setPage(store.totalPages)"
      >
        »
      </button>
      <select class="page-size" :value="store.pageSize" title="每页数量" @change="onPageSize">
        <option v-for="size in store.pageSizes" :key="size" :value="size">{{ size }} / 页</option>
      </select>
    </footer>
  </aside>
</template>

<style scoped>
.anim-library {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
  font-size: 13px;
  min-width: 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  display: none;
}

.search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  border: none;
  border-radius: 50%;
  background: var(--bg-hover);
  color: var(--text-faint);
}

.search-clear:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.folder-select {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 11px;
}

.page-info {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}

.grid-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  gap: 8px;
}

.new-section {
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--border);
}

.section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}

.section-hint {
  margin-left: auto;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-faint);
}

.new-card {
  position: relative;
}

.card-select {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
}

.new-badge {
  position: absolute;
  left: 4px;
  top: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  background: rgba(124, 92, 255, 0.82);
  color: #fff;
}

.new-badge.dirty {
  background: rgba(217, 119, 6, 0.85);
}

.name-sub {
  font-size: 9.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-section {
  border-bottom: none;
}

.trash-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trash-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
}

/* 正在预览的回收站项目：左侧强调色描边，和普通行区分 */
.trash-item.previewing {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.preview-badge {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
}

.trash-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.trash-item .btn-icon.danger:hover {
  color: var(--danger);
  background: var(--danger-soft);
}

.card-actions {
  position: absolute;
  right: 4px;
  top: 4px;
  display: flex;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.new-card:hover .card-actions,
.new-card.active .card-actions {
  opacity: 1;
}

.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: rgba(12, 14, 20, 0.78);
  color: #cbd5e1;
  transition: background 0.15s ease, color 0.15s ease;
}

.card-icon:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.rename-form {
  display: flex;
  width: 100%;
}

.rename-input {
  width: 100%;
  min-width: 0;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
  font-size: 10.5px;
  outline: none;
}

.anim-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel-2);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.anim-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* 卡片右下角的单张封面重渲染按钮，只在悬浮/聚焦时出现 */
.cover-refresh {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: rgba(16, 17, 24, 0.82);
  color: var(--text-dim);
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease;
}

.anim-card:hover .cover-refresh,
.anim-card:focus-within .cover-refresh {
  opacity: 1;
}

.cover-refresh:hover {
  color: var(--text);
  border-color: var(--accent);
}

.anim-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.anim-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.thumb {
  position: relative;
  aspect-ratio: 1 / 1;
  width: 100%;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #171922;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-faint);
  background: repeating-conic-gradient(#1f2029 0% 25%, #1a1b23 0% 50%) 50% / 12px 12px;
}

.folder-badge {
  position: absolute;
  right: 4px;
  top: 4px;
  max-width: 70%;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  background: rgba(12, 14, 20, 0.72);
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playing-badge {
  position: absolute;
  left: 4px;
  top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  background: rgba(0, 0, 0, 0.68);
  color: #d8ccff;
}

.name {
  font-size: 10.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name-hit {
  color: var(--accent-hover);
  font-weight: 600;
  background: rgba(124, 92, 255, 0.18);
  border-radius: 2px;
}

.state {
  margin: 20px 4px;
  font-size: 12px;
  color: var(--text-faint);
  text-align: center;
}

.state.error {
  color: var(--danger);
}

.state.warn {
  color: var(--warn);
}

.pager {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.pager-btn {
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-dim);
  font-size: 11px;
}

.pager-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.pager-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.pager-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-size {
  margin-left: auto;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-dim);
  font-size: 11px;
}
</style>
