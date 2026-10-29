<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import { fsApi, type FsBreadcrumb, type FsDrive, type FsEntry, type FsLocation } from '@/api/fs';

/**
 * 应用内「选择文件夹」对话框。
 *
 * 交互参考 torrent-manager 的 FolderPickerDialog：
 * - 左侧固定「快速访问 + 磁盘」，任意目录都能一两步点到；
 * - 顶部工具栏：上一级 / 面包屑 / 刷新；
 * - 路径输入 + 转到（Ctrl+L 聚焦），可以直接粘贴深层绝对路径；
 * - 当前目录搜索过滤、隐藏目录开关、子目录数量统计；
 * - 列表只列子文件夹，并显示每个子文件夹里目标扩展名的文件数；
 * - 底部展示当前文件夹并提供「选择此文件夹」。
 *
 * 组件与业务无关：动画工作区传 ext="fbx"（默认），素材库扫描传 ext="glb"。
 * 所有操作都是只读浏览，不会写入、修改或锁定任何文件。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 打开时的起始目录；为空时回退到快速访问第一项 / 第一个盘符 */
    startDir: string;
    /** 对话框标题；素材库的 GLB 扫描复用本组件时传自己的标题 */
    title?: string;
    /** 统计并展示的扩展名（不含点）；默认 fbx，扫描模型时传 glb */
    ext?: string;
  }>(),
  { title: '选择动画文件夹', ext: 'fbx' },
);
const emit = defineEmits<{ close: []; pick: [dir: string] }>();

/** 扩展名的大写形式，用于界面文案（FBX / GLB） */
const extLabel = computed(() => props.ext.toUpperCase());

const current = ref('');
const parent = ref<string | null>(null);
const breadcrumbs = ref<FsBreadcrumb[]>([]);
const entries = ref<FsEntry[]>([]);
const total = ref(0);
const truncated = ref(false);
const fileCount = ref(0);
const locations = ref<FsLocation[]>([]);
const drives = ref<FsDrive[]>([]);
const pathDraft = ref('');
const query = ref('');
const showHidden = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const breadcrumbsEl = ref<HTMLElement | null>(null);
const pathInput = ref<HTMLInputElement | null>(null);

/** 请求序号：连续点击时只认最后一次导航的结果，避免旧响应覆盖新目录 */
let requestId = 0;
let alive = true;

/** 按隐藏开关过滤后的子文件夹 */
const visibleEntries = computed(() =>
  showHidden.value ? entries.value : entries.value.filter((entry) => !entry.hidden),
);

/** 再按搜索词过滤：只在当前目录内筛选，不递归 */
const filteredEntries = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return visibleEntries.value;
  return visibleEntries.value.filter((entry) => entry.name.toLowerCase().includes(keyword));
});

const hasHiddenEntries = computed(() => entries.value.some((entry) => entry.hidden));
const isRoot = computed(() => !parent.value);
const canConfirm = computed(() => Boolean(current.value) && !loading.value);
const entryLabel = computed(() => {
  if (query.value.trim()) return `${filteredEntries.value.length} / ${visibleEntries.value.length} 个文件夹`;
  return `${visibleEntries.value.length} 个文件夹`;
});

/** 盘符剩余空间格式化（1024 进制，超过 10 或整数时不带小数） */
function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 盘符根路径补成带反斜杠的形式：用户输入 "D:" 时按 "D:\" 处理 */
function normalizeInput(value: string): string {
  const text = value.trim();
  return /^[a-zA-Z]:$/.test(text) ? `${text}\\` : text;
}

/** 比较路径时统一斜杠与大小写，避免 "D:/a" 与 "D:\a" 判定不一致 */
function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isQuickActive(location: FsLocation): boolean {
  return normalizeForCompare(current.value) === normalizeForCompare(location.path);
}

function isDriveActive(drive: FsDrive): boolean {
  const root = normalizeForCompare(drive.root);
  const target = normalizeForCompare(current.value);
  return target === root || target.startsWith(`${root}/`);
}

/**
 * 打开某个目录。
 * @param resetQuery 是否清空搜索词（点面包屑/磁盘时为 true，刷新时保留）
 */
