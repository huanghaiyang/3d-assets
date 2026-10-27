<script setup lang="ts">
/**
 * StripsPage —— 「拼接动画」工作区 v2 的页面骨架。
 *
 * 在整个拼接流程中的位置：这里是编排入口与总布局，本身不参与 Three.js 渲染，
 * 只负责把左栏素材库、中间 3D 预览、右侧 Strip 检查器、底部时间轴拼成一个整体，
 * 并在进入/离开时协调 Pinia store（useStripsStore）。
 *
 * 布局：左侧基础模型 + 三种来源（FBX / Kimodo / 已保存项目）列表；
 * 中间是 StripsViewport；右侧是 StripInspector；底部 StripTimeline 横跨整行、铺满工作栏。
 *
 * 数据来源与去向：
 *  - `store.files` / `store.projects` / `store.kimodoJobs` 由 store.bootstrap() 拉取；
 *  - 用户点「+」后调用 store.addStrip(source)，由 store 负责 5 个源动画上限、
 *    重复来源拦截、部位冲突校验，并把结果推给 StripsPlayer 渲染；
 *  - 子组件均直接读写 store，本页只通过 store 与它们共享状态，不额外传 props；
 *  - toast 由 store.toasts 统一渲染，保存/冲突/失败提示都经由 store.toast()。
 *
 * 关键交互：切换基础模型、搜索与展开 FBX 片段、快捷加入最长片段、
 * 新建/再次编辑已保存的拼接动画、有未保存改动时离开页面的拦截提示。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import MotionThumb from '../animation/MotionThumb.vue';
import StripInspector from './StripInspector.vue';
import StripTimeline from './StripTimeline.vue';
import StripsViewport from './StripsViewport.vue';
import { useStripsStore, MAX_STRIP_TRACKS } from '@/stores/strips';
import { animationApi, type AnimationFile, type SavedAnimationProject } from '@/api/animation';
import type { StripSource } from '@/viewer/strips/StripTypes';

const store = useStripsStore();

/** 左栏来源列表的当前分类：FBX 片段 / Kimodo 生成结果 / 已保存动画项目（含拼接动画） */
const tab = ref<'fbx' | 'kimodo' | 'anim'>('fbx');

/** FBX 分类下的搜索关键词（匹配相对路径，大小写不敏感） */
const keyword = ref('');
/** 点击展开的 FBX 文件；为 null 表示收起片段面板 */
const openFile = ref<AnimationFile | null>(null);
/** 当前展开文件的内嵌片段，由 store.listFbxClips() 按需读取，读完后参与列表渲染 */
const clipOptions = ref<{ name: string; duration: number }[]>([]);
const loadingClips = ref(false);
/** 正在为了快速加入而读取片段时，标记住那一行 */
const quickLoading = ref<string | null>(null);

/** 基础模型选择弹窗的开关（弹窗内容也复用 store.files） */
const basePickerOpen = ref(false);
const baseKeyword = ref('');

/**
 * FBX 分类过滤后的列表。
 * 只截取前 80 条，避免一次性渲染整个动画库导致首屏卡顿；
 * 关键词为空时直接沿用 store.files（自身已是响应式数组）。
 */
const filteredFiles = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  const list = query
    ? store.files.filter((file) => file.relative.toLowerCase().includes(query))
    : store.files;
  return list.slice(0, 80);
});

/** 基础模型弹窗的过滤结果；封面卡片更小，所以上限放宽到 120 条 */
const baseFiles = computed(() => {
  const query = baseKeyword.value.trim().toLowerCase();
  const list = query
    ? store.files.filter((file) => file.relative.toLowerCase().includes(query))
    : store.files;
  return list.slice(0, 120);
});

/**
 * FBX 文件封面地址（缩略图由后端按 `path` 渲染）。
 * @param path 动画库内的相对/绝对路径
 * @param size 期望的方形边长，单位像素；0.35 是取帧位置（视频时长的 35% 处）
 */
function fileCover(path: string, size = 64): string {
  return animationApi.animationCoverUrl(path, size, 0.35);
}

/**
 * 已保存动画项目的封面地址。
 * 项目没有磁盘上的 path，因此传空字符串并附带 projectId + updatedAt，
 * 后者作为 version 参数用于让浏览器在项目更新后重新拉取封面。
 */
function projectCover(project: SavedAnimationProject, size = 64): string {
  return animationApi.animationCoverUrl('', size, 0.35, {
    project: project.id,
    version: project.updatedAt,
  });
}

/**
 * 点击 FBX 行：再次点击同一文件则收起；否则异步读取该文件的内嵌片段。
 * 片段读取失败时 store.listFbxClips 内部会把错误转成 toast 并返回空数组，
 * 所以这里不需要额外的 try/catch。
 */
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

