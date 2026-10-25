import type { FingerPosePreset, FingerSide } from '@/api/animation';
import type {
  AnimationClipData,
  AnimationData,
  AnimationTrackData,
} from '@/viewer/FbxPlayer';

/**
 * 把形态库里的手型写入当前片段的「手指骨」轨道。
 *
 * - 只改手指骨（Thumb/Index/Middle/Ring/Pinky 1–4），不碰腕关节、其它骨骼和 Kimodo 数据；
 * - 支持时间轴区间：区间内是选中的手型，区间外保留原轨道值（原本没有轨道时回到绑定姿态）；
 * - 左右手可以分别应用不同形态。
 */

export interface FingerApplyTarget {
  side: FingerSide;
  preset: FingerPosePreset;
}

export interface FingerApplyResult {
  data: AnimationData;
  /** 写入后整个数据的轨道总数 */
  trackCount: number;
  /** 实际匹配并写入的骨骼数 */
  bones: number;
}

type Quat = [number, number, number, number];

const EPS = 1e-4;
const SWITCH_EPS = 0.01;

function canonicalBone(raw: string): string {
  return raw
    .replace(/^mixamorig[:_]?/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function asQuat(raw: number[] | undefined): Quat {
  if (!raw || raw.length < 4) return [0, 0, 0, 1];
  const length = Math.hypot(raw[0]!, raw[1]!, raw[2]!, raw[3]!) || 1;
  return [raw[0]! / length, raw[1]! / length, raw[2]! / length, raw[3]! / length];
}

function dotted(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function slerp(a: Quat, b: Quat, alpha: number): Quat {
  let cos = dotted(a, b);
  let target = b;
  if (cos < 0) {
    cos = -cos;
    target = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (cos > 0.9995) {
    const result: Quat = [0, 0, 0, 1];
    for (let index = 0; index < 4; index += 1) {
      result[index] = a[index]! + (target[index]! - a[index]!) * alpha;
    }
    return asQuat(result);
  }
  const theta = Math.acos(Math.min(1, cos));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - alpha) * theta) / sinTheta;
  const wb = Math.sin(alpha * theta) / sinTheta;
  return asQuat([
    a[0] * wa + target[0] * wb,
    a[1] * wa + target[1] * wb,
    a[2] * wa + target[2] * wb,
    a[3] * wa + target[3] * wb,
  ]);
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function trackBoneKey(track: AnimationTrackData): string | null {
  const raw = track.joint ?? track.name.split('.')[0];
  return raw ? canonicalBone(raw) : null;
}

function isQuaternionTrack(track: AnimationTrackData): boolean {
  return track.property === 'quaternion' || track.name.endsWith('.quaternion');
}

/** 从既有轨道里取任意时刻的四元数（用 slerp，避免手型边界跳变） */
function sampleValues(track: AnimationTrackData, time: number): Quat {
  const times = track.times;
  const values = track.values;
  if (!times || !values || times.length === 0) return [0, 0, 0, 1];
  if (time <= times[0]!) return asQuat(values.slice(0, 4));
  const last = times.length - 1;
  if (time >= times[last]!) return asQuat(values.slice(last * 4, last * 4 + 4));

  let low = 0;
  let high = last;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (times[mid]! <= time) low = mid;
    else high = mid;
  }
  const span = times[high]! - times[low]!;
  const alpha = span > 0 ? (time - times[low]!) / span : 0;
  return slerp(
    asQuat(values.slice(low * 4, low * 4 + 4)),
    asQuat(values.slice(high * 4, high * 4 + 4)),
    alpha,
  );
}

function jointIndex(data: AnimationData): Map<string, { name: string; rest: Quat }> {
  const map = new Map<string, { name: string; rest: Quat }>();
  for (const joint of data.skeleton?.joints ?? []) {
    map.set(canonicalBone(joint.name), {
      name: joint.name,
      rest: asQuat(joint.rest?.rotation),
    });
  }
  return map;
}

function trackInterval(track: AnimationTrackData): number | null {
  if (track.interval && track.interval > 0) return track.interval;
  const times = track.times;
  if (!times || times.length < 2) return null;
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap > EPS) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

/** 合并时间点并去掉重复值（保留第一次出现的位置） */
function mergeTimes(groups: number[][]): number[] {
  const map = new Map<string, number>();
  for (const group of groups) {
    for (const time of group) {
      if (!Number.isFinite(time)) continue;
      const key = String(round(time, 5));
      if (!map.has(key)) map.set(key, round(time, 6));
    }
  }
  return [...map.values()].sort((a, b) => a - b);
}

interface BuiltTrack {
  times: number[];
  values: number[];
}

/**
 * 生成一条在 [from,to] 内为手型、区间外保持原值的轨道。
 * 原本没有轨道时，区间外使用绑定姿态（手指伸直）。
 */
function buildFingerTrack(
  existing: AnimationTrackData | null,
  presetQuat: Quat,
  restQuat: Quat,
  from: number,
  to: number,
  duration: number,
): BuiltTrack {
  const switchEpsilon = Math.min(SWITCH_EPS, Math.max(EPS, (to - from) / 4));
  const extraTimes = [from, to];
  if (from > switchEpsilon + EPS) extraTimes.push(from - switchEpsilon);
  if (to < duration - switchEpsilon - EPS) extraTimes.push(to + switchEpsilon);

  const baseTimes = existing?.times?.length ? existing.times : [0, duration];
  const times = mergeTimes([baseTimes, extraTimes]);
  if (times.length === 0) times.push(0);

  const values: number[] = [];
  for (const time of times) {
    const inside = time >= from - EPS && time <= to + EPS;
    const quat = inside ? presetQuat : existing ? sampleValues(existing, time) : restQuat;
    values.push(round(quat[0], 7), round(quat[1], 7), round(quat[2], 7), round(quat[3], 7));
  }

  // 相邻关键帧的四元数符号保持一致，避免插值时出现绕远路的翻转
  let previous: Quat | null = null;
  for (let index = 0; index < values.length; index += 4) {
    let current: Quat = [values[index]!, values[index + 1]!, values[index + 2]!, values[index + 3]!];
    current = asQuat(current);
    if (previous && dotted(previous, current) < 0) {
      current = [-current[0], -current[1], -current[2], -current[3]];
    }
    values[index] = round(current[0], 7);
    values[index + 1] = round(current[1], 7);
    values[index + 2] = round(current[2], 7);
    values[index + 3] = round(current[3], 7);
    previous = current;
  }

  return {
    times: times.map((time) => round(time, 6)),
    values,
  };
}

function makeTrack(name: string, built: BuiltTrack, interval: number): AnimationTrackData {
  const times = built.times;
  return {
    name: `${name}.quaternion`,
    joint: name,
    property: 'quaternion',
    valueType: 'quaternion',
    valueSize: 4,
    keyframes: times.length,
    timeRange: [times[0] ?? 0, times[times.length - 1] ?? 0],
    interval: interval > 0 ? interval : 1 / 30,
    interpolation: 'LINEAR',
    times,
    values: built.values,
  };
}

/**
 * 应用左右手形态；返回新的动画数据（原数据不被修改）。
 */
export function applyFingerPoses(
  data: AnimationData,
  clipIndex: number,
  targets: FingerApplyTarget[],
  rangeStart: number,
  rangeEnd: number,
): FingerApplyResult {
  const next = structuredClone(data);
  const clip: AnimationClipData | undefined = next.clips[clipIndex];
  if (!clip) throw new Error('当前片段不存在');

  const duration = Number.isFinite(clip.duration) ? Math.max(0, clip.duration) : 0;
  if (duration <= 0) throw new Error('当前片段没有可用的时间轴');

  const from = Math.min(Math.max(0, Math.min(rangeStart, rangeEnd)), duration);
  const to = Math.min(Math.max(0, Math.max(rangeStart, rangeEnd)), duration);
  if (to - from < 1e-3) throw new Error('替换区间太短，请拉大起止时间');

  const joints = jointIndex(next);
  const interval = clip.interval ?? next.timeline?.interval ?? 1 / 30;
  let written = 0;

  for (const target of targets) {
    for (const [rawBone, rawQuat] of Object.entries(target.preset.bones)) {
      const info = joints.get(canonicalBone(rawBone));
      if (!info) continue;

      const boneKey = canonicalBone(info.name);
      const kept: AnimationTrackData[] = [];
      let existing: AnimationTrackData | null = null;
      for (const track of clip.tracks) {
        if (trackBoneKey(track) === boneKey && isQuaternionTrack(track)) {
          if (!existing) existing = track;
          continue;
        }
        kept.push(track);
      }
      clip.tracks = kept;

      const boneInterval = (existing ? trackInterval(existing) : null) ?? interval;
      const built = buildFingerTrack(
        existing,
        asQuat(rawQuat),
        info.rest,
        from,
        to,
        duration,
      );
      clip.tracks.push(makeTrack(info.name, built, boneInterval));
      written += 1;
    }
  }

  if (written === 0) {
    throw new Error('形态库的骨骼名与当前模型不匹配，未写入任何手指骨');
  }

  clip.keyframes = clip.tracks.reduce(
    (sum, track) => sum + (track.keyframes || track.times?.length || 0),
    0,
  );
  next.timeline.clipCount = next.clips.length;
  next.timeline.totalDuration = next.clips.reduce((sum, item) => sum + (item.duration || 0), 0);
  next.timeline.longestDuration = Math.max(0, ...next.clips.map((item) => item.duration || 0));

  const trackCount = next.clips.reduce((sum, item) => sum + item.tracks.length, 0);
  return { data: next, trackCount, bones: written };
}
