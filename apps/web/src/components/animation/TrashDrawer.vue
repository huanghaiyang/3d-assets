<script setup lang="ts">
import Icon from '../ui/Icon.vue';
import { useAnimationStore, type NewAnimationProject } from '@/stores/animation';
import { confirmAction } from '@/composables/useConfirm';

/** 动画工作区左侧回收站抽屉：展示封面对应的完整项目信息 */
const store = useAnimationStore();

function formatTime(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function clipText(project: NewAnimationProject): string {
  return project.imported ? `${project.imported.clipCount} 段 · ${project.imported.trackCount} 轨` : '无动画数据';
}

/** 彻底删除回收站里的项目（不可恢复） */
async function purgeProject(project: NewAnimationProject): Promise<void> {
  const ok = await confirmAction({
    title: '彻底删除',
    message: `确定彻底删除「${project.name}」？`,
    detail: '该项目的数据文件会从回收站中永久移除，无法再恢复。',
    confirmText: '彻底删除',
  });
  if (!ok) return;
  void store.purgeFromTrash(project.id);
}
</script>

<template>
  <Transition name="trash-drawer">
    <aside v-if="store.trashOpen" class="trash-drawer">
      <header class="drawer-head">
        <span class="title">
          <Icon name="trash" :size="13" />
          回收站
          <span class="chip">{{ store.trashProjects.length }}</span>
        </span>
        <button class="btn btn-icon" type="button" title="关闭回收站" @click="store.toggleTrash()">
          <Icon name="close" :size="13" />
        </button>
      </header>

      <div class="drawer-body">
        <p v-if="store.trashLoading" class="state">读取回收站…</p>
        <p v-else-if="store.trashProjects.length === 0" class="state">回收站是空的</p>

        <div v-else class="trash-list">
          <article
            v-for="item in store.trashProjects"
            :key="item.id"
            class="trash-card"
            :class="{ previewing: store.trashPreviewId === item.id }"
          >
            <div class="card-top">
              <img
                class="cover"
                :src="store.projectCoverUrl(item)"
                :alt="item.name"
                loading="lazy"
              />
              <div class="meta">
                <span class="name" :title="item.name">{{ item.name }}</span>
                <span class="sub" :title="item.baseName">基础模型：{{ item.baseName }}</span>
                <span class="sub">
                  导入：{{ item.imported ? item.imported.name : '无动画数据' }}
                </span>
                <span class="sub mono">{{ clipText(item) }}</span>
                <span v-if="store.trashPreviewId === item.id" class="preview-badge">预览中</span>
              </div>
            </div>

            <dl class="time-grid">
              <div>
                <dt>创建</dt>
                <dd class="mono">{{ formatTime(item.createdAt) }}</dd>
              </div>
              <div>
                <dt>更新</dt>
                <dd class="mono">{{ formatTime(item.updatedAt) }}</dd>
              </div>
              <div>
                <dt>删除</dt>
                <dd class="mono">{{ formatTime(item.deletedAt) }}</dd>
              </div>
              <div>
                <dt>数据</dt>
                <dd class="mono">{{ item.hasData ? '已保存' : '缺失' }}</dd>
              </div>
            </dl>

            <div class="card-actions">
              <button
                class="btn btn-sm"
                type="button"
                :disabled="!item.hasData"
                title="在 3D 视口中只读预览（不恢复、不可编辑）"
                @click="store.previewTrashProject(item.id)"
              >
                <Icon name="play" :size="12" />预览
              </button>
              <button class="btn btn-sm" type="button" title="恢复到新建动画" @click="store.restoreFromTrash(item.id)">
                <Icon name="restore" :size="12" />恢复
              </button>
              <button class="btn btn-sm danger" type="button" title="彻底删除（不可恢复）" @click="purgeProject(item)">
                <Icon name="trash" :size="12" />彻底删除
              </button>
            </div>
          </article>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.trash-drawer {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: min(380px, 82vw);
  border-right: 1px solid var(--border-strong);
  background: var(--bg-panel);
  box-shadow: 12px 0 32px rgba(0, 0, 0, 0.36);
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}

.state {
  margin: 24px 4px;
  font-size: 12px;
  color: var(--text-faint);
  text-align: center;
}

.trash-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trash-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel-2);
}

.trash-card.previewing {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.card-top {
  display: flex;
  gap: 9px;
  min-width: 0;
}

.cover {
  width: 96px;
  height: 96px;
  flex: none;
  border-radius: var(--radius-sm);
  object-fit: cover;
  background: #171922;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-badge {
  align-self: flex-start;
  margin-top: 2px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
}

.time-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 8px;
  margin: 0;
  font-size: 10.5px;
}

.time-grid div {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.time-grid dt {
  color: var(--text-faint);
  flex: none;
}

.time-grid dd {
  margin: 0;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  gap: 6px;
}

.btn-sm {
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
}

.btn-sm.danger:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.trash-drawer-enter-active,
.trash-drawer-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}

.trash-drawer-enter-from,
.trash-drawer-leave-to {
  transform: translateX(-100%);
  opacity: 0.5;
}
</style>
