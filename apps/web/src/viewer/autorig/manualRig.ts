import * as THREE from 'three';
import { fitHumanoid, type CapsuleSpec, type RigBoneDef } from './autoRig';

/**
 * 手动绑骨：人形参考关节（基础 19 骨 + 双手各 15 根指骨）。
 *
 * 流程对齐 Auto-Rig Pro 的「参考骨骼」思路：
 *  1. 先用现有的几何拟合给出一套初始关节位置（站姿自适应）；
 *  2. 用户在视口里拖动关节标记（或侧栏输入坐标）修正位置；
 *  3. 关节拖动只影响骨架预览，点「完成绑定」时才按当前坐标重建蒙皮胶囊、
 *     计算权重并把网格换成 SkinnedMesh。
 *
 * 这里只做关节 → 骨架 → 权重，不复制任何第三方插件源码；蒙皮算法与自动绑骨
 * 共用 autoRig.ts 里的胶囊衰减实现。
 */

/** 关节标记的类别：bone 参与建骨，tip 只用于定义末端胶囊（不生成骨骼） */
export type ManualJointKind = 'bone' | 'tip';

export interface ManualRigJointInfo {
  name: string;
  position: [number, number, number];
  kind: ManualJointKind;
  side: 'left' | 'right' | 'center';
  finger: boolean;
  /** 参考骨胶囊半径（世界单位）；末端参考点没有半径，为 null */
  radius: number | null;
}

export interface ManualRigMetrics {
  height: number;
  baseY: number;
  topY: number;
  centerX: number;
  centerZ: number;
  torso: number;
  neck: number;
  head: number;
  hipBand: number;
  shoulderBand: number;
  arm: Record<'L' | 'R', { upper: number; fore: number; hand: number }>;
  leg: Record<'L' | 'R', { thigh: number; shin: number; foot: number }>;
  finger: Record<'L' | 'R', number>;
}

export interface ManualRigState {
  boneDefs: RigBoneDef[];
  /** 当前关节世界坐标（含 tip 伪关节） */
  joints: Map<string, THREE.Vector3>;
  /** 初始关节位置，「重置」时恢复 */
  initial: Map<string, THREE.Vector3>;
  /** 每根参考骨的胶囊半径（对应 Auto-Rig Pro 参考骨的 radius） */
  radii: Map<string, number>;
  /** 初始半径，「重置」时恢复 */
  initialRadii: Map<string, number>;
  /**
   * 已在视口放置过的标记（ARP 的 Add Markers）。
   * 未放置的标记在视口里不显示，必须先「添加」再点模型落点。
   */
  placed: Set<string>;
  /** 手指胶囊的基准半径，供「手指粗细」按比例缩放 */
  fingerBaseRadii: Map<string, number>;
  /** 手指粗细缩放系数（1 = 拟合值） */
  fingerScale: number;
  metrics: ManualRigMetrics;
  /** 展示顺序（先躯干、再四肢、最后手指） */
  jointOrder: string[];
}

/** 基础 19 骨：与自动绑骨同名，便于复用权重与动画重定向 */
const BASE_BONE_DEFS: RigBoneDef[] = [
  { name: 'Hips', parent: null },
  { name: 'Spine', parent: 'Hips' },
  { name: 'Chest', parent: 'Spine' },
  { name: 'Neck', parent: 'Chest' },
  { name: 'Head', parent: 'Neck' },

  { name: 'ShoulderL', parent: 'Chest' },
  { name: 'UpperArmL', parent: 'ShoulderL' },
  { name: 'ForearmL', parent: 'UpperArmL' },
  { name: 'HandL', parent: 'ForearmL' },

  { name: 'ShoulderR', parent: 'Chest' },
  { name: 'UpperArmR', parent: 'ShoulderR' },
  { name: 'ForearmR', parent: 'UpperArmR' },
  { name: 'HandR', parent: 'ForearmR' },

  { name: 'UpperLegL', parent: 'Hips' },
  { name: 'LowerLegL', parent: 'UpperLegL' },
  { name: 'FootL', parent: 'LowerLegL' },

  { name: 'UpperLegR', parent: 'Hips' },
  { name: 'LowerLegR', parent: 'UpperLegR' },
  { name: 'FootR', parent: 'LowerLegR' },
];

