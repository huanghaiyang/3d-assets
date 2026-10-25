<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import BoneTree from './BoneTree.vue';
import NodeTree from './NodeTree.vue';
import FingerPanel from './FingerPanel.vue';
import { useAnimationStore } from '@/stores/animation';
import { formatBytes } from '@/utils/image';
import { confirmAction } from '@/composables/useConfirm';

const store = useAnimationStore();
const tab = ref<'info' | 'bones' | 'nodes' | 'fingers'>('info');

const file = computed(() => store.selectedFile);
const jsonInput = ref<HTMLInputElement | null>(null);

// 新建动画后自动切到信息页，方便立即导入 JSON；退出编辑时收起手指模块
watch(
  () => store.newAnimationMode,
  () => {
    tab.value = 'info';
  },
);

function onJsonPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const picked = input.files?.[0];
  input.value = '';
  if (picked) void store.importAnimationJson(picked);
}

async function deleteActive(): Promise<void> {
  const id = store.activeNewAnimationId;
  if (!id) return;
  const project = store.activeNewAnimation;
  const detail = project?.saved
    ? '已保存的项目会移入回收站，之后仍可恢复。'
    : '该动画尚未保存，移除后无法找回。';
  const ok = await confirmAction({
    title: project?.saved ? '移入回收站' : '移除新建动画',
    message: '确定删除当前新建动画？',
    detail,
    confirmText: project?.saved ? '移入回收站' : '移除',
  });
  if (!ok) return;
  store.deleteNewAnimation(id);
}

/** 保存按钮：必须先导入动画 JSON，且不在保存中 */
const canSave = computed(() => !!store.activeNewAnimation?.data && !store.savingAnimation);

const saveStateText = computed(() => {
  const project = store.activeNewAnimation;
  if (!project) return '';
  if (!project.saved) return '尚未保存';
  return project.dirty ? '有修改待保存' : '已保存到服务端';
});

function clipDuration(seconds: number): string {
  return `${seconds.toFixed(2)} 秒`;
}
</script>

