<script setup lang="ts">
/**
 * StripInspector —— 拼接工作区右栏的「单条 Strip 检查器」。
 *
 * 定位：时间轴负责粗粒度拖动，本组件负责精确属性编辑（名称、身体部位多选、
 * 起点/时长/裁剪点、混合权重、静音、复制、删除），并承担烘焙、保存与新编排入口。
 * 它不持有本地副本，全部读写 useStripsStore；`strip` 只是 selectedStrip 的只读视图。
 *
 * v2 关键设计：
 *  - 5 个身体部位互不重叠，同一部位只能归一条 Strip；多处占用会被 store 拦下并 toast，
 *    同时本组件把被占用部位标为「占用」虚线样式，提前暴露冲突；
 *  - 同一动画可通过多选部位延伸到多个 lane；
 *  - 悬停部位按钮会让模型对应部位外发光（store.setHoverPart → StripsPlayer.setHighlight）。
 *
 * 数据去向：所有编辑最终调用 store.updateStrip()，由 store 统一失效烘焙结果、
 * 标记未保存（dirty）、推送给 player 重算混合。
 */
import { computed } from 'vue';
import Icon from '../ui/Icon.vue';
import { useStripsStore, MAX_STRIP_TRACKS } from '@/stores/strips';
import { BODY_PARTS } from '@/viewer/strips/StripParts';
import type { BodyPart } from '@/viewer/strips/StripTypes';

const store = useStripsStore();
/** 当前选中的 Strip；时间轴点击块或 store.selectStrip() 会切换它，可能为 null */
const strip = computed(() => store.selectedStrip);
/** 该 Strip 的来源加载状态（loading / ready / error），决定「来源状态」文案与颜色 */
const clipState = computed(() => (strip.value ? store.clipStates[strip.value.id] : undefined));

/**
 * 数值/名称输入统一入口（在 change 时提交，避免每次按键都重建 player 数据）。
 * 时间类字段单位是秒；空串或非法数字会被 `Number(...) || 0` 转成 0，
 * 之后 store.updateStrip 还会做各自的 clamp（start ≥ 0、duration 0.2~60）。
 */
function onChange(event: Event, key: 'name' | 'start' | 'duration' | 'trimStart'): void {
  if (!strip.value) return;
  const input = event.target as HTMLInputElement;
  if (key === 'name') {
    store.updateStrip(strip.value.id, { name: input.value });
    return;
  }
  store.updateStrip(strip.value.id, { [key]: Number(input.value) || 0 });
}

/**
 * 点击部位：已占用时 store 会提示冲突，不会写入。
 * 取消最后一个部位同样会被 store 拒绝（每个 Strip 至少保留一个部位），
 * 因此这里无需本地校验，失败路径全部由 store.setStripParts 负责「拦下 + toast」。
 */
function togglePart(part: BodyPart): void {
  if (!strip.value) return;
  store.toggleStripPart(strip.value.id, part);
}

/** 该部位是否属于当前选中的 Strip（决定 .active 高亮） */
function partSelected(part: BodyPart): boolean {
  return strip.value?.parts.includes(part) ?? false;
}

/**
 * 该部位被哪条来源动画占用（用于冲突标记与提示）。
 * exceptId 传当前 Strip 的 id，把「自己」排除掉，只返回其他占用者。
 */
function partOwner(part: BodyPart): string | null {
  if (!strip.value) return null;
  return store.ownerOfPart(part, strip.value.id)?.name ?? null;
}

/** 悬停部位时让模型对应部位外发光 */
function hoverPart(part: BodyPart | null): void {
  store.setHoverPart(part);
}

/** 权重滑杆：UI 是 0~100 的整数百分比，写入 store 前换算成 0~1 */
function setWeight(event: Event): void {
  if (!strip.value) return;
  store.updateStrip(strip.value.id, { weight: Number((event.target as HTMLInputElement).value) / 100 });
}

/** 静音：保留 Strip 与部位占用，但混合时跳过该来源（时间轴上会灰显） */
function toggleMute(): void {
  if (strip.value) store.updateStrip(strip.value.id, { muted: !strip.value.muted });
}

/**
 * 复制：store.duplicateStrip 会新建 id、占用一个空闲部位、起点后移 0.5s 并换色；
 * 若已满 5 条或没有空闲部位，则由 store toast 提示并放弃。
 */
function duplicate(): void {
  if (strip.value) store.duplicateStrip(strip.value.id);
}

/** 删除当前 Strip；store 会同步清理来源状态/时长缓存并重新选中第一条 */
function remove(): void {
  if (strip.value) store.removeStrip(strip.value.id);
}