/** 五指键名与摆放参数（offset 为手掌横向偏移，length 为指长系数，spread 为张开角度） */
const FINGERS = [
  { key: 'Thumb', offset: 0.55, length: 0.62, spread: 0.55 },
  { key: 'Index', offset: 0.2, length: 1, spread: 0.18 },
  { key: 'Middle', offset: 0, length: 1.06, spread: 0 },
  { key: 'Ring', offset: -0.2, length: 0.94, spread: -0.18 },
  { key: 'Pinky', offset: -0.38, length: 0.78, spread: -0.34 },
] as const;

const FINGER_KEYS = FINGERS.map((finger) => finger.key);

/** 完整骨骼定义：基础 19 骨 + 双手 30 根指骨（每指 3 节） */
export const MANUAL_BONE_DEFS: RigBoneDef[] = [
  ...BASE_BONE_DEFS,
  ...(['L', 'R'] as const).flatMap((suffix) =>
    FINGERS.flatMap((finger) => [
      { name: `${finger.key}1${suffix}`, parent: `Hand${suffix}` },
      { name: `${finger.key}2${suffix}`, parent: `${finger.key}1${suffix}` },
      { name: `${finger.key}3${suffix}`, parent: `${finger.key}2${suffix}` },
    ]),
  ),
];

const JOINT_ORDER: string[] = [
  ...BASE_BONE_DEFS.map((bone) => bone.name),
  'HandTipL',
  'HandTipR',
  'ToeL',
  'ToeR',
  ...(['L', 'R'] as const).flatMap((suffix) =>
    FINGERS.flatMap((finger) => [
      `${finger.key}1${suffix}`,
      `${finger.key}2${suffix}`,
      `${finger.key}3${suffix}`,
      `${finger.key}Tip${suffix}`,
    ]),
  ),
];

/** 关节名后缀判断左右；中线骨骼没有后缀 */
export function jointSide(name: string): 'left' | 'right' | 'center' {
  if (name.endsWith('L')) return 'left';
  if (name.endsWith('R')) return 'right';
  return 'center';
}

/**
 * Smart 标记目录（对齐 Auto-Rig Pro 的 Add Markers）。
 *
 * label 是中文界面名，name 是 ARP 英文界面的标记名，joint 指向本项目的参考关节：
 * 标记本身不新建骨骼，落点直接写进对应关节，再按关节重建胶囊与权重。
 */
export interface ManualMarkerDef {
  /** 中文标记名（面板与提示使用） */
  label: string;
  /** 英文标记名（ARP 的叫法） */
  name: string;
  /** 对应的参考关节 */
  joint: string;
  /** 必需标记：全部放置后才允许 Go! */
  required: boolean;
}

export const MANUAL_MARKERS: ManualMarkerDef[] = [
  { label: '下巴', name: 'Chin', joint: 'Head', required: true },
  { label: '颈部', name: 'Neck', joint: 'Neck', required: true },
  { label: '盆骨', name: 'Pelvis', joint: 'Hips', required: true },
  { label: '左肩', name: 'Shoulder.L', joint: 'ShoulderL', required: true },
  { label: '右肩', name: 'Shoulder.R', joint: 'ShoulderR', required: true },
  { label: '左肘', name: 'Elbow.L', joint: 'UpperArmL', required: true },
  { label: '右肘', name: 'Elbow.R', joint: 'UpperArmR', required: true },
  { label: '左腕', name: 'Wrist.L', joint: 'ForearmL', required: true },
  { label: '右腕', name: 'Wrist.R', joint: 'ForearmR', required: true },
  { label: '左髋', name: 'Hip.L', joint: 'UpperLegL', required: true },
  { label: '右髋', name: 'Hip.R', joint: 'UpperLegR', required: true },
  { label: '左膝', name: 'Knee.L', joint: 'LowerLegL', required: true },
  { label: '右膝', name: 'Knee.R', joint: 'LowerLegR', required: true },
  { label: '左踝', name: 'Ankle.L', joint: 'FootL', required: true },
  { label: '右踝', name: 'Ankle.R', joint: 'FootR', required: true },
  { label: '左脚掌', name: 'Foot.L', joint: 'ToeL', required: false },
  { label: '右脚掌', name: 'Foot.R', joint: 'ToeR', required: false },
];

