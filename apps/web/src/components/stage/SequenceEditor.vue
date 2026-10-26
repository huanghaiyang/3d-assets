<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStageStore } from '@/stores/stage';
import { buildTimeline } from '@/viewer/stage/SequenceTimeline';
import type { AnimationFile } from '@/api/animation';
import type { SegmentDef } from '@/viewer/stage/StageTypes';

const store = useStageStore();

const pickerOpen = ref(false);
const pickerTab = ref<'fbx' | 'kimodo' | 'anim'>('fbx');
const keyword = ref('');
const openFile = ref<AnimationFile | null>(null);
const clipOptions = ref<{ name: string; duration: number }[]>([]);
const loadingClips = ref(false);

const actor = computed(() => store.selectedActor);

const timeline = computed(() => buildTimeline(store.actorSegmentsList));

const filteredFiles = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  const list = query
    ? store.files.filter((file) => file.relative.toLowerCase().includes(query))
    : store.files;
  return list.slice(0, 80);
});

function format(value: number): string {
  return value.toFixed(2);
}

function openPicker(): void {
  pickerOpen.value = true;
  // Soma 角色只能播 Kimodo 原生动作
  if (actor.value?.kind === 'soma') pickerTab.value = 'kimodo';
  else pickerTab.value = 'fbx';
}

async function chooseFile(file: AnimationFile): Promise<void> {
  openFile.value = file;
  clipOptions.value = [];
  loadingClips.value = true;
  clipOptions.value = await store.listFbxClips(file.path);
  loadingClips.value = false;
}

function addFbxClip(name: string, duration: number): void {
  if (!actor.value || !openFile.value) return;
  store.addSegment(
    actor.value.id,
    { kind: 'fbx-clip', fbxPath: openFile.value.path, clipName: name },
    duration,
  );
  pickerOpen.value = false;
}

function addKimodo(animationId: string): void {
  if (!actor.value) return;
  store.addSegment(actor.value.id, { kind: 'kimodo', animationId }, store.kimodoDuration(animationId));
  pickerOpen.value = false;
}

async function addAnimationProject(projectId: string, projectName: string): Promise<void> {
  if (!actor.value) return;
  await store.addAnimationProjectSegment(projectId, projectName);
  pickerOpen.value = false;
}

function updateTrim(id: string, key: 'trimStart' | 'trimEnd' | 'blendIn', event: Event): void {
  store.updateSegment(id, { [key]: Number((event.target as HTMLInputElement).value) || 0 });
}

function updatePose(id: string, key: 'x' | 'z' | 'yaw', event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value) || 0;
  store.updateSegmentPose(id, { [key]: key === 'yaw' ? (raw * Math.PI) / 180 : raw });
}

function poseText(segment: SegmentDef, key: 'x' | 'z' | 'yaw'): string {
  const value = segment.pose ? segment.pose[key] : 0;
  return key === 'yaw' ? (value * 180 / Math.PI).toFixed(0) : value.toFixed(2);
}

function jobTitle(animationId: string): string {
  const job = store.kimodoJobs.find((item) => item.id === animationId);
  return job?.note?.trim() || job?.prompt?.trim() || `Kimodo ${animationId.slice(0, 6)}`;
}

function projectMeta(projectId: string): string {
  const project = store.animationProjects.find((item) => item.id === projectId);
  if (!project) return '';
  return `${project.clipCount} 段 · ${project.trackCount} 轨`;
}
</script>