async function navigate(target: string, options: { resetQuery?: boolean } = {}): Promise<boolean> {
  const requested = normalizeInput(target);
  if (!requested) return false;

  const id = ++requestId;
  loading.value = true;
  error.value = null;
  try {
    const data = await fsApi.list(requested, props.ext);
    if (!alive || id !== requestId) return false;

    current.value = data.path;
    parent.value = data.parent;
    breadcrumbs.value = data.breadcrumbs;
    entries.value = data.entries;
    total.value = data.total;
    truncated.value = data.truncated;
    fileCount.value = data.fileCount;
    pathDraft.value = data.path;
    if (options.resetQuery !== false) query.value = '';

    // 面包屑可能很长，切换目录后滚到最右侧，始终看到当前目录名
    await nextTick();
    if (breadcrumbsEl.value) breadcrumbsEl.value.scrollLeft = breadcrumbsEl.value.scrollWidth;
    return true;
  } catch (err) {
    if (!alive || id !== requestId) return false;
    error.value = err instanceof Error ? err.message : '无法打开该文件夹';
    if (current.value) pathDraft.value = current.value;
    return false;
  } finally {
    if (id === requestId) loading.value = false;
  }
}

function goToDraft(): void {
  if (!pathDraft.value.trim() || loading.value) return;
  void navigate(pathDraft.value);
}

function goUp(): void {
  if (parent.value) void navigate(parent.value);
}

function refresh(): void {
  if (!current.value || loading.value) return;
  void navigate(current.value, { resetQuery: false });
}

function choose(): void {
  if (!canConfirm.value) return;
  emit('pick', current.value);
}

function clearQuery(): void {
  query.value = '';
}

/**
 * 打开对话框时初始化：
 * 1. 拉取快速访问与磁盘列表（失败也不影响手输路径）；
 * 2. 依次尝试「上次路径 → 快速访问第一项 → 第一个盘符」，第一个能打开的就用它；
 * 3. 全部失败时给出提示，让用户直接输入绝对路径。
 */
async function init(): Promise<void> {
  query.value = '';
  showHidden.value = false;
  error.value = null;

  try {
    const data = await fsApi.locations();
    if (!alive) return;
    locations.value = data.locations;
    drives.value = data.drives;
  } catch {
    /* 快速访问属于增强功能，读取失败时仍然可以浏览 */
  }

  const candidates = [props.startDir, locations.value[0]?.path, drives.value[0]?.root].filter(
    (item): item is string => Boolean(item),
  );
  const uniqueKeys = [...new Set(candidates.map((item) => item.toLowerCase()))];

  for (const key of uniqueKeys) {
    const candidate = candidates.find((item) => item.toLowerCase() === key);
    if (candidate && (await navigate(candidate))) return;
  }

  loading.value = false;
  error.value = '无法打开起始文件夹，请在上方直接输入绝对路径。';
}

watch(
  () => props.open,
  (open) => {
    if (open) void init();
  },
);

/**
 * 全局快捷键：Esc 关闭；Ctrl/Cmd + L 聚焦路径输入框。
 * 只在对话框打开时响应，避免影响主界面。
 */