/** 属于 Smart 标记的关节集合（其余关节是派生关节，始终显示） */
export const MARKER_JOINTS = new Set(MANUAL_MARKERS.map((marker) => marker.joint));

/** 是否属于手指（含指尖伪关节） */
export function isFingerJoint(name: string): boolean {
  return FINGER_KEYS.some((key) => name.startsWith(key));
}

/** 名称 → 对侧名称；中线关节返回 null */
function mirrorName(name: string): string | null {
  if (name.endsWith('L')) return `${name.slice(0, -1)}R`;
  if (name.endsWith('R')) return `${name.slice(0, -1)}L`;
  return null;
}

function requiredJoint(joints: Map<string, THREE.Vector3>, name: string): THREE.Vector3 {
  const point = joints.get(name);
  if (!point) throw new Error(`缺少关节：${name}`);
  return point;
}

/** 取某个骨骼对应的胶囊（可按方向筛选，例如躯干用 side=center） */
function capsuleOf(
  capsules: readonly CapsuleSpec[],
  bone: string,
  side?: 'left' | 'right' | 'center',
): CapsuleSpec | null {
  return capsules.find((capsule) => capsule.bone === bone && (side === undefined || capsule.side === side)) ?? null;
}

/** 从拟合结果里读出各类胶囊半径；读不到时给一个按身高比例的安全值 */
function measureMetrics(fit: { capsules: CapsuleSpec[]; height: number; baseY: number; centerX: number; centerZ: number }): ManualRigMetrics {
  const { height } = fit;
  const torsoCapsule = capsuleOf(fit.capsules, 'Chest', 'center') ?? capsuleOf(fit.capsules, 'Spine', 'center');
  const neckCapsule = capsuleOf(fit.capsules, 'Neck', 'center');
  const headCapsule = capsuleOf(fit.capsules, 'Head', 'center');
  const hipBandCapsule = fit.capsules.find(
    (capsule) => capsule.bone === 'Hips' && Math.abs(capsule.a.x - capsule.b.x) > height * 0.1,
  );
  const shoulderBandCapsule = fit.capsules.find(
    (capsule) => capsule.bone === 'Chest' && Math.abs(capsule.a.x - capsule.b.x) > height * 0.1,
  );

  const sideRadii = (suffix: 'L' | 'R', tag: 'left' | 'right') => ({
    upper: (capsuleOf(fit.capsules, `UpperArm${suffix}`, tag)?.radius ?? height * 0.05),
    fore: (capsuleOf(fit.capsules, `Forearm${suffix}`, tag)?.radius ?? height * 0.043),
    hand: (capsuleOf(fit.capsules, `Hand${suffix}`, tag)?.radius ?? height * 0.03),
  });

  const legRadii = (suffix: 'L' | 'R', tag: 'left' | 'right') => ({
    thigh: (capsuleOf(fit.capsules, `UpperLeg${suffix}`, tag)?.radius ?? height * 0.075),
    shin: (capsuleOf(fit.capsules, `LowerLeg${suffix}`, tag)?.radius ?? height * 0.06),
    foot: (capsuleOf(fit.capsules, `Foot${suffix}`, tag)?.radius ?? height * 0.038),
  });

  const armL = sideRadii('L', 'left');
  const armR = sideRadii('R', 'right');

  return {
    height,
    baseY: fit.baseY,
    topY: fit.baseY + height,
    centerX: fit.centerX,
    centerZ: fit.centerZ,
    torso: (torsoCapsule?.radius ?? height * 0.115),
    neck: (neckCapsule?.radius ?? height * 0.045),
    head: (headCapsule?.radius ?? height * 0.08),
    hipBand: (hipBandCapsule?.radius ?? height * 0.06),
    shoulderBand: (shoulderBandCapsule?.radius ?? height * 0.06),
    arm: { L: armL, R: armR },
    leg: { L: legRadii('L', 'left'), R: legRadii('R', 'right') },
    finger: {
      L: Math.max(armL.hand * 0.26, height * 0.005),
      R: Math.max(armR.hand * 0.26, height * 0.005),
    },
  };
}

