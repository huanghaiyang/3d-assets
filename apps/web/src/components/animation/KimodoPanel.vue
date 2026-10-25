<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import VueJsonPretty from 'vue-json-pretty';
import 'vue-json-pretty/lib/styles.css';
import Icon from '../ui/Icon.vue';
import KimodoPreview from './KimodoPreview.vue';
import {
  kimodoApi,
  type EnhancePromptResult,
  type KimodoAnimation,
  type KimodoArtifactContent,
  type KimodoArtifactsResponse,
  type KimodoPromptSegment,
  type KimodoRelation,
  type KimodoStatus,
  type SomaSkeleton,
} from '@/api/kimodo';
import { useAnimationStore } from '@/stores/animation';

const store = useAnimationStore();

const open = ref(false);
const mounted = ref(false);
const status = ref<KimodoStatus | null>(null);
const skeleton = ref<SomaSkeleton | null>(null);
const animations = ref<KimodoAnimation[]>([]);
const selectedId = ref<string | null>(null);
const submitting = ref(false);
const importingId = ref<string | null>(null);
const notice = ref<{ kind: 'error' | 'info'; text: string } | null>(null);

// 生成参数表单：帧数默认 60（约 2 秒 @30fps），种子 0 表示交给服务端随机掷
const prompt = ref('a person walks forward and waves one hand');
const frames = ref(60);
const steps = ref(20);
const seed = ref(0);

// ===== 提示词转译（参考图片 → DeepSeek → 英文提示词）=====
const imageDataUrl = ref<string | null>(null);
const imageName = ref('');
const enhancing = ref(false);
/** 最近一次转译的结构化结果：动作拆解 + 分段建议 */
const enhanced = ref<EnhancePromptResult | null>(null);
/** 分段生成开关（只有转译给出 2 段以上、且提示词未被改写时才生效） */
const splitEnabled = ref(false);
/** 一次提交几个不同种子的候选 */
const candidates = ref(1);
const enhanceAvailable = computed(() => status.value?.promptModelReady === true);
const canEnhance = computed(
  () => enhanceAvailable.value && (prompt.value.trim().length > 0 || imageDataUrl.value !== null),
);

/** 提示词还是转译给出的英文原文时，才能用它的分段 */
const splitUsable = computed(() => {
  const result = enhanced.value;
  return Boolean(
    result &&
      result.segments.length >= 2 &&
      prompt.value.trim() === result.prompt,
  );
});
const splitActive = computed(() => splitEnabled.value && splitUsable.value);
// 用户手动改了英文提示词后，原分段不再对应当前文本，自动关闭分段以避免错位
watch(splitUsable, (usable) => {
  if (!usable) splitEnabled.value = false;
});
const decomposition = computed(() => enhanced.value?.decomposition ?? null);
const objectText = computed(() => decomposition.value?.objects.join('、') ?? '');

// ===== 动作拆解可编辑：改完步骤后按步骤重新生成英文，避免模型又按自己的理解改回去 =====
/** 拆解步骤的编辑副本（最多 6 步） */
const stepDraft = ref<string[]>([]);
const refining = ref(false);
watch(
  () => enhanced.value?.decomposition?.steps,
  (steps) => {
    stepDraft.value = [...(steps ?? [])];
  },
  { immediate: true },
);
const stepsDirty = computed(() => {
  const original = enhanced.value?.decomposition?.steps ?? [];
  if (original.length !== stepDraft.value.length) return true;
  return original.some((step, index) => step !== (stepDraft.value[index] ?? '').trim());
});

function addStep(): void {
  if (stepDraft.value.length >= 6) return;
  stepDraft.value.push('');
}

function removeStep(index: number): void {
  if (stepDraft.value.length <= 1) return;
  stepDraft.value.splice(index, 1);
}

function resetSteps(): void {
  stepDraft.value = [...(enhanced.value?.decomposition?.steps ?? [])];
}

/** 把修改后的中文步骤交给模型重新生成英文提示词与分段 */
async function refine(): Promise<void> {
  const current = enhanced.value;
  if (!current || refining.value || submitting.value) return;
  const steps = stepDraft.value.map((step) => step.trim()).filter(Boolean);
  if (steps.length === 0) {
    notice.value = { kind: 'error', text: '拆解至少保留一个步骤' };
    return;
  }

  refining.value = true;
  notice.value = null;
  try {
    const result = await kimodoApi.refinePrompt({
      steps,
      objects: current.decomposition?.objects,
      note: current.decomposition?.note,
    });
    enhanced.value = {
      ...current,
      prompt: result.prompt,
      segments: result.segments,
      decomposition: current.decomposition ? { ...current.decomposition, steps } : null,
    };
    prompt.value = result.prompt;
    splitEnabled.value = result.segments.length >= 2;
    notice.value = {
      kind: 'info',
      text: `已按修改后的 ${steps.length} 步动作重新生成英文提示词${
        result.segments.length >= 2 ? `，并拆出 ${result.segments.length} 段` : ''
      }。`,
    };
  } catch (err) {
    notice.value = { kind: 'error', text: (err as Error).message };
  } finally {
    refining.value = false;
  }
}

const configured = computed(() => status.value?.ready === true);
const pendingCount = computed(
  () => animations.value.filter((item) => item.status === 'queued' || item.status === 'running').length,
);

/** 每 500ms 走一次，让进度条和耗时数字平滑变化 */
const now = ref(Date.now());

const runningJob = computed(() => animations.value.find((item) => item.status === 'running') ?? null);
const queuedJobs = computed(() =>
  animations.value.filter((item) => item.status === 'queued').sort((a, b) => a.createdAt - b.createdAt),
);
const activeJob = computed<KimodoAnimation | null>(() => runningJob.value ?? queuedJobs.value[0] ?? null);
/** 右侧预览当前选中的任务：用于在排队/生成中显示 loading，而不是去请求还存在的动作文件 */
const selectedJob = computed(
  () => animations.value.find((item) => item.id === selectedId.value) ?? null,
);
const lastReady = computed(() => animations.value.find((item) => item.status === 'ready') ?? null);
const lastReadyDuration = computed(() => lastReady.value?.durationMs ?? 0);
/** 某个排队任务在队列里的位置（1 起）；非排队任务返回 0 */
function queueIndexOf(item: KimodoAnimation): number {
  if (item.status !== 'queued') return 0;
  return queuedJobs.value.findIndex((entry) => entry.id === item.id) + 1;
}
const queuePosition = computed(() => (activeJob.value ? queueIndexOf(activeJob.value) : 0));

