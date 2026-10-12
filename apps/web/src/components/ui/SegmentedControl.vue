<script setup lang="ts">
interface Option {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  options: Option[];
  size?: 'sm' | 'md';
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function select(option: Option): void {
  if (option.disabled || option.value === props.modelValue) return;
  emit('update:modelValue', option.value);
}
</script>

<template>
  <div class="segmented" :class="`segmented-${size ?? 'md'}`">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="segment"
      :class="{ active: option.value === modelValue, disabled: option.disabled }"
      :disabled="option.disabled"
      :title="option.hint ?? option.label"
      @click="select(option)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  width: 100%;
}

.segment {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 4px;
  padding: 0 6px;
  height: 26px;
  font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.segmented-sm .segment {
  height: 22px;
  font-size: 11px;
}

.segment:hover:not(.disabled):not(.active) {
  background: var(--bg-hover);
  color: var(--text);
}

.segment.active {
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.segment.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
