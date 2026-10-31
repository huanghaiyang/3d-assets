<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import Icon from './ui/Icon.vue';
import { ModelViewer, ViewerCanceledError, type ManualRigJointInfo, type ManualRigSnapshot, type MeshStats } from '@/viewer/ModelViewer';
import { MANUAL_MARKERS } from '@/viewer/autorig/manualRig';
import { pickPreviewTarget } from '@/viewer/assetTarget';
import { useWorkspaceStore, isActive } from '@/stores/workspace';
import { useNow } from '@/composables/useNow';
import { confirmAction } from '@/composables/useConfirm';
import { formatDuration } from '@/utils/image';
import { animationApi, type AnimationFile } from '@/api/animation';
import type { Asset, Job } from '@/api/types';

const store = useWorkspaceStore();
const now = useNow(1000);

const containerRef = ref<HTMLDivElement | null>(null);
const viewer = shallowRef<ModelViewer | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const stats = ref<MeshStats | null>(null);

// ===== 自动绑骨（人形 T-pose） =====
/** 当前模型是否自带骨架（已含骨架的模型隐藏绑骨按钮，只保留骨骼显示开关） */
const hasSkeleton = ref(false);
/** 是否已通过 autoRig 完成绑定（决定是否显示「导出 GLB」） */
const rigged = ref(false);
const skeletonOn = ref(false);
const rigging = ref(false);
const rigProgress = ref(0);
/** 模型是否已手动/绑骨流程纠正过朝向（用于按钮 active 状态） */
const orientationCorrected = ref(false);
/** 绑骨进度卡上的标题 / 说明（自动绑骨与手动绑骨共用一张卡） */
const riggingMode = ref<'auto' | 'manual'>('auto');
const riggingLabel = computed(() => (riggingMode.value === 'manual' ? '正在按手动关节绑定' : '正在自动绑骨'));
const riggingNote = computed(() =>
  riggingMode.value === 'manual'
    ? '按当前关节位置重建胶囊并计算蒙皮权重…'
    : '拟合骨架并计算蒙皮权重…',
);

// ===== 手动绑骨（拖动参考关节） =====
/** 是否处于手动绑骨编辑状态（关节标记与预览骨架可见） */
const manualSnapshot = ref<ManualRigSnapshot | null>(null);
const manualApplying = ref(false);
const manualProgress = ref(0);
/** Auto-Rig 面板是否展开（布局参考 Auto-Rig Pro 的 N 面板：常驻、不依赖是否已生成参考骨） */
const rigPanelOpen = ref(false);
/** ARP 面板的五个标签页（对齐 Auto-Rig Pro：Smart / Rig / Remap / Skin / Export） */
const ARP_TABS = ['smart', 'rig', 'remap', 'skin', 'export'] as const;
type ArpTab = (typeof ARP_TABS)[number];
/** ARP 面板当前标签页 */
const arpTab = ref<ArpTab>('smart');
/** 可折叠分组的展开状态 */
const arpCollapsed = ref<Record<string, boolean>>({
  setup: false,
  markers: false,
  settings: false,
});
/** Smart 标记的镜像开关在 ModelViewer 里维护（放置左右标记时同步对侧） */
/** 每只手的手指数（当前骨架固定五指，面板只做展示） */
const fingerCount = 5;

/** 面板可见条件：模型已加载、且还没有骨架（有骨架后交给骨骼显示 / 动画预览） */
const rigPanelVisible = computed(() => rigPanelOpen.value && stats.value !== null && !hasSkeleton.value);

/** 已放置标记的关节名集合 */
const placedMarkers = computed(() => new Set(manualSnapshot.value?.placed ?? []));

/** 当前选中的标记定义（用于「已选标记」标题与人体示意图高亮） */
const selectedMarker = computed(
  () => MANUAL_MARKERS.find((marker) => marker.joint === manualSnapshot.value?.selected) ?? null,
);

/** 下一个建议放置的标记：先补齐必需标记，再补脚掌等可选项 */
const nextMarker = computed(
  () =>
    MANUAL_MARKERS.find((marker) => marker.required && !placedMarkers.value.has(marker.joint)) ??
    MANUAL_MARKERS.find((marker) => !placedMarkers.value.has(marker.joint)) ??
    null,
);

/** 已放置的标记数量（含可选项） */
const placedMarkerCount = computed(
  () => MANUAL_MARKERS.filter((marker) => placedMarkers.value.has(marker.joint)).length,
);

/** 正在等待落点的标记中文名（按钮文案用） */
const placingLabel = computed(() => {
  const joint = manualSnapshot.value?.placing;
  return MANUAL_MARKERS.find((marker) => marker.joint === joint)?.label ?? '';
});

/**
 * 人体示意图上的标记落点（0..60 x 0..100 的归一化坐标）。
 * 对应 ARP 面板里那张「人形 + 绿点」预览图：绿点 = 已放置，灰点 = 未放置。
 */
const MARKER_FIGURE: Record<string, { x: number; y: number }> = {
  Head: { x: 30, y: 17 },
  Neck: { x: 30, y: 23 },
  Hips: { x: 30, y: 55 },
  ShoulderL: { x: 45, y: 27 },
  ShoulderR: { x: 15, y: 27 },
  UpperArmL: { x: 52, y: 40 },
  UpperArmR: { x: 8, y: 40 },
  ForearmL: { x: 57, y: 49 },
  ForearmR: { x: 3, y: 49 },
  UpperLegL: { x: 37, y: 59 },
  UpperLegR: { x: 23, y: 59 },
  LowerLegL: { x: 39, y: 80 },
  LowerLegR: { x: 21, y: 80 },
  FootL: { x: 41, y: 92 },
  FootR: { x: 19, y: 92 },
  ToeL: { x: 46, y: 95 },
  ToeR: { x: 14, y: 95 },
};

/** 切换可折叠分组 */
function toggleArpSection(key: string): void {
  arpCollapsed.value = { ...arpCollapsed.value, [key]: !arpCollapsed.value[key] };
}

/** 人体示意图坐标（没有登记时落在躯干中央） */
function figurePos(joint: string): { x: number; y: number } {
  return MARKER_FIGURE[joint] ?? { x: 30, y: 50 };
}

/** Smart 标记行点击：未放置 → 进入添加模式（只放标记，不生成骨骼）；已放置 → 只选中 */
function pickArpMarker(joint: string): void {
  const instance = viewer.value;
  if (!instance) return;
  if (!placedMarkers.value.has(joint)) {
    startMarkerPlacement(joint);
    return;
  }
  instance.selectManualRigJoint(joint);
}

/**
 * 添加一个标记（ARP 的 Add Markers）：没有参考骨时只进入标记编辑，
 * 不生成骨骼；随后下一个视口左键点击即为落点，Esc 或再点一次「取消添加」退出。
 */
function startMarkerPlacement(joint: string): void {
  const instance = viewer.value;
  if (!instance || manualApplying.value) return;
  try {
    // 没有参考骨时只建标记编辑会话，不生成骨骼：骨架会挡住标记落点和拖拽
    if (!instance.isManualRigActive) instance.startManualRig({ createBones: false });
    instance.beginManualMarkerPlacement(joint);
    const marker = MANUAL_MARKERS.find((item) => item.joint === joint);
    store.toast('info', `请在模型上点击「${marker?.label ?? joint}」的位置`);
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '添加标记失败');
  }
}

