<script lang="ts">
import { kimodoApi } from '@/api/kimodo';

/**
 * 同一条 Kimodo 动作可能同时被多张缩略图请求：
 * 模块级缓存让它们共享一次 fetch，避免挑选面板一次发出上百个请求。
 */
const motionCache = new Map<string, Promise<{ root: Float32Array; rotations: Float32Array }>>();

function kimodoMotion(id: string): Promise<{ root: Float32Array; rotations: Float32Array }> {
  const cached = motionCache.get(id);
  if (cached) return cached;
  const pending = kimodoApi.motion(id);
  motionCache.set(id, pending);
  pending.catch(() => motionCache.delete(id));
  return pending;
}
</script>

<script setup lang="ts">
import { onMounted, ref, shallowRef, watch } from 'vue';
import * as THREE from 'three';
import type { SomaSkeleton } from '@/api/kimodo';

/**
 * 静态动作缩略图：把 Kimodo 的 root / rotations f32 做一次正向前向计算，
 * 用 2D canvas 画出骨架（3/4 视角）或根轨迹（俯视），用于挑选动画时展示封面。
 */
const props = withDefaults(
  defineProps<{
    skeleton?: SomaSkeleton | null;
    /** 直接给动作 id 时组件自己拉 f32 */
    animationId?: string;
    /** 也可以由外部传入已有数据（中间产物面板复用） */
    root?: Float32Array | null;
    rotations?: Float32Array | null;
    /** skeleton=骨架，trajectory=根位置轨迹 */
    mode?: 'skeleton' | 'trajectory';
    /** 取第几帧，0~1 相对位置 */
    position?: number;
    size?: number;
  }>(),
  { position: 0.35, mode: 'skeleton', size: 44 },
);

const canvas = ref<HTMLCanvasElement | null>(null);
const rootData = shallowRef<Float32Array | null>(null);
const rotationData = shallowRef<Float32Array | null>(null);
let loadToken = 0;

/** 构建与 KimodoPreview 一致的关节树，只用来算世界坐标 */
function buildJoints(skeleton: SomaSkeleton): { group: THREE.Group; joints: THREE.Object3D[] } {
  const group = new THREE.Group();
  const joints = skeleton.names.map(() => new THREE.Object3D());
  skeleton.names.forEach((_, index) => {
    const parent = skeleton.parents[index];
    const offset = skeleton.offsets[index] ?? [0, 0, 0];
    joints[index].position.set(offset[0], offset[1], offset[2]);
    if (parent >= 0) joints[parent].add(joints[index]);
    else group.add(joints[index]);
  });
  return { group, joints };
}

/** 计算某一帧所有关节的世界坐标（x/y/z 三元组） */
function poseAt(
  group: THREE.Group,
  joints: THREE.Object3D[],
  rotations: Float32Array,
  root: Float32Array,
  frames: number,
  index: number,
): number[] {
  const count = joints.length;
  for (let joint = 0; joint < count; joint += 1) {
    const base = (index * count + joint) * 4;
    joints[joint].quaternion.set(
      rotations[base],
      rotations[base + 1],
      rotations[base + 2],
      rotations[base + 3],
    );
  }
  // root 关节的位置就是整段动作的根位置
  joints[0].position.set(root[index * 3], root[index * 3 + 1], root[index * 3 + 2]);
  group.updateMatrixWorld(true);
  const out: number[] = [];
  const vector = new THREE.Vector3();
  for (let joint = 0; joint < count; joint += 1) {
    joints[joint].getWorldPosition(vector);
    out.push(vector.x, vector.y, vector.z);
  }
  // frames 未用到时保持签名一致，方便后续扩展
  void frames;
  return out;
}

