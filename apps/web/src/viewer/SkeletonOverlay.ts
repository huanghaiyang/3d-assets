import * as THREE from 'three';

/** 骨骼树节点（供界面渲染） */
export interface BoneNode {
  /** 稳定 id（Object3D.uuid） */
  id: string;
  /** 原始名称，如 mixamorigLeftHand */
  name: string;
  /** 去掉 mixamorig 前缀后的显示名 */
  label: string;
  depth: number;
  children: BoneNode[];
}

export interface FlatBone {
  id: string;
  name: string;
  label: string;
  depth: number;
  parentId: string | null;
}

const DEFAULT_COLOR = new THREE.Color('#5eead4');
const SELECTED_COLOR = new THREE.Color('#fbbf24');
const HOVER_COLOR = new THREE.Color('#f0abfc');

/** 去掉 Mixamo 常见前缀，让树里的名字更短 */
export function cleanBoneLabel(name: string): string {
  return name.replace(/^mixamorig[:_]?/i, '') || name;
}

/**
 * 丢弃"影子骨骼"：祖先里存在同名骨骼的节点。
 *
 * Mixamo 的 FBX 会把每根骨骼包一层同名节点（Model:: 与 LimbNode::），
 * 直接遍历会得到 129 个骨骼对象但只有 65 个唯一名字，骨骼树里每根骨头出现两次。
 * 这里按遍历顺序（父先于子）保留第一次出现的那个，与 three.js 解析
 * 动画轨道时按名字取首个匹配的行为一致。
 *
 * 只在"祖先同名"时丢弃，因此不同分支下的同名骨骼（如左右手都叫 Hand）不会被误删。
 */
