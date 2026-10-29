/**
 * 把动画库里的 Mixamo 骨架动画重定向到自动绑骨生成的骨骼上。
 *
 * 为什么需要重定向：
 *  - 动画片段里的轨道绑定的是源骨架的骨骼名（mixamorigLeftArm 等），与自动绑骨
 *    的 UpperArmL 完全不同，直接播放会「一条轨道都绑不上」；
 *  - 即使名字能对上，两套骨架的绑定姿态（T-pose / A-pose）与骨骼长度也不同，
 *    直接抄源骨骼的局部旋转会绕错轴（手臂会朝前后方向甩）。
 *
 * 做法是「世界旋转增量」重定向：
 *  1. 在源骨架、目标骨架各自的根坐标系里记录绑定姿态朝向 qRest；
 *  2. 逐帧采样源动画得到源骨骼朝向 q(t)，增量 delta = q(t) · qRest⁻¹；
 *  3. 目标骨骼朝向 = delta · qRestTarget —— 只把「相对绑定姿态的变化」搬过去，
 *     目标模型原本是 T-pose 还是 A-pose 都成立；
 *  4. 再换算成父骨骼局部坐标写成关键帧轨道，交给 AnimationMixer 播放。
 *
 * 用「根坐标系」而不是世界坐标，是为了让模型的朝向纠正（绕 Y 旋转）不影响播放：
 * 目标骨架整体旋转后，这些局部旋转仍然是对的。
 *
 * 髋部位移只保留竖直分量（原地预览），并按两套模型的身高比例缩放，
 * 否则 FBX 的厘米单位会让模型直接飞出画面。
 */
import * as THREE from 'three';
import { cleanBoneLabel } from '../SkeletonOverlay';

/** 重定向采样帧率；Mixamo 片段本身就是 30fps */
const SAMPLE_FPS = 30;
/** 单条动画最多采样帧数（30 秒 @30fps），更长时按比例降帧，避免轨道数据过大 */
const MAX_SAMPLES = 900;

/**
 * 目标骨骼 → 源骨架里常见的骨骼名（均为 normalizeBoneName 之后的形式）。
 * 数组顺序即优先级：Chest 优先取 Mixamo 的 Spine2，没有时退回 Spine1 / Chest。
 * 注意 Spine 只认 spine，避免把 spine1 抢走后 Chest 反而没有骨骼可用。
 */
const BONE_ALIASES: Record<string, readonly string[]> = {
  Hips: ['hips', 'pelvis', 'hip'],
  Spine: ['spine', 'abdomen', 'lowerback'],
  Chest: ['spine2', 'spine1', 'spine3', 'upperchest', 'chest', 'torso'],
  Neck: ['neck', 'neck1'],
  Head: ['head'],

  ShoulderL: ['leftshoulder', 'shoulderl', 'lshoulder', 'leftclavicle'],
  UpperArmL: ['leftarm', 'leftupperarm', 'upperarml', 'lupperarm', 'arml'],
  ForearmL: ['leftforearm', 'leftlowerarm', 'forearml', 'lowerarml', 'lforearm'],
  HandL: ['lefthand', 'handl', 'lhand'],

  ShoulderR: ['rightshoulder', 'shoulderr', 'rshoulder', 'rightclavicle'],
  UpperArmR: ['rightarm', 'rightupperarm', 'upperarmr', 'rupperarm', 'armr'],
  ForearmR: ['rightforearm', 'rightlowerarm', 'forearmr', 'lowerarmr', 'rforearm'],
  HandR: ['righthand', 'handr', 'rhand'],

  UpperLegL: ['leftupleg', 'leftupperleg', 'upperlegl', 'leftthigh', 'thighl', 'lupleg'],
  LowerLegL: ['leftleg', 'leftlowerleg', 'lowerlegl', 'leftshin', 'shinl', 'lleg'],
  FootL: ['leftfoot', 'footl', 'lfoot'],

  UpperLegR: ['rightupleg', 'rightupperleg', 'upperlegr', 'rightthigh', 'thighr', 'rupleg'],
  LowerLegR: ['rightleg', 'rightlowerleg', 'lowerlegr', 'rightshin', 'shinr', 'rleg'],
  FootR: ['rightfoot', 'footr', 'rfoot'],
};

export interface RetargetResult {
  /** 可直接挂到目标骨架 AnimationMixer 上的片段 */
  clip: THREE.AnimationClip;
  /** 成功映射并写入轨道的骨骼数 */
  bones: number;
}

