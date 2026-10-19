<script setup lang="ts">
import { ref } from 'vue';
import Icon from './ui/Icon.vue';
import AssetLibrary from './AssetLibrary.vue';
import NodeTree from './animation/NodeTree.vue';
import { useWorkspaceStore } from '@/stores/workspace';

/**
 * 工作台右侧栏：素材库 / 节点 两个页签。
 * 节点面板与动画页共用同一个 NodeTree 组件，只是数据来自工作台 store。
 */
const store = useWorkspaceStore();
const tab = ref<'library' | 'nodes'>('library');
</script>

<template>
  <aside class="side">
    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'library' }" type="button" @click="tab = 'library'">
        <Icon name="layers" :size="13" />
        素材库
        <span class="chip">{{ store.jobs.length }}</span>
      </button>
      <button class="tab" :class="{ active: tab === 'nodes' }" type="button" @click="tab = 'nodes'">
        <Icon name="cube" :size="13" />
        节点
      </button>
    </div>

    <AssetLibrary v-show="tab === 'library'" class="side-body" />

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
  </aside>
</template>

<style scoped>
.side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}

.tabs {
  display: flex;
  gap: 3px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
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

/* 素材库作为子组件填满剩余高度（子组件根元素会继承本组件的 scoped 属性） */
.side-body {
  flex: 1;
  min-height: 0;
  border-left: none;
}
</style>
