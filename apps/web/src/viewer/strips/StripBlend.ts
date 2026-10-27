/**
 * 拼接工作区的「混合核心」：把多条 Strip 在某一时刻的姿态合成到基础骨架上，或逐帧烘焙。
 *
 * 为什么需要独立骨架克隆：
 *  - 每条 Strip 来自不同的来源动画，播放进度、片段时长、骨架比例都不同；
 *  - 若共用一个 AnimationMixer，Three.js 的 Action 权重混合会作用于整具骨架，
 *    无法表达「这条动画只管左臂、那条只管腿」；
 *  - 因此每条 Strip 克隆一份骨架并用自己的 mixer 求值，本模块再按「部位掩码 + 权重」
 *    逐骨骼把结果合并到基础骨架。这样部位之间的边界是完全可控的。
 *
 * 混合规则（与 StripBlend.applyStrips 一一对应）：
 *  1. 候选 = 未静音、在该时刻时间范围内、部位覆盖该骨骼的 Strip；
 *  2. 总权重 > 1 时按比例归一；< 1 时剩余部分保留静置姿态；
 *  3. 旋转做增量 slerp（每次按「新增权重 / 累计权重」插值，保证与顺序无关）；
 *  4. 位置只混髋部，其余骨骼写回静置位置，避免骨架长度差异把网格拉扯变形。
 *
 * 预览与保存一致性的关键：
 *  烘焙（bakeStrips）逐帧调用同一个 applyStrips，再把结果写成 AnimationData；
 *  预览时用 clipsFromAnimationData 把它还原成 AnimationClip。两条路径共用同一份混合逻辑，
 *  因此「看到的」与「存下的」不会出现系统性偏差。
 */
import * as THREE from 'three';
import { cleanBoneLabel } from '@/viewer/SkeletonOverlay';
import type {
  AnimationClipData,
  AnimationData,
  AnimationJointData,
  AnimationTrackData,
} from '@/viewer/FbxPlayer';
import { coversBone, isHipsBone } from './StripParts';
import { stripClipTime, type StripDef } from './StripTypes';

/**
 * 骨骼静置姿态（FBX 绑定姿态的局部变换）。
 * 注意是「局部」变换：混合时直接写回骨骼的 position/quaternion/scale，
 * 世界变换交给场景图自动级联，避免手动乘父子矩阵带来的误差累积。
 */
export interface RestPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/**
 * 骨骼名 → 静置姿态。
 * 以骨骼名为键（而非引用）是因为克隆骨架、同名骨骼在不同来源里共用同一份绑定姿态。
 */
export type RestPoseMap = Map<string, RestPose>;

/**
 * 一条 Strip 的求值环境：独立骨架克隆 + 独立 mixer。
 *
 * 生命周期：StripsPlayer.setStrips 时按来源集合重建；来源集合不变时复用，
 * 因为改部位/权重/颜色只需重算外观，不必重新加载和绑定动画。
 */
export interface StripEntry {
  strip: StripDef;
  /** 该 Strip 专用的骨架克隆（不含网格，仅用于求值） */
  rig: THREE.Object3D;
  /** 与 rig 绑定；单条 Action，权重固定按 Strip.weight 在混合阶段另算 */
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  /** 骨骼名 → 克隆骨架里的骨骼 */
  bones: Map<string, THREE.Bone>;
  /** 来源片段的真实时长（秒），用于 stripClipTime 的上界夹取 */
  clipDuration: number;
}

/** 浮点容差：用于时间区间开闭判断与权重下限，避免 0 权重仍进入 slerp 分支 */
const EPS = 1e-4;

/**
 * 记录基础骨架当前的绑定姿态。
 * 必须在任何混合之前调用（loadBase 时），且之后不再被混合结果污染。
 *
 * @param bones 基础骨架骨骼列表（已过滤 shadow 骨骼）
 * @returns 名称到局部变换的映射（position/quaternion/scale 均已 clone，与骨骼解耦）
 */
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

