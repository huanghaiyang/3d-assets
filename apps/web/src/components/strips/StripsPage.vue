<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import MotionThumb from '../animation/MotionThumb.vue';
import StripInspector from './StripInspector.vue';
import StripTimeline from './StripTimeline.vue';
import StripsViewport from './StripsViewport.vue';
import { useStripsStore } from '@/stores/strips';
import { animationApi, type AnimationFile, type SavedAnimationProject } from '@/api/animation';
import { BODY_PARTS } from '@/viewer/strips/StripParts';
import type { BodyPart } from '@/viewer/strips/StripTypes';

const store = useStripsStore();

const tab = ref<'fbx' | 'kimodo' | 'anim'>('fbx');
/** 新增 Strip 默认应用的部位，加完可按需在检查器里改 */
const defaultPart = ref<BodyPart>('full');

const keyword = ref('');
const openFile = ref<AnimationFile | null>(null);
const clipOptions = ref<{ name: string; duration: number }[]>([]);
const loadingClips = ref(false);

const basePickerOpen = ref(false);
const baseKeyword = ref('');

const filteredFiles = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  const list = query
    ? store.files.filter((file) => file.relative.toLowerCase().includes(query))
    : store.files;
  return list.slice(0, 80);
});

const baseFiles = computed(() => {
  const query = baseKeyword.value.trim().toLowerCase();
  const list = query
    ? store.files.filter((file) => file.relative.toLowerCase().includes(query))
    : store.files;
  return list.slice(0, 120);
});

function fileCover(path: string, size = 64): string {
  return animationApi.animationCoverUrl(path, size, 0.35);
}

function projectCover(project: SavedAnimationProject, size = 64): string {
  return animationApi.animationCoverUrl('', size, 0.35, {
    project: project.id,
    version: project.updatedAt,
  });
}

async function chooseFile(file: AnimationFile): Promise<void> {
  if (openFile.value?.path === file.path) {
    openFile.value = null;
    clipOptions.value = [];
    return;
  }
  openFile.value = file;
  clipOptions.value = [];
  loadingClips.value = true;
  clipOptions.value = await store.listFbxClips(file.path);
  loadingClips.value = false;
}

function addFbxClip(name: string): void {
  if (!openFile.value) return;
  store.addStrip(
    { kind: 'fbx-clip', fbxPath: openFile.value.path, clipName: name },
    defaultPart.value,
  );
}

function addKimodo(animationId: string): void {
  store.addStrip({ kind: 'kimodo', animationId }, defaultPart.value);
}

function addProject(project: SavedAnimationProject): void {
  store.addStrip(
    { kind: 'anim-project', projectId: project.id, projectName: project.name },
    defaultPart.value,
  );
}

function jobTitle(prompt: string | undefined, id: string): string {
  return prompt?.trim() || `Kimodo ${id.slice(0, 6)}`;
}

async function pickBase(path: string): Promise<void> {
  basePickerOpen.value = false;
  await store.selectBase(path);
}

onMounted(() => {
  void store.bootstrap();
});
</script>

