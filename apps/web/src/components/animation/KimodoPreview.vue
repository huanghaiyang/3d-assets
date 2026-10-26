<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import Icon from '../ui/Icon.vue';
import { kimodoApi, type KimodoStatusValue, type SomaSkeleton } from '@/api/kimodo';

const props = defineProps<{
  animationId: string;
  skeleton: SomaSkeleton | null;
  /** 当前选中任务的状态：queued / running 时动作文件还不存在，预览区显示 loading */
  jobStatus?: KimodoStatusValue | null;
  /** 生成进度（0~100），仅 running 时有意义 */
  progress?: number;
  /** 阶段文案（例如「扩散采样与动作解码」），排队时是排队提示 */
  stage?: string;
  /** 中间产物预览：直接给 root / rotations 数据，不再按 animationId 请求 motion 接口 */
  rootData?: Float32Array | null;
  rotationData?: Float32Array | null;
}>();

/** 外部传入的 f32 数据（中间产物面板用） */
const hasExternal = computed(
  () =>
    Boolean(props.rootData && props.rootData.length > 0) &&
    Boolean(props.rotationData && props.rotationData.length > 0),
);

/** 任务还在排队/生成中：还没有 .f32 结果，不要去请求 motion 接口 */
const generating = computed(() => props.jobStatus === 'queued' || props.jobStatus === 'running');
const generatingTitle = computed(() =>
  props.jobStatus === 'queued' ? '排队等待生成' : '正在生成动画',
);

const container = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const playing = ref(true);
const frame = ref(0);
const totalFrames = ref(0);

/** 每帧的局部旋转（XYZW），已展开成 Float32Array */
let rotations: Float32Array | null = null;
let rootPositions: Float32Array | null = null;
let joints: THREE.Object3D[] = [];
/** 线段对应的子关节索引（父关节从 skeleton.parents 取） */
let segmentJoints: number[] = [];
let lineGeometry: THREE.BufferGeometry | null = null;
let points: THREE.Points | null = null;
const worldVector = new THREE.Vector3();

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let rafId = 0;
let lastTime = 0;
/** 播放时钟（秒） */
let clock = 0;
const FPS = 30;

// 相机轨道参数（鼠标拖拽旋转、滚轮缩放）
let yaw = 0.35;
let pitch = 0.18;
let distance = 3.4;
/** 相机注视点：加载动作后按关节包围盒中心自动设置，保证人物居中 */
const cameraTarget = new THREE.Vector3(0, 1, 0);
let dragging = false;
let lastX = 0;
let lastY = 0;

function buildRig(skeleton: SomaSkeleton): void {
  const group = new THREE.Group();
  joints = skeleton.names.map(() => new THREE.Object3D());
  skeleton.names.forEach((_, index) => {
    const parent = skeleton.parents[index];
    const offset = skeleton.offsets[index] ?? [0, 0, 0];
    joints[index].position.set(offset[0], offset[1], offset[2]);
    if (parent >= 0) joints[parent].add(joints[index]);
    else group.add(joints[index]);
  });
  scene?.add(group);

  segmentJoints = [];
  for (let index = 0; index < skeleton.parents.length; index += 1) {
    if (skeleton.parents[index] >= 0) segmentJoints.push(index);
  }

  const lineBuffer = new Float32Array(segmentJoints.length * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(lineBuffer, 3));
  lineGeometry = geometry;
  scene?.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x7dd3fc })));

  const pointBuffer = new Float32Array(joints.length * 3);
  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(pointBuffer, 3));
  points = new THREE.Points(
    pointGeometry,
    new THREE.PointsMaterial({ color: 0xe2e8f0, size: 0.022, sizeAttenuation: true }),
  );
  scene?.add(points);
}

