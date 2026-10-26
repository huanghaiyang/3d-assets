import * as THREE from 'three';
import type { StageActor } from './StageActor';
import type { ResolvedSlot, TimelinePlan } from './StageTypes';

/**
 * 根位移对齐。
 *
 * 做法：建序列时预计算每个片段起点的基准位移 `frames[i]`，运行时只做插值，
 * 绝不逐帧累加偏移——否则拖动进度条来回 scrub 会不断漂移。
 *
 * 关键前提：片段自身的根轨（髋部 position 轨）已经把角色在本段内平移了，
 * 所以 `frames[i]` 只负责「把第 i 段接到第 i-1 段走完的位置上」：
 *
 *   frames[i] = frames[i-1] + (hips[i-1](end) - hips[i-1](start))
 *
 * 但这个累加只对「没手动摆过站位」的段生效。`anchored[i]` 为真的段（用户拖过它的
 * 起始残影，`pose` 已显式设置）基准偏移归零，位置完全由 `pose` 决定——
 * 否则在它前面插入/删除一段，会把前面几段的根位移继续累加过来，
 * 让它连同后面所有段整体平移出去（生成过渡动画后「下一段被位移」就是这么来的）。
 *
 * 校准时不能再用髋部位置去驱动运动节点(`motion`)：根轨本身已经让角色动了一次，
 * 再叠加一遍 `hips - start` 会让实际位移变成 2 倍，直接冲出路径曲线(path)的范围，
 * 段与段的衔接处也会错位。
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
  anchored: ReadonlyArray<boolean>,
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
    const previousClip = clips[index - 1] ?? null;
    const currentClip = clips[index] ?? null;
    const target = frames[index - 1];

    // 手动摆放过站位的段以 pose 为准，基准偏移归零：
    // 否则插入/删除一段会把前面几段的根位移继续累加过来，把这段连同其后所有段整体平移。
    if (anchored[index]) {
      frames.push({ x: 0, z: 0 });
      continue;
    }

    if (!previousClip || !currentClip) {
      frames.push({ x: target.x, z: target.z });
      continue;
    }

    const previousEnd = sampleStart(actor, previousClip, previous.trimStart + previous.length);
    const previousStart = starts[index - 1];

    frames.push({
      x: target.x + (previousEnd.x - previousStart.x),
      z: target.z + (previousEnd.z - previousStart.z),
    });
  }

  return { frames, starts };
}

function lerp(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}

/**
 * 算出该时刻运动组(`motion`)的基准偏移。
 *
 * 只返回 `frames[i]`（把该段接到前一段走完的位置上），不再叠加上髋部位置：
 * 髋部位置是片段根轨自己算出来的位移，骨架已经在动，再叠一次就是 2 倍。
 */
export function resolveRootOffset(align: RootAlignPlan, slots: readonly ResolvedSlot[]): RootFrame {
  if (slots.length === 0) return ZERO;
  const frameA = align.frames[slots[0].index] ?? ZERO;
  if (slots.length === 1) return { x: frameA.x, z: frameA.z };

  // 交叉窗口内两段的基准偏移按权重混合，等价于两条轨迹的加权平均
  const entering = slots[1];
  const frameB = align.frames[entering.index] ?? ZERO;
  return {
    x: lerp(frameA.x, frameB.x, entering.weight),
    z: lerp(frameA.z, frameB.z, entering.weight),
  };
}
