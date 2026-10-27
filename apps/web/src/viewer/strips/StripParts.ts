/**
 * 身体部位与骨骼的映射表（拼接工作区的「部位」语义来源）。
 *
 * 三种用途，同一套判定：
 *  1. 冲突校验：一条 Strip 占用的部位不能被另一条 Strip 重复占用（store.setStripParts）；
 *  2. 顶点染色：对每个蒙皮顶点取其权重最大的骨骼，反查部位，从而把该顶点染成占用者的颜色；
 *  3. 逐骨骼混合：混合时只有骨骼所属部位被某条 Strip 覆盖，才采用该 Strip 的姿态（StripBlend）。
 *
 * 之所以让 5 个部位「互不重叠」，是为了让「一个部位只属于一个源动画」这条规则
 * 能直接等同于「最多 5 个源动画」，避免比例权重导致的部位内部撕裂。
 *
 * 命名约定：基础模型来自 Mixamo，骨骼名形如 `mixamorigLeftArm`，因此判定前统一用
 * cleanBoneLabel() 去掉 `mixamorig` 前缀并转小写处理。
 */
import { cleanBoneLabel } from '@/viewer/SkeletonOverlay';
import type { BodyPart } from './StripTypes';

export interface BodyPartOption {
  /** 与 BodyPart 联合类型一一对应 */
  id: BodyPart;
  /** 检查器 / 时间轴上的中文名 */
  label: string;
  /** 悬停提示，说明该部位实际覆盖的骨骼范围 */
  hint: string;
}

/**
 * 5 个互不重叠的身体部位。
 * 互不重叠保证「每个部位只能由一个源动画占用」，同时最多 5 个源动画。
 * 数组顺序即 UI 展示顺序与时间轴 lane 顺序（与 StripTypes.BODY_PART_IDS 保持一致）。
 */
export const BODY_PARTS: BodyPartOption[] = [
  { id: 'head', label: '头颈', hint: '颈、头' },
  { id: 'torso', label: '躯干', hint: '脊柱、胸腔' },
  { id: 'leftArm', label: '左臂', hint: '左肩、手臂、手指' },
  { id: 'rightArm', label: '右臂', hint: '右肩、手臂、手指' },
  { id: 'legs', label: '下肢', hint: '髋部、双腿、双脚' },
];

/**
 * 中间粒度：骨骼分组。
 * 把「左腿/右腿」分开识别，最后再合并成同一个 `legs` 部位；
 * 这样手指/脚趾等末端骨骼也能被正确归类，而不需要枚举每个骨骼名。
 */
type BoneGroup = 'hips' | 'spine' | 'head' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'other';

/**
 * 是否为手臂系骨骼。
 * @param label 已清理（去前缀、小写）的骨骼名
 * @returns 命中肩/臂/手/手指任意关键字时为 true
 */
function isArmKeyword(label: string): boolean {
  return (
    label.includes('shoulder') ||
    label.includes('arm') ||
    label.includes('hand') ||
    label.includes('thumb') ||
    label.includes('index') ||
    label.includes('middle') ||
    label.includes('ring') ||
    label.includes('pinky')
  );
}

/**
 * 是否为腿系骨骼。
 * 注意：不包含 hips/pelvis（髋部单独归到 hips 组），避免躯干位移被误判为下肢。
 * @param label 已清理的骨骼名
 */
function isLegKeyword(label: string): boolean {
  return label.includes('leg') || label.includes('foot') || label.includes('toe');
}

/**
 * 骨骼 → 身体部位分组；无法识别时归到 other（不参与任何局部掩码）。
 *
 * 判定顺序（自上而下短路，越靠前优先级越高）：
 *  hips/root/pelvis → hips；spine/chest/torso 开头 → spine；
 *  neck/head/eye/jaw/ear 开头 → head；left/right 前缀再分腿、臂；其余 other。
 *
 * @param label 原始骨骼名（内部会 cleanBoneLabel，允许带 mixamorig 前缀）
 */
function groupOf(label: string): BoneGroup {
  const lower = label.toLowerCase();
  if (lower === 'hips' || lower === 'pelvis' || lower === 'root') return 'hips';
  if (lower.startsWith('spine') || lower.startsWith('chest') || lower.startsWith('torso')) return 'spine';
  if (
    lower.startsWith('neck') ||
    lower.startsWith('head') ||
    lower.startsWith('eye') ||
    lower.startsWith('jaw') ||
    lower.startsWith('ear')
  ) {
    return 'head';
  }
  if (lower.startsWith('left')) {
    if (isLegKeyword(lower)) return 'leftLeg';
    if (isArmKeyword(lower)) return 'leftArm';
  }
  if (lower.startsWith('right')) {
    if (isLegKeyword(lower)) return 'rightLeg';
    if (isArmKeyword(lower)) return 'rightArm';
  }
  return 'other';
}

/**
 * 骨骼归属的唯一部位（用于顶点染色 / 冲突校验）。
 *
 * 左右腿会合并为同一个 `legs`，因为「下肢」在 UI 上是一个整体槽位；
 * 髋部（hips）也归入 legs，这样下肢来源动画可以同时带根位移。
 *
 * @param boneName 骨骼名（可带 mixamorig 前缀）
 * @returns 对应部位；无法识别（如手指之外的辅助骨骼、Twist 骨骼等）返回 null
 */
export function partOfBone(boneName: string): BodyPart | null {
  switch (groupOf(cleanBoneLabel(boneName))) {
    case 'hips':
    case 'leftLeg':
    case 'rightLeg':
      return 'legs';
    case 'spine':
      return 'torso';
    case 'head':
      return 'head';
    case 'leftArm':
      return 'leftArm';
    case 'rightArm':
      return 'rightArm';
    default:
      return null;
  }
}

/**
 * 该部位是否覆盖某根骨骼（传骨骼原名，内部会清理 mixamorig 前缀）。
 * 语义等价于 partOfBone(boneName) === part，保留独立函数是为了调用处可读性。
 */
export function partCoversBone(part: BodyPart, boneName: string): boolean {
  return partOfBone(boneName) === part;
}

/**
 * 一组部位是否覆盖某根骨骼。
 * 这是 StripBlend 逐骨骼混合的热路径函数，因此直接比较 partOfBone 的结果，
 * 不做数组深拷贝或 Set 构造。
 *
 * @param parts 某条 Strip 占用的部位（可能为空数组 → 不覆盖任何骨骼）
 * @returns 该骨骼归属的部位在 parts 中时为 true；骨骼无法识别时为 false
 */
export function coversBone(parts: readonly BodyPart[], boneName: string): boolean {
  const part = partOfBone(boneName);
  return part !== null && parts.includes(part);
}

/**
 * 是否髋部骨骼。
 * 只有髋部会在混合时参与「位置」计算（其余骨骼一律写回静置位置），
 * 因为不同源动画的骨架比例可能不同，混合位置会把骨架拉扯变形。
 */
export function isHipsBone(boneName: string): boolean {
  return groupOf(cleanBoneLabel(boneName)) === 'hips';
}