function cancelMarkerPlacement(): void {
  viewer.value?.beginManualMarkerPlacement(null);
}

/** 猜测全部标记（ARP 的 Guess Markers）：按几何拟合一次性放置 */
function guessMarkers(): void {
  const instance = viewer.value;
  if (!instance || manualApplying.value) return;
  try {
    const snapshot = instance.guessManualRigMarkers();
    onManualRigChange(snapshot);
    store.toast('success', `已按几何拟合放置 ${snapshot.placed.length} 个标记，可直接 Go! 或逐个微调`);
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '猜测标记失败');
  }
}

/** 镜像开关：放置左右标记时对侧一起落位 */
function toggleMirror(event: Event): void {
  viewer.value?.setManualRigMirror((event.target as HTMLInputElement).checked);
}

/** 使用标记深度：开启后落点贴合网格表面 */
function toggleMarkerDepth(event: Event): void {
  viewer.value?.setManualRigMarkerDepth((event.target as HTMLInputElement).checked);
}

/** 恢复上局标记（上一局的落点位置） */
function restoreLastMarkers(): void {
  const instance = viewer.value;
  if (!instance) return;
  const snapshot = instance.restoreManualMarkers();
  onManualRigChange(snapshot);
  if (snapshot.placed.length === 0) store.toast('info', '还没有可恢复的标记');
  else store.toast('success', `已恢复 ${snapshot.placed.length} 个标记`);
}

/** 取消和删除标记：清空当前落点，参考骨架保留 */
function removeMarkers(): void {
  const instance = viewer.value;
  if (!instance || !manualSnapshot.value) return;
  instance.removeManualMarkers();
  store.toast('info', '已删除全部标记');
}

/** 手指粗细（按拟合半径的倍数） */
function onFingerScaleInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  viewer.value?.setManualRigFingerScale(value);
}

const selectedJoint = computed<ManualRigJointInfo | null>(() => {
  const snapshot = manualSnapshot.value;
  if (!snapshot?.selected) return null;
  return snapshot.joints.find((joint) => joint.name === snapshot.selected) ?? null;
});

/** 侧栏按「基础骨 / 末端参考 / 手指」分组，避免 60 多个关节混在一列 */
const coordStep = computed(() => {
  const height = manualSnapshot.value?.height ?? 0;
  return height > 0 ? (height / 1000).toFixed(4) : '0.001';
});

/** 参考骨半径滑杆的取值范围（按身高比例，和默认半径量级一致） */
const radiusMin = computed(() => adv((manualSnapshot.value?.height ?? 0) * 0.004));
const radiusMax = computed(() => adv((manualSnapshot.value?.height ?? 0) * 0.15));
const radiusStep = computed(() => adv((manualSnapshot.value?.height ?? 0) / 500));

/** 0 高度（未绑骨）时给一个稳定的兜底值，避免滑杆 min/max 都是 0 */
function adv(value: number): string {
  return (value > 0 ? value : 0.001).toFixed(4);
}

// ===== 绑骨后的动画预览 =====
/** 动画库文件列表（懒加载：首次绑骨成功后读取一次） */
const animFiles = ref<AnimationFile[]>([]);
const animLoading = ref(false);
const animListError = ref<string | null>(null);
/** 当前选中的动画绝对路径；空串表示保持绑定姿态 */
const animPath = ref('');
const animPlaying = ref(false);
const animBusy = ref(false);

/** 按来源文件夹分组，下拉框里用 optgroup 展示 */
const animGroups = computed(() => {
  const groups = new Map<string, AnimationFile[]>();
  for (const file of animFiles.value) {
    const label = file.sourceLabel || '动画库';
    const list = groups.get(label);
    if (list) list.push(file);
    else groups.set(label, [file]);
  }
  return [...groups.entries()].map(([label, files]) => ({ label, files }));
});

const asset = computed<Asset | null>(() => store.selectedAsset);
const job = computed<Job | null>(() => store.selectedJob);
const activeJob = computed<Job | null>(() => {
  if (job.value && isActive(job.value.phase)) return job.value;
  return store.jobs.find((item) => isActive(item.phase)) ?? null;
});

const PHASE_TEXT: Record<Job['phase'], string> = {
  queued: '排队中',
  submitting: '提交中',
  running: '生成中',
  downloading: '下载并转存中',
  done: '已完成',
  failed: '生成失败',
  canceled: '已取消',
};

/** 接口不返回百分比，这里按耗时给出一个收敛的估算进度 */
const estimatedProgress = computed(() => {
  const active = activeJob.value;
  if (!active?.startedAt) return 6;
  const elapsed = now.value - new Date(active.startedAt).getTime();
  const estimated = 12 + 83 * (1 - Math.exp(-elapsed / 70_000));
  return Math.min(95, Math.round(estimated));
});

/** 递增令牌：连续切换素材时丢弃过期的一次加载，避免旧结果覆盖新素材的状态 */
let loadToken = 0;