/**
 * 按测量出的肢体粗细给每根参考骨一个默认胶囊半径。
 *
 * 对应 Auto-Rig Pro 参考骨上的 radius：胶囊（也就是蒙皮影响范围）由它决定，
 * 用户可以在侧栏单独调某一根，修正「大腿吞掉另一条腿」「肩膀带走胸口」这类问题。
 */
function defaultRadii(metrics: ManualRigMetrics): Map<string, number> {
  const { height, torso, neck, head } = metrics;
  const radii = new Map<string, number>();
  radii.set('Hips', torso * 0.95);
  radii.set('Spine', torso * 0.92);
  radii.set('Chest', torso);
  radii.set('Neck', neck);
  radii.set('Head', head);

  for (const suffix of ['L', 'R'] as const) {
    const arm = metrics.arm[suffix];
    radii.set(`Shoulder${suffix}`, Math.max(arm.upper * 1.08, height * 0.03));
    radii.set(`UpperArm${suffix}`, arm.upper);
    radii.set(`Forearm${suffix}`, arm.fore);
    radii.set(`Hand${suffix}`, Math.max(arm.hand, height * 0.018));

    const leg = metrics.leg[suffix];
    radii.set(`UpperLeg${suffix}`, leg.thigh);
    radii.set(`LowerLeg${suffix}`, leg.shin);
    radii.set(`Foot${suffix}`, Math.max(leg.foot, height * 0.022));

    const finger = metrics.finger[suffix];
    for (const item of FINGERS) {
      radii.set(`${item.key}1${suffix}`, finger);
      radii.set(`${item.key}2${suffix}`, finger * 0.94);
      radii.set(`${item.key}3${suffix}`, finger * 0.88);
    }
  }
  return radii;
}

/**
 * 按「腕 → 指尖」方向生成一只手的三节手指。
 *
 * 生成模型的手普遍是连指/简化手，这里不做指骨识别，只保证：
 *  - 五指位于手掌范围内、不伸到网格外；
 *  - 指骨方向沿手掌轴线，张开角很小；
 *  - 指尖伪关节作为第三节骨骼的胶囊端点。
 */
function addFingerJoints(
  joints: Map<string, THREE.Vector3>,
  suffix: 'L' | 'R',
  handName: string,
  tipName: string,
  handRadius: number,
  height: number,
): void {
  const wrist = requiredJoint(joints, handName);
  const tip = requiredJoint(joints, tipName);
  const handVector = tip.clone().sub(wrist);
  const handLength = handVector.length();
  if (!(handLength > height * 0.01)) return;
  const handDir = handVector.clone().normalize();

  // 手掌横向：世界 X 投影到垂直于手轴的方向；手轴本身接近 X 时退回世界 Z
  const lateral = new THREE.Vector3(1, 0, 0);
  lateral.addScaledVector(handDir, -lateral.dot(handDir));
  if (lateral.lengthSq() < 1e-6) {
    lateral.set(0, 0, 1);
    lateral.addScaledVector(handDir, -lateral.dot(handDir));
  }
  lateral.normalize();

  const palmBase = wrist.clone().addScaledVector(handDir, handLength * 0.45);
  for (const finger of FINGERS) {
    const base = palmBase
      .clone()
      .addScaledVector(lateral, handRadius * finger.offset * 2.4);
    const fingerDir = handDir.clone().addScaledVector(lateral, finger.spread * 0.28).normalize();
    // 手指总长相对手掌长度：拇指短、中指略长
    const total = handLength * 0.52 * finger.length;
    const first = total * 0.42;
    const second = total * 0.33;
    const third = total * 0.25;

    const joint1 = base.clone();
    const joint2 = joint1.clone().addScaledVector(fingerDir, first);
    const joint3 = joint2.clone().addScaledVector(fingerDir, second);
    const fingerTip = joint3.clone().addScaledVector(fingerDir, third);

    joints.set(`${finger.key}1${suffix}`, joint1);
    joints.set(`${finger.key}2${suffix}`, joint2);
    joints.set(`${finger.key}3${suffix}`, joint3);
    joints.set(`${finger.key}Tip${suffix}`, fingerTip);
  }
}

