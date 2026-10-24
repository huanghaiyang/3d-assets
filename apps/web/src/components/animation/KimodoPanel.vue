<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../ui/Icon.vue';
import { kimodoApi, type KimodoAnimation, type KimodoStatus } from '@/api/kimodo';
import { useAnimationStore } from '@/stores/animation';

const store = useAnimationStore();
const status = ref<KimodoStatus | null>(null);
const busy = ref(false);
/** 抽屉是否展开 */
const open = ref(false);
/** 首次展开后常驻，避免关闭再打开时 iframe 重新加载丢失内嵌页状态 */
const mounted = ref(false);
const prompt = ref('a person walks forward and waves one hand');
const frames = ref(150);
const steps = ref(50);
const generating = ref(false);
const animations = ref<KimodoAnimation[]>([]);
const importingId = ref<string | null>(null);

const frameUrl = computed(() => `${kimodoApi.frameUrl()}?t=${Date.now()}`);

function toggleDrawer(): void {
  open.value = !open.value;
  if (open.value) mounted.value = true;
}

async function refreshStatus() {
  try {
    status.value = await kimodoApi.status();
  } catch {
    /* ignore */
  }
}

async function toggle() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (status.value?.running) {
      status.value = await kimodoApi.stop();
    } else {
      status.value = await kimodoApi.start();
      mounted.value = true;
      open.value = true;
    }
  } finally {
    busy.value = false;
  }
}

async function generate() {
  if (!status.value?.running || !prompt.value.trim()) return;
  generating.value = true;
  try {
    await kimodoApi.generate({
      prompt: prompt.value.trim(),
      frames: frames.value,
      steps: steps.value,
      model: 'soma-rp-v1.1',
      text_quantization: 'q4_k_m',
    });
    await pollAnimations();
  } catch (err) {
    console.error(err);
  } finally {
    generating.value = false;
  }
}

async function pollAnimations() {
  if (!status.value?.running) return;
  try {
    animations.value = await kimodoApi.animations();
  } catch {
    /* ignore */
  }
}

const readyAnimations = computed(() => animations.value.filter((a) => a.status === 'ready'));

async function importAnimation(id: string) {
  importingId.value = id;
  try {
    const result = await kimodoApi.importAnimation(id);
    if (!result.ok) throw new Error('转换失败');
    const anim = animations.value.find((a) => a.id === id);
    await store.applyImportedData(result.data, anim?.prompt || `kimodo ${id.slice(0, 8)}`);
  } catch (err) {
    console.error(err);
    alert(`导入失败：${(err as Error).message}`);
  } finally {
    importingId.value = null;
  }
}

/** 接收 iframe 内桥脚本发来的消息 */
function onMessage(event: MessageEvent) {
  const data = event.data;
  if (!data || data.source !== 'kimodo-bridge') return;
  if (data.type === 'animations' && Array.isArray(data.payload)) {
    animations.value = data.payload;
  } else if (data.type === 'animation-ready') {
    const a = data.payload as KimodoAnimation;
    if (a && a.id) {
      pollAnimations();
    }
  }
}

/** 把提示词同步给内嵌页 */
function sendPromptToFrame() {
  document
    .querySelector<HTMLIFrameElement>('#kimodo-frame')
    ?.contentWindow?.postMessage(
      { source: 'kimodo-parent', type: 'sync-prompt', payload: { prompt: prompt.value } },
      '*',
    );
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) open.value = false;
}

let pollTimer: number | undefined;
watch(
  () => status.value?.running,
  (running) => {
    if (running) {
      pollAnimations();
      pollTimer = window.setInterval(pollAnimations, 3000);
    } else {
      animations.value = [];
      if (pollTimer) window.clearInterval(pollTimer);
    }
  },
);

