<script setup lang="ts">
import Icon from './ui/Icon.vue';
import { useWorkspaceStore } from '@/stores/workspace';

const store = useWorkspaceStore();
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="toast">
      <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="`toast-${toast.kind}`">
        <Icon :name="toast.kind === 'error' ? 'alert' : toast.kind === 'success' ? 'check' : 'info'" :size="14" />
        <span class="text">{{ toast.text }}</span>
        <button class="close" type="button" @click="store.dismissToast(toast.id)">
          <Icon name="close" :size="12" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 18px;
  bottom: 72px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 360px;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
  font-size: 12px;
  line-height: 1.5;
}

.toast-success {
  border-color: rgba(52, 211, 153, 0.4);
  color: #a7f3d0;
}

.toast-error {
  border-color: rgba(248, 113, 113, 0.45);
  color: #fecaca;
}

.text {
  flex: 1;
  word-break: break-word;
}

.close {
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  padding: 0;
}

.close:hover {
  opacity: 1;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>
