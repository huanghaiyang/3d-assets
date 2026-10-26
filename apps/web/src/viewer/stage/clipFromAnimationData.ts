import * as THREE from 'three';
import { cleanBoneLabel } from '../SkeletonOverlay';
import type { AnimationClipData, AnimationData } from '../FbxPlayer';

/**
 * 把导出的动画数据（仅关节轨迹与关键帧）转成 AnimationClip。
 *
 * 这段逻辑原本内联在 FbxPlayer.applyAnimationData 里；舞台引擎也要用同一条转换路径，
 * 所以抽成独立纯函数，避免两份实现漂移。
 */
export function buildBoneNameMap(bones: Iterable<{ name: string }>): Map<string, string> {
  // 关节名映射：导出 JSON 里的 joint / 轨道节点名可能是清理后的显示名，
  // 绑定前统一换回模型里真实的骨骼名，避免 THREE 找不到绑定目标。
  const boneNameMap = new Map<string, string>();
  for (const bone of bones) {
    for (const alias of [bone.name, THREE.PropertyBinding.sanitizeNodeName(bone.name), cleanBoneLabel(bone.name)]) {
      if (!boneNameMap.has(alias)) boneNameMap.set(alias, bone.name);
    }
  }
  return boneNameMap;
}

export interface ConvertedClips {
  clips: THREE.AnimationClip[];
  /** 成功绑定到骨骼的轨道数；0 表示骨架不匹配 */
  matchedTracks: number;
}

function clipFromSingleData(clip: AnimationClipData, boneNameMap: Map<string, string>): { clip: THREE.AnimationClip; matched: number } {
  let matched = 0;
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    if (!track.name || !Array.isArray(track.times) || !Array.isArray(track.values)) continue;
    if (track.times.length === 0) continue;
    if (track.times.length * track.valueSize !== track.values.length) continue;

    const dot = track.name.lastIndexOf('.');
    const nodeName = dot > 0 ? track.name.slice(0, dot) : track.name;
    const property = track.property || (dot > 0 ? track.name.slice(dot + 1) : '');
    const target =
      (track.joint ? boneNameMap.get(track.joint) : undefined) ??
      boneNameMap.get(nodeName) ??
      boneNameMap.get(cleanBoneLabel(nodeName));
    if (!target) continue;
    matched += 1;
    const trackName = property ? `${target}.${property}` : track.name;

    if (track.valueSize === 4) {
      tracks.push(new THREE.QuaternionKeyframeTrack(trackName, track.times, track.values));
    } else if (track.valueSize === 3) {
      tracks.push(new THREE.VectorKeyframeTrack(trackName, track.times, track.values));
    } else if (track.valueSize === 1) {
      tracks.push(new THREE.NumberKeyframeTrack(trackName, track.times, track.values));
    }
  }
  if (tracks.length === 0) {
    throw new Error(`片段「${clip.name}」没有可用的关键帧（请在导出时包含关键帧数值）`);
  }
  const lastTime = tracks.reduce((max, track) => Math.max(max, track.times[track.times.length - 1] ?? 0), 0);
  const result = new THREE.AnimationClip(clip.name || 'imported', Math.max(clip.duration || 0, lastTime), tracks);
  return { clip: result, matched };
}

export function clipsFromAnimationData(data: AnimationData, boneNameMap: Map<string, string>): ConvertedClips {
  let matchedTracks = 0;
  const clips = data.clips.map((clip) => {
    const converted = clipFromSingleData(clip, boneNameMap);
    matchedTracks += converted.matched;
    return converted.clip;
  });
  if (clips.length === 0) throw new Error('JSON 中没有动画片段');
  return { clips, matchedTracks };
}
