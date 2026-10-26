/** 舞台文档的数据模型（前端与后端共用同一份结构定义） */

export type ActorKind = 'fbx' | 'soma';

export interface ActorTransform {
  x: number;
  z: number;
  /** 绕 Y 轴的朝向，弧度 */
  yaw: number;
}

export interface StageActorDef {
  id: string;
  name: string;
  kind: ActorKind;
  /** kind=fbx 时为动画库里的 FBX 绝对路径；soma 忽略 */
  modelPath?: string;
  transform: ActorTransform;
  visible: boolean;
}

export interface FbxClipSource {
  kind: 'fbx-clip';
  fbxPath: string;
  /** FBX 内嵌片段名 */
  clipName: string;
}

export interface KimodoClipSource {
  kind: 'kimodo';
  animationId: string;
}

/** 「新建动画」工作区里保存的动画项目（Mixamo 格式 JSON 关键帧） */
export interface AnimProjectClipSource {
  kind: 'anim-project';
  projectId: string;
  /** 项目名，仅用于显示与丢失后的兜底文案 */
  projectName: string;
}

export type SegmentSource = FbxClipSource | KimodoClipSource | AnimProjectClipSource;

/** 某一段动画在舞台上的独立摆放（相对角色摆放的偏移） */
export interface SegmentPose {
  x: number;
  z: number;
  yaw: number;
}

/** 缺省站位：与角色摆放重合 */
export const ZERO_SEGMENT_POSE: SegmentPose = { x: 0, z: 0, yaw: 0 };

export interface SegmentDef {
  id: string;
  actorId: string;
  source: SegmentSource;
  /** 片段内裁剪起点（秒） */
  trimStart: number;
  /** 片段内裁剪终点（秒） */
  trimEnd: number;
  /** 与上一段的重叠时长（秒）；第一段忽略 */
  blendIn: number;
  /** 该段的独立站位；缺省表示沿用角色的摆放 */
  pose?: SegmentPose;
  /** 由「过渡动画生成」得到的过渡段：记录它连接的前后两段 */
  transition?: SegmentTransitionLink;
}

/** 过渡段连接的前后两段 id */
export interface SegmentTransitionLink {
  prevId: string;
  nextId: string;
}

export interface StageDoc {
  id: string;
  name: string;
  actors: StageActorDef[];
  /** 同一 actorId 的片段按数组顺序构成该角色的序列 */
  segments: SegmentDef[];
  loop: boolean;
  updatedAt: string;
}

export type StageSummary = Omit<StageDoc, 'actors' | 'segments'> & {
  actorCount: number;
  segmentCount: number;
};

/** 一段片段在全局时间轴上的占位 */
export interface SegmentTiming {
  /** 全局开始时间（秒） */
  start: number;
  /** 全局结束时间（秒） */
  end: number;
  /** 与上一段的重叠时长（已按两段长度做过上限约束） */
  blend: number;
  /** 裁剪后的片段长度 */
  length: number;
  /** 片段内裁剪起点 */
  trimStart: number;
}

export interface TimelinePlan {
  timings: SegmentTiming[];
  total: number;
}

/** 某个时刻要驱动的片段（最多两段：交叉窗口内 A/B） */
export interface ResolvedSlot {
  /** 片段在序列中的下标 */
  index: number;
  /** 应该写到 action.time 的时间（已含裁剪起点） */
  clipTime: number;
  /** 权重，同一时刻所有 slot 的权重之和恒为 1 */
  weight: number;
}

/** 片段素材的稳定标识，用于缓存转换结果 */
export function sourceKey(source: SegmentSource): string {
  if (source.kind === 'kimodo') return `kimodo:${source.animationId}`;
  if (source.kind === 'anim-project') return `anim:${source.projectId}`;
  return `fbx:${source.fbxPath}::${source.clipName}`;
}

/** 某个角色自己的片段序列（保持文档里的顺序） */
export function actorSegments(doc: StageDoc, actorId: string): SegmentDef[] {
  return doc.segments.filter((segment) => segment.actorId === actorId);
}
