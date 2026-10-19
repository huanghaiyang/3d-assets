<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import type { SceneNode } from '@/viewer/sceneNodes';

/**
 * 场景节点树面板（纯展示组件）。
 * 动画页与工作台各自传入自己的数据，点击时抛出事件由外部去驱动高亮。
 */
const props = defineProps<{
  tree: SceneNode[];
  selected: string[];
  keyword: string;
  showBones: boolean;
}>();

const emit = defineEmits<{
  'update:keyword': [value: string];
  'update:showBones': [value: boolean];
  select: [id: string, additive: boolean];
  clear: [];
}>();

const expanded = ref<Set<string>>(new Set());
const scrollRef = ref<HTMLDivElement | null>(null);

interface Row {
  node: SceneNode;
  depth: number;
  isLeaf: boolean;
  expanded: boolean;
  matched: boolean;
}

/** 换模型（树根变化）时重新全部展开；同一模型内保留用户的折叠状态 */
watch(
  () => props.tree.map((node) => node.id).join('|'),
  (signature, previous) => {
    if (!signature || signature === previous) return;
    const all = new Set<string>();
    const walk = (nodes: SceneNode[]): void => {
      for (const node of nodes) {
        all.add(node.id);
        walk(node.children);
      }
    };
    walk(props.tree);
    expanded.value = all;
  },
  { immediate: true },
);

/** 搜索：命中项与它的所有祖先都保留，并强制展开 */
const searchState = computed(() => {
  const keyword = props.keyword.trim().toLowerCase();
  if (!keyword) return null;
  const matched = new Set<string>();
  const visible = new Set<string>();
  const walk = (nodes: SceneNode[], ancestors: string[]): void => {
    for (const node of nodes) {
      const hits = node.name.toLowerCase().includes(keyword) || node.type.toLowerCase().includes(keyword);
      if (hits) {
        matched.add(node.id);
        visible.add(node.id);
        for (const id of ancestors) visible.add(id);
      }
      // 路径要一直累积，否则命中项的祖先不会被标记为可见
      walk(node.children, [...ancestors, node.id]);
    }
  };
  walk(props.tree, []);
  return { matched, visible };
});

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const search = searchState.value;
  const walk = (nodes: SceneNode[], depth: number): void => {
    for (const node of nodes) {
      // 「只看对象」时跳过骨骼节点（骨骼在骨骼页签里有更细的界面）
      if (!props.showBones && node.isBone) continue;
      if (search && !search.visible.has(node.id)) continue;
      const kids = node.children.filter((child) => props.showBones || !child.isBone);
      const isLeaf = kids.length === 0;
      const isOpen = search ? true : expanded.value.has(node.id);
      out.push({ node, depth, isLeaf, expanded: isOpen, matched: search?.matched.has(node.id) ?? false });
      if (isOpen) walk(node.children, depth + 1);
    }
  };
  walk(props.tree, 0);
  return out;
});

const selectedSet = computed(() => new Set(props.selected));

function toggleExpand(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function rowClick(event: MouseEvent, node: SceneNode): void {
  emit('select', node.id, event.ctrlKey || event.metaKey);
}

function expandAll(): void {
  const all = new Set<string>();
  const walk = (nodes: SceneNode[]): void => {
    for (const node of nodes) {
      all.add(node.id);
      walk(node.children);
    }
  };
  walk(props.tree);
  expanded.value = all;
}

function collapseAll(): void {
  expanded.value = new Set(props.tree.map((node) => node.id));
}

/** 节点类型徽标 */
function typeLabel(node: SceneNode): string {
  if (node.type === 'Object3D') return '';
  if (node.type === 'SkinnedMesh') return '蒙皮';
  if (node.type === 'Mesh') return '网格';
  if (node.type === 'Group') return '组';
  return '';
}
</script>

<template>
  <div class="node-panel">
    <div class="toolbar">
      <label class="switch" title="骨骼节点在「骨骼」页签里有更细的界面">
        <input
          type="checkbox"
          class="checkbox"
          :checked="props.showBones"
          @change="emit('update:showBones', ($event.target as HTMLInputElement).checked)"
        />
        <Icon name="bone" :size="12" />
        <span>含骨骼节点</span>
      </label>
      <button class="icon-btn" type="button" title="展开全部" @click="expandAll">
        <Icon name="chevronDown" :size="13" />
      </button>
      <button class="icon-btn" type="button" title="折叠到根" @click="collapseAll">
        <Icon name="chevronRight" :size="13" />
      </button>
    </div>

    <div class="search">
      <Icon name="search" :size="12" />
      <input
        class="search-input"
        type="search"
        placeholder="搜索节点名 / 类型"
        :value="props.keyword"
        @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
      />
      <button v-if="props.keyword" class="icon-btn small" type="button" @click="emit('update:keyword', '')">
        <Icon name="close" :size="10" />
      </button>
    </div>

    <div v-if="props.tree.length === 0" class="empty">当前模型没有可展示的节点</div>

    <template v-else>
      <div class="selection-bar">
        <span class="count">已选 {{ props.selected.length }} 个节点</span>
        <button v-if="props.selected.length" class="link" type="button" @click="emit('clear')">
          清除
        </button>
      </div>

      <div ref="scrollRef" class="tree">
        <div
          v-for="row in rows"
          :key="row.node.id"
          class="node-row"
          :class="{ selected: selectedSet.has(row.node.id), matched: row.matched, bone: row.node.isBone }"
          :style="{ paddingLeft: `${6 + row.depth * 11}px` }"
          :title="`${row.node.name}（${row.node.type}）`"
          @click="rowClick($event, row.node)"
        >
          <button v-if="!row.isLeaf" class="caret" type="button" @click.stop="toggleExpand(row.node.id)">
            <Icon :name="row.expanded ? 'chevronDown' : 'chevronRight'" :size="10" />
          </button>
          <span v-else class="caret-spacer"></span>
          <span class="dot" :class="{ on: selectedSet.has(row.node.id) }"></span>
          <Icon :name="row.node.isBone ? 'bone' : 'cube'" :size="11" class="node-icon" />
          <span class="label">{{ row.node.name }}</span>
          <span v-if="typeLabel(row.node)" class="badge">{{ typeLabel(row.node) }}</span>
          <span v-if="row.node.boneCount > 0 && !row.node.isBone" class="meta">{{ row.node.boneCount }} 骨骼</span>
        </div>
      </div>
    </template>

    <p class="hint">
      单击高亮对应对象（包围盒 + 自发光），<span class="mono">Ctrl/⌘</span> 可多选。<br />
      骨骼节点留空表示只看对象层级；切换到「骨骼」页签可查看骨骼树与姿态。
    </p>
  </div>
</template>

<style scoped>
.node-panel {
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

.node-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding-right: 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
}

.node-row:hover {
  background: var(--bg-hover);
}

.node-row.selected {
  background: rgba(251, 191, 36, 0.16);
}

.node-row.selected .label {
  color: #fcd34d;
  font-weight: 600;
}

.node-row.matched .label {
  color: var(--accent-hover);
}

.node-row.bone .label {
  color: var(--text-faint);
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

.node-icon {
  flex: none;
  color: var(--text-faint);
}

.label {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  flex: none;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(94, 234, 212, 0.14);
  color: #5eead4;
  font-size: 9.5px;
}

.meta {
  flex: none;
  margin-left: auto;
  padding-left: 6px;
  font-size: 9.5px;
  color: var(--text-faint);
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