/**
 * 生成手动绑骨的初始状态：复用自动绑骨几何拟合出的 19 个关节与半径，
 * 再补上手部末端、脚趾与手指关节。
 *
 * @param options.guessMarkers true = 一次性按拟合结果放置全部标记（ARP 的 Guess Markers）；
 *   false = 标记为空，用户逐个「添加」后在视口点模型落点（ARP 的 Add Markers）。
 */
export function buildManualRigState(
  root: THREE.Object3D,
  meshes: THREE.Mesh[],
  options: { guessMarkers?: boolean } = {},
): ManualRigState {
  root.updateMatrixWorld(true);
  const fit = fitHumanoid(root, meshes);
  const joints = new Map<string, THREE.Vector3>();
  for (const [name, point] of fit.joints) joints.set(name, point.clone());

  // 手部末端 / 脚趾：直接取拟合胶囊的另一端，保证胶囊覆盖到指尖与脚尖
  for (const suffix of ['L', 'R'] as const) {
    const tag = suffix === 'L' ? 'left' : 'right';
    const hand = capsuleOf(fit.capsules, `Hand${suffix}`, tag);
    if (hand) joints.set(`HandTip${suffix}`, hand.b.clone());
    const foot = capsuleOf(fit.capsules, `Foot${suffix}`, tag);
    if (foot) joints.set(`Toe${suffix}`, foot.b.clone());
  }
  // 拟合失败（理论上不会）时给一个沿 +Z 的兜底末端
  const metrics = measureMetrics(fit);
  for (const suffix of ['L', 'R'] as const) {
    if (!joints.has(`HandTip${suffix}`)) {
      joints.set(
        `HandTip${suffix}`,
        requiredJoint(joints, `Hand${suffix}`)
          .clone()
          .add(new THREE.Vector3(suffix === 'L' ? -metrics.height * 0.03 : metrics.height * 0.03, 0, 0)),
      );
    }
    if (!joints.has(`Toe${suffix}`)) {
      joints.set(
        `Toe${suffix}`,
        requiredJoint(joints, `Foot${suffix}`)
          .clone()
          .add(new THREE.Vector3(0, -metrics.height * 0.01, metrics.height * 0.08)),
      );
    }
    addFingerJoints(joints, suffix, `Hand${suffix}`, `HandTip${suffix}`, metrics.arm[suffix].hand, metrics.height);
  }

  const initial = new Map<string, THREE.Vector3>();
  for (const [name, point] of joints) initial.set(name, point.clone());

  const radii = defaultRadii(metrics);
  const initialRadii = new Map(radii);
  const fingerBaseRadii = new Map<string, number>();
  for (const [name, radius] of radii) {
    if (isFingerJoint(name)) fingerBaseRadii.set(name, radius);
  }

  return {
    boneDefs: MANUAL_BONE_DEFS,
    joints,
    initial,
    radii,
    initialRadii,
    placed: new Set(options.guessMarkers ? MANUAL_MARKERS.map((marker) => marker.joint) : []),
    fingerBaseRadii,
    fingerScale: 1,
    metrics,
    jointOrder: [...JOINT_ORDER],
  };
}

/**
 * 按当前关节坐标重建蒙皮胶囊。
 *
 * 胶囊的端点全部由关节 + 少量按身高的偏移推出，所以拖动关节后重新调用即可
 * 得到与新骨架吻合的蒙皮范围；半径沿用拟合测出的肢体粗细。
 */