export function filterShadowBones(bones: readonly THREE.Bone[]): { kept: THREE.Bone[]; ignored: number } {
  const kept: THREE.Bone[] = [];
  for (const bone of bones) {
    let ancestor: THREE.Object3D | null = bone.parent;
    let shadow = false;
    while (ancestor) {
      if ((ancestor as THREE.Bone).isBone && ancestor.name === bone.name) {
        shadow = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!shadow) kept.push(bone);
  }
  return { kept, ignored: bones.length - kept.length };
}

/**
 * 骨骼可视化叠加层。
 *
 * 关节用点云、父子关系用线段表示；材质关闭深度测试并提高 renderOrder，
 * 因此骨骼会像 DCC 工具那样穿透模型显示。点云同时用于在模型上点选骨骼
 * （对屏幕射线做最近点检测，比射线打网格再反推骨骼更直接）。
 *
 * 叠加层挂在场景根节点上，坐标使用世界坐标，所以模型的缩放/镜像会自动跟随。
 */
export class SkeletonOverlay {
  readonly root = new THREE.Group();

  private readonly bones: THREE.Bone[] = [];
  private readonly indexById = new Map<string, number>();
  private readonly parentIndex: number[] = [];
  private readonly tree: BoneNode[] = [];
  private readonly flat: FlatBone[] = [];
  private readonly selected = new Set<string>();
  private ignoredNodes = 0;

  private readonly pointGeometry = new THREE.BufferGeometry();
  private readonly lineGeometry = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private readonly lines: THREE.LineSegments;
  private readonly step = new THREE.Vector3();
  private readonly linePositions: Float32Array;
  private readonly pointPositions: Float32Array;
  private readonly lineColors: Float32Array;
  private readonly pointColors: Float32Array;
  private readonly segmentBone: number[] = [];
  private hoveredId: string | null = null;
  private visible = true;
  private pickThreshold = 0.05;

  constructor(model: THREE.Object3D) {
    const all: THREE.Bone[] = [];
    model.traverse((child) => {
      if ((child as THREE.Bone).isBone) all.push(child as THREE.Bone);
    });

    // Mixamo FBX 里每根骨骼外套着一层同名包装节点，先剔除影子骨骼
    const { kept, ignored } = filterShadowBones(all);
    this.bones.push(...kept);
    this.ignoredNodes = ignored;

    // 建立索引；父级取"最近的一个真实骨骼祖先"，跳过被忽略的影子节点
    const indexOf = new Map<THREE.Object3D, number>();
    this.bones.forEach((bone, index) => {
      indexOf.set(bone, index);
      this.indexById.set(bone.uuid, index);
    });

    const included = new Set<THREE.Object3D>(this.bones);
    this.bones.forEach((bone, index) => {
      let ancestor: THREE.Object3D | null = bone.parent;
      while (ancestor && !included.has(ancestor)) ancestor = ancestor.parent;
      const parentIndex = ancestor ? indexOf.get(ancestor) : undefined;
      this.parentIndex[index] = parentIndex ?? -1;
      if (parentIndex !== undefined) this.segmentBone.push(index);
    });

    const boneCount = this.bones.length;
    this.pointPositions = new Float32Array(boneCount * 3);
    this.pointColors = new Float32Array(boneCount * 3);
    this.linePositions = new Float32Array(this.segmentBone.length * 2 * 3);
    this.lineColors = new Float32Array(this.segmentBone.length * 2 * 3);

    this.pointGeometry.setAttribute('position', new THREE.BufferAttribute(this.pointPositions, 3));
    this.pointGeometry.setAttribute('color', new THREE.BufferAttribute(this.pointColors, 3));
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.lineGeometry.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3));

    const pointsMaterial = new THREE.PointsMaterial({
      size: 0.035,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const lineMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.pointGeometry, pointsMaterial);
    this.lines = new THREE.LineSegments(this.lineGeometry, lineMaterial);
    this.points.renderOrder = 999;
    this.lines.renderOrder = 998;
    this.points.frustumCulled = false;
    this.lines.frustumCulled = false;

    this.root.add(this.lines, this.points);
    this.buildTree();
    this.refreshPositions();
    this.refreshColors();
  }

  private buildTree(): void {
    const nodes = new Map<number, BoneNode>();
    this.bones.forEach((bone, index) => {
      const node: BoneNode = {
        id: bone.uuid,
        name: bone.name,
        label: cleanBoneLabel(bone.name),
        depth: 0,
        children: [],
      };
      nodes.set(index, node);
      this.flat.push({
        id: bone.uuid,
        name: bone.name,
        label: node.label,
        depth: 0,
        parentId: null,
      });
    });

    // traverse 是前序遍历，父骨骼一定先于子骨骼出现，因此 depth 可以一趟算完
    this.bones.forEach((_, index) => {
      const parent = this.parentIndex[index] ?? -1;
      const node = nodes.get(index)!;
      if (parent >= 0) {
        const parentNode = nodes.get(parent)!;
        node.depth = parentNode.depth + 1;
        parentNode.children.push(node);
        this.flat[index]!.parentId = this.bones[parent]!.uuid;
      } else {
        this.tree.push(node);
      }
      this.flat[index]!.depth = node.depth;
    });
  }

  get boneTree(): BoneNode[] {
    return this.tree;
  }

  get flatBones(): FlatBone[] {
    return this.flat;
  }

  get boneCount(): number {
    return this.bones.length;
  }

  /** 被忽略的 FBX 包装节点数量（同名、不参与形变） */
  get ignoredBoneNodes(): number {
    return this.ignoredNodes;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.visible = on;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** 建议的拾取阈值：按骨骼包围盒尺寸自适应 */
  calibrate(modelHeight: number): void {
    this.pickThreshold = Math.max(0.02, modelHeight * 0.025);
    const material = this.points.material as THREE.PointsMaterial;
    material.size = Math.max(0.02, modelHeight * 0.016);
  }

  setSelection(ids: readonly string[]): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.refreshColors();
  }

  setHovered(id: string | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.refreshColors();
  }

  private refreshColors(): void {
    for (let index = 0; index < this.bones.length; index += 1) {
      const id = this.bones[index]!.uuid;
      const color = this.selected.has(id)
        ? SELECTED_COLOR
        : id === this.hoveredId
          ? HOVER_COLOR
          : DEFAULT_COLOR;
      this.pointColors[index * 3] = color.r;
      this.pointColors[index * 3 + 1] = color.g;
      this.pointColors[index * 3 + 2] = color.b;
    }
    for (let segment = 0; segment < this.segmentBone.length; segment += 1) {
      const index = this.segmentBone[segment]!;
      const boneId = this.bones[index]!.uuid;
      const color = this.selected.has(boneId)
        ? SELECTED_COLOR
        : boneId === this.hoveredId
          ? HOVER_COLOR
          : DEFAULT_COLOR;
      const offset = segment * 6;
      for (let vertex = 0; vertex < 2; vertex += 1) {
        this.lineColors[offset + vertex * 3] = color.r;
        this.lineColors[offset + vertex * 3 + 1] = color.g;
        this.lineColors[offset + vertex * 3 + 2] = color.b;
      }
    }
    this.pointGeometry.getAttribute('color').needsUpdate = true;
    this.lineGeometry.getAttribute('color').needsUpdate = true;
  }

  /** 每帧从骨骼世界矩阵刷新几何（动画播放时骨骼一直在动） */
  refreshPositions(): void {
    for (let index = 0; index < this.bones.length; index += 1) {
      this.bones[index]!.getWorldPosition(this.step);
      this.pointPositions[index * 3] = this.step.x;
      this.pointPositions[index * 3 + 1] = this.step.y;
      this.pointPositions[index * 3 + 2] = this.step.z;
    }

    for (let segment = 0; segment < this.segmentBone.length; segment += 1) {
      const index = this.segmentBone[segment]!;
      const parent = this.parentIndex[index]!;
      const offset = segment * 6;
      this.linePositions[offset] = this.pointPositions[index * 3]!;
      this.linePositions[offset + 1] = this.pointPositions[index * 3 + 1]!;
      this.linePositions[offset + 2] = this.pointPositions[index * 3 + 2]!;
      this.linePositions[offset + 3] = this.pointPositions[parent * 3]!;
      this.linePositions[offset + 4] = this.pointPositions[parent * 3 + 1]!;
      this.linePositions[offset + 5] = this.pointPositions[parent * 3 + 2]!;
    }

    this.pointGeometry.getAttribute('position').needsUpdate = true;
    this.lineGeometry.getAttribute('position').needsUpdate = true;
    this.pointGeometry.computeBoundingSphere();
    this.lineGeometry.computeBoundingSphere();
  }

  /**
   * 用屏幕射线在骨骼点云上取最近的一根。
   * 返回骨骼 id；没命中返回 null。
   */
  pick(raycaster: THREE.Raycaster): string | null {
    if (this.bones.length === 0) return null;
    const previous = raycaster.params.Points?.threshold ?? 0;
    raycaster.params.Points = { threshold: this.pickThreshold };
    const hits = raycaster.intersectObject(this.points, false);
    raycaster.params.Points = { threshold: previous };
    const hit = hits[0];
    if (!hit || hit.index === undefined) return null;
    return this.indexToId(hit.index);
  }

  private indexToId(index: number): string | null {
    return this.bones[index]?.uuid ?? null;
  }

  dispose(): void {
    this.pointGeometry.dispose();
    this.lineGeometry.dispose();
    (this.points.material as THREE.Material).dispose();
    (this.lines.material as THREE.Material).dispose();
    this.root.clear();
  }
}
