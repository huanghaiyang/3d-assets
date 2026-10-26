import * as THREE from 'three';
import { cleanBoneLabel } from '@/viewer/SkeletonOverlay';
import type {
  AnimationClipData,
  AnimationData,
  AnimationJointData,
  AnimationTrackData,
} from '@/viewer/FbxPlayer';
import { isHipsBone, partCoversBone } from './StripParts';
import { stripClipTime, type StripDef } from './StripTypes';

/** 骨骼静置姿态（FBX 绑定姿态的局部变换） */
export interface RestPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export type RestPoseMap = Map<string, RestPose>;

/** 一条 Strip 的求值环境：独立骨架克隆 + 独立 mixer */
export interface StripEntry {
  strip: StripDef;
  rig: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  /** 骨骼名 → 克隆骨架里的骨骼 */
  bones: Map<string, THREE.Bone>;
  clipDuration: number;
}

const EPS = 1e-4;

export function captureRestPose(bones: readonly THREE.Bone[]): RestPoseMap {
  const map: RestPoseMap = new Map();
  for (const bone of bones) {
    map.set(bone.name, {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
    });
  }
  return map;
}

export function resetToRest(bones: readonly THREE.Bone[], rest: RestPoseMap): void {
  for (const bone of bones) {
    const pose = rest.get(bone.name);
    if (!pose) continue;
    bone.position.copy(pose.position);
    bone.quaternion.copy(pose.quaternion);
    bone.scale.copy(pose.scale);
  }
}

function stripActive(strip: StripDef, time: number): boolean {
  if (strip.muted || strip.weight <= 0 || strip.duration <= 0) return false;
  return time >= strip.start - EPS && time < strip.start + strip.duration - EPS;
}

function clampWeight(strip: StripDef): number {
  return Math.min(1, Math.max(0, strip.weight));
}

/**
 * 把多条 Strip 在时刻 time 混合写入目标骨架。
 *
 * 逐骨骼规则：
 *  - 候选 = 未静音、在时间范围内、部位掩码覆盖该骨骼的 Strip；
 *  - 总权重超过 1 时按比例归一，不足 1 的部分留给静置姿态；
 *  - 四元数做增量 slerp；位置只混髋部，其它骨骼写静置位置，避免骨架长度差拉扯。
 */
export function applyStrips(
  entries: readonly StripEntry[],
  targetBones: readonly THREE.Bone[],
  rest: RestPoseMap,
  time: number,
): void {
  for (const entry of entries) {
    if (!stripActive(entry.strip, time)) {
      if (entry.action.enabled) {
        entry.action.enabled = false;
        entry.action.setEffectiveWeight(0);
      }
      continue;
    }
    entry.action.enabled = true;
    entry.action.setEffectiveWeight(1);
    entry.action.time = stripClipTime(entry.strip, time, entry.clipDuration);
    entry.mixer.update(0);
  }

  const active = entries.filter((entry) => stripActive(entry.strip, time));
  const workQ = new THREE.Quaternion();
  const workP = new THREE.Vector3();

  for (const bone of targetBones) {
    const base = rest.get(bone.name);
    if (!base) continue;

    let total = 0;
    let candidates = 0;
    for (const entry of active) {
      if (!partCoversBone(entry.strip.part, bone.name)) continue;
      if (!entry.bones.has(bone.name)) continue;
      total += clampWeight(entry.strip);
      candidates += 1;
    }

    if (candidates === 0 || total <= 0) {
      bone.quaternion.copy(base.quaternion);
      bone.position.copy(base.position);
      continue;
    }

    const scale = total > 1 ? 1 / total : 1;
    const restWeight = Math.max(0, 1 - total);
    const blended = base.quaternion.clone();
    let acc = restWeight;

    for (const entry of active) {
      if (!partCoversBone(entry.strip.part, bone.name)) continue;
      const source = entry.bones.get(bone.name);
      if (!source) continue;
      const weight = clampWeight(entry.strip) * scale;
      if (weight <= 0) continue;
      workQ.copy(source.quaternion);
      const k = acc + weight > 1e-6 ? weight / (acc + weight) : 1;
      blended.slerp(workQ, k);
      acc += weight;
    }
    if (acc < 1e-6) blended.copy(base.quaternion);
    bone.quaternion.copy(blended);

    if (isHipsBone(bone.name)) {
      let sum = 0;
      workP.set(0, 0, 0);
      if (restWeight > 0) {
        workP.addScaledVector(base.position, restWeight);
        sum += restWeight;
      }
      for (const entry of active) {
        if (!partCoversBone(entry.strip.part, bone.name)) continue;
        const source = entry.bones.get(bone.name);
        if (!source) continue;
        const weight = clampWeight(entry.strip) * scale;
        if (weight <= 0) continue;
        workP.addScaledVector(source.position, weight);
        sum += weight;
      }
      if (sum > 0) workP.divideScalar(sum);
      else workP.copy(base.position);
      bone.position.copy(workP);
    } else {
      bone.position.copy(base.position);
    }
  }
}

