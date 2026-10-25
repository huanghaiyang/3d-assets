import fs from 'node:fs/promises';
import path from 'node:path';
import { cacheDir } from '../lib/paths.js';
import { createLogger } from '../lib/logger.js';

/**
 * 手指形态库：从现有的 Mixamo 动画缓存里采样、去重，得到一批可复用的手型。
 *
 * 数据来源是 data/cache/motion（manifests + clips JSON，均由动画提取流程生成），
 * 不读取也不修改任何 FBX 源文件。每个形态只保存手指骨的局部四元数，
 * 前端应用时再按当前模型的实际骨骼名写入 / 替换当前片段的轨道。
 */

const log = createLogger('finger');

const motionDir = path.join(cacheDir, 'motion');
const manifestFile = path.join(motionDir, 'manifest.json');
const clipsDir = path.join(motionDir, 'clips');
const cacheFile = path.join(motionDir, 'finger-poses.json');

const CACHE_VERSION = 1;
/** 单手最多保留多少种形态（实测全库去重后约 200 种，留出余量） */
const MAX_PRESETS = 400;
/** 每个片段均匀采样几帧，覆盖动作过程中的不同手型 */
const SAMPLES_PER_CLIP = 4;

export type FingerSide = 'left' | 'right';

export interface FingerPosePreset {
  id: string;
  side: FingerSide;
  /** 由五个手指弯曲度推断出的形态名 */
  name: string;
  /** 拇指、食指、中指、无名指、小指的弯曲度，0–1 */
  curls: number[];
  /** 关节名（已去掉 mixamorig 前缀）→ 局部四元数 xyzw */
  bones: Record<string, [number, number, number, number]>;
  source: { clip: string; file: string; time: number };
  /** 同一形态在动画库里出现的次数 */
  samples: number;
}

export interface FingerPoseLibrary {
  version: number;
  available: boolean;
  message: string | null;
  generatedAt: string;
  /** 扫描过的片段文件数 */
  scanned: number;
  /** 采样得到的手型总数（去重前） */
  poses: number;
  left: FingerPosePreset[];
  right: FingerPosePreset[];
}

interface ManifestEntry {
  key?: string;
  relative?: string;
  status?: string;
  clips?: unknown[];
}

interface Manifest {
  entries?: ManifestEntry[];
}

interface CachedJoint {
  name?: string;
  rest?: { q?: number[] };
}

interface CachedTrack {
  joint?: string;
  property?: string;
  times?: number[];
  values?: number[];
}

interface CachedClip {
  name?: string;
  duration?: number;
  tracks?: CachedTrack[];
}

interface CachedClipFile {
  skeleton?: CachedJoint[];
  clips?: CachedClip[];
}

type Quat = [number, number, number, number];

const FINGER_RE = /^(?:mixamorig[:_]?)?(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([1-4])$/i;
const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

function normalizeBone(raw: string): string {
  return raw.replace(/^mixamorig[:_]?/i, '');
}

function qNormalize(q: Quat): Quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function qConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function qMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function toQuat(raw: number[] | undefined, fallback: Quat = [0, 0, 0, 1]): Quat {
  if (!raw || raw.length < 4) return fallback;
  return qNormalize([raw[0]!, raw[1]!, raw[2]!, raw[3]!]);
}

/** 从关键帧轨道里取任意时刻的四元数（相邻帧线性插值后归一化） */
function sampleTrack(track: CachedTrack, time: number): Quat {
  const times = track.times;
  const values = track.values;
  if (!times || !values || times.length === 0) return [0, 0, 0, 1];
  if (time <= times[0]!) return toQuat(values.slice(0, 4));
  const last = times.length - 1;
  if (time >= times[last]!) return toQuat(values.slice(last * 4, last * 4 + 4));

  let low = 0;
  let high = last;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (times[mid]! <= time) low = mid;
    else high = mid;
  }
  const span = times[high]! - times[low]!;
  const alpha = span > 0 ? (time - times[low]!) / span : 0;
  const result: Quat = [0, 0, 0, 1];
  for (let index = 0; index < 4; index += 1) {
    const a = values[low * 4 + index] ?? 0;
    const b = values[high * 4 + index] ?? 0;
    result[index] = a * (1 - alpha) + b * alpha;
  }
  return qNormalize(result);
}