function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    pathInput.value?.focus();
    pathInput.value?.select();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  alive = false;
  requestId += 1;
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="picker">
      <div v-if="open" class="picker-layer" @mousedown.self="emit('close')">
        <div class="picker-card" role="dialog" aria-modal="true" :aria-label="title">
          <!-- 标题区：只读提示 + 关闭 -->
          <header class="picker-header">
            <span class="header-icon"><Icon name="folder" :size="19" /></span>
            <div class="header-copy">
              <h2>{{ title }}</h2>
              <p>浏览并选择一个文件夹；列表只展示子文件夹，右侧数字是其中的 .{{ ext }} 数量</p>
            </div>
            <span class="chip chip-info">只读</span>
            <button class="icon-btn" type="button" title="关闭" aria-label="关闭" @click="emit('close')">
              <Icon name="close" :size="16" />
            </button>
          </header>

          <div class="picker-body">
            <!-- 左侧：快速访问 + 磁盘 -->
            <aside class="picker-sidebar">
              <section v-if="locations.length" class="sidebar-section">
                <h3 class="section-heading">快速访问</h3>
                <div class="sidebar-list">
                  <button
                    v-for="location in locations"
                    :key="location.id"
                    class="location-btn"
                    :class="{ active: isQuickActive(location) }"
                    type="button"
                    :title="location.path"
                    @click="navigate(location.path)"
                  >
                    <Icon :name="location.icon" :size="14" />
                    <span class="location-name">{{ location.name }}</span>
                  </button>
                </div>
              </section>

              <section v-if="drives.length" class="sidebar-section">
                <h3 class="section-heading">磁盘</h3>
                <div class="sidebar-list">
                  <button
                    v-for="drive in drives"
                    :key="drive.root"
                    class="location-btn drive-btn"
                    :class="{ active: isDriveActive(drive) }"
                    type="button"
                    :title="drive.root"
                    @click="navigate(drive.root)"
                  >
                    <Icon name="layers" :size="14" />
                    <span class="drive-copy">
                      <span>{{ drive.name }}</span>
                      <small>本地磁盘</small>
                    </span>
                    <span v-if="drive.freeSpace !== null" class="drive-free">{{ formatBytes(drive.freeSpace) }}</span>
                  </button>
                </div>
              </section>
            </aside>

            <!-- 右侧：导航 + 路径 + 搜索 + 列表 -->
            <section class="picker-main">
              <div class="picker-toolbar">
                <button
                  class="icon-btn nav-btn"
                  type="button"
                  title="上一级"
                  aria-label="上一级"
                  :disabled="isRoot || loading"
                  @click="goUp"
                >
                  <Icon name="arrowUp" :size="15" />
                </button>

                <div ref="breadcrumbsEl" class="breadcrumbs">
                  <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
                    <Icon v-if="index > 0" name="chevronRight" :size="11" class="crumb-separator" />
                    <button
                      class="crumb"
                      :class="{ current: index === breadcrumbs.length - 1 }"
                      type="button"
                      :title="crumb.path"
                      @click="navigate(crumb.path)"
                    >
                      {{ crumb.name }}
                    </button>
                  </template>
                </div>

                <button
                  class="icon-btn nav-btn"
                  type="button"
                  title="刷新"
                  aria-label="刷新"
                  :disabled="loading || !current"
                  @click="refresh"
                >
                  <Icon name="refresh" :size="14" :class="{ spin: loading }" />
                </button>
              </div>

              <div class="path-row">
                <div class="field path-field">
                  <Icon name="folder" :size="13" />
                  <input
                    ref="pathInput"
                    v-model="pathDraft"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    aria-label="文件夹路径"
                    placeholder="输入绝对路径，例如 D:\models"
                    @keydown.enter.prevent="goToDraft"
                  />
                  <kbd class="kbd">Ctrl L</kbd>
                </div>
                <button class="btn go-btn" type="button" :disabled="!pathDraft.trim() || loading" @click="goToDraft">
                  转到
                </button>
              </div>

              <div class="search-row">
                <div class="field search-field">
                  <Icon name="search" :size="13" />
                  <input
                    v-model="query"
                    type="text"
                    spellcheck="false"
                    placeholder="筛选当前文件夹…"
                    aria-label="筛选当前文件夹"
                  />
                  <button v-if="query" class="clear-search" type="button" aria-label="清空筛选" @click="clearQuery">
                    <Icon name="close" :size="12" />
                  </button>
                </div>
                <button
                  v-if="hasHiddenEntries"
                  class="hidden-toggle"
                  :class="{ active: showHidden }"
                  type="button"
                  :title="showHidden ? '隐藏以 . 或 $ 开头的文件夹' : '显示以 . 或 $ 开头的文件夹'"
                  @click="showHidden = !showHidden"
                >
                  <Icon :name="showHidden ? 'eye' : 'eyeOff'" :size="13" />
                  <span>{{ showHidden ? '隐藏项已显示' : '显示隐藏项' }}</span>
                </button>
                <span class="entry-count">{{ entryLabel }}</span>
              </div>

              <div v-if="error" class="error-banner">
                <Icon name="alert" :size="14" />
                <span>{{ error }}</span>
                <button v-if="current" class="retry-btn" type="button" @click="refresh">重试</button>
              </div>

              <div class="picker-list" :class="{ 'is-loading': loading && entries.length > 0 }">
                <div v-if="loading && entries.length === 0" class="skeleton-list">
                  <span v-for="index in 7" :key="index"></span>
                </div>

                <template v-else>
                  <button
                    v-for="entry in filteredEntries"
                    :key="entry.path"
                    class="folder-row"
                    type="button"
                    :title="entry.path"
                    @click="navigate(entry.path)"
                  >
                    <span class="folder-icon"><Icon name="folder" :size="16" /></span>
                    <span class="folder-name">{{ entry.name }}</span>
                    <span v-if="entry.fileCount > 0" class="chip chip-accent">
                      {{ entry.fileCount }} {{ extLabel }}
                    </span>
                    <span v-else-if="entry.hidden" class="chip">隐藏</span>
                    <Icon name="chevronRight" :size="14" class="folder-chevron" />
                  </button>

                  <div v-if="filteredEntries.length === 0" class="empty-list">
                    <Icon name="folder" :size="22" />
                    <p v-if="query">没有匹配的文件夹</p>
                    <p v-else-if="hasHiddenEntries && !showHidden">当前只包含隐藏文件夹，可点击「显示隐藏项」查看。</p>
                    <p v-else>这个文件夹下没有子文件夹，可以直接选择当前文件夹。</p>
                  </div>
                </template>
              </div>

              <p v-if="truncated" class="truncated-note">
                当前目录项目较多，仅显示前 2000 个子文件夹（共 {{ total }} 个）；可直接在路径框输入更深层路径。
              </p>
            </section>
          </div>

          <!-- 底部：当前文件夹 + 操作 -->
          <footer class="picker-footer">
            <div class="selection">
              <span class="selection-label">当前文件夹</span>
              <code class="selection-path" :title="current">{{ current || '—' }}</code>
            </div>
            <div class="footer-actions">
              <span v-if="fileCount > 0" class="chip">{{ fileCount }} 个 {{ extLabel }}</span>
              <button class="btn" type="button" @click="emit('close')">取消</button>
              <button class="btn btn-primary" type="button" :disabled="!canConfirm" @click="choose">
                <Icon :name="loading ? 'refresh' : 'check'" :size="14" :class="{ spin: loading }" />
                选择此文件夹
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ===== 遮罩与卡片 ===== */
.picker-layer {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 20px;
  background: rgba(8, 9, 12, 0.66);
  backdrop-filter: blur(4px);
}