/** 应用第 index 帧的姿态，并把关节世界坐标写进线段缓冲 */
function applyFrame(index: number): void {
  if (!rotations || !rootPositions || !lineGeometry || !points) return;
  const jointCount = joints.length;
  for (let joint = 0; joint < jointCount; joint += 1) {
    const base = (index * jointCount + joint) * 4;
    joints[joint].quaternion.set(rotations[base], rotations[base + 1], rotations[base + 2], rotations[base + 3]);
  }
  joints[0].position.set(rootPositions[index * 3], rootPositions[index * 3 + 1], rootPositions[index * 3 + 2]);
  scene?.updateMatrixWorld(true);

  const pointArray = (points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  for (let joint = 0; joint < jointCount; joint += 1) {
    joints[joint].getWorldPosition(worldVector);
    pointArray[joint * 3] = worldVector.x;
    pointArray[joint * 3 + 1] = worldVector.y;
    pointArray[joint * 3 + 2] = worldVector.z;
  }
  (points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

  const lineAttribute = lineGeometry.getAttribute('position') as THREE.BufferAttribute;
  const lineArray = lineAttribute.array as Float32Array;
  let cursor = 0;
  for (const child of segmentJoints) {
    const parent = joints.length ? props.skeleton?.parents[child] ?? -1 : -1;
    // 起点：父关节；终点：子关节
    const from = parent >= 0 ? parent : child;
    lineArray[cursor] = pointArray[from * 3];
    lineArray[cursor + 1] = pointArray[from * 3 + 1];
    lineArray[cursor + 2] = pointArray[from * 3 + 2];
    lineArray[cursor + 3] = pointArray[child * 3];
    lineArray[cursor + 4] = pointArray[child * 3 + 1];
    lineArray[cursor + 5] = pointArray[child * 3 + 2];
    cursor += 6;
  }
  lineAttribute.needsUpdate = true;
}

/**
 * 按整段动作的关节包围盒调整相机注视点与距离，让骨架在视口里居中且完整可见。
 * 只抽样十几帧，避免 300 帧逐帧计算。
 */
function fitCamera(): void {
  if (!camera || joints.length === 0 || totalFrames.value === 0) return;
  const samples = Math.min(12, totalFrames.value);
  const box = new THREE.Box3();
  for (let sample = 0; sample < samples; sample += 1) {
    const index = samples === 1 ? 0 : Math.round(((totalFrames.value - 1) * sample) / (samples - 1));
    applyFrame(index);
    for (const joint of joints) {
      joint.getWorldPosition(worldVector);
      box.expandByPoint(worldVector);
    }
  }
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.5);
  // 45° 垂直视野：distance ≈ maxDim / (2·tan(22.5°)) · 余量
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const fitted = (maxDim / (2 * Math.tan(halfFov))) * 1.25;
  cameraTarget.set(center.x, center.y, center.z);
  distance = Math.min(9, Math.max(2.2, fitted));
}

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  const delta = lastTime ? (now - lastTime) / 1000 : 0;
  lastTime = now;
  if (playing.value && totalFrames.value > 0) {
    clock += delta;
    const index = Math.floor(clock * FPS) % totalFrames.value;
    if (index !== frame.value) {
      frame.value = index;
      applyFrame(index);
    }
  }

  if (!renderer || !scene || !camera) return;
  camera.position.set(
    cameraTarget.x + distance * Math.sin(yaw) * Math.cos(pitch),
    cameraTarget.y + distance * Math.sin(pitch),
    cameraTarget.z + distance * Math.cos(yaw) * Math.cos(pitch),
  );
  camera.lookAt(cameraTarget);
  renderer.render(scene, camera);
}

function setupScene(): void {
  if (!container.value) return;
  const width = container.value.clientWidth || 640;
  const height = container.value.clientHeight || 360;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.value.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f17);
  camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 100);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
  const grid = new THREE.GridHelper(6, 12, 0x1e293b, 0x111827);
  scene.add(grid);

  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    yaw -= (event.clientX - lastX) * 0.01;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + (event.clientY - lastY) * 0.01));
    lastX = event.clientX;
    lastY = event.clientY;
  });
  canvas.addEventListener('pointerup', (event) => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    distance = Math.max(1.2, Math.min(9, distance + Math.sign(event.deltaY) * 0.3));
  }, { passive: false });
}

/**
 * 抽屉是用 v-show 控制显隐的：关闭状态下容器尺寸为 0×0，
 * 打开时窗口本身不会触发 resize 事件，必须监听容器自身尺寸变化，
 * 否则 canvas 会停留在初始的兜底尺寸（宽高比错误），骨架看起来偏出画面。
 */
let resizeObserver: ResizeObserver | null = null;
/** 上一次观察到的容器宽度，用于判断「从隐藏变为可见」 */
let lastWidth = 0;

