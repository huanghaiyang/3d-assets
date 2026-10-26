import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import {
  animationApi,
  type AnimationFile,
  type SavedAnimationProject,
  type SavedAnimationProjectDetail,
} from '@/api/animation';
import { kimodoApi, type KimodoAnimation } from '@/api/kimodo';
import { stageApi } from '@/api/stage';
import { rotateXZ } from '@/viewer/stage/StageActor';
import type { StagePlayer } from '@/viewer/stage/StagePlayer';
import type {
  ActorKind,
  ActorTransform,
  SegmentDef,
  SegmentPose,
  SegmentSource,
  StageActorDef,
  StageDoc,
  StageSummary,
} from '@/viewer/stage/StageTypes';

export interface StageToast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

/** 一次「过渡动画生成」任务：生成期间冻结相邻两段与所属角色 */
export interface TransitionTask {
  key: string;
  prevId: string;
  nextId: string;
  actorId: string;
  status: 'submitting' | 'queued' | 'running' | 'failed';
  jobId?: string;
  frames: number;
  distance: number;
  turnDeg: number;
  prompt: string;
  message?: string;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Kimodo 动作按 30fps 生成，用于估算片段时长 */
const SOMA_FPS = 30;

export const useStageStore = defineStore('stage', () => {
  const docs = ref<StageSummary[]>([]);
  const doc = ref<StageDoc | null>(null);
  const selectedActorId = ref<string | null>(null);
  const selectedSegmentId = ref<string | null>(null);

  const files = ref<AnimationFile[]>([]);
  const kimodoJobs = ref<KimodoAnimation[]>([]);
  const animationProjects = ref<SavedAnimationProject[]>([]);
  const catalogLoading = ref(false);
  const catalogError = ref<string | null>(null);

  const onionSkin = ref(false);
  const showPath = ref(false);

  const time = ref(0);
  const duration = ref(0);
  const playing = ref(false);
  const speed = ref(1);
  const gizmoMode = ref<'translate' | 'rotate'>('translate');
  const saving = ref(false);
  const loading = ref(false);
  const toasts = ref<StageToast[]>([]);
  const canUndo = ref(false);
  const canRedo = ref(false);
  /** 过渡动画生成任务，按 prevId:nextId 索引 */
  const transitionTasks = ref<Record<string, TransitionTask>>({});
  const busyGenerating = computed(() => Object.keys(transitionTasks.value).length > 0);

  let player: StagePlayer | null = null;
  let toastSeq = 0;
  /** 舞台页初始化只做一次，重进页面时保留当前文档 */
  let bootstrapped = false;
  /** 新建动画详情缓存：挑选片段时按需拉取，避免每次点选都请求 */
  const projectCache = new Map<string, Promise<SavedAnimationProjectDetail | null>>();
  /** 过渡生成的轮询计时器 */
  const transitionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const selectedActor = computed(
    () => doc.value?.actors.find((actor) => actor.id === selectedActorId.value) ?? null,
  );

  const actorSegmentsList = computed(() =>
    doc.value && selectedActorId.value
      ? doc.value.segments.filter((segment) => segment.actorId === selectedActorId.value)
      : [],
  );

  function toast(kind: StageToast['kind'], text: string): void {
    const id = ++toastSeq;
    toasts.value.push({ id, kind, text });
    setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id);
    }, 3200);
  }

  // ===== 播放器接入 =====

  function attachPlayer(instance: StagePlayer): void {
    player = instance;
    instance.onFrame((state) => {
      time.value = state.time;
      duration.value = state.duration;
      playing.value = state.playing;
    });
    instance.onNotice((message) => toast('error', message));
    instance.onSelect((id) => {
      const changed = selectedActorId.value !== id;
      selectedActorId.value = id;
      selectedSegmentId.value = null;
      if (changed) instance.setSelectedActor(id);
    });
    instance.onPlacement((event) => updateActorTransform(event.id, event.transform));
    // 点中起始帧残影：选中该段；拖动结束后回写该段站位
    instance.onSelectSegment((actorId, segmentId) => {
      selectedActorId.value = actorId;
      selectedSegmentId.value = segmentId;
    });
    instance.onSegmentPose((segmentId, pose) => updateSegmentPose(segmentId, pose));
    instance.setOnionSkin(onionSkin.value);
    instance.setShowPath(showPath.value);
    // 重进舞台页时恢复当前选中角色（选中环与 gizmo 依赖它）
    instance.setSelectedActor(selectedActorId.value);
    void instance.setDoc(doc.value);
    // 生成中重进舞台页：恢复冻结状态
    applyLocks();
  }

  function detachPlayer(): void {
    player = null;
  }

  function syncPlayer(): void {
    void player?.setDoc(doc.value);
  }

  // ===== 撤销 / 重做 =====

  const HISTORY_LIMIT = 60;
  const past: StageDoc[] = [];
  const future: StageDoc[] = [];
  let historyKey = '';
  let historyAt = 0;

  function cloneDoc(source: StageDoc): StageDoc {
    return JSON.parse(JSON.stringify(source)) as StageDoc;
  }

  function syncHistoryFlags(): void {
    canUndo.value = past.length > 0;
    canRedo.value = future.length > 0;
  }

  function resetHistory(): void {
    past.length = 0;
    future.length = 0;
    historyKey = '';
    syncHistoryFlags();
  }

  /** 记录一次可撤销改动；同 key 的连续操作（拖 gizmo、连续输入）在 800ms 内合并成一步 */
  function recordHistory(key: string, coalesce = true): void {
    if (!doc.value) return;
    const now = performance.now();
    if (coalesce && key === historyKey && now - historyAt < 800) {
      historyAt = now;
      return;
    }
    past.push(cloneDoc(doc.value));
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
    historyKey = key;
    historyAt = now;
    syncHistoryFlags();
  }

  function applySnapshot(snapshot: StageDoc): void {
    const next = cloneDoc(snapshot);
    doc.value = next;
    if (selectedActorId.value && !next.actors.some((actor) => actor.id === selectedActorId.value)) {
      selectedActorId.value = next.actors[0]?.id ?? null;
    }
    if (selectedSegmentId.value && !next.segments.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = null;
    }
    historyKey = '';
    syncPlayer();
    player?.setSelectedActor(selectedActorId.value);
  }

  function undo(): void {
    if (!doc.value) return;
    if (busyGenerating.value) {
      toast('info', '过渡动画生成中，暂不能撤销');
      return;
    }
    const previous = past.pop();
    if (!previous) return;
    future.push(cloneDoc(doc.value));
    applySnapshot(previous);
    syncHistoryFlags();
  }

  function redo(): void {
    if (!doc.value) return;
    if (busyGenerating.value) {
      toast('info', '过渡动画生成中，暂不能重做');
      return;
    }
    const next = future.pop();
    if (!next) return;
    past.push(cloneDoc(doc.value));
    applySnapshot(next);
    syncHistoryFlags();
  }

  // ===== 过渡动画生成 =====

  function taskKey(prevId: string, nextId: string): string {
    return `${prevId}:${nextId}`;
  }

  /** 生成中的任务（不含已失败的）会冻结相邻两段与角色 */
  function activeTasks(): TransitionTask[] {
    return Object.values(transitionTasks.value).filter((task) => task.status !== 'failed');
  }

  function isSegmentLocked(id: string): boolean {
    return activeTasks().some((task) => task.prevId === id || task.nextId === id);
  }

  function isActorLocked(id: string): boolean {
    return activeTasks().some((task) => task.actorId === id);
  }

  function guardLockedSegment(id: string): boolean {
    if (!isSegmentLocked(id)) return false;
    toast('info', '过渡动画生成期间，这两段已冻结');
    return true;
  }

  function guardLockedActor(id: string): boolean {
    if (!isActorLocked(id)) return false;
    toast('info', '过渡动画生成期间，角色已锁定');
    return true;
  }

  function transitionTaskFor(prevId: string, nextId: string): TransitionTask | null {
    return transitionTasks.value[taskKey(prevId, nextId)] ?? null;
  }

  function applyLocks(): void {
    const segmentIds: string[] = [];
    const actorIds: string[] = [];
    for (const task of activeTasks()) {
      segmentIds.push(task.prevId, task.nextId);
      actorIds.push(task.actorId);
    }
    player?.setLocked(segmentIds, actorIds);
  }

  function putTask(task: TransitionTask): void {
    transitionTasks.value = { ...transitionTasks.value, [task.key]: task };
    applyLocks();
  }

  function clearTask(key: string): void {
    const timer = transitionTimers.get(key);
    if (timer) clearTimeout(timer);
    transitionTimers.delete(key);
    const next = { ...transitionTasks.value };
    delete next[key];
    transitionTasks.value = next;
    applyLocks();
  }

  /** 切换/新建舞台时放弃正在等待的过渡生成 */
  function clearTransitions(): void {
    for (const timer of transitionTimers.values()) clearTimeout(timer);
    transitionTimers.clear();
    transitionTasks.value = {};
    player?.setLocked([], []);
  }

  /** 把前后段的位移与转向写成 Kimodo 的过渡提示词（文字编码器只认英文） */
  function transitionPrompt(distance: number, local: { x: number; z: number }, turn: number): string {
    const parts = ['smooth transition motion'];
    if (distance > 0.08) {
      const dirs: string[] = [];
      if (local.z > 0.2) dirs.push('forward');
      else if (local.z < -0.2) dirs.push('backward');
      if (local.x > 0.2) dirs.push('to the right');
      else if (local.x < -0.2) dirs.push('to the left');
      parts.push(`move ${distance.toFixed(1)} meters ${dirs.length > 0 ? dirs.join(' and ') : 'forward'}`);
    }
    const degrees = Math.round((Math.abs(turn) * 180) / Math.PI);
    if (degrees >= 10) parts.push(`turn ${turn > 0 ? 'right' : 'left'} ${degrees} degrees`);
    if (distance <= 0.08 && degrees < 10) parts.push('shift weight naturally in place');
    parts.push('continuous natural full-body motion, steady balance, no abrupt stop');
    return `${parts.join(', ')}.`;
  }

  function failTransition(key: string, message: string): void {
    const task = transitionTasks.value[key];
    if (!task) return;
    putTask({ ...task, status: 'failed', message });
    toast('error', `过渡动画生成失败：${message}`);
  }

  function schedulePoll(key: string): void {
    const existing = transitionTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      transitionTimers.delete(key);
      void pollTransition(key);
    }, 2000);
    transitionTimers.set(key, timer);
  }

  async function pollTransition(key: string): Promise<void> {
    const task = transitionTasks.value[key];
    if (!task?.jobId) return;
    try {
      const list = await kimodoApi.animations();
      const job = list.find((item) => item.id === task.jobId);
      if (!job) {
        failTransition(key, '生成任务已丢失');
        return;
      }
      if (job.status === 'failed') {
        failTransition(key, job.error || 'Kimodo 生成本身失败');
        return;
      }
      if (job.status === 'ready') {
        await completeTransition(key, job.id, job.frames);
        return;
      }
      putTask({ ...task, status: job.status });
      schedulePoll(key);
    } catch (error) {
      failTransition(key, (error as Error).message);
    }
  }

  /** 生成完成：把过渡段插到两段中间，并让根位移正好落到下一段站位 */
  async function completeTransition(key: string, animationId: string, frames: number): Promise<void> {
    const task = transitionTasks.value[key];
    if (!task || !doc.value) return;
    const segments = doc.value.segments;
    const prevIndex = segments.findIndex((item) => item.id === task.prevId);
    const nextIndex = segments.findIndex((item) => item.id === task.nextId);
    if (prevIndex < 0 || nextIndex < 0) {
      failTransition(key, '舞台内容已改变，过渡段未插入');
      return;
    }
    const prev = segments[prevIndex];
    const next = segments[nextIndex];
    const startPose = player?.segmentEndPose(task.actorId, task.prevId) ?? {
      ...(prev.pose ?? { x: 0, z: 0, yaw: 0 }),
    };
    const duration = Math.max(0.2, frames / SOMA_FPS);
    const segment: SegmentDef = {
      id: createId(),
      actorId: task.actorId,
      source: { kind: 'kimodo', animationId },
      trimStart: 0,
      trimEnd: duration,
      blendIn: 0.2,
      pose: startPose,
      transition: { prevId: task.prevId, nextId: task.nextId },
    };

    recordHistory('generate-transition', false);
    // 过渡段尾帧与下一段首帧用短交叉衔接，避免长窗口里来回滑
    next.blendIn = Math.min(next.blendIn, 0.2);
    segments.splice(prevIndex + 1, 0, segment);
    selectedSegmentId.value = segment.id;
    syncPlayer();
    clearTask(key);
    toast('success', '过渡动画已生成并插入');
    void loadCatalog();
  }

  async function generateTransition(prevId: string, nextId: string): Promise<void> {
    if (!doc.value || !selectedActorId.value) return;
    const key = taskKey(prevId, nextId);
    const existing = transitionTasks.value[key];
    if (existing) {
      if (existing.status !== 'failed') return;
      clearTask(key);
    }

    const prev = doc.value.segments.find((item) => item.id === prevId);
    const next = doc.value.segments.find((item) => item.id === nextId);
    if (!prev || !next || prev.actorId !== next.actorId) {
      toast('error', '只能为同一角色的相邻两段生成过渡');
      return;
    }
    const list = actorSegmentsList.value;
    const position = list.findIndex((item) => item.id === prevId);
    if (position < 0 || list[position + 1]?.id !== nextId) {
      toast('error', '过渡动画只能插在相邻两段之间');
      return;
    }

    // 前一段播放到末尾时的真实落点（含片段自身根位移），下一段已经有明确站位
    const startPose = player?.segmentEndPose(prev.actorId, prevId) ?? {
      ...(prev.pose ?? { x: 0, z: 0, yaw: 0 }),
    };
    const endPose = next.pose ?? { x: 0, z: 0, yaw: 0 };
    // 位移量（欧氏距离）和转向角（atan2 归一化到 [-π, π]，避免 359°→1° 被误判为大转）
    const dx = endPose.x - startPose.x;
    const dz = endPose.z - startPose.z;
    const distance = Math.hypot(dx, dz);
    const turn = Math.atan2(Math.sin(endPose.yaw - startPose.yaw), Math.cos(endPose.yaw - startPose.yaw));
    // 把位移向量旋转到 prev 末帧的局部坐标系（前方为 +Z），用于生成英文方向提示词
    const local = rotateXZ(dx, dz, -startPose.yaw);
    // 过渡时长估算：取「位移耗时」和「转向耗时」的较大值，再夹到 [0.8s, 3.2s]
    //   位移：按 1.25 m/s 步行速度估算，加 0.25s 起手缓冲
    //   转向：按每秒约 0.9π (162°) 估算，加 0.35s 缓冲
    const duration = Math.min(
      3.2,
      Math.max(0.8, Math.max(distance / 1.25 + 0.25, Math.abs(turn) / (Math.PI * 0.9) + 0.35)),
    );
    // 帧数 = duration × 30fps，对齐到偶数（DDIM 采样对偶数帧更友好），夹到 [24, 96]
    const frames = Math.max(24, Math.min(96, Math.round((duration * SOMA_FPS) / 2) * 2));

    const task: TransitionTask = {
      key,
      prevId,
      nextId,
      actorId: prev.actorId,
      status: 'submitting',
      frames,
      distance,
      turnDeg: Math.round((turn * 180) / Math.PI),
      prompt: transitionPrompt(distance, local, turn),
    };
    putTask(task);

    // ---- 决定走哪条生成路径 ----
    // 判断两段是否都是 Kimodo 生成的片段：只有 source.kind === 'kimodo' 的段才有
    // animationId，后端才能根据 animationId 切出原始 f32 做真实 pose 约束。
    // 如果任一段来自 FBX / 新建动画（没有 animationId），只能退回纯文本 prompt。
    const prevAnimId = prev.source.kind === 'kimodo' ? prev.source.animationId : undefined;
    const nextAnimId = next.source.kind === 'kimodo' ? next.source.animationId : undefined;
    const bothKimodo = !!prevAnimId && !!nextAnimId;

    try {
      let job;
      if (bothKimodo) {
        // 真实 pose 约束路径：首尾帧精确对齐 prev 末 / next 首（RMS=0）
        // 关键参数选择：
        //   transitionFrames=1 → 只硬约束首尾各 1 帧（prev 末帧 + next 首帧），
        //                        中间帧完全交给 DDIM 自由生成，保证过渡自然不僵硬
        //   steps=50           → 条件生成需要更多扩散步收敛，比文本生成的 20 步更稳
        //   rootDelta=local    → 两段 root 都是各自 Kimodo job 的局部坐标、原点都在 0 附近，
        //                        直接把 prev 末帧/next 首帧当约束会让模型「看不出距离」而原地踏步。
        //                        把舞台位移（已旋到 prev 局部系）传下去，服务端将 next 的 root
        //                        平移到 prev 末帧 + local，首尾约束之间就有了真实间距，
        //                        模型必须走出这段距离才能同时满足两端。
        job = await kimodoApi.generateConditioned({
          prevAnimationId: prevAnimId,
          nextAnimationId: nextAnimId,
          frames,
          transitionFrames: 1,
          steps: 50,
          prompt: task.prompt,
          rootDelta: { dx: local.x, dz: local.z },
        });
      } else {
        // 纯文本 prompt 回退路径（任一段非 kimodo 源时使用）
        // 只靠文字描述位移/转向来生成，首尾无法精确对齐，可能有 5–10cm 的跳变
        // steps=20 足够，文本生成不需要那么多扩散步
        job = await kimodoApi.generate({ prompt: task.prompt, frames, steps: 20 });
      }

      const live = transitionTasks.value[key];
      if (!live) return;
      if (job.status === 'failed') {
        failTransition(key, job.error || 'Kimodo 生成本身失败');
        return;
      }
      putTask({ ...live, jobId: job.id, status: job.status === 'ready' ? 'running' : job.status });
      if (job.status === 'ready') {
        await completeTransition(key, job.id, job.frames);
        return;
      }
      schedulePoll(key);
      toast(
        'info',
        `已提交过渡动画生成（${frames} 帧，位移 ${distance.toFixed(1)}m / 转向 ${task.turnDeg}°），生成期间相邻两段与角色已冻结`,
      );
    } catch (error) {
      failTransition(key, (error as Error).message);
    }
  }

  // ===== 文档 =====

  function newStage(name = '新舞台'): void {
    clearTransitions();
    doc.value = {
      id: '',
      name,
      actors: [],
      segments: [],
      loop: true,
      updatedAt: new Date().toISOString(),
    };
    selectedActorId.value = null;
    selectedSegmentId.value = null;
    resetHistory();
    void player?.setDoc(doc.value);
  }

  async function loadStages(): Promise<void> {
    try {
      const response = await stageApi.list();
      docs.value = response.stages;
    } catch (error) {
      docs.value = [];
      catalogError.value = (error as Error).message;
    }
  }

  async function openStage(id: string): Promise<void> {
    clearTransitions();
    loading.value = true;
    try {
      const loaded = await stageApi.get(id);
      doc.value = { ...loaded, actors: loaded.actors ?? [], segments: loaded.segments ?? [] };
      selectedActorId.value = doc.value.actors[0]?.id ?? null;
      selectedSegmentId.value = null;
      time.value = 0;
      resetHistory();
      await player?.setDoc(doc.value);
      player?.setSelectedActor(selectedActorId.value);
    } catch (error) {
      toast('error', `打开舞台失败：${(error as Error).message}`);
    } finally {
      loading.value = false;
    }
  }

  async function saveStage(): Promise<void> {
    if (!doc.value) return;
    saving.value = true;
    try {
      if (!doc.value.id) {
        const summary = await stageApi.create(doc.value);
        doc.value.id = summary.id;
      } else {
        await stageApi.save(doc.value);
      }
      doc.value.updatedAt = new Date().toISOString();
      await loadStages();
      toast('success', `已保存「${doc.value.name}」`);
    } catch (error) {
      toast('error', `保存失败：${(error as Error).message}`);
    } finally {
      saving.value = false;
    }
  }

  async function removeStage(id: string): Promise<void> {
    try {
      await stageApi.remove(id);
      await loadStages();
      if (doc.value?.id === id) newStage();
      toast('info', '舞台已删除');
    } catch (error) {
      toast('error', `删除失败：${(error as Error).message}`);
    }
  }

  function renameStage(name: string): void {
    if (!doc.value) return;
    const next = name.trim().slice(0, 80);
    if (!next || next === doc.value.name) return;
    recordHistory('rename-stage', false);
    doc.value.name = next;
  }

  /** 舞台列表里就地重命名已保存的舞台（会直接落盘） */
  async function renameStageById(id: string, name: string): Promise<void> {
    const next = name.trim().slice(0, 80);
    if (!id || !next) return;
    const summary = docs.value.find((item) => item.id === id);
    if (summary) summary.name = next;
    const isCurrent = doc.value?.id === id;
    if (isCurrent) {
      recordHistory('rename-stage', false);
      doc.value!.name = next;
    }
    try {
      if (isCurrent) {
        await stageApi.save(doc.value!);
      } else {
        const loaded = await stageApi.get(id);
        loaded.name = next;
        await stageApi.save(loaded);
      }
      await loadStages();
      toast('success', `已重命名为「${next}」`);
    } catch (error) {
      toast('error', `重命名失败：${(error as Error).message}`);
    }
  }

  // ===== 角色 =====

  function addActor(kind: ActorKind, modelPath?: string): StageActorDef | null {
    if (!doc.value) return null;
    const path = kind === 'fbx' ? modelPath ?? files.value[0]?.path : undefined;
    if (kind === 'fbx' && !path) {
      toast(
        'info',
        catalogLoading.value
          ? '动画库还在加载，请稍候再添加 FBX 角色'
          : '还没有可用的 FBX，请先在设置里添加动画文件夹',
      );
      return null;
    }
    recordHistory('add-actor', false);
    const index = doc.value.actors.length + 1;
    const actor: StageActorDef = {
      id: createId(),
      name: kind === 'fbx' ? `FBX 角色 ${index}` : `Soma 角色 ${index}`,
      kind,
      ...(path ? { modelPath: path } : {}),
      transform: { x: 0, z: 0, yaw: 0 },
      visible: true,
    };
    doc.value.actors.push(actor);
    selectedActorId.value = actor.id;
    selectedSegmentId.value = null;
    syncPlayer();
    return actor;
  }

  function removeActor(id: string): void {
    if (!doc.value) return;
    if (guardLockedActor(id)) return;
    const exists = doc.value.actors.some((actor) => actor.id === id);
    if (!exists) return;
    recordHistory('remove-actor', false);
    doc.value.actors = doc.value.actors.filter((actor) => actor.id !== id);
    doc.value.segments = doc.value.segments.filter((segment) => segment.actorId !== id);
    if (selectedActorId.value === id) {
      selectedActorId.value = doc.value.actors[0]?.id ?? null;
      selectedSegmentId.value = null;
    }
    syncPlayer();
  }

  function updateActorTransform(id: string, transform: ActorTransform): void {
    if (guardLockedActor(id)) return;
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor) return;
    recordHistory(`transform:${id}`);
    actor.transform = { x: transform.x, z: transform.z, yaw: transform.yaw };
    syncPlayer();
  }

  function updateActorName(id: string, name: string): void {
    if (guardLockedActor(id)) return;
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor) return;
    const next = name.trim().slice(0, 80);
    if (!next || next === actor.name) return;
    recordHistory(`actor-name:${id}`, false);
    actor.name = next;
  }

  function updateActorModel(id: string, modelPath: string): void {
    if (guardLockedActor(id)) return;
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor || actor.kind !== 'fbx' || !modelPath) return;
    recordHistory(`actor-model:${id}`, false);
    actor.modelPath = modelPath;
    // 换模型后原 FBX 片段可能不再匹配，清空该角色的序列避免播出空白
    doc.value!.segments = doc.value!.segments.filter((segment) => segment.actorId !== id);
    syncPlayer();
  }

  function toggleActorVisible(id: string): void {
    if (guardLockedActor(id)) return;
    const actor = doc.value?.actors.find((item) => item.id === id);
    if (!actor) return;
    recordHistory(`actor-visible:${id}`, false);
    actor.visible = !actor.visible;
    syncPlayer();
  }

  // ===== 片段序列 =====

  function addSegment(actorId: string, source: SegmentSource, clipDuration: number): void {
    if (!doc.value) return;
    recordHistory('add-segment', false);
    const length = Math.max(0.05, clipDuration || 1);
    const segment: SegmentDef = {
      id: createId(),
      actorId,
      source,
      trimStart: 0,
      trimEnd: length,
      blendIn: Math.min(0.3, length / 4),
    };
    doc.value.segments.push(segment);
    selectedSegmentId.value = segment.id;
    syncPlayer();
  }

  function updateSegment(id: string, patch: Partial<Pick<SegmentDef, 'trimStart' | 'trimEnd' | 'blendIn'>>): void {
    if (guardLockedSegment(id)) return;
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    recordHistory(`segment:${id}:${Object.keys(patch).join(',')}`);
    if (patch.trimStart !== undefined) segment.trimStart = Math.max(0, patch.trimStart);
    if (patch.trimEnd !== undefined) segment.trimEnd = Math.max(segment.trimStart + 0.05, patch.trimEnd);
    if (patch.blendIn !== undefined) segment.blendIn = Math.max(0, Math.min(2, patch.blendIn));
    syncPlayer();
  }

  function removeSegment(id: string): void {
    if (!doc.value) return;
    if (guardLockedSegment(id)) return;
    const exists = doc.value.segments.some((item) => item.id === id);
    if (!exists) return;
    recordHistory('remove-segment', false);
    doc.value.segments = doc.value.segments.filter((item) => item.id !== id);
    if (selectedSegmentId.value === id) selectedSegmentId.value = null;
    syncPlayer();
  }

  /** 改某段的独立站位（相对角色摆放的偏移） */
  function updateSegmentPose(id: string, patch: Partial<SegmentPose>): void {
    if (guardLockedSegment(id)) return;
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    recordHistory(`pose:${id}`);
    const base = segment.pose ?? { x: 0, z: 0, yaw: 0 };
    segment.pose = {
      x: patch.x ?? base.x,
      z: patch.z ?? base.z,
      yaw: patch.yaw ?? base.yaw,
    };
    syncPlayer();
  }

  function resetSegmentPose(id: string): void {
    if (guardLockedSegment(id)) return;
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    recordHistory(`pose-reset:${id}`, false);
    segment.pose = { x: 0, z: 0, yaw: 0 };
    syncPlayer();
  }

  /** 在同一角色的序列里移动一段（-1 上移，+1 下移） */
  function moveSegment(id: string, delta: number): void {
    if (!doc.value) return;
    if (guardLockedSegment(id)) return;
    const segment = doc.value.segments.find((item) => item.id === id);
    if (!segment) return;
    const indexes = doc.value.segments
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.actorId === segment.actorId);
    const position = indexes.findIndex((entry) => entry.item.id === id);
    const target = indexes[position + delta];
    if (!target) return;
    recordHistory('move-segment', false);
    const origin = indexes[position];
    const segments = doc.value.segments;
    [segments[origin.index], segments[target.index]] = [segments[target.index], segments[origin.index]];
    syncPlayer();
  }

  // ===== 播放控制 =====

  function seek(next: number): void {
    time.value = Math.max(0, Math.min(duration.value, next));
    player?.seek(time.value);
  }

  function togglePlay(): void {
    player?.toggle();
  }

  function setSpeed(next: number): void {
    speed.value = next;
    player?.setSpeed(next);
  }

  function setLoop(on: boolean): void {
    if (!doc.value) return;
    recordHistory('loop', false);
    doc.value.loop = on;
    syncPlayer();
  }

  function setGizmoMode(mode: 'translate' | 'rotate'): void {
    gizmoMode.value = mode;
    player?.setGizmoMode(mode);
  }

  function setOnionSkin(on: boolean): void {
    onionSkin.value = on;
    player?.setOnionSkin(on);
  }

  function setShowPath(on: boolean): void {
    showPath.value = on;
    player?.setShowPath(on);
  }

  function selectActor(id: string | null): void {
    selectedActorId.value = id;
    selectedSegmentId.value = null;
    player?.setSelectedActor(id);
  }

  /** 右侧面板选中某段：联动选中角色，并在舞台上激活该段起始帧残影的移动句柄 */
  function selectSegment(id: string | null): void {
    selectedSegmentId.value = id;
    if (!id) return;
    const segment = doc.value?.segments.find((item) => item.id === id);
    if (!segment) return;
    if (selectedActorId.value !== segment.actorId) {
      selectedActorId.value = segment.actorId;
      player?.setSelectedActor(segment.actorId);
    }
    // 起始帧残影就是拖动的对象，没开洋葱皮时先打开
    if (!onionSkin.value) setOnionSkin(true);
    player?.selectSegment(id);
  }

  // ===== 素材目录 =====

  async function loadCatalog(): Promise<void> {
    catalogLoading.value = true;
    catalogError.value = null;
    projectCache.clear();
    try {
      const [list, jobs, projects] = await Promise.all([
        animationApi.list().catch(() => null),
        kimodoApi.animations().catch(() => [] as KimodoAnimation[]),
        animationApi.projects().catch(() => null),
      ]);
      files.value = list?.files ?? [];
      kimodoJobs.value = jobs.filter((job) => job.status === 'ready');
      animationProjects.value = projects?.projects ?? [];
    } catch (error) {
      catalogError.value = (error as Error).message;
    } finally {
      catalogLoading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    // 舞台页每次切回来都会重新挂载，但这里只能初始化一次：
    // 否则会重新打开第一个已保存舞台，覆盖掉用户刚点「新建」的空白舞台
    if (bootstrapped) return;
    bootstrapped = true;
    await Promise.all([loadCatalog(), loadStages()]);
    if (docs.value.length > 0) await openStage(docs.value[0].id);
    else newStage();
  }

  /** 片段来源的可读名称 */
  function sourceLabel(source: SegmentSource): string {
    if (source.kind === 'kimodo') {
      const job = kimodoJobs.value.find((item) => item.id === source.animationId);
      const title = job?.note?.trim() || job?.prompt?.trim();
      return title ? title.slice(0, 32) : `Kimodo ${source.animationId.slice(0, 6)}`;
    }
    if (source.kind === 'anim-project') {
      return source.projectName || `新建动画 ${source.projectId.slice(0, 6)}`;
    }
    const file = files.value.find((item) => item.path === source.fbxPath);
    const fileName = file?.name ?? source.fbxPath.split(/[\\/]/).pop() ?? 'FBX';
    return `${fileName} · ${source.clipName}`;
  }

  /** 读新建动画项目详情（带缓存）；失败返回 null */
  function projectDetail(id: string): Promise<SavedAnimationProjectDetail | null> {
    const cached = projectCache.get(id);
    if (cached) return cached;
    const promise = animationApi.project(id).catch(() => null);
    projectCache.set(id, promise);
    return promise;
  }

  /** 从动画 JSON 里取片段时长（关键帧末尾时间与 clip.duration 取大） */
  function animationDataDuration(data: unknown): number {
    const clips = (data as { clips?: unknown } | null)?.clips;
    if (!Array.isArray(clips)) return 0;
    let longest = 0;
    for (const clip of clips) {
      const duration = Number((clip as { duration?: unknown } | null)?.duration);
      if (Number.isFinite(duration)) longest = Math.max(longest, duration);
      const tracks = (clip as { tracks?: unknown } | null)?.tracks;
      if (!Array.isArray(tracks)) continue;
      for (const track of tracks) {
        const times = (track as { times?: unknown } | null)?.times;
        if (!Array.isArray(times) || times.length === 0) continue;
        const last = Number(times[times.length - 1]);
        if (Number.isFinite(last)) longest = Math.max(longest, last);
      }
    }
    return longest;
  }

  /** 把「新建动画」里的项目作为片段加入当前角色 */
  async function addAnimationProjectSegment(projectId: string, projectName: string): Promise<void> {
    if (!doc.value || !selectedActorId.value) return;
    const detail = await projectDetail(projectId);
    if (!detail) {
      toast('error', '读取新建动画失败');
      return;
    }
    const length = animationDataDuration(detail.data);
    if (length <= 0) {
      toast('error', `「${detail.name}」里还没有可用的关键帧`);
      return;
    }
    addSegment(selectedActorId.value, { kind: 'anim-project', projectId, projectName }, length);
  }

  /** Kimodo 动作的估算时长（秒） */
  function kimodoDuration(animationId: string): number {
    const job = kimodoJobs.value.find((item) => item.id === animationId);
    return job ? Math.max(0.1, job.frames / SOMA_FPS) : 1;
  }

  /** 列出某个 FBX 里的片段（按需加载，失败返回空） */
  async function listFbxClips(path: string): Promise<{ name: string; duration: number }[]> {
    try {
      return (await player?.listClips(path)) ?? [];
    } catch {
      toast('error', '读取 FBX 片段失败');
      return [];
    }
  }

  return {
    docs,
    doc,
    selectedActorId,
    selectedSegmentId,
    selectedActor,
    actorSegmentsList,
    files,
    kimodoJobs,
    animationProjects,
    catalogLoading,
    catalogError,
    onionSkin,
    showPath,
    time,
    duration,
    playing,
    speed,
    gizmoMode,
    saving,
    loading,
    toasts,
    canUndo,
    canRedo,
    undo,
    redo,
    transitionTasks,
    busyGenerating,
    transitionTaskFor,
    generateTransition,
    isSegmentLocked,
    isActorLocked,
    attachPlayer,
    detachPlayer,
    bootstrap,
    loadCatalog,
    loadStages,
    newStage,
    openStage,
    saveStage,
    removeStage,
    renameStage,
    renameStageById,
    addActor,
    removeActor,
    updateActorTransform,
    updateActorName,
    updateActorModel,
    toggleActorVisible,
    addSegment,
    updateSegment,
    updateSegmentPose,
    resetSegmentPose,
    removeSegment,
    moveSegment,
    seek,
    togglePlay,
    setSpeed,
    setLoop,
    setGizmoMode,
    setOnionSkin,
    setShowPath,
    selectActor,
    selectSegment,
    sourceLabel,
    addAnimationProjectSegment,
    kimodoDuration,
    listFbxClips,
  };
});