.picker-card {
  display: flex;
  width: min(880px, 100%);
  height: min(660px, 88vh);
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  box-shadow: var(--shadow);
}

.picker-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.header-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
}

.header-copy {
  min-width: 0;
  flex: 1;
}

.header-copy h2 {
  font-size: 15px;
  font-weight: 650;
  color: var(--text);
}

.header-copy p {
  margin-top: 2px;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
}

.icon-btn:hover:not(:disabled) {
  border-color: var(--border);
  background: var(--bg-hover);
  color: var(--text);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ===== 主体：左侧导航 + 右侧列表 ===== */
.picker-body {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 196px minmax(0, 1fr);
}

.picker-sidebar {
  min-height: 0;
  overflow-y: auto;
  padding: 12px 8px;
  border-right: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.16);
}

.sidebar-section + .sidebar-section {
  margin-top: 16px;
}

.section-heading {
  margin: 0 8px 6px;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.sidebar-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.location-btn {
  display: flex;
  width: 100%;
  min-height: 32px;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  text-align: left;
}

.location-btn > svg {
  flex: none;
  color: var(--text-faint);
}

.location-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.location-btn.active {
  border-color: var(--border-strong);
  background: var(--accent-soft);
  color: var(--text);
}

.location-btn.active > svg {
  color: var(--accent);
}

.location-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}

.drive-copy > span {
  font-family: var(--mono);
  font-size: 11px;
  white-space: nowrap;
}

.drive-copy small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-free {
  flex: none;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 8.5px;
}

/* ===== 右侧主区 ===== */
.picker-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  padding: 12px 16px 0;
}

.picker-toolbar {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
}

.nav-btn {
  width: 30px;
  height: 30px;
  border-color: var(--border);
}

.breadcrumbs {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  padding: 2px 1px;
  scrollbar-width: none;
}

.breadcrumbs::-webkit-scrollbar {
  display: none;
}

.crumb {
  flex: none;
  max-width: 170px;
  overflow: hidden;
  padding: 3px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumb:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.crumb.current {
  color: var(--text);
  font-weight: 600;
}

.crumb-separator {
  flex: none;
  color: var(--text-faint);
}

.path-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
  margin-top: 9px;
}

.field {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-faint);
}

.field:focus-within {
  border-color: var(--accent);
}

.field input {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text);
  outline: none;
}

.path-field input {
  font-family: var(--mono);
  font-size: 10.5px;
}

.kbd {
  flex: none;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 9px;
}