<template>
  <aside class="anim-info">
    <header class="head">
      <div class="tabs">
        <button class="tab" :class="{ active: tab === 'info' }" type="button" @click="tab = 'info'">
          <Icon name="info" :size="13" />
          信息
        </button>
        <button class="tab" :class="{ active: tab === 'bones' }" type="button" @click="tab = 'bones'">
          <Icon name="bone" :size="13" />
          骨骼
          <span v-if="store.boneList.length" class="chip">{{ store.boneList.length }}</span>
        </button>
        <button class="tab" :class="{ active: tab === 'nodes' }" type="button" @click="tab = 'nodes'">
          <Icon name="cube" :size="13" />
          节点
        </button>
        <button
          v-if="store.newAnimationMode"
          class="tab"
          :class="{ active: tab === 'fingers' }"
          type="button"
          title="从现有 Mixamo 动画提取的手型，左右手可分别替换"
          @click="tab = 'fingers'"
        >
          <Icon name="bone" :size="13" />
          手指
        </button>
      </div>
    </header>

    <NodeTree
      v-if="tab === 'nodes'"
      :tree="store.nodeTree"
      :selected="store.selectedNodeIds"
      :keyword="store.nodeKeyword"
      :show-bones="store.nodeShowBones"
      @update:keyword="store.nodeKeyword = $event"
      @update:show-bones="store.nodeShowBones = $event"
      @select="(id, additive) => store.selectNode(id, additive)"
      @clear="store.clearNodeSelection()"
    />
    <BoneTree v-else-if="tab === 'bones'" />
    <FingerPanel v-else-if="tab === 'fingers'" />

    <div v-else class="body">
      <section v-if="store.newAnimationMode" class="block new-anim">
        <span class="field-label">新建动画</span>
        <p class="file-name">{{ store.activeNewAnimation?.name ?? '新建动画' }}</p>
        <dl class="info">
          <div><dt>基础模型</dt><dd :title="store.activeNewAnimation?.baseName">{{ store.activeNewAnimation?.baseName || '—' }}</dd></div>
          <div>
            <dt>骨骼</dt>
            <dd>{{ store.selectedStats?.bones ?? store.boneList.length }} 根</dd>
          </div>
          <div>
            <dt>保存状态</dt>
            <dd :class="{ 'save-dirty': store.activeNewAnimation?.dirty }">{{ saveStateText }}</dd>
          </div>
        </dl>
        <p class="data-hint">已从基础模型上去掉动画，只保留网格与绑定姿态；导入动画 JSON 即可按关节名绑定。</p>
        <p class="data-hint">原有动画为只读，只有新建动画可以导入 JSON、编辑姿态、保存或删除。</p>
        <p v-if="store.importedAnimation" class="import-note">
          <Icon name="check" :size="12" />
          <span>
            已绑定 {{ store.importedAnimation.name }}：{{ store.importedAnimation.clipCount }} 个片段、
            {{ store.importedAnimation.trackCount }} 条轨迹
          </span>
        </p>
        <div class="new-actions">
          <button
            class="btn data-btn"
            type="button"
            :disabled="store.importingAnimation"
            @click="jsonInput?.click()"
          >
            <Icon name="upload" :size="13" />
            {{ store.importingAnimation ? '导入中…' : (store.importedAnimation ? '重新导入 JSON' : '导入动画 JSON') }}
          </button>
          <button
            class="btn data-btn"
            type="button"
            :disabled="!canSave"
            :title="canSave ? '保存到服务端，刷新后仍可重新打开' : '请先导入动画 JSON'"
            @click="store.saveNewAnimation()"
          >
            <Icon name="check" :size="13" />
            {{ store.savingAnimation ? '保存中…' : '保存' }}
          </button>
          <button
            class="btn"
            type="button"
            title="退出编辑只是回到进入编辑前选中的原动画；当前项目仍保留在左侧「新建动画」里，可随时重新打开，不代表保存失败"
            @click="store.exitNewAnimation()"
          >
            退出编辑
          </button>
          <button class="btn btn-danger" type="button" @click="deleteActive">删除</button>
        </div>
        <p class="data-hint">
          「退出编辑」不会删除项目，也不会撤销已保存的内容；它只是把 3D 视图切回进入编辑前选中的原动画。
          保存进度见上方「保存状态」，左侧「新建动画」卡片会标出「已保存 / 未保存」。
        </p>
        <input
          ref="jsonInput"
          class="hidden-input"
          type="file"
          accept=".json,application/json"
          @change="onJsonPicked"
        />
      </section>

      <template v-if="file">
        <section class="block">
          <span class="field-label">文件</span>
          <p class="file-name" :title="file.name">{{ file.name }}</p>
          <dl class="info">
            <div><dt>大小</dt><dd>{{ formatBytes(file.size) }}</dd></div>
            <div><dt>修改时间</dt><dd>{{ new Date(file.mtime).toLocaleString('zh-CN') }}</dd></div>
            <div v-if="store.selectedStats">
              <dt>网格</dt>
              <dd>
                {{ store.selectedStats.meshes }} 个<template v-if="store.selectedStats.skinned">（含蒙皮）</template>
              </dd>
            </div>
            <div v-if="store.selectedStats">
              <dt>骨骼</dt>
              <dd>
                {{ store.selectedStats.bones }}
                <span
                  v-if="store.selectedStats.boneNodes > store.selectedStats.bones"
                  class="note"
                  :title="`场景里共有 ${store.selectedStats.boneNodes} 个骨骼对象，其余为 FBX 同名包装节点`"
                >
                  （共 {{ store.selectedStats.boneNodes }} 节点）
                </span>
              </dd>
            </div>
            <div v-if="store.selectedStats">
              <dt>三角面</dt><dd>{{ store.selectedStats.triangles.toLocaleString('en-US') }}</dd>
            </div>
            <div v-if="store.selectedStats">
              <dt>材质</dt><dd>{{ store.selectedStats.materials }}</dd>
            </div>
          </dl>
        </section>
      </template>

      <section v-if="store.selectedClips.length > 0" class="block">
        <span class="field-label">动画片段（{{ store.selectedClips.length }}）</span>
        <div class="clips">
          <button
            v-for="(clip, index) in store.selectedClips"
            :key="clip.name + index"
            class="clip"
            :class="{ active: store.activeClipIndex === index }"
            type="button"
            @click="store.playClipIndex(index)"
          >
            <Icon name="play" :size="11" />
            <span class="clip-name" :title="clip.name">{{ clip.name }}</span>
            <span class="mono faint">{{ clipDuration(clip.duration) }}</span>
          </button>
        </div>
      </section>

      <section v-if="file && !store.newAnimationMode" class="block">
        <span class="field-label">动画数据</span>
        <p class="data-hint">只提取关节层级、轨迹与时间线，不含网格蒙皮数据。</p>
        <button
          class="btn data-btn"
          type="button"
          :disabled="!file || store.viewLoading"
          @click="store.openAnimationData()"
        >
          <Icon name="text" :size="13" />
          提取动画数据
        </button>
      </section>

      <section v-if="file || store.newAnimationMode" class="block">
        <span class="field-label">播放选项</span>
        <label class="row">
          <span>原地播放<small>去掉髋部水平位移，便于观察循环动作</small></span>
          <input
            type="checkbox"
            class="checkbox"
            :checked="store.inPlace"
            @change="store.setInPlace(($event.target as HTMLInputElement).checked)"
          />
        </label>
        <label class="row">
          <span>左右镜像<small>翻转模型与动作方向</small></span>
          <input
            type="checkbox"
            class="checkbox"
            :checked="store.mirror"
            @change="store.setMirror(($event.target as HTMLInputElement).checked)"
          />
        </label>
        <label class="row">
          <span>地面网格</span>
          <input
            type="checkbox"
            class="checkbox"
            :checked="store.showGrid"
            @change="store.setGridView(($event.target as HTMLInputElement).checked)"
          />
        </label>
        <div class="speed-row">
          <span class="speed-label">播放速度</span>
          <input
            class="slider"
            type="range"
            min="0.1"
            max="2"
            step="0.05"
            :value="store.speed"
            @input="store.setSpeed(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="mono speed-value">{{ store.speed.toFixed(2) }}×</span>
        </div>
      </section>

      <p v-if="!file && !store.newAnimationMode" class="empty">从左侧选择一个动画，这里会显示文件与片段信息</p>

      <section class="block readonly-note">
        <span class="field-label">只读说明</span>
        <p>
          本页只使用 <span class="mono">readdir / stat / readFile</span> 读取
          <span class="mono">.fbx</span>，不会写入、修改或锁定源文件夹中的任何文件；
          新建动画保存到项目自己的 <span class="mono">data/anim-projects</span> 目录，同样不会碰源文件。
          封面由后端子线程渲染，只缓存 192px 的 PNG 到内存（不落盘、不占浏览器主线程）。
        </p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.anim-info {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}