export function buildManualCapsules(state: ManualRigState): CapsuleSpec[] {
  const { joints, metrics, radii } = state;
  const { height } = metrics;
  /** 参考骨 radius 优先；缺省时退回测量值，并夹在所有胶囊的合理范围内 */
  const radiusOf = (bone: string, fallback: number): number => {
    const value = radii.get(bone);
    const radius = Number.isFinite(value) ? (value as number) : fallback;
    return Math.max(height * 0.002, radius);
  };
  const capsule = (
    bone: string,
    a: THREE.Vector3,
    b: THREE.Vector3,
    radius: number,
    side: 'left' | 'right' | 'center',
  ): CapsuleSpec => ({ bone, a: a.clone(), b: b.clone(), radius, side });

  const hips = requiredJoint(joints, 'Hips');
  const spine = requiredJoint(joints, 'Spine');
  const chest = requiredJoint(joints, 'Chest');
  const neck = requiredJoint(joints, 'Neck');
  const head = requiredJoint(joints, 'Head');
  const shoulderL = requiredJoint(joints, 'ShoulderL');
  const shoulderR = requiredJoint(joints, 'ShoulderR');

  const capsules: CapsuleSpec[] = [
    capsule(
      'Hips',
      hips.clone().add(new THREE.Vector3(0, -height * 0.06, 0)),
      hips,
      radiusOf('Hips', metrics.torso * 0.95),
      'center',
    ),
    capsule(
      'Hips',
      requiredJoint(joints, 'UpperLegR'),
      requiredJoint(joints, 'UpperLegL'),
      metrics.hipBand,
      'center',
    ),
    capsule('Spine', hips, spine, radiusOf('Spine', metrics.torso * 0.92), 'center'),
    capsule('Chest', spine, chest, radiusOf('Chest', metrics.torso), 'center'),
    // 肩带横条保持独立半径：调细上臂不应该让胸口跟着丢掉
    capsule('Chest', shoulderR, shoulderL, metrics.shoulderBand, 'center'),
    capsule(
      'Neck',
      neck,
      neck.clone().add(new THREE.Vector3(0, height * 0.02, 0)),
      radiusOf('Neck', metrics.neck),
      'center',
    ),
    capsule(
      'Head',
      head,
      head.clone().add(new THREE.Vector3(0, Math.min(height * 0.1, Math.max(height * 0.02, metrics.topY - head.y)), 0)),
      radiusOf('Head', metrics.head),
      'center',
    ),
  ];

  for (const suffix of ['L', 'R'] as const) {
    const tag = suffix === 'L' ? 'left' : 'right';
    const radii2 = metrics.arm[suffix];
    const shoulder = requiredJoint(joints, `Shoulder${suffix}`);
    const upper = requiredJoint(joints, `UpperArm${suffix}`);
    const fore = requiredJoint(joints, `Forearm${suffix}`);
    const hand = requiredJoint(joints, `Hand${suffix}`);
    const handTip = requiredJoint(joints, `HandTip${suffix}`);
    capsules.push(
      capsule(`Shoulder${suffix}`, shoulder, upper, radiusOf(`Shoulder${suffix}`, Math.max(radii2.upper * 1.08, height * 0.03)), tag),
      capsule(`UpperArm${suffix}`, upper, fore, radiusOf(`UpperArm${suffix}`, radii2.upper), tag),
      capsule(`Forearm${suffix}`, fore, hand, radiusOf(`Forearm${suffix}`, radii2.fore), tag),
      capsule(`Hand${suffix}`, hand, handTip, radiusOf(`Hand${suffix}`, Math.max(radii2.hand, height * 0.018)), tag),
    );

    const legRadii = metrics.leg[suffix];
    const legUpper = requiredJoint(joints, `UpperLeg${suffix}`);
    const knee = requiredJoint(joints, `LowerLeg${suffix}`);
    const ankle = requiredJoint(joints, `Foot${suffix}`);
    const toe = requiredJoint(joints, `Toe${suffix}`);
    capsules.push(
      capsule(`UpperLeg${suffix}`, legUpper, knee, radiusOf(`UpperLeg${suffix}`, legRadii.thigh), tag),
      capsule(`LowerLeg${suffix}`, knee, ankle, radiusOf(`LowerLeg${suffix}`, legRadii.shin), tag),
      capsule(
        `Foot${suffix}`,
        ankle.clone().add(new THREE.Vector3(0, height * 0.005, -height * 0.02)),
        toe,
        radiusOf(`Foot${suffix}`, Math.max(legRadii.foot, height * 0.022)),
        tag,
      ),
    );

    for (const finger of FINGERS) {
      const fallback = metrics.finger[suffix];
      capsules.push(
        capsule(
          `${finger.key}1${suffix}`,
          requiredJoint(joints, `${finger.key}1${suffix}`),
          requiredJoint(joints, `${finger.key}2${suffix}`),
          radiusOf(`${finger.key}1${suffix}`, fallback),
          tag,
        ),
        capsule(
          `${finger.key}2${suffix}`,
          requiredJoint(joints, `${finger.key}2${suffix}`),
          requiredJoint(joints, `${finger.key}3${suffix}`),
          radiusOf(`${finger.key}2${suffix}`, fallback * 0.94),
          tag,
        ),
        capsule(
          `${finger.key}3${suffix}`,
          requiredJoint(joints, `${finger.key}3${suffix}`),
          requiredJoint(joints, `${finger.key}Tip${suffix}`),
          radiusOf(`${finger.key}3${suffix}`, fallback * 0.88),
          tag,
        ),
      );
    }
  }

  return capsules;
}