async function loadAsset(target: Asset | null): Promise<void> {
  const instance = viewer.value;
  if (!instance) return;
  const token = ++loadToken;
  loadError.value = null;

  if (!target) {
    instance.clear();
    stats.value = null;
    resetAnimationPreview();
    return;
  }

  const loadTarget = pickPreviewTarget(target);
  if (!loadTarget) {
    instance.clear();
    stats.value = null;
    resetAnimationPreview();
    loadError.value = '该素材没有浏览器可直接预览的格式，请下载后用本地软件打开';
    return;
  }

  loading.value = true;
  // 切换素材时重置绑骨状态（骨架绑定不跨素材保留）
  hasSkeleton.value = false;
  rigged.value = false;
  skeletonOn.value = false;
  orientationCorrected.value = false;
  manualSnapshot.value = null;
  rigPanelOpen.value = false;
  resetAnimationPreview();
  try {
    const loaded = await instance.load(loadTarget);
    // 加载期间又切了素材：本次结果已过期，状态留给后一次加载写
    if (token !== loadToken) return;
    stats.value = loaded;
    instance.setWireframe(store.wireframe);
    instance.setGrid(store.showGrid);
    instance.setAutoRotate(store.autoRotate);
    hasSkeleton.value = instance.hasSkeleton;
    rigged.value = instance.isRigged;
    // 回填节点树，并按当前选择恢复高亮
    store.setNodeTree(instance.sceneNodes);
    instance.setNodeSelection(store.selectedNodeIds);
  } catch (err) {
    // 被新素材取代的加载不算失败
    if (token !== loadToken || err instanceof ViewerCanceledError) return;
    loadError.value = (err as Error).message;
    stats.value = null;
    store.setNodeTree([]);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

// 素材切换 / 文件集合变化 / 文件被改写（批量修正中心点或朝向）后都要重新加载：
// 改写后的 URL 带 ?v= 版本号，把它并入 key 才能触发重载
const viewKey = computed(() => {
  if (!asset.value) return null;
  const primary = asset.value.files[0]?.primaryUrl ?? '';
  return `${asset.value.id}:${asset.value.files.length}:${primary}`;
});

watch(viewKey, () => void loadAsset(asset.value));
watch(
  () => store.wireframe,
  (value) => viewer.value?.setWireframe(value),
);
watch(
  () => store.showGrid,
  (value) => viewer.value?.setGrid(value),
);
watch(
  () => store.autoRotate,
  (value) => viewer.value?.setAutoRotate(value),
);
// 节点选择变化 → 同步高亮（加选逻辑在 store 里）
watch(
  () => store.selectedNodeIds,
  (ids) => viewer.value?.setNodeSelection(ids),
  { deep: true },
);

onMounted(() => {
  if (containerRef.value) {
    viewer.value = new ModelViewer(containerRef.value);
    viewer.value.onManualRigChange = onManualRigChange;
    void loadAsset(asset.value);
  }
});

onBeforeUnmount(() => {
  if (viewer.value) viewer.value.onManualRigChange = null;
  viewer.value?.dispose();
  viewer.value = null;
});

function toggleFullscreen(): void {
  const element = containerRef.value?.parentElement;
  if (!element) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void element.requestFullscreen().catch(() => store.toast('error', '浏览器拒绝了全屏请求'));
}

function retry(): void {
  if (activeJob.value) void store.retry(activeJob.value.id);
}

/**
 * 自动绑骨：从网格几何测量躯干/手臂/腿部走向后拟合骨架，胶囊距离蒙皮。
 * 先弹确认（提示适用条件），确认后分块计算并通过 rigProgress 更新进度条。
 */
async function autoRig(): Promise<void> {
  const instance = viewer.value;
  if (!instance || rigging.value || !stats.value) return;
  const confirmed = await confirmAction({
    title: '自动绑骨（实验）',
    message: '将按模型的实际几何走向自适应拟合 19 根骨骼并计算蒙皮权重。',
    detail:
      '适用于站立人形模型，T-pose / A-pose / 手臂自然下垂都可以；' +
      '仍要求左右对称、脚底贴地。绑定不改变当前外观，可导出 GLB；切换素材后失效。',
    confirmText: '开始绑定',
    danger: false,
  });
  if (!confirmed) return;

  rigging.value = true;
  riggingMode.value = 'auto';
  rigProgress.value = 0;
  try {
    const result = await instance.autoRig((done, total) => {
      rigProgress.value = total > 0 ? Math.round((done / total) * 100) : 0;
    });
    hasSkeleton.value = true;
    rigged.value = true;
    skeletonOn.value = instance.isSkeletonVisible;
    orientationCorrected.value = instance.isOrientationCorrected;
    // 骨骼已进场景，刷新节点树
    store.setNodeTree(instance.sceneNodes);
    // 几何测量失败的部分会回退到模板比例，这里如实告知用户，便于判断绑骨质量
    const fallbackParts = [
      result.fit.torso ? '' : '躯干',
      result.fit.arms ? '' : '手臂',
      result.fit.legs ? '' : '腿部',
    ].filter(Boolean);
    store.toast(
      'success',
      `绑骨完成：${result.bones} 根骨骼 · ${result.vertices.toLocaleString('en-US')} 个顶点` +
        (result.orientation.note ? ` · ${result.orientation.note}` : '') +
        (fallbackParts.length > 0 ? ` · ${fallbackParts.join('/')}回退模板比例` : ''),
    );
    // 绑骨成功后才需要动画列表，懒加载避免白跑一次文件夹扫描
    void ensureAnimationList();
  } catch (err) {
    // 绑骨期间切换了素材：感受不到这次绑骨，静默忽略
    if (err instanceof ViewerCanceledError) return;
    store.toast('error', err instanceof Error ? err.message : '自动绑骨失败');
  } finally {
    rigging.value = false;
  }
}

/** 视口 / 侧栏的关节变化回调：把快照同步到侧栏（会话结束后存 null，面板回到 Add Armature） */
function onManualRigChange(snapshot: ManualRigSnapshot): void {
  manualSnapshot.value = snapshot.active ? snapshot : null;
  if (snapshot.active) rigPanelOpen.value = true;
}

/** 展开 / 收起 Auto-Rig 面板（收起不会丢弃已生成的参考骨） */
function toggleRigPanel(): void {
  if (!stats.value) return;
  rigPanelOpen.value = !rigPanelOpen.value;
}

/**
 * Add Armature：建一副空的参考骨架（基础 19 骨 + 双手各 15 根指骨）。
 * 对应 ARP 的第一步：生成骨架 → 用 Add Markers 放置标记 → Go!。
 */
function addArmature(): void {
  const instance = viewer.value;
  if (!instance || !stats.value || manualApplying.value) return;
  rigPanelOpen.value = true;
  try {
    // 已经在放标记时只补预览骨骼，不重置已放置的标记
    const existed = instance.isManualRigActive;
    const snapshot = existed ? instance.showManualRigBones() : instance.startManualRig({ guessMarkers: false });
    onManualRigChange(snapshot);
    store.toast(
      'info',
      existed ? '已生成参考骨架，已放置的标记保留' : '参考骨架已建：请在标记列表里逐个添加，或点「猜测全部标记」',
    );
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '生成参考骨失败');
  }
}

/** 旋转模型（ARP Smart 面板 Turn 按钮） */
function turnModel(degrees: number): void {
  viewer.value?.turnModel(degrees);
}

/** 修改选中参考骨的胶囊半径（ARP 的 radius，决定蒙皮影响范围） */
function onJointRadiusInput(name: string, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  viewer.value?.setManualRigRadius(name, value);
}

function toggleManualXRay(): void {
  const snapshot = manualSnapshot.value;
  if (!snapshot) return;
  viewer.value?.setManualRigXRay(!snapshot.xray);
}

function toggleManualBones(): void {
  const snapshot = manualSnapshot.value;
  if (!snapshot) return;
  viewer.value?.setManualRigBonesVisible(!snapshot.bonesVisible);
}

/** 删除参考骨（放弃这一步，模型回到未绑骨状态） */
function removeArmature(): void {
  const instance = viewer.value;
  if (!instance || !manualSnapshot.value) return;
  instance.cancelManualRig();
  store.toast('info', '已删除参考骨架');
}

/** 按当前关节完成绑定 */
async function applyManualRig(): Promise<void> {
  const instance = viewer.value;
  if (!instance || manualApplying.value) return;
  manualApplying.value = true;
  manualProgress.value = 0;
  riggingMode.value = 'manual';
  rigging.value = true;
  rigProgress.value = 0;
  try {
    const result = await instance.applyManualRig((done, total) => {
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      manualProgress.value = percent;
      rigProgress.value = percent;
    });
    hasSkeleton.value = true;
    rigged.value = true;
    skeletonOn.value = instance.isSkeletonVisible;
    store.setNodeTree(instance.sceneNodes);
    store.toast(
      'success',
      `手动绑骨完成：${result.bones} 根骨骼 · ${result.vertices.toLocaleString('en-US')} 个顶点`,
    );
    // 绑骨成功后才需要动画列表，懒加载避免白跑一次文件夹扫描
    void ensureAnimationList();
  } catch (err) {
    // 绑骨期间切换了素材：感受不到这次绑骨，静默忽略
    if (err instanceof ViewerCanceledError) return;
    store.toast('error', err instanceof Error ? err.message : '手动绑骨失败');
  } finally {
    manualApplying.value = false;
    rigging.value = false;
  }
}

/** 侧栏输入坐标（世界坐标） */
function onJointCoordInput(name: string, axis: number, event: Event): void {
  const instance = viewer.value;
  const info = selectedJoint.value;
  if (!instance || !info || info.name !== name) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  const next: [number, number, number] = [info.position[0], info.position[1], info.position[2]];
  next[axis] = value;
  instance.moveManualRigJoint(name, next);
}

function toggleManualFingers(): void {
  const instance = viewer.value;
  if (!instance || !manualSnapshot.value) return;
  instance.setManualRigFingersVisible(!manualSnapshot.value.fingersVisible);
}

/** Mirror 开关（放置左右标记时同步对侧） */
function toggleMirrorFlag(): void {
  const snapshot = manualSnapshot.value;
  if (!snapshot) return;
  viewer.value?.setManualRigMirror(!snapshot.mirror);
}

/** 恢复到进入绑骨时的初始关节 */
function resetManualRig(): void {
  viewer.value?.resetManualRig();
}

/** 单独纠正模型朝向（不依赖绑骨；已纠正时再点一次还原） */
function correctOrientation(): void {
  const instance = viewer.value;
  if (!instance || !stats.value) return;
  try {
    const fix = instance.correctOrientation();
    orientationCorrected.value = instance.isOrientationCorrected;
    if (fix.note) store.toast('success', fix.note);
    else if (fix.yaw === 0) store.toast('info', '模型朝向看起来就对了，无需调整');
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '纠正朝向失败');
  }
}

