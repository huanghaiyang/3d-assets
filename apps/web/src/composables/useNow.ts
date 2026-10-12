import { onBeforeUnmount, onMounted, ref } from 'vue';

/** 每秒刷新的当前时间，用于驱动耗时显示 */
export function useNow(intervalMs = 1000) {
  const now = ref(Date.now());
  let timer: number | null = null;

  onMounted(() => {
    timer = window.setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  });

  onBeforeUnmount(() => {
    if (timer !== null) window.clearInterval(timer);
  });

  return now;
}
