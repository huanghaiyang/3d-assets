import { cleanBoneLabel } from '@/viewer/SkeletonOverlay';
import type { BodyPart } from './StripTypes';

export interface BodyPartOption {
  id: BodyPart;
  label: string;
  hint: string;
}

export const BODY_PARTS: BodyPartOption[] = [
  { id: 'full', label: '全身', hint: '所有骨骼（含髋部）' },
  { id: 'upper', label: '上半身', hint: '脊柱、头颈、双臂' },
  { id: 'lower', label: '下半身', hint: '髋部、双腿' },
  { id: 'head', label: '头部', hint: '颈、头' },
  { id: 'leftArm', label: '左臂', hint: '左肩、手臂、手指' },
  { id: 'rightArm', label: '右臂', hint: '右肩、手臂、手指' },
  { id: 'leftLeg', label: '左腿', hint: '左大腿、小腿、脚' },
  { id: 'rightLeg', label: '右腿', hint: '右大腿、小腿、脚' },
];

type BoneGroup = 'hips' | 'spine' | 'head' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'other';

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

function isLegKeyword(label: string): boolean {
  return label.includes('leg') || label.includes('foot') || label.includes('toe');
}

/** 骨骼 → 身体部位分组；无法识别时归到 other（不参与任何局部掩码） */
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

/** 该部位掩码是否覆盖某根骨骼（传骨骼原名，内部会清理 mixamorig 前缀） */
export function partCoversBone(part: BodyPart, boneName: string): boolean {
  const group = groupOf(cleanBoneLabel(boneName));
  switch (part) {
    case 'full':
      return true;
    case 'upper':
      return group === 'spine' || group === 'head' || group === 'leftArm' || group === 'rightArm';
    case 'lower':
      return group === 'hips' || group === 'leftLeg' || group === 'rightLeg';
    case 'head':
      return group === 'head';
    case 'leftArm':
      return group === 'leftArm';
    case 'rightArm':
      return group === 'rightArm';
    case 'leftLeg':
      return group === 'leftLeg';
    case 'rightLeg':
      return group === 'rightLeg';
    default:
      return false;
  }
}

export function isHipsBone(boneName: string): boolean {
  return groupOf(cleanBoneLabel(boneName)) === 'hips';
}