/** 骨骼连线显示开关（绑骨后或自带骨架的模型可用） */
function toggleSkeleton(): void {
  const instance = viewer.value;
  if (!instance) return;
  instance.setSkeletonVisible(!skeletonOn.value);
  skeletonOn.value = instance.isSkeletonVisible;
}

/** 导出绑定后的模型为 GLB（含骨架与蒙皮权重） */
async function exportRigged(): Promise<void> {
  const instance = viewer.value;
  if (!instance) return;
  try {
    // 导出的是绑定姿态的骨架：先停掉预览动画，避免把当前姿势烘进节点变换
    instance.stopRigAnimation();
    animPath.value = '';
    animPlaying.value = false;
    const baseName = (job.value?.name ?? 'model').replace(/[\\/:*?"<>|]/g, '_');
    await instance.exportGlb(`${baseName}-rigged.glb`);
  } catch (err) {
    store.toast('error', err instanceof Error ? err.message : '导出 GLB 失败');
  }
}

/**
 * 读取动画库文件列表（绑骨成功后懒加载一次）。
 * 文件夹缺失或为空时只在面板里给出提示，不影响绑骨本身。
 */
async function ensureAnimationList(): Promise<void> {
  if (animLoading.value || animFiles.value.length > 0) return;
  animLoading.value = true;
  animListError.value = null;
  try {
    const result = await animationApi.list();
    animFiles.value = result.files;
    if (result.files.length === 0) {
      animListError.value =
        result.missing.length > 0
          ? '动画库文件夹不存在，请到「动画」页重新添加'
          : '动画库为空，请到「动画」页添加 FBX 动画文件夹';
    }
  } catch (err) {
    animListError.value = err instanceof Error ? err.message : '读取动画库失败';
  } finally {
    animLoading.value = false;
  }
}

/** 切换素材 / 卸载模型时清空动画预览状态 */
function resetAnimationPreview(): void {
  animPath.value = '';
  animPlaying.value = false;
  animBusy.value = false;
  viewer.value?.stopRigAnimation();
}

/** 下拉框选择：空值 = 回到绑定姿态，其余加载 FBX 并重定向到绑骨骨架 */
async function onAnimChange(event: Event): Promise<void> {
  const instance = viewer.value;
  const path = (event.target as HTMLSelectElement).value;
  animPath.value = path;
  animPlaying.value = false;
  if (!instance) return;

  if (!path) {
    instance.stopRigAnimation();
    return;
  }

  const file = animFiles.value.find((item) => item.path === path);
  if (!file) return;

  animBusy.value = true;
  try {
    const applied = await instance.playRigAnimation(animationApi.fileUrl(file.path));
    // 连续切换时旧的一次加载会被新选择取代，这里不改状态
    if (!applied) return;
    animPlaying.value = instance.isRigAnimationPlaying;
  } catch (err) {
    animPath.value = '';
    instance.stopRigAnimation();
    store.toast('error', err instanceof Error ? err.message : '动画预览加载失败');
  } finally {
    animBusy.value = false;
  }
}

function toggleAnimPlay(): void {
  const instance = viewer.value;
  if (!instance || !animPath.value) return;
  instance.setRigAnimationPlaying(!animPlaying.value);
  animPlaying.value = instance.isRigAnimationPlaying;
}
</script>

<template>
  <section class="viewport">
    <div ref="containerRef" class="canvas-host" />

    <!-- 左上：当前素材信息 + 网格统计 -->
    <div v-if="stats || job" class="overlay overlay-stats">
      <div class="stats-title">
        <Icon name="cube" :size="13" />
        <span class="ellipsis">{{ job?.name ?? '未选择素材' }}</span>
      </div>
      <div v-if="stats" class="stats-grid">
        <div class="stat"><span class="stat-label">格式</span><span class="stat-value">{{ stats.format.toUpperCase() }}</span></div>
        <div class="stat"><span class="stat-label">三角面</span><span class="stat-value">{{ stats.triangles.toLocaleString('en-US') }}</span></div>
        <div class="stat"><span class="stat-label">顶点</span><span class="stat-value">{{ stats.vertices.toLocaleString('en-US') }}</span></div>
        <div class="stat"><span class="stat-label">网格</span><span class="stat-value">{{ stats.meshes }}</span></div>
        <div v-if="job?.asset?.creditConsumed" class="stat">
          <span class="stat-label">消耗积分</span><span class="stat-value">{{ job.asset.creditConsumed }}</span>
        </div>
      </div>
    </div>

    <!-- 右上：视图工具 -->
    <div class="overlay overlay-tools">
      <button
        class="tool"
        :class="{ active: store.wireframe }"
        type="button"
        title="线框叠加"
        :disabled="!stats"
        @click="store.wireframe = !store.wireframe"
      >
        <Icon name="grid" :size="15" />
      </button>
      <button
        class="tool"
        :class="{ active: store.showGrid }"
        type="button"
        title="显示网格地面"
        @click="store.showGrid = !store.showGrid"
      >
        <Icon name="layers" :size="15" />
      </button>
      <button
        class="tool"
        :class="{ active: store.autoRotate }"
        type="button"
        title="自动旋转"
        :disabled="!stats"
        @click="store.autoRotate = !store.autoRotate"
      >
        <Icon name="rotate" :size="15" />
      </button>
      <button class="tool" type="button" title="重置视角" :disabled="!stats" @click="viewer?.resetView()">
        <Icon name="refresh" :size="15" />
      </button>
      <button class="tool" type="button" title="全屏" @click="toggleFullscreen">
        <Icon name="maximize" :size="15" />
      </button>

      <!-- 绑骨相关：只在已加载模型时出现 -->
      <template v-if="stats">
        <div class="tool-divider" />
        <button
          class="tool"
          :class="{ active: orientationCorrected }"
          type="button"
          :title="orientationCorrected ? '还原模型原始朝向' : '自动纠正模型朝向（贴合人形 +Z 正面）'"
          @click="correctOrientation"
        >
          <Icon name="flip" :size="15" />
        </button>
        <button
          v-if="!hasSkeleton"
          class="tool"
          type="button"
          title="自动绑骨（自适应站姿，实验）"
          :disabled="rigging"
          @click="autoRig"
        >
          <Icon name="bone" :size="15" />
        </button>
        <button
          v-if="!hasSkeleton"
          class="tool"
          :class="{ active: rigPanelOpen }"
          type="button"
          title="Auto-Rig 手动绑骨（参考骨摆位 → Match to Rig）"
          :disabled="rigging"
          @click="toggleRigPanel"
        >
          <Icon name="pose" :size="15" />
        </button>
        <button
          v-if="hasSkeleton"
          class="tool"
          :class="{ active: skeletonOn }"
          type="button"
          title="显示 / 隐藏骨骼"
          @click="toggleSkeleton"
        >
          <Icon name="bone" :size="15" />
        </button>
        <button
          v-if="rigged"
          class="tool"
          type="button"
          title="导出绑定后的 GLB（含骨架与蒙皮）"
          @click="exportRigged"
        >
          <Icon name="download" :size="15" />
        </button>
      </template>
    </div>

    <!-- 生成中 / 失败提示 -->
    <div v-if="activeJob" class="overlay overlay-status">
      <div class="status-card">
        <div class="status-row">
          <Icon :name="activeJob.phase === 'queued' ? 'clock' : 'refresh'" :size="14" :class="{ spin: activeJob.phase !== 'queued' }" />
          <span class="status-text">{{ PHASE_TEXT[activeJob.phase] }}</span>
          <span class="mono faint">{{ activeJob.remoteJobId ? `JobId ${activeJob.remoteJobId}` : '等待提交' }}</span>
        </div>
        <div class="progress">
          <div class="progress-bar" :style="{ width: `${estimatedProgress}%` }" />
        </div>
        <div class="status-meta">
          <span>已耗时 {{ formatDuration(now - new Date(activeJob.startedAt ?? activeJob.createdAt).getTime()) }}</span>
          <span class="faint">进度为估算值，接口不返回百分比</span>
        </div>
      </div>
    </div>

    <div v-else-if="job?.phase === 'failed'" class="overlay overlay-status">
      <div class="status-card">
        <div class="status-row">
          <Icon name="alert" :size="14" />
          <span class="status-text">生成失败</span>
          <span class="mono faint">{{ job.errorCode }}</span>
        </div>
        <p class="status-error">{{ job.error }}</p>
        <button class="btn" type="button" @click="retry">
          <Icon name="refresh" :size="13" />
          重试
        </button>
      </div>
    </div>

    <!-- Auto-Rig Pro 风格 N 面板：Smart / Rig / Remap / Skin / Export 五个标签 -->
    <div v-if="rigPanelVisible" class="overlay overlay-arppanel">
      <div class="arp-card">
        <!-- 顶部标签栏（对齐 ARP 的 N 面板标签） -->
        <div class="arp-tabs">
          <button
            v-for="tab in ARP_TABS"
            :key="tab"
            class="arp-tab"
            :class="{ active: arpTab === tab }"
            type="button"
            @click="arpTab = tab"
          >
            {{ tab.charAt(0).toUpperCase() + tab.slice(1) }}
          </button>
          <button class="arp-close" type="button" title="收起面板" @click="rigPanelOpen = false">×</button>
        </div>

        <!-- ===================== Smart 标签 ===================== -->
        <div v-if="arpTab === 'smart'" class="arp-body">
          <!-- Setup 分组：选择对象 + 朝向旋转 -->
          <div class="arp-section">
            <button class="arp-section-head" type="button" @click="toggleArpSection('setup')">
              <span class="arp-caret" :class="{ open: !arpCollapsed.setup }">▸</span>
              <span>Setup</span>
            </button>
            <div v-show="!arpCollapsed.setup" class="arp-section-body">
              <div class="arp-row">
                <span class="arp-label">Selected</span>
                <span class="arp-value mono">{{ stats?.name?.slice(0, 16) ?? '—' }}</span>
              </div>
              <div class="arp-row">
                <span class="arp-label">BBox</span>
                <span class="arp-value mono">
                  {{ stats ? `${stats.bboxSize.toFixed(1)}` : '—' }}
                </span>
              </div>
              <div class="arp-turn">
                <button class="arp-turn-btn" type="button" title="左转 90°" @click="turnModel(-90)">⟲</button>
                <button class="arp-turn-btn" type="button" title="右转 90°" @click="turnModel(90)">⟳</button>
                <span class="arp-turn-label">Turn</span>
              </div>
            </div>
          </div>

          <!-- 标记预览 + 已选标记（对应 ARP 面板顶部的人形示意图） -->
          <div class="arp-marker-preview">
            <svg class="arp-figure" viewBox="0 0 60 100" aria-hidden="true">
              <circle class="arp-figure-head" cx="30" cy="10" r="6.5" />
              <path
                class="arp-figure-body"
                d="M30 17 L30 55 M30 26 L15 28 L8 40 L3 49 M30 26 L45 28 L52 40 L57 49 M30 55 L23 59 L21 80 L19 92 M30 55 L37 59 L39 80 L41 92 M19 92 L14 95 M41 92 L46 95"
              />
              <circle
                v-for="marker in MANUAL_MARKERS"
                :key="marker.joint"
                class="arp-figure-dot"
                :class="{
                  placed: placedMarkers.has(marker.joint),
                  active: manualSnapshot?.selected === marker.joint,
                }"
                :cx="figurePos(marker.joint).x"
                :cy="figurePos(marker.joint).y"
                r="2.2"
              />
            </svg>
            <div class="arp-marker-status">
              <span class="arp-marker-kicker">已选标记</span>
              <span class="arp-marker-name">{{ selectedMarker ? selectedMarker.label : '未选择' }}</span>
              <span v-if="selectedMarker" class="arp-marker-en mono">{{ selectedMarker.name }}</span>
              <span class="arp-marker-count mono">{{ placedMarkerCount }}/{{ MANUAL_MARKERS.length }}</span>
            </div>
          </div>

          <!-- 添加下一个标记 / 取消添加（ARP 的 Add Markers） -->
          <button v-if="manualSnapshot?.placing" class="arp-guess placing" type="button" @click="cancelMarkerPlacement">
            <Icon name="close" :size="12" />
            取消添加（{{ placingLabel }}）
          </button>
          <button
            v-else-if="nextMarker"
            class="arp-guess"
            type="button"
            :disabled="manualApplying"
            @click="startMarkerPlacement(nextMarker.joint)"
          >
            <Icon name="plus" :size="12" />
            添加{{ nextMarker.label }}
          </button>
          <button v-else class="arp-guess" type="button" disabled>
            <Icon name="check" :size="12" />
            标记已全部放置
          </button>
          <p v-if="manualSnapshot?.placing" class="arp-hint on">在模型上点击落点，Esc 取消</p>

          <!-- 猜测全部标记（几何拟合一次性放置） -->
          <button class="arp-guess ghost" type="button" :disabled="manualApplying" @click="guessMarkers">
            <Icon name="bone" :size="12" />
            猜测全部标记
          </button>

          <!-- Markers 分组：逐个添加 / 选中 -->
          <div class="arp-section">
            <button class="arp-section-head" type="button" @click="toggleArpSection('markers')">
              <span class="arp-caret" :class="{ open: !arpCollapsed.markers }">▸</span>
              <span>标记</span>
              <span class="arp-section-count">{{ placedMarkerCount }}/{{ MANUAL_MARKERS.length }}</span>
            </button>
            <div v-show="!arpCollapsed.markers" class="arp-section-body">
              <div class="arp-marker-list">
                <button
                  v-for="marker in MANUAL_MARKERS"
                  :key="marker.joint"
                  class="arp-marker-row"
                  :class="{
                    placed: placedMarkers.has(marker.joint),
                    active: manualSnapshot?.selected === marker.joint,
                    optional: !marker.required,
                  }"
                  type="button"
                  @click="pickArpMarker(marker.joint)"
                >
                  <span class="arp-marker-dot" />
                  <span class="arp-marker-row-label">{{ marker.label }}</span>
                  <span class="arp-marker-row-en mono">{{ marker.name }}</span>
                  <span class="arp-marker-row-action">{{ placedMarkers.has(marker.joint) ? '已放置' : '添加' }}</span>
                </button>
              </div>
              <p v-if="!manualSnapshot" class="arp-hint">点标记行的「添加」即可在视口落点，不会自动生成骨骼。</p>
            </div>
          </div>

          <!-- 标记选项（对齐 ARP Smart 面板的复选框） -->
          <label class="arp-check">
            <input
              type="checkbox"
              :checked="manualSnapshot?.mirror ?? false"
              :disabled="!manualSnapshot"
              @change="toggleMirror"
            />
            <span>镜像</span>
            <span class="arp-check-hint">左右标记同步落位</span>
          </label>
          <label class="arp-check">
            <input
              type="checkbox"
              :checked="manualSnapshot?.markerDepth ?? false"
              :disabled="!manualSnapshot"
              @change="toggleMarkerDepth"
            />
            <span>使用标记深度</span>
            <span class="arp-check-hint">贴到网格表面</span>
          </label>
          <div class="arp-mini-actions">
            <button class="arp-btn" type="button" :disabled="!manualSnapshot" @click="restoreLastMarkers">
              恢复上局标记
            </button>
            <button
              class="arp-btn"
              type="button"
              :disabled="!manualSnapshot?.placed.length"
              @click="removeMarkers"
            >
              取消和删除标记
            </button>
          </div>

          <!-- 骨骼设置（对齐 ARP 的预设 / 手指 / 骨段设置区） -->
          <div class="arp-section">
            <button class="arp-section-head" type="button" @click="toggleArpSection('settings')">
              <span class="arp-caret" :class="{ open: !arpCollapsed.settings }">▸</span>
              <span>骨骼设置</span>
              <span class="arp-section-count">ARP 默认</span>
            </button>
            <div v-show="!arpCollapsed.settings" class="arp-section-body">
              <div class="arp-row">
                <span class="arp-label">骨架预设</span>
                <span class="arp-value">ARP 默认</span>
              </div>
              <div class="arp-row">
                <span class="arp-label">手指</span>
                <span class="arp-value mono">{{ fingerCount }} 指 / 手</span>
              </div>
              <div class="arp-row">
                <span class="arp-label">手指粗细</span>
                <input
                  class="arp-range"
                  type="range"
                  min="0.4"
                  max="2.5"
                  step="0.05"
                  :value="manualSnapshot?.fingerScale ?? 1"
                  :disabled="!manualSnapshot"
                  @input="onFingerScaleInput"
                />
                <span class="arp-value mono">{{ (manualSnapshot?.fingerScale ?? 1).toFixed(2) }}</span>
              </div>
              <div class="arp-row">
                <span class="arp-label">脊椎 / 颈部</span>
                <span class="arp-value">2 段 / 1 段</span>
              </div>
              <p class="arp-hint">骨段数量固定为 19 骨结构，保证动画重定向与 GLB 导出兼容。</p>
            </div>
          </div>

          <!-- 显示选项 -->
          <div v-if="manualSnapshot" class="arp-toggles">
            <button class="arp-toggle" :class="{ on: manualSnapshot.xray }" type="button" @click="toggleManualXRay">
              X-Ray
            </button>
            <button class="arp-toggle" :class="{ on: manualSnapshot.bonesVisible }" type="button" @click="toggleManualBones">
              Bones
            </button>
            <button
              class="arp-toggle"
              :class="{ on: manualSnapshot.fingersVisible }"
              type="button"
              @click="toggleManualFingers"
            >
              Fingers
            </button>
            <button class="arp-toggle" :class="{ on: manualSnapshot.mirror }" type="button" @click="toggleMirrorFlag">
              Mirror
            </button>
            <button class="arp-toggle" type="button" @click="resetManualRig">Reset</button>
          </div>

          <!-- Go! 主按钮（= Match to Rig） -->
          <button
            class="arp-go"
            type="button"
            :disabled="!manualSnapshot?.canBuild || manualApplying"
            @click="applyManualRig"
          >
            <Icon name="check" :size="12" />
            Go!
          </button>
          <p v-if="manualSnapshot && !manualSnapshot.canBuild" class="arp-hint">
            还差必需标记：{{ manualSnapshot.missing.join('、') }}
          </p>
        </div>

        <!-- ===================== Rig 标签 ===================== -->
        <div v-else-if="arpTab === 'rig'" class="arp-body">
          <button class="arp-guess" type="button" @click="addArmature">
            <Icon name="bone" :size="12" />
            Add Armature
          </button>

          <div class="arp-row">
            <span class="arp-label">Rig type</span>
            <span class="arp-value">Human</span>
          </div>

          <div class="arp-row">
            <span class="arp-label">Mode</span>
            <span class="arp-value" :class="{ on: manualSnapshot }">
              {{ manualSnapshot ? 'Reference Bones' : 'Object Mode' }}
            </span>
          </div>

          <!-- 选中参考骨的属性 -->
          <div v-if="selectedJoint" class="arp-bone-props">
            <div class="arp-bone-head">
              <span class="mono">{{ selectedJoint.name }}</span>
              <span class="arp-tag">{{ selectedJoint.kind === 'bone' ? 'ref' : 'tip' }}</span>
            </div>
            <div v-if="selectedJoint.radius !== null" class="coord-row">
              <span class="coord-label">R</span>
              <input
                class="manual-range"
                type="range"
                :min="radiusMin"
                :max="radiusMax"
                :step="radiusStep"
                :value="selectedJoint.radius"
                @input="onJointRadiusInput(selectedJoint.name, $event)"
              />
              <input
                class="coord-input arp-radius-num"
                type="number"
                :step="coordStep"
                :value="selectedJoint.radius.toFixed(4)"
                @change="onJointRadiusInput(selectedJoint.name, $event)"
              />
            </div>
            <div v-for="axis in [0, 1, 2]" :key="axis" class="coord-row">
              <span class="coord-label">{{ ['X', 'Y', 'Z'][axis] }}</span>
              <input
                class="coord-input"
                type="number"
                :step="coordStep"
                :value="selectedJoint.position[axis].toFixed(4)"
                @change="onJointCoordInput(selectedJoint.name, axis, $event)"
              />
            </div>
          </div>
          <div v-else-if="manualSnapshot" class="arp-hint">在 Smart 标签的标记网格点选，或在视口里点标记球</div>
          <div v-else class="arp-hint">先点 Add Armature 生成参考骨</div>

          <!-- 显示选项 -->
          <div v-if="manualSnapshot" class="arp-toggles">
            <button class="arp-toggle" :class="{ on: manualSnapshot.xray }" type="button" @click="toggleManualXRay">X-Ray</button>
            <button class="arp-toggle" :class="{ on: manualSnapshot.bonesVisible }" type="button" @click="toggleManualBones">Bones</button>
            <button class="arp-toggle" :class="{ on: manualSnapshot.fingersVisible }" type="button" @click="toggleManualFingers">Fingers</button>
            <button class="arp-toggle" :class="{ on: manualSnapshot.mirror }" type="button" @click="toggleMirrorFlag">Mirror</button>
            <button class="arp-toggle" type="button" @click="resetManualRig">Reset</button>
          </div>

          <div v-if="manualSnapshot" class="arp-actions">
            <button class="arp-cancel" type="button" @click="removeArmature">Remove</button>
            <button class="arp-apply" type="button" :disabled="manualApplying" @click="applyManualRig">
              <Icon name="check" :size="12" />
              Match to Rig
            </button>
          </div>
        </div>

        <!-- ===================== 其余标签（占位，对齐 ARP 结构） ===================== -->
        <div v-else class="arp-body">
          <div class="arp-placeholder">
            <span class="arp-ph-title">{{ arpTab.charAt(0).toUpperCase() + arpTab.slice(1) }}</span>
            <p class="arp-hint">{{ arpTab === 'remap' ? '骨骼名称重映射与动作重定向' : arpTab === 'skin' ? '蒙皮绑定与权重平滑' : '导出 GLB / FBX' }}</p>
            <p class="arp-hint">此标签对应 Auto-Rig Pro 的同名模块，当前版本在完成绑骨后通过动画预览与导出按钮使用。</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 绑骨后的动画预览（左下角，避开底部居中的生成状态卡） -->
    <div v-if="rigged" class="overlay overlay-anim">
      <div class="anim-card">
        <div class="anim-head">
          <Icon name="film" :size="13" />
          <span>动画预览</span>
          <span v-if="animPlaying" class="anim-live">循环中</span>
        </div>
        <div v-if="animLoading" class="anim-note">
          <Icon name="refresh" :size="12" class="spin" />
          正在读取动画库…
        </div>
        <div v-else-if="animFiles.length === 0" class="anim-note">{{ animListError ?? '动画库为空' }}</div>
        <template v-else>
          <select class="anim-select" :value="animPath" :disabled="animBusy" @change="onAnimChange">
            <option value="">绑定姿态（无动画）</option>
            <optgroup v-for="group in animGroups" :key="group.label" :label="group.label">
              <option v-for="file in group.files" :key="file.path" :value="file.path">{{ file.name }}</option>
            </optgroup>
          </select>
          <div class="anim-row">
            <button class="anim-play" type="button" :disabled="!animPath || animBusy" @click="toggleAnimPlay">
              <Icon
                :name="animBusy ? 'refresh' : animPlaying ? 'pause' : 'play'"
                :size="12"
                :class="{ spin: animBusy }"
              />
              {{ animBusy ? '载入中' : animPlaying ? '暂停' : '播放' }}
            </button>
            <span class="anim-tip">{{ animPath ? (animPlaying ? '预览中' : '已暂停') : '选择动画预览骨骼' }}</span>
          </div>
        </template>
      </div>
    </div>

    <!-- 自动绑骨进度（放顶部，避开底部生成状态卡） -->
    <div v-if="rigging" class="overlay overlay-rigging">
      <div class="status-card">
        <div class="status-row">
          <Icon name="bone" :size="14" />
          <span class="status-text">{{ riggingLabel }}</span>
          <span class="mono faint">{{ rigProgress }}%</span>
        </div>
        <div class="progress">
          <div class="progress-bar" :style="{ width: `${rigProgress}%` }" />
        </div>
        <div class="status-meta">
          <span>{{ riggingNote }}</span>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!asset && !activeJob && !loading" class="overlay overlay-empty">
      <Icon name="cubeOutline" :size="42" />
      <p class="empty-title">工作区还没有模型</p>
      <p class="empty-hint">在左侧输入描述文字或上传参考图，点击「立即生成」开始</p>
    </div>

    <div v-if="loading" class="overlay overlay-empty">
      <Icon name="refresh" :size="30" class="spin" />
      <p class="empty-hint">正在载入模型…</p>
    </div>

    <div v-if="loadError" class="overlay overlay-error">
      <Icon name="alert" :size="14" />
      <span>{{ loadError }}</span>
    </div>

    <div v-if="stats" class="overlay overlay-hint">左键旋转 · 右键平移 · 滚轮缩放</div>
  </section>