/** 某一帧相对绑定姿态的弯曲角度，累加后换算成 0–1 的弯曲度 */
function curlOf(rest: Quat, animated: Quat, joints: number): number {
  if (joints <= 0) return 0;
  const relative = qMultiply(qConjugate(rest), animated);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(relative[3])));
  return Math.min(1, angle / (joints * (Math.PI / 2)));
}

function describeHand(curls: number[]): string {
  const [thumb = 0, index = 0, middle = 0, ring = 0, pinky = 0] = curls;
  const four = [index, middle, ring, pinky];
  const average = (thumb + index + middle + ring + pinky) / 5;

  if (four.every((value) => value > 0.58) && thumb > 0.42) return '握拳';
  if (index < 0.28 && four.slice(1).every((value) => value > 0.42)) return '指向';
  if (thumb < 0.28 && four.every((value) => value > 0.48)) return '点赞';
  if (thumb < 0.42 && index < 0.46 && middle > 0.3 && ring > 0.3) return '捏合';
  if (average < 0.16) return '张开';
  if (average < 0.32) return '自然放松';
  if (four.every((value) => value > 0.35)) return '半握';
  if (average < 0.5) return '微屈';
  return '抓握';
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function readJson<T>(file: string): Promise<T | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function emptyLibrary(message: string): FingerPoseLibrary {
  return {
    version: CACHE_VERSION,
    available: false,
    message,
    generatedAt: new Date().toISOString(),
    scanned: 0,
    poses: 0,
    left: [],
    right: [],
  };
}

interface CachedLibrary extends FingerPoseLibrary {
  manifestMtime: number;
}

function sortPresets(list: FingerPosePreset[]): FingerPosePreset[] {
  return list
    .sort((a, b) => b.samples - a.samples || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, MAX_PRESETS);
}

async function buildLibrary(): Promise<FingerPoseLibrary> {
  const manifest = await readJson<Manifest>(manifestFile);
  if (!manifest || !Array.isArray(manifest.entries)) {
    return emptyLibrary('未找到 Mixamo 动画缓存（data/cache/motion），暂时无法提取手指形态');
  }
  const entries = manifest.entries.filter(
    (entry) => entry.status === 'done' && typeof entry.key === 'string' && entry.key.length > 0,
  );

  const buckets: Record<FingerSide, Map<string, FingerPosePreset>> = {
    left: new Map(),
    right: new Map(),
  };
  let scanned = 0;
  let poses = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    // 每批让出事件循环：全库约 2000 个文件，一次性同步解析会卡住接口
    if (index > 0 && index % 40 === 0) await new Promise((resolve) => setImmediate(resolve));
    if (!entry.key) continue;

    const clipFile = await readJson<CachedClipFile>(path.join(clipsDir, `${entry.key}.json`));
    if (!clipFile) continue;
    scanned += 1;

    const rest = new Map<string, Quat>();
    for (const joint of clipFile.skeleton ?? []) {
      const name = joint.name;
      if (name) rest.set(normalizeBone(name), toQuat(joint.rest?.q));
    }

    for (const clip of clipFile.clips ?? []) {
      const fingerTracks = new Map<string, CachedTrack>();
      for (const track of clip.tracks ?? []) {
        if (track.property !== 'quaternion' || !track.joint) continue;
        if (!FINGER_RE.test(track.joint)) continue;
        fingerTracks.set(normalizeBone(track.joint), track);
      }
      if (fingerTracks.size === 0) continue;

      const duration = Number.isFinite(clip.duration) ? Math.max(0, clip.duration ?? 0) : 0;
      const times =
        duration > 0
          ? [
              0,
              duration / SAMPLES_PER_CLIP,
              (duration * 2) / SAMPLES_PER_CLIP,
              (duration * 3) / SAMPLES_PER_CLIP,
              duration,
            ]
          : [0];
      const uniqueTimes = [...new Set(times.map((value) => round(value, 4)))];

      for (const time of uniqueTimes) {
        for (const side of ['left', 'right'] as const) {
          const sideName = side === 'left' ? 'Left' : 'Right';
          const curls: number[] = [];
          const bones: Record<string, Quat> = {};

          for (const finger of FINGER_NAMES) {
            let sum = 0;
            let joints = 0;
            for (let index = 1; index <= 4; index += 1) {
              const bone = `${sideName}Hand${finger}${index}`;
              const restQ = rest.get(bone);
              if (!restQ) continue;
              const track = fingerTracks.get(bone);
              const animated = track ? sampleTrack(track, time) : restQ;
              bones[bone] = animated;
              sum += curlOf(restQ, animated, 1);
              joints += 1;
            }
            const curl = joints > 0 ? Math.min(1, sum / joints) : 0;
            curls.push(round(curl));
          }

          if (Object.keys(bones).length === 0) continue;

          // 按 0.2 一档量化弯曲度做去重；同一形态保留第一次采到的原始四元数
          const key = curls.map((value) => Math.round(value * 5)).join('');
          const id = `${side}-${key}`;
          const bucket = buckets[side];
          const existing = bucket.get(id);
          if (existing) {
            existing.samples += 1;
          } else {
            bucket.set(id, {
              id,
              side,
              name: describeHand(curls),
              curls,
              bones: Object.fromEntries(
                Object.entries(bones).map(([name, quat]) => [
                  name,
                  quat.map((value) => round(value, 6)) as Quat,
                ]),
              ),
              source: {
                clip: clip.name || entry.relative || entry.key,
                file: entry.relative || entry.key,
                time: round(time, 3),
              },
              samples: 1,
            });
          }
          poses += 1;
        }
      }
    }
  }

  const library: CachedLibrary = {
    version: CACHE_VERSION,
    available: true,
    message: null,
    generatedAt: new Date().toISOString(),
    scanned,
    poses,
    left: sortPresets([...buckets.left.values()]),
    right: sortPresets([...buckets.right.values()]),
    manifestMtime: await fs
      .stat(manifestFile)
      .then((stat) => stat.mtimeMs)
      .catch(() => 0),
  };

  await fs.mkdir(motionDir, { recursive: true }).catch(() => undefined);
  await fs.writeFile(cacheFile, JSON.stringify(library), 'utf8').catch((err) => {
    log.warn(`手指形态库缓存写入失败：${(err as Error).message}`);
  });
  log.info(
    `手指形态库已重建：扫描 ${scanned} 个片段，左手 ${library.left.length} 种、右手 ${library.right.length} 种`,
  );
  return library;
}

let building: Promise<FingerPoseLibrary> | null = null;

/** 读取形态库；优先用磁盘缓存，manifest 变化或 refresh=true 时重建 */
export async function getFingerPoseLibrary(refresh = false): Promise<FingerPoseLibrary> {
  if (building) return building;
  building = (async () => {
    const manifestStat = await fs.stat(manifestFile).catch(() => null);
    if (!manifestStat) {
      return emptyLibrary('未找到 Mixamo 动画缓存（data/cache/motion），暂时无法提取手指形态');
    }
    if (!refresh) {
      const cached = await readJson<CachedLibrary>(cacheFile);
      if (
        cached &&
        cached.version === CACHE_VERSION &&
        cached.manifestMtime === manifestStat.mtimeMs &&
        Array.isArray(cached.left) &&
        Array.isArray(cached.right)
      ) {
        return cached;
      }
    }
    return buildLibrary();
  })().finally(() => {
    building = null;
  });
  return building;
}
