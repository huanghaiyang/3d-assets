<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import Icon from '../ui/Icon.vue';
import { kimodoApi, type SomaSkeleton } from '@/api/kimodo';

const props = defineProps<{ animationId: string; skeleton: SomaSkeleton | null }>();

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

function resize(): void {
  if (!renderer || !camera || !container.value) return;
  const width = container.value.clientWidth;
  const height = container.value.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

async function load(): Promise<void> {
  if (!props.animationId || !props.skeleton) return;
  loading.value = true;
  error.value = null;
  try {
    const data = await kimodoApi.motion(props.animationId);
    rotations = data.rotations;
    rootPositions = data.root;
    totalFrames.value = Math.floor(data.root.length / 3);
    frame.value = 0;
    clock = 0;

    // 清掉上一次的骨架
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
watch(() => props.skeleton, (value) => {
  if (value) void load();
});

onMounted(() => {
  setupScene();
  void load();
  window.addEventListener('resize', resize);
  rafId = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', resize);
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

    <div v-if="loading" class="hint">
      <Icon name="refresh" :size="14" class="spin" /> 读取动作数据…
    </div>
    <div v-else-if="error" class="hint error">{{ error }}</div>
    <div v-else-if="!animationId" class="hint">从左侧选一条已生成的动画查看预览</div>

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