</template>

<style scoped>
.viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  background: radial-gradient(circle at 50% 38%, #2a2d36 0%, #1b1d23 48%, #141519 100%);
  overflow: hidden;
}

.canvas-host {
  position: absolute;
  inset: 0;
}

.overlay {
  position: absolute;
  z-index: 2;
}

.overlay-stats {
  top: 14px;
  left: 14px;
  min-width: 168px;
  padding: 9px 11px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(8px);
}

.stats-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 7px;
  color: var(--text);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}

.stats-grid {
  display: grid;
  grid-template-columns: auto auto;
  gap: 3px 12px;
}

.stat {
  display: contents;
}

.stat-label {
  font-size: 11px;
  color: var(--text-faint);
}

.stat-value {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text);
  text-align: right;
}

.overlay-tools {
  top: 14px;
  right: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(8px);
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
}

.tool:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.tool.active {
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.tool:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}

/* 视图工具与绑骨工具之间的分隔线 */
.tool-divider {
  height: 1px;
  margin: 2px 4px;
  background: rgba(255, 255, 255, 0.08);
}

/* 绑骨进度放顶部居中，避开 bottom: 46px 的生成状态卡 */
.overlay-rigging {
  left: 50%;
  top: 64px;
  transform: translateX(-50%);
  width: min(360px, calc(100% - 40px));
}