onMounted(() => {
  window.addEventListener('message', onMessage);
  window.addEventListener('keydown', onKeydown);
  refreshStatus();
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  window.removeEventListener('keydown', onKeydown);
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <div class="kimodo">
    <div class="kimodo-bar">
      <button class="btn" type="button" :class="{ on: open }" @click="toggleDrawer">
        <Icon name="sparkle" :size="13" />
        Kimodo 文生动画
      </button>
      <span class="status-dot" :class="status?.running ? 'on' : 'off'"></span>
      <span class="status-text">{{ status?.running ? '运行中' : '未启动' }}</span>
      <button class="btn btn-primary" type="button" :disabled="busy" @click="toggle">
        <Icon :name="status?.running ? 'ban' : 'play'" :size="12" />
        {{ status?.running ? '停止' : '启动' }}
      </button>
    </div>

    <Transition name="drawer">
      <div v-show="open && mounted" class="drawer-mask" @click.self="open = false">
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="Kimodo 文生动画">
          <header class="drawer-head">
            <div class="drawer-title">
              <Icon name="sparkle" :size="15" />
              Kimodo 文生动画
              <span class="chip" :class="status?.running ? 'chip-accent' : ''">
                {{ status?.running ? '运行中' : '未启动' }}
              </span>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" title="关闭" @click="open = false">
              <Icon name="close" :size="15" />
            </button>
          </header>

          <div class="drawer-body">
            <div v-if="!status?.running" class="empty">
              <p>Kimodo 服务未启动。</p>
              <p>点击上方「启动」后会在本地拉起 kimodo-demo（CPU 模式），首次生成需要加载模型，耗时较长。</p>
            </div>

            <template v-else>
              <section class="controls">
                <div class="field">
                  <label>提示词</label>
                  <textarea
                    v-model="prompt"
                    rows="2"
                    placeholder="Describe a motion, e.g. a person raises both hands above their head"
                  ></textarea>
                </div>
                <div class="nums">
                  <div class="field">
                    <label>帧数</label>
                    <input v-model.number="frames" type="number" min="60" max="150" />
                  </div>
                  <div class="field">
                    <label>步数</label>
                    <input v-model.number="steps" type="number" min="1" max="1000" />
                  </div>
                  <button class="btn btn-primary" type="button" :disabled="generating" @click="generate">
                    <Icon :name="generating ? 'refresh' : 'sparkle'" :size="13" :class="{ spin: generating }" />
                    {{ generating ? '生成中…' : '生成动画' }}
                  </button>
                  <button class="btn" type="button" @click="sendPromptToFrame" title="把提示词同步到内嵌页">
                    <Icon name="refresh" :size="13" /> 同步到内嵌页
                  </button>
                </div>
              </section>

              <section v-if="readyAnimations.length" class="imports">
                <span class="label">可导入的动画（{{ readyAnimations.length }}）</span>
                <div class="import-list">
                  <div v-for="a in readyAnimations" :key="a.id" class="import-item">
                    <span class="iprompt" :title="a.prompt">{{ a.prompt }}</span>
                    <span class="imeta">{{ a.frames }} 帧 · {{ a.diffusion_steps }} 步</span>
                    <button
                      class="btn btn-primary"
                      type="button"
                      :disabled="importingId === a.id || !store.newAnimationMode"
                      @click="importAnimation(a.id)"
                    >
                      <Icon
                        :name="importingId === a.id ? 'refresh' : 'download'"
                        :size="12"
                        :class="{ spin: importingId === a.id }"
                      />
                      {{ store.newAnimationMode ? '导入到当前动画' : '先新建动画' }}
                    </button>
                  </div>
                </div>
              </section>

              <div class="frame-wrap">
                <iframe
                  id="kimodo-frame"
                  :src="frameUrl"
                  class="kimodo-frame"
                  title="Kimodo text-to-motion"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                ></iframe>
              </div>
            </template>
          </div>
        </aside>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.kimodo {
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.kimodo-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #64748b;
}
.status-dot.on {
  background: #34d399;
  box-shadow: 0 0 8px #34d399aa;
}
.status-text {
  font-size: 12px;
  color: var(--text-dim);
}
.btn.on {
  background: var(--primary);
  color: var(--primary-fg);
}

/* 右侧抽屉 */
.drawer-mask {
  position: fixed;
  inset: 0;
  /* 高于 toast（70），避免提示条压在抽屉上 */
  z-index: 80;
  background: rgba(8, 9, 12, 0.5);
  backdrop-filter: blur(2px);
}
.drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(1080px, 94vw);
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border-strong);
  background: var(--bg-panel);
  box-shadow: var(--shadow);
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.empty {
  padding: 24px 16px;
  color: var(--text-dim);
  font-size: 13px;
  text-align: center;
}
.empty p {
  margin: 4px 0;
}
.controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  font-size: 11px;
  color: var(--text-dim);
}
.field textarea,
.field input {
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text);
  padding: 6px 8px;
  font-size: 13px;
}
.nums {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.nums .field {
  width: 90px;
}
.imports {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.label {
  font-size: 11px;
  color: var(--text-dim);
}
.import-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.import-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.iprompt {
  flex: 1;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.imeta {
  font-size: 11px;
  color: var(--text-dim);
}
.frame-wrap {
  flex: 1;
  min-height: 460px;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: #0c1019;
}
.kimodo-frame {
  flex: 1;
  width: 100%;
  border: 0;
  display: block;
}
.spin {
  animation: kimodo-spin 1s linear infinite;
}
@keyframes kimodo-spin {
  to {
    transform: rotate(360deg);
  }
}

.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.22s ease;
}
.drawer-enter-active .drawer,
.drawer-leave-active .drawer {
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer,
.drawer-leave-to .drawer {
  transform: translateX(100%);
}
</style>