/**
 * 加入 FBX 的某个具名片段。
 * 同一文件可添加多个不同片段，但同一 (fbxPath, clipName) 只会占用一个源动画槽位，
 * 重复添加由 store.addStrip 拦截并提示。
 */
function addFbxClip(name: string): void {
  if (!openFile.value) return;
  store.addStrip({ kind: 'fbx-clip', fbxPath: openFile.value.path, clipName: name });
}

/**
 * 文件行右侧加号：读取片段并加入其中最长的一段。
 * v2 要求三种来源行右侧都提供快捷加号；FBX 一行可能含多个片段，
 * 这里取 duration 最大者作为默认选择（用户仍可展开后逐个挑选）。
 * `quickLoading` 同时充当并发锁：读取期间忽略后续点击，避免重复入队。
 */
async function addFbxFileQuick(file: AnimationFile): Promise<void> {
  if (quickLoading.value) return;
  quickLoading.value = file.path;
  try {
    const clips = await store.listFbxClips(file.path);
    if (clips.length === 0) {
      store.toast('info', '这个 FBX 没有内嵌动画，展开后可查看片段');
      return;
    }
    const longest = clips.reduce((best, clip) => (clip.duration > best.duration ? clip : best), clips[0]!);
    store.addStrip({ kind: 'fbx-clip', fbxPath: file.path, clipName: longest.name });
  } finally {
    quickLoading.value = null;
  }
}

/** 加入一条 Kimodo 生成动画；时长由 store.kimodoDuration() 按 30fps 帧数换算 */
function addKimodo(animationId: string): void {
  store.addStrip({ kind: 'kimodo', animationId });
}

/**
 * 加入一个已保存的动画项目（v2 起项目按「拼接动画」等分类区分）。
 * 保存时写入的 composition 会在动画工作区点「编辑拼接」时再次送回本页。
 */
function addProject(project: SavedAnimationProject): void {
  store.addStrip({ kind: 'anim-project', projectId: project.id, projectName: project.name });
}

/** Kimodo 作业的显示名：优先用提示词，没有提示词则截取 id 前 6 位兜底 */
function jobTitle(prompt: string | undefined, id: string): string {
  return prompt?.trim() || `Kimodo ${id.slice(0, 6)}`;
}

/**
 * 这个 FBX 文件里是否有任何片段已加入时间轴。
 * v2 要求被使用的来源在左栏高亮，因此只按 fbxPath 匹配，
 * 不关心具体是哪个 clipName（同一文件的不同片段也算「该来源已被使用」）。
 */
function fileAdded(file: AnimationFile): boolean {
  return store.strips.some(
    (strip) => strip.source.kind === 'fbx-clip' && strip.source.fbxPath === file.path,
  );
}

/** 具体某个 (文件, 片段) 是否已加入时间轴，用于片段按钮打勾 */
function clipAdded(name: string): boolean {
  if (!openFile.value) return false;
  return store.strips.some(
    (strip) =>
      strip.source.kind === 'fbx-clip' &&
      strip.source.fbxPath === openFile.value!.path &&
      strip.source.clipName === name,
  );
}

/** Kimodo 来源是否已在时间轴上（按 animationId 判重） */
function kimodoAdded(id: string): boolean {
  return store.isSourceAdded({ kind: 'kimodo', animationId: id });
}

/** 已保存项目是否已在时间轴上（按 projectId 判重） */
function projectAdded(project: SavedAnimationProject): boolean {
  return store.isSourceAdded({ kind: 'anim-project', projectId: project.id, projectName: project.name });
}

/**
 * 生成「+」按钮的 title 文案，三种状态：
 *  - 已加入：提示去右侧检查器多选部位（同一动画可占用多个部位）；
 *  - 已达上限：身体部位只有 MAX_STRIP_TRACKS 个，因此最多该数量的源动画；
 *  - 可加入：展示来源名称。
 */
function addTitle(source: StripSource, added: boolean): string {
  if (added) return '已在时间轴上（可去右侧检查器多选部位）';
  if (!store.canAddSource) return `最多从 ${MAX_STRIP_TRACKS} 个源动画拼接，已达上限`;
  return `加入时间轴 · ${store.sourceLabel(source)}`;
}

/** 选中基础模型：先关闭弹窗，再交给 store.selectBase() 真正加载 FBX */
async function pickBase(path: string): Promise<void> {
  basePickerOpen.value = false;
  await store.selectBase(path);
}

/**
 * 离开页面/关闭浏览器时提示未保存的拼接修改。
 * 浏览器只允许同步拦截，因此不弹自定义确认框，而是走标准 beforeunload：
 * `returnValue = ''` 触发宿主浏览器的「离开此网站？」提示。
 */
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!store.hasUnsavedChanges) return;
  event.preventDefault();
  event.returnValue = '';
}

