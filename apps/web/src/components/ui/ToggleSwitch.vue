<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean;
  label?: string;
  hint?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

function toggle(): void {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <label class="switch-row" :class="{ disabled }">
    <span class="switch-text">
      <span class="switch-label">{{ label }}</span>
      <span v-if="hint" class="switch-hint">{{ hint }}</span>
    </span>
    <button
      type="button"
      class="switch"
      :class="{ on: modelValue }"
      role="switch"
      :aria-checked="modelValue"
      :disabled="disabled"
      @click.prevent="toggle"
    >
      <span class="knob" />
    </button>
  </label>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  padding: 6px 0;
}

.switch-row.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.switch-label {
  font-size: 12px;
  color: var(--text);
}

.switch-hint {
  font-size: 11px;
  color: var(--text-faint);
}

.switch {
  flex: none;
  width: 36px;
  height: 20px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg-app);
  transition: background 0.18s ease, border-color 0.18s ease;
}

.switch.on {
  background: var(--accent);
  border-color: transparent;
}

.knob {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #d6d7dd;
  transition: transform 0.18s ease;
}

.switch.on .knob {
  transform: translateX(16px);
  background: #fff;
}
</style>