/** 3/4 视角的水平投影：x 轴略微带一点 z，避免正视图完全重合成一根线 */
const VIEW_YAW = 0.42;

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  skeleton: SomaSkeleton,
  rotations: Float32Array,
  root: Float32Array,
): void {
  const count = skeleton.names.length;
  const frames = Math.floor(Math.min(root.length / 3, rotations.length / (count * 4)));
  if (!frames || count === 0) return;

  const { group, joints } = buildJoints(skeleton);
  const samples = Math.min(10, frames);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let sample = 0; sample < samples; sample += 1) {
    const index = samples === 1 ? 0 : Math.round(((frames - 1) * sample) / (samples - 1));
    const points = poseAt(group, joints, rotations, root, frames, index);
    for (let joint = 0; joint < count; joint += 1) {
      const sx = points[joint * 3] * Math.cos(VIEW_YAW) + points[joint * 3 + 2] * Math.sin(VIEW_YAW);
      const sy = points[joint * 3 + 1];
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

  const width = Math.max(maxX - minX, 0.2);
  const height = Math.max(maxY - minY, 0.2);
  const area = props.size;
  const scale = Math.min((area * 0.8) / width, (area * 0.84) / height);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const toX = (x: number) => area / 2 + (x - centerX) * scale;
  const toY = (y: number) => area / 2 - (y - centerY) * scale;

  const index = Math.min(frames - 1, Math.max(0, Math.round((frames - 1) * props.position)));
  const points = poseAt(group, joints, rotations, root, frames, index);

  ctx.lineWidth = Math.max(1, area / 34);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.92)';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let joint = 0; joint < count; joint += 1) {
    const parent = skeleton.parents[joint];
    if (parent < 0) continue;
    ctx.moveTo(toX(points[parent * 3] * Math.cos(VIEW_YAW) + points[parent * 3 + 2] * Math.sin(VIEW_YAW)), toY(points[parent * 3 + 1]));
    ctx.lineTo(toX(points[joint * 3] * Math.cos(VIEW_YAW) + points[joint * 3 + 2] * Math.sin(VIEW_YAW)), toY(points[joint * 3 + 1]));
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)';
  const radius = Math.max(0.9, area / 48);
  for (let joint = 0; joint < count; joint += 1) {
    const x = toX(points[joint * 3] * Math.cos(VIEW_YAW) + points[joint * 3 + 2] * Math.sin(VIEW_YAW));
    const y = toY(points[joint * 3 + 1]);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTrajectory(ctx: CanvasRenderingContext2D, root: Float32Array): void {
  const frames = Math.floor(root.length / 3);
  if (frames < 1) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < frames; index += 1) {
    const x = root[index * 3];
    const z = root[index * 3 + 2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const width = Math.max(maxX - minX, 0.2);
  const height = Math.max(maxZ - minZ, 0.2);
  const area = props.size;
  const scale = Math.min((area * 0.78) / width, (area * 0.78) / height);
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const toX = (x: number) => area / 2 + (x - centerX) * scale;
  // 俯视图：+Z 向下，和舞台的 X/Z 方向一致
  const toY = (z: number) => area / 2 + (z - centerZ) * scale;

  ctx.lineWidth = Math.max(1.2, area / 30);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.85)';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let index = 0; index < frames; index += 1) {
    const x = toX(root[index * 3]);
    const y = toY(root[index * 3 + 2]);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const dot = (x: number, y: number, color: string, radius: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  dot(toX(root[0]), toY(root[2]), '#34d399', Math.max(2, area / 20));
  const last = (frames - 1) * 3;
  dot(toX(root[last]), toY(root[last + 2]), '#fbbf24', Math.max(2, area / 20));
}

function draw(): void {
  const element = canvas.value;
  if (!element) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const area = props.size;
  element.width = Math.round(area * dpr);
  element.height = Math.round(area * dpr);
  const ctx = element.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, area, area);

  const root = rootData.value;
  if (!root || root.length === 0) return;

  if (props.mode === 'trajectory') {
    drawTrajectory(ctx, root);
    return;
  }
  const rotations = rotationData.value;
  if (!rotations || !props.skeleton) return;
  drawSkeleton(ctx, props.skeleton, rotations, root);
}

async function load(): Promise<void> {
  const token = ++loadToken;
  if (props.root && props.root.length > 0) {
    rootData.value = props.root;
    rotationData.value = props.rotations ?? null;
    draw();
    return;
  }
  rootData.value = null;
  rotationData.value = null;
  if (!props.animationId) {
    draw();
    return;
  }
  try {
    const data = await kimodoMotion(props.animationId);
    if (token !== loadToken) return;
    if (props.rotations && props.rotations.length > 0) {
      rootData.value = data.root;
      rotationData.value = props.rotations;
    } else {
      rootData.value = data.root;
      rotationData.value = data.rotations;
    }
    draw();
  } catch {
    if (token === loadToken) draw();
  }
}

onMounted(draw);
watch(
  () => [props.animationId, props.root, props.rotations, props.skeleton, props.mode, props.position],
  load,
  { immediate: true },
);
</script>

<template>
  <canvas ref="canvas" class="motion-thumb" :style="{ width: `${size}px`, height: `${size}px` }" />
</template>

<style scoped>
.motion-thumb {
  display: block;
  flex: none;
  border-radius: var(--radius-sm);
  background: #171922;
}
</style>