/**
 * 挂载时注册离开拦截并启动 store.bootstrap()：
 * bootstrap 会加载素材目录、选中默认基础模型，或应用从动画工作区
 * 「编辑拼接」暂存过来的编排（pendingComposition）。
 */
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload);
  void store.bootstrap();
});

/** 卸载时必须解除全局监听，否则组件销毁后仍会拦截跳转 */
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <div class="strips-page">
    <!-- 左栏：基础模型卡片 + 三种来源库；所有「+」最终都汇入 store.strips -->
    <aside class="panel left">
      <div class="base">
        <div class="base-head">
          <span class="section-title"><Icon name="cube" :size="12" />基础模型</span>
          <button class="btn btn-sm" type="button" @click="basePickerOpen = true">
            <Icon name="grid" :size="11" />更换
          </button>
        </div>

        <button v-if="store.baseFile" class="base-card" type="button" @click="basePickerOpen = true">
          <!-- 已选基础模型：封面 + 名称 + 相对路径 + 当前占用槽位（n/5） -->
          <img class="base-cover" :src="fileCover(store.baseFile.path, 96)" :alt="store.baseFile.name" />
          <span class="base-info">
            <span class="base-name">{{ store.baseFile.name }}</span>
            <span class="faint mono">{{ store.baseFile.relative }}</span>
            <span class="faint mono">{{ store.strips.length }}/{{ MAX_STRIP_TRACKS }} 个源动画</span>
          </span>
        </button>
        <button v-else class="base-empty" type="button" @click="basePickerOpen = true">
          <Icon name="plus" :size="14" />
          {{ store.catalogLoading ? '正在加载动画库…' : '选择基础模型' }}
        </button>
        <p v-if="store.catalogError" class="catalog-error">{{ store.catalogError }}</p>
      </div>

      <div class="library">
        <!-- 三个分类共用 store 的同一份素材目录，只是过滤方式不同 -->
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

        <div class="usage" :class="{ full: !store.canAddSource }">
          <!-- 槽位用量条：5 个身体部位 = 最多 5 个源动画，满额时整条变红 -->
          <Icon name="layers" :size="11" />
          <span>已用 {{ store.strips.length }}/{{ MAX_STRIP_TRACKS }} 个源动画</span>
          <span class="faint">点 + 加入，重复源不会重复添加</span>
        </div>

        <template v-if="tab === 'fbx'">
          <div class="search">
            <Icon name="search" :size="12" />
            <input v-model="keyword" class="search-input" placeholder="搜索 FBX 文件" />
          </div>
          <div class="list">
            <!-- 每行同时具备两个入口：点行展开片段；点右侧加号快捷加入最长片段 -->
            <div
              v-for="file in filteredFiles"
              :key="file.path"
              class="row"
              :class="{ active: openFile?.path === file.path, added: fileAdded(file) }"
              role="button"
              tabindex="0"
              @click="chooseFile(file)"
              @keydown.enter.prevent="chooseFile(file)"
            >
              <img class="row-cover" :src="fileCover(file.path, 64)" :alt="file.name" loading="lazy" />
              <span class="row-text">
                <span class="row-name">{{ file.name }}</span>
                <span class="faint mono row-sub">{{ file.relative }}</span>
              </span>
              <!-- .stop 阻止冒泡，避免加号同时触发展开片段 -->
              <button
                class="row-add"
                :class="{ added: fileAdded(file) }"
                type="button"
                :title="addTitle({ kind: 'fbx-clip', fbxPath: file.path, clipName: '' }, fileAdded(file))"
                :disabled="quickLoading === file.path"
                @click.stop="addFbxFileQuick(file)"
              >
                <Icon :name="fileAdded(file) ? 'check' : 'plus'" :size="12" />
              </button>
            </div>
            <div v-if="filteredFiles.length === 0" class="empty">
              {{ store.catalogLoading ? '正在加载…' : '没有匹配的 FBX' }}
            </div>
          </div>
          <!-- 展开某文件后逐个挑选内嵌片段；同一片段只能加一次，已加入的打勾 -->
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
                :class="{ added: clipAdded(clip.name) }"
                type="button"
                :title="`加入时间轴 · ${clip.duration.toFixed(2)}s`"
                @click="addFbxClip(clip.name)"
              >
                <Icon :name="clipAdded(clip.name) ? 'check' : 'plus'" :size="10" />
                <span class="clip-name">{{ clip.name }}</span>
                <span class="faint mono">{{ clip.duration.toFixed(2) }}s</span>
              </button>
              <div v-if="!loadingClips && clipOptions.length === 0" class="empty">这个 FBX 没有内嵌动画</div>
            </div>
          </div>
        </template>

        <template v-else-if="tab === 'kimodo'">
          <div class="list">
            <!-- Kimodo 条目：整行可点即加入；缩略图用骨架预览（store.somaSkeleton） -->
            <div
              v-for="job in store.kimodoJobs"
              :key="job.id"
              class="row"
              :class="{ added: kimodoAdded(job.id) }"
              role="button"
              tabindex="0"
              :title="addTitle({ kind: 'kimodo', animationId: job.id }, kimodoAdded(job.id))"
              @click="addKimodo(job.id)"
              @keydown.enter.prevent="addKimodo(job.id)"
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
              <button class="row-add" :class="{ added: kimodoAdded(job.id) }" type="button" @click.stop="addKimodo(job.id)">
                <Icon :name="kimodoAdded(job.id) ? 'check' : 'plus'" :size="12" />
              </button>
            </div>
            <div v-if="store.kimodoJobs.length === 0" class="empty">还没有生成完成的 Kimodo 动画</div>
          </div>
        </template>

        <template v-else>
          <div class="list">
            <!-- 已保存项目（含「拼接动画」分类出来的条目）也可以作为源动画再次拼接 -->
            <div
              v-for="project in store.projects"
              :key="project.id"
              class="row"
              :class="{ added: projectAdded(project) }"
              role="button"
              tabindex="0"
              :title="addTitle({ kind: 'anim-project', projectId: project.id, projectName: project.name }, projectAdded(project))"
              @click="addProject(project)"
              @keydown.enter.prevent="addProject(project)"
            >
              <img class="row-cover" :src="projectCover(project, 64)" :alt="project.name" loading="lazy" />
              <span class="row-text">
                <span class="row-name">{{ project.name }}</span>
                <span class="faint mono row-sub">{{ project.clipCount }} 段 · {{ project.trackCount }} 轨</span>
              </span>
              <button class="row-add" :class="{ added: projectAdded(project) }" type="button" @click.stop="addProject(project)">
                <Icon :name="projectAdded(project) ? 'check' : 'plus'" :size="12" />
              </button>
            </div>
            <div v-if="store.projects.length === 0" class="empty">还没有保存过新建动画</div>
          </div>
        </template>
      </div>
    </aside>

    <!-- 中栏：Three.js 预览（实时混合 / 烘焙结果、部位高亮、骨骼与下肢轨迹都在这里呈现） -->
    <div class="center">
      <div class="view">
        <StripsViewport />
      </div>
    </div>

    <!-- 右栏：当前选中 Strip 的属性编辑与烘焙/保存入口 -->
    <StripInspector class="right" />

    <!-- 时间轴铺满整个底部工作栏（grid-column: 1 / -1），因此跨度等于左中右三栏之和 -->
    <StripTimeline class="bottom" />

    <!-- 基础模型选择弹窗；Teleport 到 body 以脱离左右栏的 overflow 裁剪 -->
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

    <!-- 全局轻提示：由 store.toast() 压入，3.2 秒后自动移除（成功/失败/冲突提示共用） -->
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
  /* 左：基础模型与来源库；中：视口；右：Strip 检查器；底部整行：时间轴 */
  grid-template-columns: 300px minmax(0, 1fr) 340px;
  grid-template-rows: minmax(0, 1fr) auto;
  height: 100%;
  min-height: 0;
  gap: 8px;
  padding: 8px;
  background: var(--bg-app);
}

.left {
  grid-column: 1;
  grid-row: 1;
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

.usage {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  font-size: 11px;
  color: var(--text-dim);
}

.usage.full {
  border-color: rgba(248, 113, 113, 0.35);
  color: var(--danger);
}

.usage .faint {
  margin-left: auto;
  font-size: 10px;
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
  position: relative;
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
  cursor: pointer;
}

.row:hover {
  background: var(--bg-hover);
}

.row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.row.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.row.added {
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(52, 211, 153, 0.08);
}

.row.added::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: var(--success, #34d399);
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

.row-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-panel);
  color: var(--text-dim);
}

.row-add:hover {
  border-color: var(--accent);
  color: var(--accent-hover);
}

.row-add.added {
  border-color: rgba(52, 211, 153, 0.45);
  color: var(--success, #34d399);
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

.clip.added {
  border-color: rgba(52, 211, 153, 0.4);
  color: var(--success, #34d399);
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
  grid-column: 2;
  grid-row: 1;
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
  grid-column: 3;
  grid-row: 1;
  min-height: 0;
}

.bottom {
  grid-column: 1 / -1;
  grid-row: 2;
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