/**
 * 把骨架恢复成静置姿态。
 * 用途：切换 baked / live 模式前清场，保证下一次混合从干净状态开始，
 * 不会残留上一次烘焙或其它 Strip 的局部旋转。
 *
 * @param bones 目标骨架骨骼
 * @param rest  由 captureRestPose 采集的绑定姿态；缺失的骨骼会被跳过（保持原状）
 * @sideEffect 直接修改 bones 的按引用字段，不触发矩阵更新
 */
export function resetToRest(bones: readonly THREE.Bone[], rest: RestPoseMap): void {
  for (const bone of bones) {
    const pose = rest.get(bone.name);
    if (!pose) continue;
    bone.position.copy(pose.position);
    bone.quaternion.copy(pose.quaternion);
    bone.scale.copy(pose.scale);
  }
}

/**
 * 该 Strip 在时刻 time 是否生效。
 *
 * 区间为左闭右开 [start, start + duration)，两端各留 EPS 容差：
 *  - 左端允许 time 略小于 start（浮点误差 / 播放头正好落在边界）；
 *  - 右端排除结束帧，避免相邻 Strip 在同一时刻同时生效造成双重叠加。
 *
 * @param time 时间轴时刻（秒）
 * @returns 静音、权重 <= 0、时长 <= 0 或不在时间范围内时为 false
 */
function stripActive(strip: StripDef, time: number): boolean {
  if (strip.muted || strip.weight <= 0 || strip.duration <= 0) return false;
  return time >= strip.start - EPS && time < strip.start + strip.duration - EPS;
}

/**
 * 把权重夹到 [0, 1]。
 * UI 已经限制范围，这里再夹一次是因为旧编排可能被手改脏（normalizeTrack 容错）。
 * @returns 0–1 之间的权重
 */
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
 *
 * 实现细节：
 *  - 先对每条生效的 Strip 设置 action.time 并 mixer.update(0)。用 0 步长是因为这里只需要
 *    「按目标时间求值一次」，不推进播放；这样拖动时间轴也不会累积漂移。
 *  - 旋转插值用「增量 slerp」：每追加一条，k = w / (已累计 + w)，等价于按权重加权，
 *    且结果与 Strip 顺序无关。
 *  - 任务要求「已添加部位颜色与该动画一致」，颜色不在这里处理（见 StripsPlayer.refreshPaint），
 *    本函数只负责姿态。
 *
 * @param entries     所有 Strip 的求值环境（可能包含未生效的）
 * @param targetBones 基础骨架骨骼（原地写入姿势）
 * @param rest        基础骨架的静置姿态，作为未覆盖部分的回退
 * @param time        时间轴时刻（秒）；调用方需保证在 [0, duration] 内（越界会被区间判断自然过滤）
 * @sideEffect 修改 targetBones 的 local position/quaternion；不更新世界矩阵
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
      if (!coversBone(entry.strip.parts, bone.name)) continue;
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
      if (!coversBone(entry.strip.parts, bone.name)) continue;
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
        if (!coversBone(entry.strip.parts, bone.name)) continue;
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
 *
 * 为什么不能直接用原 clip：
 *  来源动画的骨架名与基础模型未必完全一致（Mixamo 前缀、命名空间、PropertyBinding 的
 *  合法化转义都会影响匹配）。若绑定不上，mixer 会静默跳过该轨道，表现成「部分骨骼不动」，
 *  很难排查；因此这里主动重绑定，并在一条都绑不上时返回 null 让上层报错。
 *
 * @param clip        来源片段（不会被修改）
 * @param boneNameMap 基础骨架的「别名 → 实际骨骼名」表（buildBoneNameMap）
 * @returns 重绑定后的新 clip；track 全部无法匹配时返回 null（调用方提示「骨架不匹配」）
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

/**
 * 向上查找最近的骨骼父节点名。
 * FBX 导出的骨架常被 Group / Armature 节点包住，直接取 bone.parent.name 未必是骨骼，
 * 因此需要穿透非骨骼节点。用于烘焙输出里 joints[].parent 的构建。
 * @returns 父骨骼名；已是根骨骼时返回 null
 */
