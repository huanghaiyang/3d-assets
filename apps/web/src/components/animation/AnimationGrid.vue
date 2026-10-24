<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import { useAnimationStore } from '@/stores/animation';
import type { NewAnimationProject } from '@/stores/animation';
import { highlightSegments } from '@/utils/fuzzy';
import type { AnimationFile } from '@/api/animation';

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
        const path = (entry.target as HTMLElement).dataset.path;
        const file = store.files.find((item) => item.path === path);
        if (file) store.requestThumbnail(file);
      }
    },
    { root: listRef.value, rootMargin: '120px' },
  );
  for (const card of listRef.value.querySelectorAll('.anim-card')) observer.observe(card);
}

watch(files, () => {
  requestAnimationFrame(setupObserver);
});

onMounted(() => setupObserver());

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

function pick(file: AnimationFile): void {
  void store.select(file);
}

/** 只有新建动画允许删除；原有 FBX 卡片没有删除入口 */
function removeProject(project: NewAnimationProject): void {
  const hint = project.saved ? '该项目已保存到服务端，删除后无法恢复。' : '已导入的动画数据会一并清除。';
  if (!window.confirm(`确定删除「${project.name}」？${hint}`)) return;
  store.deleteNewAnimation(project.id);
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
          <span class="section-hint">仅新建动画可删除</span>
        </div>
        <div class="grid">
          <div
            v-for="project in store.newAnimations"
            :key="project.id"
            class="anim-card new-card"
            :class="{ active: store.activeNewAnimationId === project.id }"
            :data-path="project.basePath"
            :title="`模型 ${project.baseName}${project.imported ? ` · ${project.imported.name}` : ' · 无动画数据'}`"
          >
            <button class="card-select" type="button" @click="store.selectNewAnimation(project.id)">
              <div class="thumb">
                <img
                  v-if="store.thumbnails[project.basePath]"
                  :src="store.thumbnails[project.basePath]"
                  :alt="project.name"
                />
                <div v-else class="thumb-placeholder">
                  <Icon name="film" :size="18" />
                </div>
                <span class="new-badge" :class="{ dirty: project.dirty }">{{ projectStatus(project) }}</span>
              </div>
              <span class="name">{{ project.name }}</span>
              <span class="name-sub" :title="project.baseName">
                {{ project.baseName }} · {{ project.imported ? project.imported.name : '无动画数据' }}
              </span>
            </button>
            <button class="card-delete" type="button" title="删除新建动画" @click.stop="removeProject(project)">
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
        <button
          v-for="file in files"
          :key="file.path"
          class="anim-card"
          :class="{ active: isSelected(file) }"
          type="button"
          :data-path="file.path"
          :title="`${file.sourceLabel} / ${file.relative}`"
          @click="pick(file)"
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
          </div>
          <span class="name" :title="file.relative">
            <span
              v-for="(segment, index) in nameSegments(file)"
              :key="index"
              :class="{ 'name-hit': segment.hit }"
              >{{ segment.text }}</span
            >
          </span>
        </button>
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

.card-delete {
  position: absolute;
  right: 4px;
  top: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: rgba(12, 14, 20, 0.78);
  color: #cbd5e1;
  opacity: 0.7;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.new-card:hover .card-delete,
.new-card.active .card-delete {
  opacity: 1;
}

.card-delete:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.anim-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel-2);
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease;
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