/** 「来源状态」文案：clips 尚未回调时也算等待加载，成功时附带该来源的真实时长（秒） */
const clipText = computed(() => {
  const state = clipState.value;
  if (!state) return '等待加载';
  if (state.status === 'loading') return '载入来源片段…';
  if (state.status === 'error') return state.message ?? '加载失败';
  return state.duration ? `就绪 · ${state.duration.toFixed(2)}s` : '就绪';
});

/** 保存按钮文案：已有 projectId 表示这是再次编辑，保存走「更新」 */
const saveLabel = computed(() => {
  if (store.saving) return '保存中';
  return store.projectId ? '更新拼接动画' : '保存为拼接动画';
});
</script>

<template>
  <div class="inspector panel">
    <!-- 头部：显示当前 Strip 的来源标签（FBX 片段 / Kimodo / 已保存项目） -->
    <div class="head">
      <span class="section-title"><Icon name="layers" :size="12" />Strip 检查器</span>
      <span v-if="strip" class="faint mono source">{{ store.sourceLabel(strip.source) }}</span>
    </div>

    <!-- 编排级状态条：项目名（未保存时有黄点）与「新建」入口（清空时间轴但保留基础模型） -->
    <div class="project-bar">
      <span class="project-name" :title="store.projectName || '尚未保存'">
        {{ store.projectName || '未保存的拼接编排' }}
        <span v-if="store.dirty" class="dot" title="有未保存的修改"></span>
      </span>
      <button class="btn btn-sm" type="button" title="清空时间轴，新建一个拼接动画" @click="store.newComposition()">
        <Icon name="plus" :size="11" />新建
      </button>
    </div>

    <!-- 未选中任何 Strip 时的占位说明；属性表单与操作按钮仅在选中后渲染 -->
    <div v-if="!strip" class="empty">
      在时间轴上选中一个 Strip，这里可以调整身体部位、权重与范围
    </div>

    <template v-else>
      <label class="field">
        <span class="field-label">名称</span>
        <!-- change 而非 input：失焦/回车才提交，减少对 player 的频繁重建 -->
        <input class="text-input" :value="strip.name" @change="onChange($event, 'name')" />
      </label>

      <div class="field">
        <span class="field-label">
          身体部位（可多选）
          <span class="faint part-hint">悬停可高亮模型部位</span>
        </span>
        <!-- 5 个部位按钮：active = 本 Strip 占用；used = 被其他 Strip 占用（虚线 + 「占用」角标） -->
        <div class="parts">
          <button
            v-for="part in BODY_PARTS"
            :key="part.id"
            class="part"
            :class="{ active: partSelected(part.id), used: !!partOwner(part.id) }"
            type="button"
            :title="partOwner(part.id) ? `${part.hint} · 已被「${partOwner(part.id)}」占用` : part.hint"
            @click="togglePart(part.id)"
            @mouseenter="hoverPart(part.id)"
            @mouseleave="hoverPart(null)"
          >
            <span class="part-label">{{ part.label }}</span>
            <span v-if="partOwner(part.id)" class="part-used mono">占用</span>
          </button>
        </div>
      </div>

      <div class="field">
        <span class="field-label">混合权重 <span class="mono weight">{{ Math.round(strip.weight * 100) }}%</span></span>
        <!-- 0~100 百分比滑杆，实时 input 即写入（权重变化不触发重新加载来源） -->
        <input class="range" type="range" min="0" max="100" :value="strip.weight * 100" @input="setWeight" />
      </div>

      <!-- 时间参数：起点/时长/裁剪起点单位均为秒，step 0.05s；min 只是浏览器约束，
           真正的 clamp 在 store.updateStrip 内 -->
      <div class="grid2">
        <label class="field">
          <span class="field-label">起点（秒）</span>
          <input class="text-input mono" type="number" min="0" step="0.05" :value="strip.start.toFixed(2)" @change="onChange($event, 'start')" />
        </label>
        <label class="field">
          <span class="field-label">时长（秒）</span>
          <input class="text-input mono" type="number" min="0.2" step="0.05" :value="strip.duration.toFixed(2)" @change="onChange($event, 'duration')" />
        </label>
        <label class="field">
          <span class="field-label">裁剪起点（秒）</span>
          <input class="text-input mono" type="number" min="0" step="0.05" :value="strip.trimStart.toFixed(2)" @change="onChange($event, 'trimStart')" />
        </label>
        <div class="field">
          <span class="field-label">来源状态</span>
          <span class="state" :class="clipState?.status ?? 'idle'">{{ clipText }}</span>
        </div>
      </div>

      <!-- 当前 Strip 的快捷操作：静音不释放部位；复制会另占空闲部位；删除不可撤销 -->
      <div class="actions">
        <button class="btn btn-sm" type="button" @click="toggleMute">
          <Icon :name="strip.muted ? 'ban' : 'eye'" :size="12" />{{ strip.muted ? '取消静音' : '静音' }}
        </button>
        <button class="btn btn-sm" type="button" @click="duplicate">
          <Icon name="copy" :size="12" />复制
        </button>
        <button class="btn btn-sm danger" type="button" @click="remove">
          <Icon name="trash" :size="12" />删除
        </button>
      </div>
    </template>

    <div class="divider"></div>

    <!-- 烘焙区：把 5 条来源按部位混合结果固化成一条 30fps 的 AnimationClip，
         只有烘焙成功后才能切「烘焙预览」或保存项目 -->
    <div class="bake">
      <div class="bake-head">
        <span class="section-title"><Icon name="sparkle" :size="12" />烘焙</span>
        <!-- 无 Strip、无基础模型或正在烘焙时禁用，避免产出空结果 -->
        <button
          class="btn btn-sm btn-primary"
          type="button"
          :disabled="store.baking || store.strips.length === 0 || !store.baseFile"
          @click="store.bake()"
        >
          <Icon name="check" :size="12" />{{ store.baking ? '烘焙中' : '烘焙' }}
        </button>
      </div>

      <!-- 烘焙后可在「实时混合 / 烘焙预览」间切换；未烘焙时该组不出现 -->
      <div v-if="store.baked" class="modes">
        <button class="mode" :class="{ active: !store.bakedMode }" type="button" @click="store.setBakedMode(false)">
          实时混合
        </button>
        <button class="mode" :class="{ active: store.bakedMode }" type="button" @click="store.setBakedMode(true)">
          烘焙预览
        </button>
      </div>

      <!-- 烘焙结果摘要：轨道数、烘焙时间轴总长（秒）与固定 30fps -->
      <div v-if="store.baked" class="baked-info faint mono">
        {{ store.baked.data.clips[0]?.tracks.length ?? 0 }} 轨 ·
        {{ store.baked.data.timeline.totalDuration.toFixed(2) }}s · 30fps
      </div>

      <!-- 编排约束提示：总长取最长源动画（store.span），槽位上限 = 身体部位数量 -->
      <p class="note">
        总长 {{ store.span.toFixed(2) }}s（取源动画里最长的一段）· 最多 {{ MAX_STRIP_TRACKS }} 个源动画 ·
        当前 {{ store.strips.length }} 个
      </p>

      <!-- 保存：名称默认「动画自由拼-年-月-日-时-分-秒」，由 store 在首次添加时生成 -->
      <div class="save">
        <input v-model="store.saveName" class="text-input" placeholder="动画名称" />
        <!-- 必须先烘焙；已有 projectId 时按钮文案变为「更新拼接动画」 -->
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!store.baked || store.saving"
          @click="store.saveBaked()"
        >
          <Icon name="download" :size="12" />{{ saveLabel }}
        </button>
      </div>
      <!-- 保存去向：动画工作区的「拼接动画」分类，card 上提供「编辑拼接」再次回到本页 -->
      <p class="note">保存后在「动画」工作区的「拼接动画」分类里，可随时再次打开修改。</p>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.project-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
}