.go-btn {
  height: 34px;
  flex: none;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  margin-top: 9px;
}

.search-field {
  height: 32px;
}

.search-field input {
  font-size: 11.5px;
}

.clear-search {
  display: grid;
  width: 20px;
  height: 20px;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
}

.clear-search:hover {
  color: var(--text);
}

.hidden-toggle {
  display: inline-flex;
  height: 27px;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

.hidden-toggle:hover {
  border-color: var(--border);
  background: var(--bg-hover);
  color: var(--text-dim);
}

.hidden-toggle.active {
  border-color: var(--border-strong);
  background: var(--accent-soft);
  color: var(--text);
}

.entry-count {
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
  margin-top: 9px;
  padding: 8px 10px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11px;
  line-height: 1.45;
}

.error-banner > span {
  min-width: 0;
  flex: 1;
  word-break: break-word;
}

.retry-btn {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--danger);
  font-size: 10.5px;
  font-weight: 600;
}

/* ===== 文件夹列表 ===== */
.picker-list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  margin-top: 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  transition: opacity 140ms ease;
}

.picker-list.is-loading {
  opacity: 0.5;
  pointer-events: none;
}

.folder-row {
  display: flex;
  width: 100%;
  min-height: 42px;
  align-items: center;
  gap: 10px;
  padding: 7px 11px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  text-align: left;
}

.folder-row:last-of-type {
  border-bottom: 0;
}

.folder-row:hover {
  background: var(--bg-hover);
}

.folder-icon {
  display: grid;
  width: 26px;
  height: 26px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-dim);
}

.folder-row:hover .folder-icon {
  border-color: var(--border-strong);
  background: var(--accent-soft);
  color: var(--accent);
}

.folder-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-chevron {
  flex: none;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 140ms ease;
}

.folder-row:hover .folder-chevron {
  opacity: 1;
}

.empty-list {
  display: flex;
  min-height: 160px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--text-faint);
  font-size: 11px;
  text-align: center;
}

.skeleton-list {
  display: flex;
  flex-direction: column;
}

.skeleton-list span {
  height: 42px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
  background-size: 600px 100%;
  animation: picker-shimmer 1.5s linear infinite;
}

@keyframes picker-shimmer {
  from {
    background-position: -600px 0;
  }
  to {
    background-position: 600px 0;
  }
}

.truncated-note {
  flex: none;
  padding: 7px 2px 0;
  color: var(--text-faint);
  font-size: 10px;
}

/* ===== 底部 ===== */
.picker-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: none;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.16);
}

.selection {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.selection-label {
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.selection-path {
  overflow: hidden;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.footer-actions .btn {
  height: 34px;
  font-size: 12px;
}

/* ===== 进出场动画 ===== */
.picker-enter-active,
.picker-leave-active {
  transition: opacity 160ms ease;
}

.picker-enter-active .picker-card,
.picker-leave-active .picker-card {
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.picker-enter-from,
.picker-leave-to {
  opacity: 0;
}

.picker-enter-from .picker-card,
.picker-leave-to .picker-card {
  transform: translateY(8px) scale(0.985);
}

/* ===== 窄屏：侧栏折叠成一行 ===== */
@media (max-width: 760px) {
  .picker-layer {
    padding: 0;
  }

  .picker-card {
    width: 100vw;
    height: 100dvh;
    border: 0;
    border-radius: 0;
  }

  .picker-body {
    display: flex;
    flex-direction: column;
  }

  .picker-sidebar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    overflow: visible;
    padding: 8px 10px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .sidebar-section,
  .sidebar-section + .sidebar-section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    margin-top: 0;
  }

  .section-heading {
    flex: none;
    margin: 0 3px 0 0;
  }

  .sidebar-list {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px;
  }

  .location-btn {
    width: auto;
    min-height: 28px;
    flex: none;
    padding: 5px 8px;
    white-space: nowrap;
  }

  .drive-copy small,
  .drive-free {
    display: none;
  }

  .picker-main {
    padding: 10px 12px 0;
  }

  .path-field .kbd {
    display: none;
  }

  .hidden-toggle span {
    display: none;
  }

  .picker-footer {
    align-items: stretch;
    flex-direction: column;
    gap: 9px;
    padding: 10px 12px;
  }

  .footer-actions {
    width: 100%;
  }

  .footer-actions .btn {
    flex: 1;
  }
}
</style>
