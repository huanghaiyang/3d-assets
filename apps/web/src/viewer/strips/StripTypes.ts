import type { SegmentSource } from '@/viewer/stage/StageTypes';

/** Strip 的动画来源与舞台片段共用同一套描述 */
export type StripSource = SegmentSource;

/**
 * 身体部位掩码：
 * full 全身（含髋部）、upper 上半身（脊柱/头颈/双臂）、lower 下半身（髋部/双腿）、
 * head 头颈、leftArm/rightArm 单臂、leftLeg/rightLeg 单腿。
 */
export type BodyPart =
  | 'full'
  | 'upper'
  | 'lower'
  | 'head'
  | 'leftArm'
  | 'rightArm'
  | 'leftLeg'
  | 'rightLeg';

export interface StripDef {
  id: string;
  name: string;
  source: StripSource;
  part: BodyPart;
  /** 时间轴起点（秒） */
  start: number;
  /** 片段内裁剪起点（秒） */
  trimStart: number;
  /** 时间轴上的时长（秒） */
  duration: number;
  /** 混合权重 0–1；多条叠加时总和超过 1 会自动归一 */
  weight: number;
  muted: boolean;
  /** 自定义标识色（#rrggbb）；缺省按序号生成 */
  color?: string;
}

export function stripEnd(strip: StripDef): number {
  return strip.start + strip.duration;
}

/** 片段在时间轴上的有效时长（不超过来源片段本身） */
export function stripClipTime(strip: StripDef, time: number, clipDuration: number): number {
  const local = strip.trimStart + (time - strip.start);
  const max = Math.max(0, clipDuration - 1e-4);
  return Math.min(Math.max(local, 0), max);
}

export function createStripId(): string {
  return `strip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