function resize(): void {
  if (!renderer || !camera || !container.value) return;
  const width = container.value.clientWidth;
  const height = container.value.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

/** 移除上一次的骨架（生成中/切换任务时先清空，避免旧动作留在画面里） */
function clearRig(): void {
  if (scene) {
    for (const child of [...scene.children]) {
      if (child instanceof THREE.LineSegments || child instanceof THREE.Points) {
        scene.remove(child);
        child.geometry.dispose();
      } else if (child instanceof THREE.Group) {
        scene.remove(child);
      }
    }
  }
  lineGeometry = null;
  points = null;
  joints = [];
  rotations = null;
  rootPositions = null;
  totalFrames.value = 0;
  frame.value = 0;
  clock = 0;
}

async function load(): Promise<void> {
  // 中间产物预览：数据由外部直接给出，不需要再请求接口
  if (hasExternal.value) {
    clearRig();
    loading.value = false;
    error.value = null;
    rotations = props.rotationData ?? null;
    rootPositions = props.rootData ?? null;
    totalFrames.value = rootPositions ? Math.floor(rootPositions.length / 3) : 0;
    if (totalFrames.value > 0 && props.skeleton) {
      buildRig(props.skeleton);
      fitCamera();
    }
    applyFrame(0);
    return;
  }
  if (!props.animationId || !props.skeleton) return;
  // 排队/生成中的任务还没有动作文件，直接展示 loading，不发起请求
  if (generating.value) {
    clearRig();
    error.value = null;
    loading.value = false;
    return;
  }
  if (props.jobStatus === 'failed') {
    clearRig();
    loading.value = false;
    error.value = props.stage ? `生成失败：${props.stage}` : '生成失败';
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const data = await kimodoApi.motion(props.animationId);
    clearRig();
    rotations = data.rotations;
    rootPositions = data.root;
    totalFrames.value = Math.floor(data.root.length / 3);
    if (totalFrames.value > 0) {
      buildRig(props.skeleton);
      fitCamera();
    }
    applyFrame(0);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

watch(() => props.animationId, load);
// 中间产物面板切换产物时直接换数据源
watch(() => [props.rootData, props.rotationData], () => void load());
watch(() => props.skeleton, (value) => {
  if (value) void load();
});
// 生成完成（ready）后自动加载动作；排队→生成中时清空画面并显示 loading
watch(
  () => props.jobStatus,
  (value) => {
    if (value === 'ready' || value === 'failed' || value === 'queued' || value === 'running') {
      void load();
    }
  },
);

onMounted(() => {
  setupScene();
  void load();
  window.addEventListener('resize', resize);
  // 抽屉展开/收起、窗口宽度变化都会改变容器尺寸，这里统一按真实尺寸校正画面
  if (container.value) {
    resizeObserver = new ResizeObserver(() => {
      const width = container.value?.clientWidth ?? 0;
      const height = container.value?.clientHeight ?? 0;
      if (!width || !height) {
        // 抽屉收起：记成 0，下次展开时重新拟合相机
        lastWidth = 0;
        return;
      }
      const wasHidden = lastWidth === 0;
      resize();
      // 只在「由隐藏变为可见」时重新拟合相机（让人物居中）；
      // 后续的普通缩放保留用户拖拽/滚轮调整过的视角与距离
      if (wasHidden) {
        fitCamera();
        applyFrame(frame.value);
      }
      lastWidth = width;
    });
    resizeObserver.observe(container.value);
  }
  rafId = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', resize);
  resizeObserver?.disconnect();
  resizeObserver = null;
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
  camera = null;
  joints = [];
});

function scrub(value: number): void {
  playing.value = false;
  frame.value = value;
  clock = value / FPS;
  applyFrame(value);
}
</script>

<template>
  <div class="preview">
    <div ref="container" class="canvas"></div>

    <!-- 排队/生成中：动作文件还不存在，用 loading 卡片占位，完成后自动切换成骨架预览 -->
    <div v-if="generating" class="hint">
      <div class="gen-card">
        <Icon name="refresh" :size="16" class="spin" />
        <div class="gen-body">
          <p class="gen-title">{{ generatingTitle }}</p>
          <p class="gen-sub">{{ stage || '任务开始后会自动载入预览' }}</p>
          <div v-if="jobStatus === 'running'" class="gen-track">
            <div class="gen-fill" :style="{ width: `${Math.min(100, Math.max(0, progress ?? 0))}%` }" />
          </div>
          <p v-if="jobStatus === 'running'" class="gen-percent mono">{{ Math.round(progress ?? 0) }}%</p>
        </div>
      </div>
    </div>
    <div v-else-if="loading" class="hint">
      <Icon name="refresh" :size="14" class="spin" /> 读取动作数据…
    </div>
    <div v-else-if="error" class="hint error">{{ error }}</div>
    <div v-else-if="!animationId && !hasExternal" class="hint">从左侧选一条已生成的动画查看预览</div>

    <div class="controls">
      <button class="btn btn-ghost btn-icon" type="button" :title="playing ? '暂停' : '播放'" @click="playing = !playing">
        <Icon :name="playing ? 'pause' : 'play'" :size="13" />
      </button>
      <input
        class="scrub"
        type="range"
        min="0"
        :max="Math.max(0, totalFrames - 1)"
        :value="frame"
        :disabled="!totalFrames"
        @input="scrub(Number(($event.target as HTMLInputElement).value))"
      />
      <span class="frame-text mono">{{ frame }}/{{ Math.max(0, totalFrames - 1) }}</span>
    </div>
  </div>
</template>

<style scoped>
.preview {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: #0b0f17;
}
.canvas {
  flex: 1;
  min-height: 0;
  cursor: grab;
}
.canvas :deep(canvas) {
  display: block;
}
.hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-dim);
  pointer-events: none;
}
.hint.error {
  color: var(--danger);
}
/* 生成中 loading 卡片：深色玻璃底，和 3D 视口区分开 */
.gen-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: min(420px, 82%);
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(15, 20, 30, 0.86);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
  color: var(--text);
}
.gen-body {
  flex: 1;
  min-width: 0;
  text-align: left;
}
.gen-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}
.gen-sub {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.5;
}
.gen-track {
  margin-top: 10px;
  height: 4px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
  overflow: hidden;
}
.gen-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--primary, #60a5fa);
  transition: width 0.4s ease;
}
.gen-percent {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-dim);
}
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}
.scrub {
  flex: 1;
  accent-color: var(--primary);
}
.frame-text {
  font-size: 11px;
  color: var(--text-dim);
  min-width: 64px;
  text-align: right;
}
.spin {
  animation: preview-spin 1s linear infinite;
}
@keyframes preview-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
