import * as THREE from 'three';
import type { StageActor } from './StageActor';
import type { ResolvedSlot, TimelinePlan } from './StageTypes';

/**
 * 根位移对齐。
 *
 * 做法：建序列时预计算每个衔接边界的角色基准位移 `frames[i]`，运行时只做插值，
 * 绝不逐帧累加偏移——否则拖动进度条来回 scrub 会不断漂移。
 *
 * 位移对齐在「骨架局部空间」里完成：第 i 段结束时髋部相对该段起点的位移，
 * 必须等于第 i+1 段在交叉窗口结束处的位移。于是
 *
 *   frames[i] = frames[i-1] + (hips[i-1](end) - hips[i-1](0)) - (hips[i](blend) - hips[i](0))
 *
 * 这里刻意不累计边界处的偏航角差（原方案里的 dYaw）：髋部骨骼的旋转本身已经
 * 带动整个骨架转向，再把它加到根节点上会让角色在衔接处转向两倍角度。
 * 朝向的连续过渡由 crossfade 的骨骼权重混合自然完成。
 */

export interface RootFrame {
  x: number;
  z: number;
}

export interface RootAlignPlan {
  /** 每个片段起点处的基准位移 */
  frames: RootFrame[];
  /** 每个片段起点处的髋部位置，用于计算段内位移增量 */
  starts: RootFrame[];
}

const ZERO: RootFrame = { x: 0, z: 0 };

function sampleStart(actor: StageActor, clip: THREE.AnimationClip | null, time: number): RootFrame {
  if (!clip) return ZERO;
  const sample = actor.sampleHips(clip, time);
  return sample ? { x: sample.x, z: sample.z } : ZERO;
}

export function buildRootAlign(
  actor: StageActor,
  plan: TimelinePlan,
  clips: ReadonlyArray<THREE.AnimationClip | null>,
): RootAlignPlan {
  const starts: RootFrame[] = [];
  const frames: RootFrame[] = [];

  for (let index = 0; index < plan.timings.length; index += 1) {
    const timing = plan.timings[index];
    starts.push(sampleStart(actor, clips[index] ?? null, timing.trimStart));
  }

  frames.push({ x: 0, z: 0 });
  for (let index = 1; index < plan.timings.length; index += 1) {
    const previous = plan.timings[index - 1];
    const current = plan.timings[index];
    const previousClip = clips[index - 1] ?? null;
    const currentClip = clips[index] ?? null;
    const target = frames[index - 1];

    if (!previousClip || !currentClip) {
      frames.push({ x: target.x, z: target.z });
      continue;
    }

    const previousEnd = sampleStart(actor, previousClip, previous.trimStart + previous.length);
    const currentBlend = sampleStart(actor, currentClip, current.trimStart + current.blend);
    const previousStart = starts[index - 1];
    const currentStart = starts[index];

    frames.push({
      x: target.x + (previousEnd.x - previousStart.x) - (currentBlend.x - currentStart.x),
      z: target.z + (previousEnd.z - previousStart.z) - (currentBlend.z - currentStart.z),
    });
  }

  return { frames, starts };
}

function lerp(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}

/** 结合当前髋部位置，算出该时刻的运动组偏移 */
export function resolveRootOffset(
  align: RootAlignPlan,
  slots: readonly ResolvedSlot[],
  hips: { x: number; z: number },
): RootFrame {
  if (slots.length === 0) return ZERO;
  if (slots.length === 1) {
    const frame = align.frames[slots[0].index] ?? ZERO;
    const start = align.starts[slots[0].index] ?? ZERO;
    return { x: frame.x + hips.x - start.x, z: frame.z + hips.z - start.z };
  }

  const entering = slots[1];
  const weight = entering.weight;
  const frameA = align.frames[slots[0].index] ?? ZERO;
  const frameB = align.frames[entering.index] ?? ZERO;
  const startA = align.starts[slots[0].index] ?? ZERO;
  const startB = align.starts[entering.index] ?? ZERO;
  // 交叉窗口内：基准位移与段内增量都按权重混合，等价于两段各自轨迹的加权平均
  return {
    x: lerp(frameA.x, frameB.x, weight) + hips.x - lerp(startA.x, startB.x, weight),
    z: lerp(frameA.z, frameB.z, weight) + hips.z - lerp(startA.z, startB.z, weight),
  };
}
