import type { ResolvedSlot, SegmentDef, SegmentPose, SegmentTiming, TimelinePlan } from './StageTypes';

/**
 * 序列时间轴折算（纯函数）。
 *
 * 每段长度 = trimEnd - trimStart；全局起点优先取段上的显式 `start`（时间轴拖动/插入对齐后写死），
 * 缺省则紧跟上一段结束，因此新段默认首尾相接、没有额外提前量。
 * 段与段之间的交叉淡化窗口由「实际重叠」推导：
 *
 *   start[i] = segment.start ?? end[i-1]
 *   blend[i] = max(0, min(end[i-1] - start[i], length[i], length[i-1]))
 *   end[i]   = start[i] + length[i]
 *   total    = max(end[*])
 */

const MIN_LENGTH = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 平滑插值：交叉窗口内权重按 smoothstep 变化，避免线性淡入的观感突变 */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function buildTimeline(segments: readonly SegmentDef[]): TimelinePlan {
  const timings: SegmentTiming[] = [];
  let previousStart = 0;
  let previousEnd = 0;
  let previousLength = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const trimStart = Number.isFinite(segment.trimStart) ? Math.max(0, segment.trimStart) : 0;
    const trimEnd = Number.isFinite(segment.trimEnd) ? Math.max(trimStart, segment.trimEnd) : trimStart;
    const length = Math.max(MIN_LENGTH, trimEnd - trimStart);
    const explicit = Number.isFinite(segment.start) ? Math.max(0, segment.start as number) : null;
    const desired = explicit ?? (index === 0 ? 0 : previousEnd);
    // 时间轴必须单调递增：resolveTimeline 靠「起点 <= 当前时刻」定位片段，
    // 起点倒序会让定位错位，因此拖动时最左也只能压到上一段的起点。
    const start = index === 0 ? desired : Math.max(desired, previousStart);
    // 重叠量完全由实际摆放决定：往左压进上一段才有交叉淡化，默认首尾相接为硬切
    const blend = index === 0 ? 0 : Math.max(0, Math.min(previousEnd - start, length, previousLength));
    const end = start + length;

    timings.push({ start, end, blend, length, trimStart });
    previousStart = start;
    previousEnd = Math.max(previousEnd, end);
    previousLength = length;
  }

  return { timings, total: previousEnd };
}

/**
 * 解析某一时刻应该驱动哪些片段。
 * 返回值的 weight 之和恒等于 1（含首段、末段与 blend=0 的硬切）。
 */
export function resolveTimeline(plan: TimelinePlan, time: number): ResolvedSlot[] {
  if (plan.timings.length === 0) return [];

  const clamped = clamp(time, 0, plan.total);
  let index = 0;
  for (let cursor = plan.timings.length - 1; cursor >= 0; cursor -= 1) {
    if (clamped >= plan.timings[cursor].start) {
      index = cursor;
      break;
    }
  }

  const current = plan.timings[index];
  if (index > 0 && current.blend > 0 && clamped < current.start + current.blend) {
    const previous = plan.timings[index - 1];
    const entering = smoothstep((clamped - current.start) / current.blend);
    return [
      {
        index: index - 1,
        clipTime: previous.trimStart + clamp(clamped - previous.start, 0, previous.length),
        weight: 1 - entering,
      },
      {
        index,
        clipTime: current.trimStart + clamp(clamped - current.start, 0, current.length),
        weight: entering,
      },
    ];
  }

  return [
    {
      index,
      clipTime: current.trimStart + clamp(clamped - current.start, 0, current.length),
      weight: 1,
    },
  ];
}

const NO_POSE: SegmentPose = { x: 0, z: 0, yaw: 0 };

/** 最短路径角度插值（度/弧度均适用） */
function lerpAngle(from: number, to: number, t: number): number {
  const delta = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return from + delta * t;
}

/**
 * 解算当前时刻的段摆放（段偏移 + 朝向）。
 * 单段直接返回该段摆放；交叉窗口内按 slot 权重混合位置、按最短弧混合朝向，
 * 这样两段站位不同时也是平滑过去而不是瞬移。
 */
export function resolveSegmentPose(poses: readonly (SegmentPose | undefined)[], slots: readonly ResolvedSlot[]): SegmentPose {
  if (slots.length === 0) return NO_POSE;
  if (slots.length === 1) return poses[slots[0].index] ?? NO_POSE;

  const first = poses[slots[0].index] ?? NO_POSE;
  const second = poses[slots[1].index] ?? NO_POSE;
  const weight = slots[1].weight;
  return {
    x: first.x * (1 - weight) + second.x * weight,
    z: first.z * (1 - weight) + second.z * weight,
    yaw: lerpAngle(first.yaw, second.yaw, weight),
  };
}