/**
 * 把任意来源的 AnimationClip 轨道名重绑定到基础模型的骨骼名。
 * FBX 内嵌片段可能带 / 不带 mixamorig 前缀，统一走别名表；无法匹配的轨道直接丢弃。
 */
export function bindClipToBones(
  clip: THREE.AnimationClip,
  boneNameMap: Map<string, string>,
): THREE.AnimationClip | null {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    if (dot <= 0) continue;
    const nodeName = track.name.slice(0, dot);
    const property = track.name.slice(dot + 1);
    const target =
      boneNameMap.get(nodeName) ??
      boneNameMap.get(THREE.PropertyBinding.sanitizeNodeName(nodeName)) ??
      boneNameMap.get(cleanBoneLabel(nodeName));
    if (!target) continue;
    const cloned = track.clone();
    cloned.name = `${target}.${property}`;
    tracks.push(cloned);
  }
  if (tracks.length === 0) return null;
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function parentBoneName(bone: THREE.Bone): string | null {
  let parent = bone.parent;
  while (parent) {
    if ((parent as THREE.Bone).isBone) return parent.name;
    parent = parent.parent;
  }
  return null;
}

function boneDepth(bone: THREE.Bone): number {
  let depth = 0;
  let parent = bone.parent;
  while (parent) {
    if ((parent as THREE.Bone).isBone) depth += 1;
    parent = parent.parent;
  }
  return depth;
}

/**
 * 逐帧烘焙成 AnimationData（fbx-animation-data）。
 *
 * 输出与「新建动画」保存格式一致，可经 clipsFromAnimationData 还原为 AnimationClip，
 * 保证「预览的动画」与「保存的动画」是同一条数据。
 */
export function bakeStrips(
  entries: readonly StripEntry[],
  targetBones: readonly THREE.Bone[],
  rest: RestPoseMap,
  duration: number,
  fps: number,
  clipName: string,
): AnimationData {
  const safeDuration = Math.max(1 / fps, duration);
  const byName = new Map<string, THREE.Bone>();
  for (const bone of targetBones) byName.set(bone.name, bone);

  const animated = new Set<string>();
  for (const bone of targetBones) {
    for (const entry of entries) {
      const strip = entry.strip;
      if (strip.muted || strip.weight <= 0 || strip.duration <= 0) continue;
      if (partCoversBone(strip.part, bone.name) && entry.bones.has(bone.name)) {
        animated.add(bone.name);
        break;
      }
    }
  }

  const hips = targetBones.find((bone) => isHipsBone(bone.name)) ?? null;
  const frameCount = Math.max(2, Math.ceil(safeDuration * fps) + 1);
  const times: number[] = [];
  const quatValues = new Map<string, number[]>();
  for (const name of animated) quatValues.set(name, []);
  const hipsValues: number[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const time = Math.min(index / fps, safeDuration);
    times.push(time);
    applyStrips(entries, targetBones, rest, time);
    for (const name of animated) {
      const bone = byName.get(name);
      const values = quatValues.get(name);
      if (!bone || !values) continue;
      values.push(bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w);
    }
    if (hips) hipsValues.push(hips.position.x, hips.position.y, hips.position.z);
  }

  const joints: AnimationJointData[] = targetBones.map((bone) => {
    const pose = rest.get(bone.name);
    return {
      name: bone.name,
      label: cleanBoneLabel(bone.name),
      parent: parentBoneName(bone),
      depth: boneDepth(bone),
      rest: {
        position: pose ? [pose.position.x, pose.position.y, pose.position.z] : [0, 0, 0],
        rotation: pose
          ? [pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w]
          : [0, 0, 0, 1],
        scale: pose ? [pose.scale.x, pose.scale.y, pose.scale.z] : [1, 1, 1],
      },
    };
  });

  const interval = 1 / fps;
  const tracks: AnimationTrackData[] = [];
  for (const name of animated) {
    const values = quatValues.get(name);
    if (!values || values.length === 0) continue;
    tracks.push({
      name: `${name}.quaternion`,
      joint: name,
      property: 'quaternion',
      valueType: 'number',
      valueSize: 4,
      keyframes: frameCount,
      timeRange: [0, safeDuration],
      interval,
      interpolation: 'linear',
      times: [...times],
      values,
    });
  }
  if (hips && hipsValues.length > 0) {
    tracks.push({
      name: `${hips.name}.position`,
      joint: hips.name,
      property: 'position',
      valueType: 'number',
      valueSize: 3,
      keyframes: frameCount,
      timeRange: [0, safeDuration],
      interval,
      interpolation: 'linear',
      times: [...times],
      values: hipsValues,
    });
  }

  const clip: AnimationClipData = {
    name: clipName,
    duration: safeDuration,
    fps,
    interval,
    keyframes: frameCount,
    tracks,
  };

  return {
    format: 'fbx-animation-data',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { name: clipName },
    skeleton: { jointCount: joints.length, joints },
    timeline: {
      clipCount: 1,
      totalDuration: safeDuration,
      longestDuration: safeDuration,
      fps,
      interval,
    },
    clips: [clip],
    excluded: ['mesh', 'skin', 'materials'],
  };
}