/** 左右镜像：以模型中线（metrics.centerX）为对称面，把 L/R 关节的 X 取反（半径一并镜像） */
export function mirrorManualJoints(state: ManualRigState): void {
  const { joints, metrics, radii } = state;
  for (const [name, point] of joints) {
    if (!name.endsWith('L')) continue;
    const twin = mirrorName(name);
    if (!twin) continue;
    const peer = joints.get(twin);
    if (!peer) continue;
    // 通过 moveManualJointTo 同步平移：手腕镜像后手指、手尖也跟着过去
    moveManualJointTo(state, twin, new THREE.Vector3(metrics.centerX * 2 - point.x, point.y, point.z));
    if (state.placed.has(name)) state.placed.add(twin);
    const radius = radii.get(name);
    if (radius !== undefined) radii.set(twin, radius);
  }
}

/** 把各关节与参考骨半径恢复到进入手动绑骨时的初始值 */
export function resetManualJoints(state: ManualRigState): void {
  for (const [name, point] of state.initial) {
    const current = state.joints.get(name);
    if (current) current.copy(point);
  }
  for (const [name, radius] of state.initialRadii) state.radii.set(name, radius);
  state.fingerScale = 1;
}

/** 修改某根参考骨的胶囊半径（世界单位），用于局部修正蒙皮影响范围 */
export function setManualRigRadius(state: ManualRigState, name: string, radius: number): void {
  if (!state.radii.has(name) || !Number.isFinite(radius)) return;
  const { height } = state.metrics;
  state.radii.set(name, Math.max(height * 0.002, Math.min(height * 0.4, radius)));
}

/** 生成给侧栏 / 视口用的关节快照 */
export function manualJointInfos(state: ManualRigState): ManualRigJointInfo[] {
  const boneNames = new Set(state.boneDefs.map((def) => def.name));
  return state.jointOrder.map((name) => {
    const point = requiredJoint(state.joints, name);
    return {
      name,
      position: [point.x, point.y, point.z],
      kind: boneNames.has(name) ? 'bone' : 'tip',
      side: jointSide(name),
      finger: isFingerJoint(name),
      radius: state.radii.get(name) ?? null,
    };
  });
}

// ===== Smart 标记（Auto-Rig Pro 的 Add Markers） =====

/** 手指粗细缩放（1 = 拟合值）：只改手指胶囊半径，不改关节位置 */
export function setFingerRadiusScale(state: ManualRigState, scale: number): void {
  if (!Number.isFinite(scale)) return;
  const clamped = Math.max(0.4, Math.min(2.5, scale));
  state.fingerScale = clamped;
  for (const [name, base] of state.fingerBaseRadii) {
    state.radii.set(name, base * clamped);
  }
}

/**
 * 移动某个关节时跟着一起平移的派生关节。
 * 手腕 / 手掌移动后，手尖与五指不能留在原地，否则重建胶囊时手会断开。
 */