/**
 * 估算进度（0–1）。kmd-generate 不回报中间进度，只能按「已用时间 / 预计耗时」推算，
 * 完成后由任务状态直接跳到 100%。
 */
function progressOf(item: KimodoAnimation): number {
  if (item.status === 'ready') return 1;
  if (item.status !== 'running' || !item.startedAt || !item.etaMs) return 0;
  return Math.min(0.99, Math.max(0.01, (now.value - item.startedAt) / item.etaMs));
}
function percentOf(item: KimodoAnimation): number {
  return Math.round(progressOf(item) * 100);
}
function stageOf(item: KimodoAnimation): string {
  if (item.status === 'queued') {
    const position = queueIndexOf(item);
    return position > 1 ? `排队中，前面还有 ${position - 1} 个任务` : '排队中，即将开始';
  }
  if (item.status === 'running') {
    const elapsed = item.startedAt ? now.value - item.startedAt : 0;
    if (item.loadMs && elapsed < item.loadMs) return '正在加载模型权重（冷启动）';
    return '扩散采样与动作解码';
  }
  if (item.status === 'failed') return '生成失败';
  return '生成完成';
}
const activeElapsed = computed(() =>
  activeJob.value?.startedAt ? Math.max(0, now.value - activeJob.value.startedAt) : 0,
);
const activeEta = computed(() => activeJob.value?.etaMs ?? 0);
const activeRemaining = computed(() => Math.max(0, activeEta.value - activeElapsed.value));

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}分${seconds.toString().padStart(2, '0')}秒` : `${seconds}秒`;
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 骰子：随机掷一个非零种子（0 留给「每次随机」） */
function rollSeed(): void {
  seed.value = Math.floor(Math.random() * 1_000_000_000) + 1;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('参考图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 选择参考图片：先在前端做类型/体积校验，再转成 data URL。
 * 清空 input.value 是为了让用户能连续选择同一个文件（否则 change 不会再触发）。
 */
async function pickImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    notice.value = { kind: 'error', text: '参考图片仅支持 PNG / JPEG / WebP / GIF' };
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    notice.value = { kind: 'error', text: '参考图片不能超过 8MB' };
    return;
  }
  try {
    imageDataUrl.value = await readAsDataUrl(file);
    imageName.value = file.name;
  } catch (err) {
    notice.value = { kind: 'error', text: (err as Error).message };
  }
}

function clearImage(): void {
  imageDataUrl.value = null;
  imageName.value = '';
}

/** 中文提示词直接交给英文文本编码器会严重失真，生成前先自动转译 */
const CJK_RE = /[\u3400-\u9fff]/;

/**
 * 调一次转译并回填表单。返回结果供 generate 复用；失败时返回 null（notice 已给出原因）。
 */
async function requestEnhance(source: string): Promise<EnhancePromptResult | null> {
  enhancing.value = true;
  notice.value = null;
  try {
    const result = await kimodoApi.enhancePrompt({
      prompt: source,
      image: imageDataUrl.value ?? undefined,
    });
    prompt.value = result.prompt;
    enhanced.value = result;
    splitEnabled.value = result.segments.length >= 2;
    const splitHint = result.segments.length >= 2 ? `，并拆出 ${result.segments.length} 段可分段生成` : '';
    notice.value = {
      kind: 'info',
      text: `已由 ${result.model} 转译为英文提示词${result.usedImage ? '（参考图已解析）' : ''}${splitHint}，可直接生成或继续微调。`,
    };
    return result;
  } catch (err) {
    notice.value = { kind: 'error', text: (err as Error).message };
    return null;
  } finally {
    enhancing.value = false;
  }
}

/** 把中文描述 / 参考图片交给大模型，回填英文提示词 */
async function enhance(): Promise<void> {
  if (!canEnhance.value || enhancing.value) return;
  await requestEnhance(prompt.value.trim());
}

// ===== 中间产物与关联关系 =====
const artifactOpen = ref(false);
const artifactTaskId = ref<string | null>(null);
const artifactData = ref<KimodoArtifactsResponse | null>(null);
const artifactLoading = ref(false);
const artifactError = ref<string | null>(null);
const artifactKey = ref<string | null>(null);
const artifactContent = ref<KimodoArtifactContent | null>(null);
const artifactContentLoading = ref(false);
const artifactContentError = ref<string | null>(null);

/** vue-json-pretty 需要可索引对象 */
const artifactJson = computed<Record<string, unknown> | unknown[] | null>(() => {
  const content = artifactContent.value;
  if (!content || content.format !== 'json') return null;
  try {
    const parsed = JSON.parse(content.text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
});

/**
 * 打开某条任务的产物弹窗：先取清单与关联关系，再默认选中第一个「存在且可读」的产物，
 * 避免用户打开后看到一个空白内容区。
 */
async function openArtifacts(item: KimodoAnimation): Promise<void> {
  artifactOpen.value = true;
  artifactTaskId.value = item.id;
  artifactData.value = null;
  artifactError.value = null;
  artifactKey.value = null;
  artifactContent.value = null;
  artifactContentError.value = null;
  artifactLoading.value = true;
  try {
    const data = await kimodoApi.artifacts(item.id);
    artifactData.value = data;
    const first = data.artifacts.find((entry) => entry.exists && entry.viewable);
    if (first) await pickArtifact(first.key);
  } catch (err) {
    artifactError.value = (err as Error).message;
  } finally {
    artifactLoading.value = false;
  }
}

/** 切换产物：按 key 重新拉文本内容（JSON 已由后端格式化） */
async function pickArtifact(key: string): Promise<void> {
  const id = artifactTaskId.value;
  if (!id) return;
  artifactKey.value = key;
  artifactContent.value = null;
  artifactContentError.value = null;
  artifactContentLoading.value = true;
  try {
    artifactContent.value = await kimodoApi.artifact(id, key);
  } catch (err) {
    artifactContentError.value = (err as Error).message;
  } finally {
    artifactContentLoading.value = false;
  }
}

function closeArtifacts(): void {
  artifactOpen.value = false;
}

/** 跳到关联的新建动画（关闭抽屉，直接进入编辑） */
function gotoRelation(relation: KimodoRelation): void {
  closeArtifacts();
  open.value = false;
  store.selectNewAnimation(relation.id);
}


function openDrawer(): void {
  open.value = true;
  mounted.value = true;
  void refresh();
}

async function refresh(): Promise<void> {
  try {
    status.value = await kimodoApi.status();
  } catch {
    /* 服务不可达时保持上一次状态 */
  }
  if (!status.value?.ready) return;
  try {
    animations.value = await kimodoApi.animations();
    if (!selectedId.value) {
      // 优先展示已生成的结果；没有结果时自动选中正在生成/排队的任务，预览区显示 loading
      const preferred =
        animations.value.find((item) => item.status === 'ready') ??
        animations.value.find((item) => item.status === 'running') ??
        animations.value.find((item) => item.status === 'queued');
      if (preferred) selectedId.value = preferred.id;
    }
  } catch {
    /* ignore */
  }
}

async function ensureSkeleton(): Promise<void> {
  if (skeleton.value) return;
  try {
    skeleton.value = await kimodoApi.skeleton();
  } catch (err) {
    notice.value = { kind: 'error', text: `骨架定义读取失败：${(err as Error).message}` };
  }
}

/**
 * 把总帧数均分给各段提示词，每段至少 8 帧；总帧数不够分时返回 null（退回单段）。
 */
function buildSegments(total: number, list: string[]): KimodoPromptSegment[] | null {
  const count = list.length;
  if (count < 2 || total < count * 8) return null;
  const share = Math.max(8, Math.floor(total / count));
  return list.map((prompt, index) => ({
    prompt,
    frames: index === count - 1 ? Math.max(8, total - share * (count - 1)) : share,
  }));
}

async function generate(): Promise<void> {
  if (refining.value) return;
  let text = prompt.value.trim();
  if (!text) {
    notice.value = { kind: 'error', text: '请先填写提示词' };
    return;
  }
  submitting.value = true;
  notice.value = null;
  try {
    // 中文提示词先自动转译：英文文本编码器直接读中文会把动作识别成别的语义
    if (CJK_RE.test(text) && enhanceAvailable.value) {
      const result = await requestEnhance(text);
      if (!result) return; // 转译失败，notice 里已给出原因
      text = result.prompt;
    }

    const segments =
      splitActive.value && enhanced.value ? buildSegments(frames.value, enhanced.value.segments) : null;
    const count = Math.max(1, Math.min(3, candidates.value));
    const submitted: KimodoAnimation[] = [];
    for (let index = 0; index < count; index += 1) {
      submitted.push(
        await kimodoApi.generate({
          prompt: text,
          frames: frames.value,
          steps: steps.value,
          // 多候选时用连续种子，避免服务端随机导致结果不可复现
          seed: seed.value > 0 ? seed.value + index : undefined,
          segments: segments ?? undefined,
        }),
      );
    }

    // 先刷新列表再选中：让预览区拿到的任务状态是 queued，
    // 从而直接显示 loading，而不是先请求一次还不存在的动作文件
    await refresh();
    selectedId.value = submitted[0]?.id ?? null;
    const first = submitted[0];
    const parts = [`${first?.frames ?? frames.value} 帧 / ${steps.value} 步`];
    if (segments) parts.push(`${segments.length} 段`);
    if (count > 1) parts.push(`${count} 个候选（种子连续）`);
    notice.value = {
      kind: 'info',
      text: `已提交：${parts.join('，')}，seed=${first?.seed ?? '随机'}。本地 CPU 推理，请保持页面打开。`,
    };
  } catch (err) {
    notice.value = { kind: 'error', text: (err as Error).message };
  } finally {
    submitting.value = false;
  }
}

async function importAnimation(item: KimodoAnimation): Promise<void> {
  importingId.value = item.id;
  notice.value = null;
  try {
    const result = await kimodoApi.importAnimation(item.id, item.prompt.slice(0, 40));
    if (!result.ok) throw new Error('动画转换失败');
    await store.applyImportedData(result.data, result.clipName || item.prompt);
  } catch (err) {
    notice.value = { kind: 'error', text: `导入失败：${(err as Error).message}` };
  } finally {
    importingId.value = null;
  }
}

async function remove(item: KimodoAnimation): Promise<void> {
  try {
    await kimodoApi.remove(item.id);
    if (selectedId.value === item.id) selectedId.value = null;
    await refresh();
  } catch (err) {
    notice.value = { kind: 'error', text: `删除失败：${(err as Error).message}` };
  }
}

function statusText(item: KimodoAnimation): string {
  if (item.status === 'queued') return '排队中';
  if (item.status === 'running') {
    const elapsed = item.startedAt ? Math.max(0, now.value - item.startedAt) : 0;
    return `生成中 ${percentOf(item)}% · 已用 ${formatDuration(elapsed)}`;
  }
  if (item.status === 'failed') return '失败';
  return item.durationMs ? `已完成 · ${formatDuration(item.durationMs)}` : '已完成';
}

// ===== 生成结果注释：同一时刻只编辑一条，回车/失焦保存 =====
const noteEditingId = ref<string | null>(null);
const noteDraft = ref('');
const noteInput = ref<HTMLInputElement | null>(null);

/** 函数式 ref 在每次组件更新时都会重新调用，缓存元素保证只聚焦一次 */
function focusNoteInput(el: unknown): void {
  const input = el instanceof HTMLInputElement ? el : null;
  if (noteInput.value === input) return;
  noteInput.value = input;
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function startNote(item: KimodoAnimation): void {
  noteEditingId.value = item.id;
  noteDraft.value = item.note ?? '';
}

function cancelNote(): void {
  noteEditingId.value = null;
  noteDraft.value = '';
}

/** 只更新本地那一条任务，避免整表刷新打断其他输入 */
async function saveNote(item: KimodoAnimation): Promise<void> {
  if (noteEditingId.value !== item.id) return;
  const note = noteDraft.value.trim();
  const previous = item.note ?? '';
  noteEditingId.value = null;
  if (note === previous) return;
  try {
    const updated = await kimodoApi.updateNote(item.id, note);
    const target = animations.value.find((entry) => entry.id === item.id);
    if (target) target.note = updated.note;
  } catch (err) {
    noteEditingId.value = item.id;
    noteDraft.value = note;
    notice.value = { kind: 'error', text: `注释保存失败：${(err as Error).message}` };
  }
}

function formatTime(value: number): string {
  const date = new Date(value);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

let timer: number | undefined;
let clock: number | undefined;
watch(
  () => open.value,
  (value) => {
    if (value) void refresh();
  },
);
watch(selectedId, () => {
  void ensureSkeleton();
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (artifactOpen.value) {
    artifactOpen.value = false;
    return;
  }
  if (open.value) open.value = false;
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void refresh();
  // 进度条与「生成中 xx%」需要连续走动，关闭抽屉时也要继续更新
  clock = window.setInterval(() => {
    now.value = Date.now();
  }, 500);
  timer = window.setInterval(() => {
    // 抽屉打开、有任务在跑或后端报告忙碌时才轮询，空闲时不打扰服务
    if (open.value || pendingCount.value > 0 || status.value?.busy) void refresh();
  }, 2000);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (timer) window.clearInterval(timer);
  if (clock) window.clearInterval(clock);
});
</script>

<template>
  <div class="kimodo">
    <div class="kimodo-bar">
      <button class="btn" type="button" :class="{ on: open }" @click="openDrawer">
        <Icon name="sparkle" :size="13" />
        Kimodo 文生动画
      </button>
      <span class="status-dot" :class="status?.busy ? 'busy' : configured ? 'on' : 'off'"></span>
      <span class="status-text">
        <template v-if="!configured">未配置</template>
        <template v-else-if="runningJob || status?.busy">
          生成中{{ runningJob ? ` ${percentOf(runningJob)}%` : '' }}{{ queuedJobs.length ? ` · ${queuedJobs.length} 个排队` : '' }}
        </template>
        <template v-else-if="queuedJobs.length">排队 {{ queuedJobs.length }} 个</template>
        <template v-else-if="status?.running">就绪</template>
        <template v-else>待用</template>
      </span>
      <span v-if="animations.length" class="chip">{{ animations.length }} 条结果</span>
    </div>

    <Transition name="drawer">
      <div v-show="open && mounted" class="drawer-mask" @click.self="open = false">
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="Kimodo 文生动画">
          <header class="drawer-head">
            <div class="drawer-title">
              <Icon name="sparkle" :size="15" />
              Kimodo 文生动画
              <span class="chip chip-info">{{ status?.backend ?? 'cpu' }} 本地推理</span>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" title="关闭" @click="open = false">
              <Icon name="close" :size="15" />
            </button>
          </header>

          <div v-if="!configured" class="unconfigured">
            <p class="title">尚未配置 Kimodo</p>
            <p>请在根目录 <code>.env</code> 里补齐以下变量后重启服务：</p>
            <ul>
              <li><code>KIMODO_GENERATE_EXE</code> — kmd-generate 可执行文件</li>
              <li><code>KIMODO_MOTION_MODEL</code> — SOMA RP v1.1 动作模型 GGUF</li>
              <li><code>KIMODO_TEXT_BUNDLE</code> — LLM2Vec 文本编码器 GGUF</li>
              <li><code>KIMODO_PYTHON</code> — 带 numpy 的 Python 解释器</li>
            </ul>
            <p v-if="status?.error" class="err">{{ status.error }}</p>
          </div>

          <div v-else class="drawer-body">
            <section class="left">
              <div class="form">
                <label class="field">
                  <span class="field-head">
                    提示词
                    <span
                      v-if="enhanceAvailable"
                      class="ai-badge"
                      :title="`${status?.promptProviderLabel} · 文字 ${status?.promptModel} · 视觉 ${status?.promptVisionModel}`"
                    >
                      {{ status?.promptProviderLabel }}
                    </span>
                  </span>
                  <textarea
                    v-model="prompt"
                    rows="3"
                    placeholder="可用中文描述，点「AI 转译」交给大模型；也可直接写英文动作"
                  ></textarea>
                </label>

                <div v-if="imageDataUrl" class="image-chip">
                  <img :src="imageDataUrl" :alt="imageName" class="image-thumb" />
                  <span class="image-name" :title="imageName">{{ imageName }}</span>
                  <button class="btn btn-ghost btn-icon" type="button" title="移除参考图" @click="clearImage">
                    <Icon name="close" :size="11" />
                  </button>
                </div>

                <div class="prompt-tools">
                  <label class="btn btn-ghost upload-btn" title="上传参考图片，由大模型转译为动作提示词">
                    <Icon name="image" :size="12" />
                    参考图片
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      hidden
                      @change="pickImage"
                    />
                  </label>
                  <button
                    class="btn ai-btn"
                    type="button"
                    :disabled="!canEnhance || enhancing"
                    :title="
                      enhanceAvailable
                        ? '把描述与参考图片交给大模型，转译成英文动作提示词并做动作拆解'
                        : '服务端未配置提示词模型 API Key，无法使用 AI 转译'
                    "
                    @click="enhance"
                  >
                    <Icon
                      :name="enhancing ? 'refresh' : 'sparkle'"
                      :size="12"
                      :class="{ spin: enhancing }"
                    />
                    {{ enhancing ? '转译中…' : 'AI 转译' }}
                  </button>
                  <span class="hint">
                    {{ enhanceAvailable ? '支持图片；中文会自动转译成纯身体动作' : '未配置提示词模型 API Key' }}
                  </span>
                </div>

                <!-- 动作拆解：可逐条修改，改完按步骤重新生成英文 -->
                <div v-if="decomposition" class="decomp-card">
                  <div class="decomp-head">
                    <Icon name="sparkle" :size="12" />
                    <span>动作拆解</span>
                    <span v-if="stepsDirty" class="decomp-edited">已修改</span>
                    <span
                      v-if="objectText"
                      class="decomp-objects"
                      :title="`模型没有物体接触，只能模拟身体动作：${objectText}`"
                    >
                      物体：{{ objectText }}
                    </span>
                  </div>
                  <div class="decomp-step-list">
                    <div v-for="(step, index) in stepDraft" :key="index" class="decomp-step-row">
                      <span class="decomp-index">{{ index + 1 }}</span>
                      <input
                        v-model="stepDraft[index]"
                        class="decomp-input"
                        type="text"
                        maxlength="80"
                        placeholder="描述这一步的身体动作"
                        :aria-label="step || `步骤 ${index + 1}`"
                      />
                      <button
                        v-if="stepDraft.length > 1"
                        class="decomp-remove"
                        type="button"
                        title="删除该步骤"
                        @click="removeStep(index)"
                      >
                        <Icon name="close" :size="10" />
                      </button>
                    </div>
                    <button
                      v-if="stepDraft.length < 6"
                      class="decomp-add"
                      type="button"
                      title="在末尾增加一个动作步骤"
                      @click="addStep"
                    >
                      <Icon name="plus" :size="10" />
                      增加步骤
                    </button>
                  </div>
                  <p v-if="decomposition.note" class="decomp-note">{{ decomposition.note }}</p>
                  <div class="decomp-actions">
                    <button
                      class="btn btn-ghost decomp-refine"
                      type="button"
                      :disabled="!stepsDirty || refining || submitting"
                      :title="stepsDirty ? '按修改后的步骤重新生成英文提示词与分段' : '修改步骤后可用'"
                      @click="refine"
                    >
                      <Icon
                        :name="refining ? 'refresh' : 'sparkle'"
                        :size="11"
                        :class="{ spin: refining }"
                      />
                      {{ refining ? '重新生成中…' : '按拆解重新生成' }}
                    </button>
                    <button
                      v-if="stepsDirty"
                      class="btn btn-ghost decomp-reset"
                      type="button"
                      title="恢复为上次转译的拆解"
                      @click="resetSteps"
                    >
                      还原
                    </button>
                    <span v-else class="hint">步骤可直接修改，改完点左侧按钮生效</span>
                  </div>
                </div>

                <div class="row">
                  <label class="field small">
                    <span>帧数</span>
                    <input v-model.number="frames" type="number" min="8" max="300" />
                  </label>
                  <label class="field small">
                    <span>步数</span>
                    <input v-model.number="steps" type="number" min="1" max="200" />
                  </label>
                  <label class="field small">
                    <span>种子（0 随机）</span>
                    <div class="seed-row">
                      <input v-model.number="seed" type="number" min="0" />
                      <button
                        class="btn btn-ghost btn-icon seed-btn"
                        type="button"
                        title="掷一个随机种子"
                        @click="rollSeed"
                      >
                        <Icon name="dice" :size="14" />
                      </button>
                    </div>
                  </label>
                </div>
                <div class="row options-row">
                  <label
                    class="toggle"
                    :class="{ disabled: !splitUsable }"
                    :title="
                      splitUsable
                        ? '把动作按「接近 / 施力 / 收势」分段生成，段间自动过渡'
                        : 'AI 转译后若给出 2 段以上，且提示词未被手动修改，才能启用分段生成'
                    "
                  >
                    <input v-model="splitEnabled" type="checkbox" :disabled="!splitUsable" />
                    <span>
                      分段生成<template v-if="enhanced && enhanced.segments.length >= 2">
                        （{{ enhanced.segments.length }} 段 · 总帧数均分）</template>
                    </span>
                  </label>
                  <label class="field small candidate-field" title="一次提交多个不同种子的任务，生成后对比挑选">
                    <span>候选数</span>
                    <select v-model.number="candidates">
                      <option :value="1">1</option>
                      <option :value="2">2</option>
                      <option :value="3">3</option>
                    </select>
                  </label>
                </div>
                <div class="row">
                  <button
                    class="btn btn-primary"
                    type="button"
                    :disabled="submitting || refining"
                    @click="generate"
                  >
                    <Icon :name="submitting ? 'refresh' : 'sparkle'" :size="13" :class="{ spin: submitting }" />
                    生成动画
                  </button>
                  <span class="hint">
                    CPU 推理：60 帧 / 10 步约 1 分钟{{ splitActive ? '，分段任务会依次排队' : '' }}
                  </span>
                </div>
              </div>

              <div class="progress-card">
                <template v-if="activeJob">
                  <div class="pc-head">
                    <span class="pc-label">
                      <Icon
                        :name="activeJob.status === 'running' ? 'refresh' : 'clock'"
                        :size="12"
                        :class="{ spin: activeJob.status === 'running' }"
                      />
                      {{ activeJob.status === 'running' ? '正在生成' : '排队等待' }}
                    </span>
                    <span v-if="activeJob.status === 'running'" class="pc-value">{{ percentOf(activeJob) }}%</span>
                    <span v-else class="pc-value">第 {{ queuePosition }} 位</span>
                  </div>
                  <p class="pc-prompt" :title="activeJob.prompt">{{ activeJob.prompt }}</p>
                  <div class="pc-track" :class="{ queued: activeJob.status === 'queued' }">
                    <div
                      class="pc-fill"
                      :style="{ width: activeJob.status === 'running' ? `${percentOf(activeJob)}%` : '100%' }"
                    ></div>
                  </div>
                  <div class="pc-meta">
                    <span>{{ stageOf(activeJob) }}</span>
                    <span v-if="activeJob.status === 'running'">
                      已用 {{ formatDuration(activeElapsed) }} · 预计 {{ formatDuration(activeEta) }} · 剩余
                      {{ formatDuration(activeRemaining) }}
                    </span>
                    <span v-else>共 {{ queuedJobs.length }} 个任务排队</span>
                    <span>{{ activeJob.frames }} 帧 · {{ activeJob.steps }} 步</span>
                  </div>
                </template>
                <template v-else>
                  <div class="pc-head">
                    <span class="pc-label">
                      <Icon name="check" :size="12" />
                      就绪
                    </span>
                    <span v-if="lastReadyDuration" class="pc-value idle">
                      上次耗时 {{ formatDuration(lastReadyDuration) }}
                    </span>
                  </div>
                  <p class="pc-idle">
                    {{
                      lastReady
                        ? '没有正在进行的任务，可以继续提交生成。'
                        : '还没有生成任务，填写提示词后点击「生成动画」。'
                    }}
                  </p>
                </template>
              </div>

              <div v-if="notice" class="notice" :class="notice.kind">
                <Icon :name="notice.kind === 'error' ? 'alert' : 'info'" :size="12" />
                {{ notice.text }}
              </div>

              <div class="list-head">
                <span>生成结果</span>
                <button class="btn btn-ghost btn-icon" type="button" title="刷新" @click="refresh">
                  <Icon name="refresh" :size="12" />
                </button>
              </div>

              <div class="list">
                <p v-if="animations.length === 0" class="empty">还没有生成结果，先写提示词开始生成。</p>
                <div
                  v-for="item in animations"
                  :key="item.id"
                  class="item"
                  :class="{ active: selectedId === item.id }"
                  @click="selectedId = item.id"
                >
                  <div class="item-main">
                    <span class="iprompt" :title="item.prompt">{{ item.prompt }}</span>
                    <div class="imeta">
                      <span class="state" :class="item.status">{{ statusText(item) }}</span>
                      <span>{{ item.frames }} 帧 · {{ item.steps }} 步</span>
                      <span>seed {{ item.seed }}</span>
                      <span>{{ formatTime(item.createdAt) }}</span>
                    </div>
                    <div v-if="noteEditingId === item.id" class="inote-edit" @click.stop>
                      <input
                        :ref="focusNoteInput"
                        v-model="noteDraft"
                        class="inote-input"
                        type="text"
                        maxlength="200"
                        placeholder="写个注释，回车保存"
                        @keydown.enter.prevent="saveNote(item)"
                        @keydown.esc.stop.prevent="cancelNote"
                        @blur="saveNote(item)"
                      />
                    </div>
                    <button
                      v-else-if="item.note"
                      class="inote"
                      type="button"
                      :title="item.note"
                      @click.stop="startNote(item)"
                    >
                      <span class="inote-tag">注释</span>{{ item.note }}
                    </button>
                    <div v-if="item.status === 'running'" class="item-progress">
                      <div class="item-progress-fill" :style="{ width: `${percentOf(item)}%` }"></div>
                    </div>
                    <div v-else-if="item.status === 'queued'" class="item-progress queued">
                      <div class="item-progress-fill"></div>
                    </div>
                    <p v-if="item.error" class="ierr">{{ item.error }}</p>
                  </div>
                  <div class="item-actions">
                    <button
                      class="btn btn-primary"
                      type="button"
                      :disabled="item.status !== 'ready' || importingId === item.id || !store.newAnimationMode"
                      :title="store.newAnimationMode ? '' : '请先在动画页新建一个动画项目'"
                      @click.stop="importAnimation(item)"
                    >
                      <Icon
                        :name="importingId === item.id ? 'refresh' : 'download'"
                        :size="12"
                        :class="{ spin: importingId === item.id }"
                      />
                      导入
                    </button>
                    <button
                      class="btn btn-ghost btn-icon"
                      type="button"
                      :title="item.note ? '编辑注释' : '添加注释'"
                      @click.stop="startNote(item)"
                    >
                      <Icon name="edit" :size="12" />
                    </button>
                    <button
                      class="btn btn-ghost btn-icon"
                      type="button"
                      title="查看中间产物与关联关系"
                      @click.stop="openArtifacts(item)"
                    >
                      <Icon name="layers" :size="12" />
                    </button>
                    <button
                      class="btn btn-ghost btn-icon"
                      type="button"
                      title="删除这条结果"
                      :disabled="item.status === 'running'"
                      @click.stop="remove(item)"
                    >
                      <Icon name="trash" :size="12" />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section class="right">
              <KimodoPreview
                :animation-id="selectedId ?? ''"
                :skeleton="skeleton"
                :job-status="selectedJob?.status ?? null"
                :progress="selectedJob ? percentOf(selectedJob) : 0"
                :stage="selectedJob ? stageOf(selectedJob) : ''"
              />
            </section>
          </div>
        </aside>
      </div>
    </Transition>

    <!-- 中间产物：产物清单 + 文本/ JSON 格式化预览 + 关联的新建动画 -->
    <Transition name="drawer">
      <div v-if="artifactOpen" class="artifact-mask" @click.self="closeArtifacts">
        <div class="artifact-dialog" role="dialog" aria-modal="true" aria-label="中间产物">
          <header class="artifact-head">
            <div class="artifact-title">
              <Icon name="layers" :size="14" />
              中间产物与关联关系
              <span class="chip">{{ artifactTaskId }}</span>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" title="关闭" @click="closeArtifacts">
              <Icon name="close" :size="14" />
            </button>
          </header>

          <p class="artifact-chain">
            <span class="chain-node">提示词</span>
            <Icon name="chevronRight" :size="10" />
            <span class="chain-node">生成任务</span>
            <Icon name="chevronRight" :size="10" />
            <span class="chain-node">动作数据 .f32</span>
            <Icon name="chevronRight" :size="10" />
            <span class="chain-node">Mixamo JSON</span>
            <Icon name="chevronRight" :size="10" />
            <span class="chain-node accent">
              新建动画 {{ artifactData?.relations.length ?? 0 }}
            </span>
          </p>

          <p v-if="artifactLoading" class="artifact-state">读取产物清单…</p>
          <p v-else-if="artifactError" class="artifact-state err">{{ artifactError }}</p>
          <div v-else-if="artifactData" class="artifact-body">
            <div class="artifact-list">
              <div
                v-for="entry in artifactData.artifacts"
                :key="entry.key"
                class="artifact-item"
                :class="{
                  active: artifactKey === entry.key,
                  muted: !entry.exists,
                  binary: !entry.viewable,
                }"
                :title="entry.viewable && entry.exists ? '点击查看内容' : entry.description"
                @click="entry.viewable && entry.exists ? pickArtifact(entry.key) : undefined"
              >
                <div class="ai-head">
                  <span class="ai-label">{{ entry.label }}</span>
                  <span class="ai-size">{{ entry.exists ? formatSize(entry.size) : '未生成' }}</span>
                </div>
                <code class="ai-file">{{ entry.file }}</code>
                <p class="ai-desc">{{ entry.description }}</p>
              </div>

              <div class="relation-block">
                <p class="relation-title">关联的新建动画（{{ artifactData.relations.length }}）</p>
                <p v-if="artifactData.relations.length === 0" class="relation-empty">
                  还没有把这条结果导入到新建动画。
                </p>
                <button
                  v-for="relation in artifactData.relations"
                  :key="relation.id"
                  class="relation-item"
                  type="button"
                  @click="gotoRelation(relation)"
                >
                  <Icon name="film" :size="11" />
                  <span class="rel-name" :title="relation.name">{{ relation.name }}</span>
                  <span class="rel-meta">
                    {{ relation.clipCount }} 片段 · {{ relation.trackCount }} 轨道
                  </span>
                </button>
              </div>
            </div>

            <div class="artifact-view">
              <div class="view-head">
                <span class="view-file">{{ artifactContent?.file ?? '选择左侧产物查看内容' }}</span>
                <span v-if="artifactContent" class="view-size">
                  {{ formatSize(artifactContent.size) }}
                </span>
              </div>
              <p v-if="artifactContentLoading" class="view-empty">读取中…</p>
              <p v-else-if="artifactContentError" class="view-empty err">{{ artifactContentError }}</p>
              <template v-else-if="artifactContent">
                <p v-if="artifactContent.truncated" class="view-truncated">文件较大，仅显示前 2MB。</p>
                <VueJsonPretty
                  v-if="artifactJson"
                  :data="artifactJson"
                  :deep="4"
                  :show-length="true"
                  :show-icon="true"
                  theme="dark"
                  class="view-json"
                />
                <pre v-else class="view-text">{{ artifactContent.text }}</pre>
              </template>
              <p v-else class="view-empty">点击左侧可查看的产物（提示词 / 元数据 / Mixamo JSON）。</p>
            </div>
          </div>
        </div>
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
.status-dot.busy {
  background: #fbbf24;
  box-shadow: 0 0 8px #fbbf24aa;
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
  z-index: 80;
  background: rgba(8, 9, 12, 0.5);
  backdrop-filter: blur(2px);
}
.drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  /* 宽屏下占满大部分屏幕，窄屏保留一点遮罩边距 */
  width: min(1720px, 92vw);
  min-width: min(560px, 100vw);
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
  display: grid;
  grid-template-columns: 420px minmax(0, 1fr);
  gap: 12px;
  padding: 12px 16px 16px;
}
.left {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 10px;
}
.right {
  min-height: 0;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.field.small {
  width: 110px;
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
.row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.hint {
  font-size: 11px;
  color: var(--text-faint);
  flex: 1;
}

/* 提示词：参考图片 / AI 转译 / 骰子种子 */
.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-badge {
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 9.5px;
  color: var(--text-faint);
}
.prompt-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.upload-btn {
  cursor: pointer;
  font-size: 11.5px;
}
.ai-btn {
  font-size: 11.5px;
  color: var(--primary);
}
.ai-btn:disabled {
  color: var(--text-faint);
}
.image-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
}
.image-thumb {
  width: 34px;
  height: 34px;
  object-fit: cover;
  border-radius: 4px;
}
.image-name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seed-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.seed-row input {
  flex: 1;
  min-width: 0;
}
.seed-btn {
  flex: none;
  width: 26px;
  height: 26px;
}

/* 动作拆解：把物体动作解释成可模拟的身体动作链 */
.decomp-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-left: 2px solid var(--primary);
  border-radius: 6px;
  background: var(--bg-elevated);
}
.decomp-head {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}
.decomp-objects {
  margin-left: auto;
  padding: 0 6px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 400;
  color: #fbbf24;
  cursor: help;
}
.decomp-edited {
  margin-left: 4px;
  padding: 0 5px;
  border: 1px solid rgba(251, 191, 36, 0.45);
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 400;
  color: #fbbf24;
}
.decomp-step-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.decomp-step-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.decomp-index {
  flex: none;
  width: 14px;
  text-align: right;
  font-size: 10px;
  color: var(--text-faint);
}
.decomp-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--bg-input);
  color: var(--text-dim);
  font-size: 11px;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.decomp-input:hover {
  border-color: var(--border-strong);
}
.decomp-input:focus {
  outline: none;
  border-color: var(--primary);
  color: var(--text);
}
.decomp-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-faint);
  opacity: 0.7;
}
.decomp-remove:hover {
  background: var(--danger-soft);
  color: var(--danger);
  opacity: 1;
}
.decomp-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 6px;
  border: 1px dashed var(--border-strong);
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 10.5px;
}
.decomp-add:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.decomp-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.decomp-refine,
.decomp-reset {
  height: 24px;
  padding: 0 8px;
  font-size: 10.5px;
}
.decomp-note {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--text-faint);
}

/* 分段生成 / 多候选 */
.options-row {
  align-items: center;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.toggle input {
  margin: 0;
  accent-color: var(--primary);
}
.toggle.disabled {
  color: var(--text-faint);
  cursor: not-allowed;
}
.candidate-field {
  margin-left: auto;
}
/* 候选数与帧数/步数输入框保持同一套尺寸、圆角与配色，右对齐箭头替换原生下拉框 */
.candidate-field select {
  appearance: none;
  width: 100%;
  height: 28px;
  padding: 0 24px 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background-color: var(--bg-elevated);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%239b9ca6' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px 6px;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}
.candidate-field select:hover {
  border-color: var(--accent);
  background-color: var(--bg-hover);
}
.candidate-field option {
  background: var(--bg-panel-2);
  color: var(--text);
}

/* 中间产物对话框 */
.artifact-mask {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 9, 12, 0.62);
  backdrop-filter: blur(3px);
}
.artifact-dialog {
  display: flex;
  flex-direction: column;
  width: min(1040px, 94vw);
  height: min(680px, 88vh);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: var(--shadow);
}
.artifact-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.artifact-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.artifact-chain {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
}
.chain-node {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elevated);
}
.chain-node.accent {
  border-color: var(--primary);
  color: var(--primary);
}
.artifact-state {
  margin: 0;
  padding: 20px 16px;
  font-size: 12px;
  color: var(--text-dim);
}
.artifact-state.err {
  color: var(--danger);
}
.artifact-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
}
.artifact-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}
.artifact-item {
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  cursor: pointer;
}
.artifact-item.active {
  border-color: var(--primary);
}
.artifact-item.muted,
.artifact-item.binary {
  cursor: default;
}
.artifact-item.muted {
  opacity: 0.55;
}
.ai-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
}
.ai-size {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
}
.ai-file {
  display: block;
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-dim);
}
.ai-desc {
  margin: 4px 0 0;
  font-size: 10.5px;
  color: var(--text-faint);
}
.relation-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.relation-title {
  margin: 0;
  font-size: 11px;
  color: var(--text-dim);
}
.relation-empty {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-faint);
}
.relation-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-panel-2);
  color: var(--text);
  font-size: 11px;
  text-align: left;
}
.relation-item:hover {
  border-color: var(--primary);
  background: var(--bg-hover);
}
.rel-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rel-meta {
  font-size: 10px;
  color: var(--text-faint);
}
.artifact-view {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.view-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
}
.view-file {
  font-family: var(--mono);
}
.view-size {
  color: var(--text-faint);
}
.view-empty {
  margin: 0;
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-faint);
}
.view-empty.err {
  color: var(--danger);
}
.view-truncated {
  margin: 0;
  padding: 6px 12px;
  font-size: 10.5px;
  color: #fbbf24;
}
.view-text {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.view-json {
  flex: 1;
  min-height: 0;
  padding: 8px 12px;
  overflow: auto;
  font-size: 11.5px;
}

/* 生成进度与状态提示 */
.progress-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-elevated);
}
.pc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}
.pc-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text);
}
.pc-value {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--primary);
}
.pc-value.idle {
  font-family: inherit;
  color: var(--text-dim);
}
.pc-prompt {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pc-idle {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-faint);
}
.pc-track {
  height: 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  overflow: hidden;
}
.pc-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--primary), #7dd3fc);
  transition: width 0.4s linear;
}
.pc-track.queued .pc-fill {
  background: linear-gradient(90deg, #3f3f46, #52525b, #3f3f46);
  background-size: 200% 100%;
  animation: kimodo-stripes 1.2s linear infinite;
}
.pc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 12px;
  color: var(--text-dim);
}
.notice.error {
  border-color: rgba(248, 113, 113, 0.45);
  color: #fecaca;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-dim);
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.empty {
  margin: 8px 0;
  font-size: 12px;
  color: var(--text-faint);
}
.item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  cursor: pointer;
}
.item.active {
  border-color: var(--primary);
}
.item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.iprompt {
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.imeta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-dim);
}
/* 已有注释：整行可点，点开编辑 */
.inote {
  display: block;
  margin: 1px 0 0;
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--text-dim);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.inote:hover {
  color: var(--text);
}
.inote-tag {
  margin-right: 5px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--bg-panel);
  color: var(--text-faint);
  font-size: 10px;
}
.inote-edit {
  margin-top: 2px;
}
.inote-input {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--bg-panel);
  color: var(--text);
  font-family: inherit;
  font-size: 11.5px;
  outline: none;
}
.inote-input:focus {
  border-color: var(--primary);
}
.state {
  color: var(--text-dim);
}
.state.ready {
  color: #34d399;
}
.state.running {
  color: #fbbf24;
}
.state.failed {
  color: var(--danger);
}
.item-progress {
  margin-top: 2px;
  height: 3px;
  border-radius: 999px;
  background: var(--bg-panel);
  overflow: hidden;
}
.item-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--primary);
  transition: width 0.4s linear;
}
.item-progress.queued .item-progress-fill {
  width: 100%;
  background: linear-gradient(90deg, #3f3f46, #52525b, #3f3f46);
  background-size: 200% 100%;
  animation: kimodo-stripes 1.2s linear infinite;
}
@keyframes kimodo-stripes {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}
.ierr {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--danger);
  word-break: break-all;
}
.item-actions {
  display: flex;
  gap: 4px;
}
.unconfigured {
  flex: 1;
  padding: 24px;
  font-size: 13px;
  color: var(--text-dim);
  overflow-y: auto;
}
.unconfigured .title {
  font-size: 14px;
  color: var(--text);
  margin: 0 0 8px;
}
.unconfigured ul {
  margin: 8px 0;
  padding-left: 18px;
}
.unconfigured li {
  margin: 3px 0;
}
.unconfigured code {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
}
.unconfigured .err {
  color: var(--danger);
  word-break: break-all;
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