.head {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.tabs {
  display: flex;
  gap: 3px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 0;
  min-width: 0;
  justify-content: center;
  height: 28px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
}

.tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tab.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
  font-weight: 600;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-name {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  word-break: break-all;
}

.info {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.info dt {
  font-size: 11.5px;
  color: var(--text-faint);
  flex: none;
}

.info dd {
  margin: 0;
  font-size: 11.5px;
  text-align: right;
}

.note {
  font-size: 10.5px;
  color: var(--text-faint);
  cursor: help;
}

.clips {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.clip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-dim);
  text-align: left;
}

.clip:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.clip.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.clip-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

.data-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}

.data-btn {
  align-self: flex-start;
}

.new-anim {
  padding: 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
}

.import-note {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--accent-hover);
}

.import-note :deep(svg) {
  flex: none;
  margin-top: 1px;
}

.new-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.save-dirty {
  color: #e0a030;
}

.hidden-input {
  display: none;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
  font-size: 12px;
}

.row small {
  display: block;
  font-size: 10.5px;
  color: var(--text-faint);
  line-height: 1.4;
}

.checkbox {
  flex: none;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  cursor: pointer;
}

.speed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.speed-label {
  font-size: 12px;
  flex: none;
}

.slider {
  flex: 1;
  min-width: 0;
  height: 4px;
  appearance: none;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #4b3fb0);
  outline: none;
}

.slider::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent);
  cursor: pointer;
}

.speed-value {
  flex: none;
  width: 40px;
  text-align: right;
  color: var(--text-dim);
}

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}

.readonly-note {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.readonly-note p {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-faint);
}
</style>