/** 去掉 Mixamo 前缀、命名空间分隔符与大小写差异，得到可比较的骨骼名 */
function normalizeBoneName(name: string): string {
  return cleanBoneLabel(name)
    .toLowerCase()
    .replace(/^\d+/, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * 在源骨架里按别名表找到每根目标骨骼对应的骨骼。
 * 一个源骨骼只会被一根目标骨骼占用（先到先得），避免 Spine / Chest 抢同一根。
 */
function mapSourceBones(bones: readonly THREE.Bone[]): Map<string, THREE.Bone> {
  const byName = new Map<string, THREE.Bone>();
  for (const bone of bones) {
    const key = normalizeBoneName(bone.name);
    if (key && !byName.has(key)) byName.set(key, bone);
  }
  const mapped = new Map<string, THREE.Bone>();
  const claimed = new Set<THREE.Bone>();
  for (const [target, aliases] of Object.entries(BONE_ALIASES)) {
    for (const alias of aliases) {
      const bone = byName.get(alias);
      if (!bone || claimed.has(bone)) continue;
      mapped.set(target, bone);
      claimed.add(bone);
      break;
    }
  }
  return mapped;
}

/**
 * 把源片段重定向成「目标骨架可直接播放」的新片段。
 *
 * @param targetRoot 自动绑骨后的模型根（骨骼在其层级里，当前应为绑定姿态）
 * @param sourceRoot 已加载的源 FBX 模型根（动画片段来自它）
 * @param sourceClip 源动画片段
 * @returns 重定向结果；骨架没有可用映射（比如不是人形）时返回 null
 * @sideEffect 会用 sourceRoot 上的 AnimationMixer 逐帧推进源动画，不修改目标骨架
 */
export function retargetClipToRig(
  targetRoot: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  sourceClip: THREE.AnimationClip,
): RetargetResult | null {
  if (!(sourceClip.duration > 1e-3) || sourceClip.tracks.length === 0) return null;

  targetRoot.updateMatrixWorld(true);
  sourceRoot.updateMatrixWorld(true);

  const targetBones: THREE.Bone[] = [];
  targetRoot.traverse((child) => {
    if ((child as THREE.Bone).isBone) targetBones.push(child as THREE.Bone);
  });
  const sourceBones: THREE.Bone[] = [];
  sourceRoot.traverse((child) => {
    if ((child as THREE.Bone).isBone) sourceBones.push(child as THREE.Bone);
  });
  if (targetBones.length === 0 || sourceBones.length === 0) return null;

  const mapping = mapSourceBones(sourceBones);
  const targetByName = new Map<string, THREE.Bone>();
  for (const bone of targetBones) targetByName.set(bone.name, bone);
  const targetHips = targetByName.get('Hips');
  const sourceHips = mapping.get('Hips');
  // 连髋部都对不上，基本不是人形骨架，没有预览价值
  if (!targetHips || !sourceHips) return null;

  // ---- 记录两套骨架在各自根坐标系里的绑定姿态 ----
  const invSourceRoot = sourceRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const invTargetRoot = targetRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const tmpQuat = new THREE.Quaternion();

  const sourceRest = new Map<THREE.Bone, THREE.Quaternion>();
  const sourceRestInverse = new Map<THREE.Bone, THREE.Quaternion>();
  for (const bone of sourceBones) {
    bone.getWorldQuaternion(tmpQuat);
    const rest = new THREE.Quaternion().copy(invSourceRoot).multiply(tmpQuat).normalize();
    sourceRest.set(bone, rest);
    sourceRestInverse.set(bone, rest.clone().invert());
  }
  const targetRest = new Map<THREE.Bone, THREE.Quaternion>();
  for (const bone of targetBones) {
    bone.getWorldQuaternion(tmpQuat);
    targetRest.set(bone, new THREE.Quaternion().copy(invTargetRoot).multiply(tmpQuat).normalize());
  }

  // ---- 髋部位移的换算基准 ----
  const sourceHeight = new THREE.Box3().setFromObject(sourceRoot).getSize(new THREE.Vector3()).y;
  const targetHeight = new THREE.Box3().setFromObject(targetRoot).getSize(new THREE.Vector3()).y;
  const heightRatio = sourceHeight > 1e-6 && targetHeight > 1e-6 ? targetHeight / sourceHeight : 1;
  const targetScaleY = targetRoot.getWorldScale(new THREE.Vector3()).y || 1;
  /** 目标模型身高（换算回模型自身单位），用于给髋位移兜底限幅 */
  const targetHeightLocal = targetScaleY > 1e-9 ? targetHeight / targetScaleY : 0;
  const hipsRestPosition = targetHips.position.clone();
  const sourceHipsRestY = sourceHips.getWorldPosition(new THREE.Vector3()).y;

  // ---- 逐帧采样源动画 ----
  const mixer = new THREE.AnimationMixer(sourceRoot);
  const action = mixer.clipAction(sourceClip);
  action.play();

  const fps = Math.min(SAMPLE_FPS, (MAX_SAMPLES - 1) / sourceClip.duration);
  const frameCount = Math.max(2, Math.min(MAX_SAMPLES, Math.round(sourceClip.duration * fps) + 1));
  const step = sourceClip.duration / (frameCount - 1);
  const times = new Float32Array(frameCount);

  const rotations = new Map<THREE.Bone, Float32Array>();
  for (const targetName of mapping.keys()) {
    const bone = targetByName.get(targetName);
    if (!bone) continue;
    rotations.set(bone, new Float32Array(frameCount * 4));
  }
  const hipsValues = new Float32Array(frameCount * 3);

  // 每帧复用的四元数：目标骨骼在根坐标系里的朝向
  const frameInner = new Map<THREE.Bone, THREE.Quaternion>();
  for (const bone of targetBones) frameInner.set(bone, new THREE.Quaternion());
  const prevLocal = new Map<THREE.Bone, THREE.Quaternion>();

  const innerSource = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const local = new THREE.Quaternion();
  const parentInverse = new THREE.Quaternion();
  const worldPosition = new THREE.Vector3();

  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = step * frame;
    times[frame] = time;
    // 循环片段在 t = duration 处会回卷到 0，最后一帧取端点前一瞬间，保证姿态连续
    mixer.setTime(Math.min(time, sourceClip.duration - 1e-4));
    sourceRoot.updateMatrixWorld(true);

    // 1) 源骨骼朝向 → 世界旋转增量 → 目标骨骼在根坐标系里的朝向
    for (const bone of targetBones) {
      const inner = frameInner.get(bone)!;
      const sourceBone = mapping.get(bone.name);
      if (!sourceBone) {
        // 源动画没有对应骨骼（例如缺肩骨）：保持绑定姿态
        inner.copy(targetRest.get(bone)!);
        continue;
      }
      sourceBone.getWorldQuaternion(tmpQuat);
      innerSource.copy(invSourceRoot).multiply(tmpQuat).normalize();
      delta.copy(innerSource).multiply(sourceRestInverse.get(sourceBone)!);
      inner.copy(delta).multiply(targetRest.get(bone)!);
    }

    // 2) 换算成父骨骼局部坐标，写成关键帧（目标骨骼按层级父先子后遍历）
    for (const bone of targetBones) {
      const values = rotations.get(bone);
      const inner = frameInner.get(bone)!;
      const parent = bone.parent;
      const parentInner =
        parent && (parent as THREE.Bone).isBone ? frameInner.get(parent as THREE.Bone) : undefined;
      if (parentInner) {
        parentInverse.copy(parentInner).invert();
        local.copy(parentInverse).multiply(inner);
      } else {
        // 根骨骼的父节点是模型根，根坐标系下父朝向为单位四元数
        local.copy(inner);
      }
      if (!values) continue;

      // 四元数 q 与 -q 表示同一朝向；相邻帧保持一致才不会插值绕远路
      const previous = prevLocal.get(bone);
      if (previous && previous.dot(local) < 0) {
        local.set(-local.x, -local.y, -local.z, -local.w);
      }
      if (previous) previous.copy(local);
      else prevLocal.set(bone, local.clone());

      const offset = frame * 4;
      values[offset] = local.x;
      values[offset + 1] = local.y;
      values[offset + 2] = local.z;
      values[offset + 3] = local.w;
    }

    // 3) 髋部竖直位移：原地预览，只搬 Y，并按身高比例缩放
    sourceHips.getWorldPosition(worldPosition);
    let hipsOffset = ((worldPosition.y - sourceHipsRestY) * heightRatio) / targetScaleY;
    // 防御：动画源缺少蒙皮（量不到身高）或本身带巨大位移时，限制在身高的 1/4 以内，
    // 避免模型直接飞出画面
    if (targetHeightLocal > 1e-6) {
      const limit = targetHeightLocal * 0.25;
      hipsOffset = Math.max(-limit, Math.min(limit, hipsOffset));
    }
    hipsValues[frame * 3] = hipsRestPosition.x;
    hipsValues[frame * 3 + 1] = hipsRestPosition.y + hipsOffset;
    hipsValues[frame * 3 + 2] = hipsRestPosition.z;
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(sourceRoot);

  const tracks: THREE.KeyframeTrack[] = [];
  for (const [bone, values] of rotations) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${targetHips.name}.position`, times, hipsValues));
  if (tracks.length === 0) return null;

  return {
    clip: new THREE.AnimationClip(sourceClip.name || 'preview', sourceClip.duration, tracks),
    bones: rotations.size,
  };
}