.project-name {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--warn, #d97706);
}

.empty {
  padding: 14px 2px;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-label {
  font-size: 11.5px;
  color: var(--text-dim);
}

.part-hint {
  float: right;
  font-size: 10.5px;
}

.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.weight {
  float: right;
  color: var(--text);
}

.parts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.part {
  position: relative;
  height: 30px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 11.5px;
}

.part:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.part.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.part.used {
  border-style: dashed;
  color: var(--text-faint);
}

.part-used {
  position: absolute;
  right: 3px;
  top: 2px;
  font-size: 8.5px;
  color: var(--danger);
}

.range {
  width: 100%;
  accent-color: var(--accent);
}

.grid2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

.state {
  height: 26px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  font-size: 11.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state.ready {
  color: var(--success);
  border-color: rgba(52, 211, 153, 0.4);
}

.state.error {
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.4);
}

.actions {
  display: flex;
  gap: 6px;
}

.btn-sm {
  height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
}

.btn.danger {
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.35);
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 2px 0;
}

.bake {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bake-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modes {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
}

.mode {
  flex: 1;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
}

.mode:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.mode.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.baked-info {
  font-size: 11px;
}

.note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}

.save {
  display: flex;
  gap: 6px;
}

.save .text-input {
  flex: 1;
  min-width: 0;
}

.save .btn {
  flex: none;
  white-space: nowrap;
}
</style>