<template>
  <div class="editor">
    <div class="head">
      <span class="section-title"><Icon name="film" :size="12" />动作序列</span>
      <button class="btn btn-sm btn-primary" type="button" :disabled="!actor" @click="openPicker">
        <Icon name="plus" :size="12" />添加片段
      </button>
    </div>

    <div v-if="!actor" class="empty">在左侧选择一个角色后编排它的动作序列</div>

    <template v-else>
      <div class="actor-hint">
        <span class="chip chip-accent">{{ actor.name }}</span>
        <span class="faint">共 {{ store.actorSegmentsList.length }} 段</span>
      </div>

      <div v-if="store.actorSegmentsList.length === 0" class="empty">
        这个角色还没有动作，点「添加片段」从动画库或 Kimodo 里挑
      </div>

      <div class="segments">
        <div
          v-for="(segment, index) in store.actorSegmentsList"
          :key="segment.id"
          class="segment"
          :class="{ active: segment.id === store.selectedSegmentId }"
          @click="store.selectSegment(segment.id)"
        >
          <div class="segment-head">
            <span class="index mono">{{ index + 1 }}</span>
            <span class="segment-name">{{ store.sourceLabel(segment.source) }}</span>
            <span class="faint mono">
              {{ format(timeline.timings[index]?.start ?? 0) }}–{{ format(timeline.timings[index]?.end ?? 0) }}s
            </span>
            <span class="segment-actions">
              <span class="mini" title="上移" @click.stop="store.moveSegment(segment.id, -1)">
                <Icon name="arrowUp" :size="12" />
              </span>
              <span class="mini rotate" title="下移" @click.stop="store.moveSegment(segment.id, 1)">
                <Icon name="arrowUp" :size="12" />
              </span>
              <span class="mini" title="删除片段" @click.stop="store.removeSegment(segment.id)">
                <Icon name="trash" :size="12" />
              </span>
            </span>
          </div>

          <div class="segment-fields">
            <label class="field">
              <span class="field-label">起点 s</span>
              <input class="text-input" type="number" step="0.05" min="0" :value="format(segment.trimStart)" @change="updateTrim(segment.id, 'trimStart', $event)" />
            </label>
            <label class="field">
              <span class="field-label">终点 s</span>
              <input class="text-input" type="number" step="0.05" min="0" :value="format(segment.trimEnd)" @change="updateTrim(segment.id, 'trimEnd', $event)" />
            </label>
            <label class="field">
              <span class="field-label">重叠 s</span>
              <input
                class="text-input"
                type="number"
                step="0.05"
                min="0"
                :value="format(segment.blendIn)"
                :disabled="index === 0"
                @change="updateTrim(segment.id, 'blendIn', $event)"
              />
            </label>
          </div>

          <div class="segment-fields">
            <label class="field">
              <span class="field-label">X</span>
              <input class="text-input" type="number" step="0.1" :value="poseText(segment, 'x')" @change="updatePose(segment.id, 'x', $event)" />
            </label>
            <label class="field">
              <span class="field-label">Z</span>
              <input class="text-input" type="number" step="0.1" :value="poseText(segment, 'z')" @change="updatePose(segment.id, 'z', $event)" />
            </label>
            <label class="field">
              <span class="field-label">朝向°</span>
              <input class="text-input" type="number" step="5" :value="poseText(segment, 'yaw')" @change="updatePose(segment.id, 'yaw', $event)" />
            </label>
          </div>

          <div class="pose-foot">
            <span class="faint">段站位相对角色摆放，播放到该段时生效</span>
            <button class="btn btn-sm" type="button" @click.stop="store.resetSegmentPose(segment.id)">清除站位</button>
          </div>
        </div>
      </div>
    </template>

    <div v-if="pickerOpen" class="picker panel">
      <div class="picker-head">
        <div class="tabs">
          <button
            class="tab"
            :class="{ active: pickerTab === 'fbx' }"
            type="button"
            :disabled="actor?.kind === 'soma'"
            @click="pickerTab = 'fbx'"
          >
            FBX 动画库
          </button>
          <button class="tab" :class="{ active: pickerTab === 'kimodo' }" type="button" @click="pickerTab = 'kimodo'">
            Kimodo
          </button>
          <button
            class="tab"
            :class="{ active: pickerTab === 'anim' }"
            type="button"
            :disabled="actor?.kind === 'soma'"
            @click="pickerTab = 'anim'"
          >
            新建动画
          </button>
        </div>
        <button class="btn btn-icon" type="button" title="关闭" @click="pickerOpen = false">
          <Icon name="close" :size="13" />
        </button>
      </div>

      <template v-if="pickerTab === 'fbx'">
        <input v-model="keyword" class="text-input" placeholder="搜索 FBX 文件名" />
        <div class="list">
          <button
            v-for="file in filteredFiles"
            :key="file.path"
            class="row"
            :class="{ active: openFile?.path === file.path }"
            type="button"
            @click="chooseFile(file)"
          >
            <Icon name="cube" :size="12" />
            <span class="row-name">{{ file.relative }}</span>
          </button>
          <div v-if="filteredFiles.length === 0" class="empty">动画库里没有匹配的 FBX</div>
        </div>

        <div v-if="openFile" class="clips">
          <span class="faint mono">片段 {{ openFile.name }}</span>
          <div v-if="loadingClips" class="empty">读取片段…</div>
          <div v-else class="chips">
            <button
              v-for="clip in clipOptions"
              :key="clip.name"
              class="clip"
              type="button"
              @click="addFbxClip(clip.name, clip.duration)"
            >
              <span>{{ clip.name }}</span>
              <span class="faint mono">{{ format(clip.duration) }}s</span>
            </button>
            <div v-if="clipOptions.length === 0" class="empty">该 FBX 没有内嵌动画</div>
          </div>
        </div>
      </template>

      <template v-else-if="pickerTab === 'kimodo'">
        <div class="list">
          <button v-for="job in store.kimodoJobs" :key="job.id" class="row" type="button" @click="addKimodo(job.id)">
            <Icon name="sparkle" :size="12" />
            <span class="row-name">{{ jobTitle(job.id) }}</span>
            <span class="faint mono">{{ format(store.kimodoDuration(job.id)) }}s</span>
          </button>
          <div v-if="store.kimodoJobs.length === 0" class="empty">还没有生成完成的 Kimodo 动作</div>
        </div>
        <p class="hint">
          {{ actor?.kind === 'soma' ? 'Soma 骨架角色播放 Kimodo 原生 30 关节动作' : 'Kimodo 动作会自动转换成 Mixamo 骨架的关键帧' }}
        </p>
      </template>

      <template v-else>
        <div class="list">
          <button
            v-for="project in store.animationProjects"
            :key="project.id"
            class="row"
            type="button"
            @click="addAnimationProject(project.id, project.name)"
          >
            <Icon name="film" :size="12" />
            <span class="row-name">{{ project.name }}</span>
            <span class="faint mono">{{ projectMeta(project.id) }}</span>
          </button>
          <div v-if="store.animationProjects.length === 0" class="empty">「新建动画」工作区里还没有保存的动画</div>
        </div>
        <p class="hint">加入时会读取该项目的关键帧时长；只导入动画数据，不复制模型</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.editor {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.btn-sm {
  height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
}

.actor-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.empty {
  padding: 16px 10px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  line-height: 1.6;
}

.segments {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.segment {
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  cursor: pointer;
}

.segment:hover {
  border-color: var(--border-strong);
}

.segment.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.segment-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-dim);
}

.segment-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.segment-actions {
  display: flex;
  gap: 2px;
}

.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-faint);
}

.mini:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.mini.rotate svg {
  transform: rotate(180deg);
}

.segment-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-top: 6px;
}

.pose-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
}

.pose-foot .btn-sm {
  height: 22px;
  padding: 0 7px;
  font-size: 11px;
}

.field {
  display: block;
}

.text-input,
.select-input {
  padding: 5px 7px;
  font-size: 12px;
}

.picker {
  position: absolute;
  inset: 8px;
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--bg-panel);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tabs {
  display: flex;
  gap: 4px;
}

.tab {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 12px;
}

.tab.active {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-hover);
}

.tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
  flex: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
}

.row:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.row.active {
  border-color: var(--accent);
  color: var(--text);
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clips {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.clip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-panel-2);
  font-size: 12px;
}

.clip:hover {
  border-color: var(--accent);
  color: var(--accent-hover);
}

.hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.5;
}
</style>