.overlay-status {
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  width: min(420px, calc(100% - 40px));
}

.status-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
}

.status-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}

.status-text {
  font-weight: 600;
}

.status-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
  line-height: 1.5;
  word-break: break-word;
}

.progress {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-app);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), #59c2ff);
  transition: width 0.6s ease;
}

.status-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-dim);
}

.overlay-empty {
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-faint);
  pointer-events: none;
}

.empty-title {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--text-dim);
}

.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}

.overlay-error {
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: calc(100% - 40px);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: rgba(248, 113, 113, 0.16);
  border: 1px solid rgba(248, 113, 113, 0.4);
  color: #fecaca;
  font-size: 12px;
}

.overlay-hint {
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--text-faint);
  background: rgba(22, 23, 27, 0.6);
  padding: 4px 10px;
  border-radius: 999px;
  pointer-events: none;
}

/* 手动绑骨侧栏（右侧，与右上角工具栏并排） */
/* ========== Auto-Rig Pro 风格 N 面板 ========== */
.overlay-arppanel {
  top: 14px;
  right: 58px;
  width: min(280px, calc(100% - 72px));
  max-height: calc(100% - 28px);
  display: flex;
  z-index: 3;
}

.arp-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 100%;
  border-radius: var(--radius);
  background: rgba(20, 21, 25, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
  overflow: hidden;
}