function parentBoneName(bone: THREE.Bone): string | null {
  let parent = bone.parent;
  while (parent) {
    if ((parent as THREE.Bone).isBone) return parent.name;
    parent = parent.parent;
  }
  return null;
}

/**
 * 骨骼在骨架中的深度（根骨骼 = 0），同样穿透非骨骼节点。
 * 供下游骨架可视化按深度排序 / 分色。
 */
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
 *
 * 具体流程：
 *  1. 统计「被至少一条生效 Strip 覆盖、且克隆骨架里确实存在」的骨骼集合 animated，
 *     只有这些骨骼写旋转轨道；其余骨骼在播放时保持绑定姿态（体积小、语义也更清晰）。
 *  2. 按 fps 均匀采样，每帧调用 applyStrips 求值，记录四元数（全部 animated 骨骼）
 *     与髋部位置（唯一会位移的骨骼，见 StripParts.isHipsBone）。
 *  3. 同时输出 joints 元信息（name/label/parent/depth/rest），供下游骨架可视化与重定向使用。
 *
 * 边界：
 *  - 采样帧数至少 2（单帧动画在 Three.js 里无法插值）；duration 至少 1/fps。
 *  - 采样时刻用 min(index/fps, safeDuration) 夹取，保证最后一帧正好落在结尾。
 *  - 若某骨骼在克隆骨架中不存在（来源动画缺骨），不会进入 animated，也不会产生轨道。
 *
 * @param entries    Strip 求值环境；调用前应确保 action 已绑定到各自克隆骨架
 * @param targetBones 基础骨架（会被本函数反复覆写姿态，调用方负责在结束后恢复时间轴所在帧）
 * @param rest       基础骨架静置姿态
 * @param duration   烘焙总长（秒），通常取时间轴总长；小于 1/fps 时按 1/fps 处理
 * @param fps        采样帧率，StripsPlayer 固定传 30，与 Kimodo 来源保持一致
 * @param clipName   写入 data.clips[0].name 的片段名
 * @returns 可直接保存的 AnimationData（format = 'fbx-animation-data'）
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
  // 只统计「确实会被驱动」的骨骼：部位被覆盖 + 克隆骨架里存在同名骨骼。
  // 这样烘焙体积与来源动画的覆盖面成正比，而不是固定写满整副骨架。
  for (const bone of targetBones) {
    for (const entry of entries) {
      const strip = entry.strip;
      if (strip.muted || strip.weight <= 0 || strip.duration <= 0) continue;
      if (coversBone(strip.parts, bone.name) && entry.bones.has(bone.name)) {
        animated.add(bone.name);
        break;
      }
    }
  }

  // 髋部是唯一会位移的骨骼（根位移），也是下肢运动轨迹的采样点。
  // 找不到髋部（非标准骨架）时退化为「纯旋转动画」，不产出 position 轨道。
  const hips = targetBones.find((bone) => isHipsBone(bone.name)) ?? null;
  // 帧数 = 时长*fps + 1（含首尾两帧），并保证至少 2 帧
  const frameCount = Math.max(2, Math.ceil(safeDuration * fps) + 1);
  const times: number[] = [];
  const quatValues = new Map<string, number[]>();
  for (const name of animated) quatValues.set(name, []);
  const hipsValues: number[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    // 最后一帧夹到 safeDuration，避免浮点误差导致时间略超片段末尾
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

  // joints 元信息：即使该骨骼没被驱动也全部输出，方便下游按 rest 还原未驱动骨骼。
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
  // 每根被驱动的骨骼输出一条四元数轨道；times 复用同一份数组（只读约定，后续不再修改）
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
  // 髋部位置轨道：唯一的位置通道，驱动整具身体的根位移与下肢轨迹
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

  // 与「新建动画」保存格式对齐的完整数据包；excluded 声明本格式不含网格/蒙皮/材质，
  // 便于下游区分「纯动画数据」与「含模型的资产」。
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
