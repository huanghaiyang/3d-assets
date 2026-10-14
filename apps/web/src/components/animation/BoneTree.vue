<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import { useAnimationStore } from '@/stores/animation';
import type { BoneDisplayMode, BoneNode } from '@/viewer/SkeletonOverlay';

const store = useAnimationStore();

const DISPLAY_MODES = [
  { value: 'stick', label: '点线', hint: '关节圆点 + 父子连线，看整体结构更清爽' },
  { value: 'bone', label: '八面体', hint: 'Blender 风格的八面体骨头，能看出一根骨骼的长短与朝向' },
];

const expanded = ref<Set<string>>(new Set());
const scrollRef = ref<HTMLDivElement | null>(null);
/** 上一次点击的行下标，用于 Shift 连选 */
let lastIndex = -1;

interface Row {
  node: BoneNode;
  depth: number;
  isLeaf: boolean;
  expanded: boolean;
  /** 搜索命中要害：命中的骨骼本身 */
  matched: boolean;
}

/** 首次拿到骨骼时全部展开，之后保留用户折叠状态 */
watch(
  () => store.boneList.length,
  (count, previous) => {
    if (count > 0 && (!previous || previous === 0)) {
      const all = new Set<string>();
      for (const bone of store.boneList) all.add(bone.id);
      expanded.value = all;
    }
    lastIndex = -1;
  },
  { immediate: true },
);

/** 搜索时先算出"命中 + 命中项的所有祖先"，用于自动展开 */
const searchState = computed(() => {
  const keyword = store.boneKeyword.trim().toLowerCase();
  if (!keyword) return null;
  const matched = new Set<string>();
  const visible = new Set<string>();
  const byId = new Map(store.boneList.map((bone) => [bone.id, bone]));
  for (const bone of store.boneList) {
    if (!bone.label.toLowerCase().includes(keyword) && !bone.name.toLowerCase().includes(keyword)) continue;
    matched.add(bone.id);
    visible.add(bone.id);
    let parentId = bone.parentId;
    while (parentId) {
      visible.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  return { matched, visible };
});

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const search = searchState.value;
  const walk = (nodes: BoneNode[]): void => {
    for (const node of nodes) {
      if (search && !search.visible.has(node.id)) continue;
      const isLeaf = node.children.length === 0;
      // 搜索时强制展开，便于直接看到命中项
      const isOpen = search ? true : expanded.value.has(node.id);
      out.push({ node, depth: node.depth, isLeaf, expanded: isOpen, matched: search?.matched.has(node.id) ?? false });
      if (isOpen) walk(node.children);
    }
  };
  walk(store.boneTree);
  return out;
});

const selectedSet = computed(() => new Set(store.selectedBones));

