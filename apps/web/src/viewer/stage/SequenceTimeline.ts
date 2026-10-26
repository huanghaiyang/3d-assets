import type { ResolvedSlot, SegmentDef, SegmentPose, SegmentTiming, TimelinePlan } from './StageTypes';

/**
 * 序列时间轴折算（纯函数）。
 *
 * 每段长度 = trimEnd - trimStart；与上一段的重叠量 blendIn 会被两段长度的一半约束，
 * 避免短片段被重叠吃掉。全局时间轴上的位置由 overlap 递推得到：
 *
 *   start[i] = i ? end[i-1] - blend[i] : 0
 *   end[i]   = start[i] + length[i]
 *   total    = end[last]
 */

const MIN_LENGTH = 0.05;
/** 段间换位时的移动速度（单位/秒）：站位差越大过渡窗口越长，避免一段距离在零点几秒内瞬移 */
const TRAVEL_SPEED = 1.6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 两段摆放的水平距离（缺省视为原地） */
function poseGap(from: SegmentDef['pose'], to: SegmentDef['pose']): number {
  const ax = from?.x ?? 0;
  const az = from?.z ?? 0;
  const bx = to?.x ?? 0;
  const bz = to?.z ?? 0;
  return Math.hypot(bx - ax, bz - az);
}

/** 平滑插值：交叉窗口内权重按 smoothstep 变化，避免线性淡入的观感突变 */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function buildTimeline(segments: readonly SegmentDef[]): TimelinePlan {
  const timings: SegmentTiming[] = [];
  let previousEnd = 0;
  let previousLength = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const trimStart = Number.isFinite(segment.trimStart) ? Math.max(0, segment.trimStart) : 0;
    const trimEnd = Number.isFinite(segment.trimEnd) ? Math.max(trimStart, segment.trimEnd) : trimStart;
    const length = Math.max(MIN_LENGTH, trimEnd - trimStart);
    const requested = Number.isFinite(segment.blendIn) ? Math.max(0, segment.blendIn) : 0;
    // 站位不同时按距离自动拉长交叉窗口，让身体走过去而不是瞬间滑过去
    const travel = index === 0 ? 0 : poseGap(segments[index - 1].pose, segment.pose) / TRAVEL_SPEED;
    const desired = Math.max(requested, travel);
    const blend = index === 0 ? 0 : Math.min(desired, length / 2, previousLength / 2);
    const start = index === 0 ? 0 : previousEnd - blend;
    const end = start + length;

    timings.push({ start, end, blend, length, trimStart });
    previousEnd = end;
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