/* 顶部标签栏（Smart / Rig / Remap / Skin / Export） */
.arp-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.2);
}

.arp-tab {
  flex: 1;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: color 0.12s, background 0.12s;
}

.arp-tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}

.arp-tab.active {
  color: var(--accent-hover);
  background: var(--accent-soft);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.arp-close {
  width: 22px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 14px;
  line-height: 1;
}

.arp-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}

.arp-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow-y: auto;
}

/* 可折叠分组（Blender N 面板的 section 风格） */
.arp-section {
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}

.arp-section-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
}

.arp-section-head:hover {
  background: rgba(255, 255, 255, 0.04);
}

.arp-caret {
  display: inline-block;
  width: 10px;
  color: var(--text-faint);
  font-size: 9px;
  transition: transform 0.12s;
}

.arp-caret.open {
  transform: rotate(90deg);
}

.arp-section-count {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  color: var(--accent-hover);
}

.arp-section-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.arp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
}

.arp-label {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.arp-value {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-dim);
}

.arp-value.on {
  color: var(--accent-hover);
}

/* Setup 区的 Turn 按钮 */
.arp-turn {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.arp-turn-btn {
  width: 24px;
  height: 22px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
  font-size: 14px;
  line-height: 1;
}

.arp-turn-btn:hover {
  border-color: var(--accent);
  color: var(--accent-hover);
}

.arp-turn-label {
  font-size: 10px;
  color: var(--text-faint);
}

/* Guess Markers / Add Armature 主按钮 */
.arp-guess {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}

.arp-guess:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent-hover);
}