<template>
  <div class="strips-page">
    <aside class="panel left">
      <div class="base">
        <div class="base-head">
          <span class="section-title"><Icon name="cube" :size="12" />基础模型</span>
          <button class="btn btn-sm" type="button" @click="basePickerOpen = true">
            <Icon name="grid" :size="11" />更换
          </button>
        </div>

        <button v-if="store.baseFile" class="base-card" type="button" @click="basePickerOpen = true">
          <img class="base-cover" :src="fileCover(store.baseFile.path, 96)" :alt="store.baseFile.name" />
          <span class="base-info">
            <span class="base-name">{{ store.baseFile.name }}</span>
            <span class="faint mono">{{ store.baseFile.relative }}</span>
            <span class="faint mono">{{ store.strips.length }} 个 Strip</span>
          </span>
        </button>
        <button v-else class="base-empty" type="button" @click="basePickerOpen = true">
          <Icon name="plus" :size="14" />
          {{ store.catalogLoading ? '正在加载动画库…' : '选择基础模型' }}
        </button>
        <p v-if="store.catalogError" class="catalog-error">{{ store.catalogError }}</p>
      </div>

      <div class="library">
        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'fbx' }" type="button" @click="tab = 'fbx'">
            FBX
          </button>
          <button class="tab" :class="{ active: tab === 'kimodo' }" type="button" @click="tab = 'kimodo'">
            Kimodo
          </button>
          <button class="tab" :class="{ active: tab === 'anim' }" type="button" @click="tab = 'anim'">
            新建动画
          </button>
        </div>

        <div class="part-row">
          <span class="field-label">新增到</span>
          <select v-model="defaultPart" class="select-input">
            <option v-for="part in BODY_PARTS" :key="part.id" :value="part.id">{{ part.label }}</option>
          </select>
        </div>

        <template v-if="tab === 'fbx'">
          <div class="search">
            <Icon name="search" :size="12" />
            <input v-model="keyword" class="search-input" placeholder="搜索 FBX 文件" />
          </div>
          <div class="list">
            <button
              v-for="file in filteredFiles"
              :key="file.path"
              class="row"
              :class="{ active: openFile?.path === file.path }"
              type="button"
              @click="chooseFile(file)"
            >
              <img class="row-cover" :src="fileCover(file.path, 64)" :alt="file.name" loading="lazy" />
              <span class="row-text">
                <span class="row-name">{{ file.name }}</span>
                <span class="faint mono row-sub">{{ file.relative }}</span>
              </span>
            </button>
            <div v-if="filteredFiles.length === 0" class="empty">
              {{ store.catalogLoading ? '正在加载…' : '没有匹配的 FBX' }}
            </div>
          </div>
          <div v-if="openFile" class="clips">
            <div class="clips-head">
              <span class="section-title"><Icon name="film" :size="11" />{{ openFile.name }}</span>
              <span v-if="loadingClips" class="faint">读取中…</span>
            </div>
            <div class="clip-list">
              <button
                v-for="clip in clipOptions"
                :key="clip.name"
                class="clip"
                type="button"
                :title="`加入时间轴 · ${clip.duration.toFixed(2)}s`"
                @click="addFbxClip(clip.name)"
              >
                <Icon name="plus" :size="10" />
                <span class="clip-name">{{ clip.name }}</span>
                <span class="faint mono">{{ clip.duration.toFixed(2) }}s</span>
              </button>
              <div v-if="!loadingClips && clipOptions.length === 0" class="empty">这个 FBX 没有内嵌动画</div>
            </div>
          </div>
        </template>

        <template v-else-if="tab === 'kimodo'">
          <div class="list">
            <button
              v-for="job in store.kimodoJobs"
              :key="job.id"
              class="row"
              type="button"
              title="加入时间轴"
              @click="addKimodo(job.id)"
            >
              <MotionThumb
                class="row-thumb"
                :skeleton="store.somaSkeleton"
                :animation-id="job.id"
                mode="skeleton"
                :size="40"
              />
              <span class="row-text">
                <span class="row-name">{{ jobTitle(job.prompt, job.id) }}</span>
                <span class="faint mono row-sub">{{ store.kimodoDuration(job.id).toFixed(2) }}s · {{ job.frames }} 帧</span>
              </span>
              <Icon name="plus" :size="12" />
            </button>
            <div v-if="store.kimodoJobs.length === 0" class="empty">还没有生成完成的 Kimodo 动画</div>
          </div>
        </template>

        <template v-else>
          <div class="list">
            <button
              v-for="project in store.projects"
              :key="project.id"
              class="row"
              type="button"
              title="加入时间轴"
              @click="addProject(project)"
            >
              <img class="row-cover" :src="projectCover(project, 64)" :alt="project.name" loading="lazy" />
              <span class="row-text">
                <span class="row-name">{{ project.name }}</span>
                <span class="faint mono row-sub">{{ project.clipCount }} 段 · {{ project.trackCount }} 轨</span>
              </span>
              <Icon name="plus" :size="12" />
            </button>
            <div v-if="store.projects.length === 0" class="empty">还没有保存过新建动画</div>
          </div>
        </template>
      </div>
    </aside>

    <div class="center">
      <div class="view">
        <StripsViewport />
      </div>
      <StripTimeline />
    </div>

    <StripInspector class="right" />

    <Teleport to="body">
      <div v-if="basePickerOpen" class="modal-backdrop" @click.self="basePickerOpen = false">
        <div class="modal panel">
          <div class="modal-head">
            <span class="section-title"><Icon name="cube" :size="12" />选择基础模型</span>
            <div class="modal-search">
              <Icon name="search" :size="12" />
              <input v-model="baseKeyword" class="search-input" placeholder="搜索 FBX 文件" />
            </div>
            <button class="btn btn-icon" type="button" title="关闭" @click="basePickerOpen = false">
              <Icon name="close" :size="14" />
            </button>
          </div>
          <div class="modal-body">
            <button
              v-for="file in baseFiles"
              :key="file.path"
              class="cover-card"
              :class="{ active: file.path === store.basePath }"
              type="button"
              @click="pickBase(file.path)"
            >
              <img :src="fileCover(file.path, 160)" :alt="file.name" loading="lazy" />
              <span class="cover-name">{{ file.name }}</span>
            </button>
            <div v-if="baseFiles.length === 0" class="empty">没有匹配的 FBX</div>
          </div>
        </div>
      </div>
    </Teleport>

    <div class="toasts">
      <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="toast.kind">
        {{ toast.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.strips-page {
  position: relative;
  display: grid;
  /* 左：基础模型与来源库；中：视口 + 时间轴；右：Strip 检查器 */
  grid-template-columns: 300px minmax(0, 1fr) 340px;
  height: 100%;
  min-height: 0;
  gap: 8px;
  padding: 8px;
  background: var(--bg-app);
}

.left {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.base {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
}

.base-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.base-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
  text-align: left;
}

.base-card:hover {
  background: var(--bg-hover);
}

.base-cover {
  width: 48px;
  height: 48px;
  flex: none;
  border-radius: 5px;
  object-fit: cover;
  background: var(--bg-panel);
}

.base-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.base-name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.base-info .mono {
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.base-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 52px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 12px;
}

.base-empty:hover {
  border-color: var(--accent);
  color: var(--accent-hover);
}

.catalog-error {
  margin: 0;
  font-size: 11px;
  color: var(--danger);
}

.library {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
}

.tab {
  flex: 1;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
}

.tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tab.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.part-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.field-label {
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
}

.part-row .select-input {
  flex: 1;
  height: 26px;
  padding: 0 6px;
  font-size: 11.5px;
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
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
  color: var(--text);
  font-size: 11.5px;
  outline: none;
}

.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
  text-align: left;
}

.row:hover {
  background: var(--bg-hover);
}

.row.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.row-cover {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 4px;
  object-fit: cover;
  background: var(--bg-panel);
}

.row-thumb {
  flex: none;
  border-radius: 4px;
  background: var(--bg-panel);
}

.row-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.row-name {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-sub {
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clips {
  flex: none;
  max-height: 200px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
  min-height: 0;
}

.clips-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
}

.clip-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 0;
  overflow-y: auto;
}

.clip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 11px;
}

.clip:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.clip-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.empty {
  padding: 12px 2px;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.5;
  text-align: center;
}

.center {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}

.view {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.right {
  min-height: 0;
}

/* ===== 基础模型选择弹窗 ===== */

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 8, 12, 0.7);
  backdrop-filter: blur(3px);
}

.modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(880px, calc(100vw - 64px));
  height: min(620px, calc(100vh - 96px));
  padding: 12px;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.modal-search {
  flex: 1;
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

.modal-body {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
}

.cover-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
}

.cover-card:hover {
  background: var(--bg-hover);
}

.cover-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.cover-card img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 4px;
  object-fit: cover;
  background: var(--bg-panel);
}

.cover-name {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 轻提示 ===== */

.toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}

.toast {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
  color: var(--text);
  font-size: 12px;
  max-width: 320px;
}

.toast.success {
  border-color: rgba(52, 211, 153, 0.45);
}

.toast.error {
  border-color: rgba(248, 113, 113, 0.45);
}
</style>