function toggleExpand(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function rowClick(event: MouseEvent, index: number): void {
  const id = rows.value[index]!.node.id;
  const additive = event.ctrlKey || event.metaKey;
  const range = event.shiftKey;

  if (range && lastIndex >= 0) {
    const [from, to] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
    const slice = rows.value.slice(from, to + 1).map((row) => row.node.id);
    store.setBoneSelection([...new Set([...store.selectedBones, ...slice])]);
  } else if (additive) {
    store.toggleBone(id);
  } else {
    store.setBoneSelection([id]);
  }
  lastIndex = index;
}

function focusBone(id: string): void {
  const index = rows.value.findIndex((row) => row.node.id === id);
  if (index < 0) {
    // 被折叠了：先把祖先全部展开
    const byId = new Map(store.boneList.map((bone) => [bone.id, bone]));
    const next = new Set(expanded.value);
    let parentId = byId.get(id)?.parentId ?? null;
    while (parentId) {
      next.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    expanded.value = next;
    return;
  }
  requestAnimationFrame(() => {
    scrollRef.value?.querySelector(`[data-bone="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

/** 在模型上点选后，把树上对应的骨骼滚动到可见位置 */
watch(
  () => store.selectedBones.join('|'),
  () => {
    const id = store.selectedBones[store.selectedBones.length - 1];
    if (id) focusBone(id);
  },
);

function expandAll(): void {
  const all = new Set<string>();
  for (const bone of store.boneList) all.add(bone.id);
  expanded.value = all;
}

function collapseAll(): void {
  const roots = new Set(store.boneTree.map((node) => node.id));
  expanded.value = roots;
}
</script>

<template>
  <div class="bone-panel">
    <div class="toolbar">
      <label class="switch" :title="store.showSkeleton ? '隐藏骨骼' : '显示骨骼'">
        <input
          type="checkbox"
          class="checkbox"
          :checked="store.showSkeleton"
          @change="store.setSkeletonVisible(($event.target as HTMLInputElement).checked)"
        />
        <Icon name="bone" :size="13" />
        <span>显示骨骼</span>
      </label>
      <button class="icon-btn" type="button" title="展开全部" @click="expandAll">
        <Icon name="chevronDown" :size="13" />
      </button>
      <button class="icon-btn" type="button" title="折叠到根" @click="collapseAll">
        <Icon name="chevronRight" :size="13" />
      </button>
    </div>

    <div class="mode-row">
      <SegmentedControl
        :model-value="store.boneDisplayMode"
        :options="DISPLAY_MODES"
        size="sm"
        @update:model-value="store.setBoneDisplayMode($event as BoneDisplayMode)"
      />
    </div>

    <div class="search">
      <Icon name="search" :size="12" />
      <input v-model="store.boneKeyword" class="search-input" type="search" placeholder="搜索骨骼" />
      <button v-if="store.boneKeyword" class="icon-btn small" type="button" title="清空" @click="store.boneKeyword = ''">
        <Icon name="close" :size="10" />
      </button>
    </div>

    <div v-if="store.boneList.length === 0" class="empty">当前模型没有骨骼</div>

    <template v-else>
      <div class="selection-bar">
        <span class="count">已选 {{ store.selectedBones.length }} / {{ store.boneList.length }}</span>
        <button v-if="store.selectedBones.length" class="link" type="button" @click="store.clearBoneSelection()">
          清除
        </button>
      </div>

      <div ref="scrollRef" class="tree">
        <div
          v-for="(row, index) in rows"
          :key="row.node.id"
          class="bone-row"
          :class="{ selected: selectedSet.has(row.node.id), matched: row.matched }"
          :data-bone="row.node.id"
          :style="{ paddingLeft: `${6 + row.depth * 11}px` }"
          :title="row.node.name"
          @click="rowClick($event, index)"
          @mouseenter="store.setHoveredBone(row.node.id)"
          @mouseleave="store.setHoveredBone(null)"
        >
          <button
            v-if="!row.isLeaf"
            class="caret"
            type="button"
            @click.stop="toggleExpand(row.node.id)"
          >
            <Icon :name="row.expanded ? 'chevronDown' : 'chevronRight'" :size="10" />
          </button>
          <span v-else class="caret-spacer"></span>
          <span class="dot" :class="{ on: selectedSet.has(row.node.id) }"></span>
          <span class="label">{{ row.node.label }}</span>
        </div>
      </div>
    </template>

    <p class="hint">
      单击选中，<span class="mono">Ctrl/⌘</span> 加选或取消，<span class="mono">Shift</span> 连选；也可以直接在模型上点骨骼。
      <template v-if="store.ignoredBoneNodes > 0">
        <br />已忽略 {{ store.ignoredBoneNodes }} 个 FBX 同名包装节点（不参与形变）。
      </template>
    </p>
  </div>
</template>

<style scoped>
.bone-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}

.mode-row {
  padding: 0 12px 8px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel-2);
  color: var(--text-dim);
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.icon-btn.small {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 8px;
  height: 26px;
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
  font-size: 12px;
}

.search-input::-webkit-search-cancel-button {
  display: none;
}

.selection-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 6px;
  font-size: 11px;
  color: var(--text-faint);
}

.link {
  border: none;
  background: transparent;
  color: var(--accent-hover);
  font-size: 11px;
}

.tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 6px;
}

.bone-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding-right: 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
}

.bone-row:hover {
  background: var(--bg-hover);
}

.bone-row.selected {
  background: rgba(251, 191, 36, 0.16);
}

.bone-row.selected .label {
  color: #fcd34d;
  font-weight: 600;
}

.bone-row.matched .label {
  color: var(--accent-hover);
}

.caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-faint);
  padding: 0;
}

.caret-spacer {
  width: 14px;
  flex: none;
}

.dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: #5eead4;
}

.dot.on {
  background: #fbbf24;
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.25);
}

.label {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 20px 12px;
  font-size: 12px;
  color: var(--text-faint);
  text-align: center;
}

.hint {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-faint);
}
</style>