.arp-guess:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Mirror 复选框 */
.arp-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text);
  cursor: pointer;
}

.arp-check input {
  accent-color: var(--accent);
}

.arp-check-hint {
  margin-left: auto;
  font-size: 9px;
  color: var(--text-faint);
}

/* 标记预览：人形示意图 + 已选标记（对应 ARP 面板顶部的标记状态图） */
.arp-marker-preview {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 10px;
  align-items: center;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.28);
}

.arp-figure {
  width: 64px;
  height: 104px;
  margin: 0 auto;
  display: block;
}

.arp-figure-head {
  fill: rgba(255, 255, 255, 0.1);
  stroke: rgba(255, 255, 255, 0.28);
  stroke-width: 0.8;
}

.arp-figure-body {
  fill: none;
  stroke: rgba(255, 255, 255, 0.22);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.arp-figure-dot {
  fill: rgba(255, 255, 255, 0.06);
  stroke: rgba(255, 255, 255, 0.26);
  stroke-width: 0.8;
}

.arp-figure-dot.placed {
  fill: #39d98a;
  stroke: #0b0c0e;
}

.arp-figure-dot.active {
  fill: #ffb54d;
  stroke: #ffb54d;
  stroke-width: 1.4;
}

.arp-marker-status {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.arp-marker-kicker {
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.arp-marker-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.arp-marker-en {
  font-size: 10px;
  color: var(--text-faint);
}

.arp-marker-count {
  margin-top: 2px;
  font-size: 10px;
  color: var(--accent-hover);
}

/* 标记列表：每行一个标记（绿点 = 已放置） */
.arp-marker-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 232px;
  overflow-y: auto;
}

.arp-marker-row {
  display: grid;
  grid-template-columns: 8px 1fr auto auto;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-dim);
  font-size: 11px;
  text-align: left;
}

.arp-marker-row:hover {
  background: rgba(255, 255, 255, 0.07);
  color: var(--text);
}

.arp-marker-row.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-hover);
}

.arp-marker-row.optional {
  opacity: 0.78;
}

.arp-marker-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
}

.arp-marker-row.placed .arp-marker-dot {
  background: #39d98a;
}

.arp-marker-row.active .arp-marker-dot {
  background: #ffb54d;
}

.arp-marker-row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arp-marker-row-en {
  font-size: 9px;
  color: var(--text-faint);
}

.arp-marker-row.placed .arp-marker-row-en {
  color: rgba(57, 217, 138, 0.75);
}

.arp-marker-row-action {
  font-size: 9px;
  color: var(--text-faint);
}

.arp-marker-row.placed .arp-marker-row-action {
  color: rgba(57, 217, 138, 0.9);
}

/* 添加中状态：主按钮变成「取消添加」 */
.arp-guess.placing {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-hover);
}

.arp-guess.ghost {
  height: 26px;
  background: transparent;
  color: var(--text-dim);
  font-weight: 500;
}

.arp-mini-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.arp-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--accent);
}

.arp-hint.on {
  color: var(--accent-hover);
}

.arp-hint {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-faint);
}

.arp-num {
  width: 36px;
  height: 22px;
  padding: 0 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
  font-family: var(--mono);
  font-size: 11px;
  text-align: center;
}

.arp-btn {
  height: 24px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 11px;
}

.arp-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent-hover);
}

.arp-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Go! 大按钮 */
.arp-go {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  margin-top: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #0b0c0e;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.arp-go:hover:not(:disabled) {
  filter: brightness(1.12);
}

.arp-go:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Rig 标签：选中参考骨的属性 */
.arp-bone-props {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.03);
}

.arp-bone-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text);
}

.arp-tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 9px;
  color: var(--text-faint);
}

.arp-radius-num {
  flex: 0 0 58px;
}

/* 显示选项 / 快捷操作 */
.arp-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.arp-toggle {
  height: 22px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  background: transparent;
  color: var(--text-faint);
  font-size: 10px;
}

.arp-toggle:hover {
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.2);
}

.arp-toggle.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-hover);
}

/* 底部操作区（Remove / Match to Rig） */
.arp-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.arp-cancel {
  flex: 1;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
}

.arp-cancel:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.arp-apply {
  flex: 1.5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #0b0c0e;
  font-size: 12px;
  font-weight: 600;
}

.arp-apply:hover:not(:disabled) {
  filter: brightness(1.12);
}

.arp-apply:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

/* 其余标签的占位 */
.arp-placeholder {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 10px;
}

.arp-ph-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

/* 坐标输入（Rig 标签内仍沿用） */
.coord-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.coord-label {
  width: 12px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
}

.coord-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm);
  background: var(--bg-app);
  color: var(--text);
  font-family: var(--mono);
  font-size: 11px;
}

.manual-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--accent);
}

/* 绑骨后的动画预览面板 */
.overlay-anim {
  left: 14px;
  bottom: 14px;
  width: min(268px, calc(100% - 28px));
}

.anim-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 11px;
  border-radius: var(--radius);
  background: rgba(22, 23, 27, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
}

.anim-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.anim-live {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  color: var(--accent-hover);
}

.anim-note {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-dim);
}

.anim-select {
  width: 100%;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: var(--bg-app);
  color: var(--text);
  font-size: 12px;
}

.anim-select:disabled {
  opacity: 0.5;
}

.anim-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.anim-play {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-hover);
  font-size: 11px;
  font-weight: 600;
}

.anim-play:hover:not(:disabled) {
  filter: brightness(1.12);
}

.anim-play:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.anim-tip {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