function dependentJoints(state: ManualRigState, name: string): string[] {
  const side = jointSide(name);
  if (side === 'center') return [];
  const suffix = side === 'left' ? 'L' : 'R';
  const fingers = state.jointOrder.filter((item) => item.endsWith(suffix) && isFingerJoint(item));
  if (name === `Forearm${suffix}`) return [`Hand${suffix}`, `HandTip${suffix}`, ...fingers];
  if (name === `Hand${suffix}`) return [`HandTip${suffix}`, ...fingers];
  if (name === `Foot${suffix}`) return [`Toe${suffix}`];
  return [];
}

/** 平移关节并把派生关节一起带走 */
export function translateManualJoint(state: ManualRigState, name: string, delta: THREE.Vector3): void {
  if (delta.lengthSq() < 1e-12) return;
  const point = state.joints.get(name);
  if (!point) return;
  point.add(delta);
  for (const dependent of dependentJoints(state, name)) {
    state.joints.get(dependent)?.add(delta);
  }
}

/** 把关节移动到目标位置（派生关节跟随） */
export function moveManualJointTo(state: ManualRigState, name: string, position: THREE.Vector3): void {
  const current = state.joints.get(name);
  if (!current) return;
  translateManualJoint(state, name, position.clone().sub(current));
}

/**
 * 放置一个 Smart 标记：写关节坐标并标记为「已放置」。
 * 镜像开启且该标记有左右孪生时，对侧按中线同步落位。
 *
 * @returns 被改动的关节名（第一个是目标标记，第二个可能是镜像孪生）
 */
export function placeManualMarker(
  state: ManualRigState,
  name: string,
  position: THREE.Vector3,
  mirror: boolean,
): string[] {
  if (!state.joints.has(name)) return [];
  moveManualJointTo(state, name, position);
  state.placed.add(name);
  const changed = [name];
  if (!mirror) return changed;

  const twin = mirrorName(name);
  const twinPoint = twin ? state.joints.get(twin) : null;
  if (!twin || !twinPoint) return changed;
  const mirrored = new THREE.Vector3(state.metrics.centerX * 2 - position.x, position.y, position.z);
  moveManualJointTo(state, twin, mirrored);
  state.placed.add(twin);
  changed.push(twin);
  return changed;
}

/** 一次性放置全部标记（位置沿用几何拟合结果），对应 ARP 的 Guess Markers */
export function guessManualMarkers(state: ManualRigState): void {
  for (const marker of MANUAL_MARKERS) state.placed.add(marker.joint);
}

/** 移除全部标记（ARP 的「取消和删除标记」） */
export function clearManualMarkers(state: ManualRigState): void {
  state.placed.clear();
}

/** 记录当前已放置标记的位置，供「恢复上局标记」使用 */
export function captureManualMarkers(state: ManualRigState): Map<string, THREE.Vector3> {
  const snapshot = new Map<string, THREE.Vector3>();
  for (const name of state.placed) {
    const point = state.joints.get(name);
    if (point) snapshot.set(name, point.clone());
  }
  return snapshot;
}

/** 把上一局的标记位置写回当前骨架 */
export function restoreManualMarkers(state: ManualRigState, snapshot: Map<string, THREE.Vector3>): void {
  for (const [name, point] of snapshot) {
    if (!state.joints.has(name)) continue;
    moveManualJointTo(state, name, point.clone());
    state.placed.add(name);
  }
}

/** 还没放置的必需标记 */
export function missingManualMarkers(state: ManualRigState): ManualMarkerDef[] {
  return MANUAL_MARKERS.filter((marker) => marker.required && !state.placed.has(marker.joint));
}

/** 必需标记是否齐全（决定 Go! 是否可以点） */
export function hasRequiredMarkers(state: ManualRigState): boolean {
  return missingManualMarkers(state).length === 0;
}

/** 下一个建议放置的标记：先补齐必需标记，再补可选项 */
export function nextManualMarker(state: ManualRigState): ManualMarkerDef | null {
  return (
    MANUAL_MARKERS.find((marker) => marker.required && !state.placed.has(marker.joint)) ??
    MANUAL_MARKERS.find((marker) => !state.placed.has(marker.joint)) ??
    null
  );
}
