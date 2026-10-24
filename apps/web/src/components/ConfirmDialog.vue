<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './ui/Icon.vue';
import { confirmState, settleConfirm } from '@/composables/useConfirm';

const confirmRef = ref<HTMLButtonElement | null>(null);
const cancelRef = ref<HTMLButtonElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    settleConfirm(false);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    settleConfirm(true);
  }
}

watch(
  () => confirmState.open,
  (open) => {
    if (!open) {
      window.removeEventListener('keydown', onKeydown);
      return;
    }
    window.addEventListener('keydown', onKeydown);
    // 危险操作默认聚焦「取消」，避免回车误确认
    void nextTick(() => {
      (confirmState.danger ? cancelRef.value : confirmRef.value)?.focus();
    });
  },
);

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Transition name="fade">
    <div v-if="confirmState.open" class="confirm-backdrop" @click.self="settleConfirm(false)">
      <div class="confirm-dialog" role="alertdialog" aria-modal="true" :aria-label="confirmState.title">
        <div class="confirm-body">
          <span class="confirm-icon" :class="{ danger: confirmState.danger }">
            <Icon name="alert" :size="18" />
          </span>
          <div class="confirm-text">
            <p class="confirm-title">{{ confirmState.title }}</p>
            <p class="confirm-message">{{ confirmState.message }}</p>
            <p v-if="confirmState.detail" class="confirm-detail">{{ confirmState.detail }}</p>
          </div>
        </div>

        <div class="confirm-actions">
          <button ref="cancelRef" class="btn" type="button" @click="settleConfirm(false)">
            {{ confirmState.cancelText }}
          </button>
          <button
            ref="confirmRef"
            class="btn"
            :class="confirmState.danger ? 'confirm-danger' : 'btn-primary'"
            type="button"
            @click="settleConfirm(true)"
          >
            {{ confirmState.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 9, 12, 0.62);
  backdrop-filter: blur(3px);
}

.confirm-dialog {
  width: min(420px, 100%);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 18px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  box-shadow: var(--shadow);
}

.confirm-body {
  display: flex;
  gap: 12px;
}

.confirm-icon {
  flex: none;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.confirm-icon.danger {
  background: var(--danger-soft);
  color: var(--danger);
}

.confirm-text {
  min-width: 0;
}

.confirm-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}

.confirm-message {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
}

.confirm-detail {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-faint);
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.confirm-danger {
  background: #b91c1c;
  border-color: transparent;
  color: #fff;
}

.confirm-danger:hover:not(:disabled) {
  background: #dc2626;
  border-color: transparent;
}
</style>
