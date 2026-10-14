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

/**
 * 骨骼显示方式：
 *  - `stick` 关节圆点 + 父子连线（轻量，适合看整体结构）
 *  - `bone`  八面体骨头 + 关节圆点（Blender 那种，一眼看出骨骼朝向与长短）
 */
export type BoneDisplayMode = 'stick' | 'bone';

/** 八面体骨头：腰身位置与半径占骨长的比例（Blender 八面体骨骼的默认比例是 0.1，这里略放宽更清楚） */
const OCTA_WAIST_RATIO = 0.13;
/** 末端骨骼（没有子骨骼）补的小尾巴，长度相对父骨长度的比例 */
const LEAF_RATIO = 0.32;

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
  private readonly octaGeometry = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private readonly lines: THREE.LineSegments;
  private readonly octaMesh: THREE.Mesh;
  private readonly step = new THREE.Vector3();
  /** 拾取时复用，避免每次移动都分配对象 */
  private readonly worldPoint = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly linePositions: Float32Array;
  private readonly pointPositions: Float32Array;
  private readonly lineColors: Float32Array;
  private readonly pointColors: Float32Array;
  private readonly octaPositions: Float32Array;
  private readonly octaColors: Float32Array;
  private readonly segmentBone: number[] = [];
  /**
   * 每个八面体骨头：owner = 决定颜色的骨骼，tail 来自子骨骼位置或末端补的小尾巴。
   * 一根骨骼有多个子级时会画成多块骨头（与 Blender 一致）。
   */
  private readonly boneShapes: { owner: number; child: number }[] = [];
  private mode: BoneDisplayMode = 'stick';
  private basePointSize = 0.035;
  private hoveredId: string | null = null;
  private visible = true;

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

    // 每根父→子边画一块八面体骨头；没有子级的末端骨骼补一条小尾巴，
    // 否则手指尖、脚趾尖这些位置会只剩一个孤零零的关节圆点。
    const hasChild = new Array<boolean>(boneCount).fill(false);
    for (const child of this.segmentBone) {
      const parent = this.parentIndex[child]!;
      hasChild[parent] = true;
      this.boneShapes.push({ owner: parent, child });
    }
    for (let index = 0; index < boneCount; index += 1) {
      if (!hasChild[index]) this.boneShapes.push({ owner: index, child: -1 });
    }

    // 每块骨头 6 个顶点：头部 1 + 腰身 4 + 尾部 1
    this.octaPositions = new Float32Array(this.boneShapes.length * 6 * 3);
    this.octaColors = new Float32Array(this.boneShapes.length * 6 * 3);
    const octaIndices = new Uint32Array(this.boneShapes.length * 24);
    for (let shape = 0; shape < this.boneShapes.length; shape += 1) {
      const base = shape * 6;
      const at = shape * 24;
      octaIndices.set(
        [
          base, base + 1, base + 2, base, base + 2, base + 3, base, base + 3, base + 4, base, base + 4, base + 1,
          base + 1, base + 2, base + 5, base + 2, base + 3, base + 5, base + 3, base + 4, base + 5, base + 4, base + 1, base + 5,
        ],
        at,
      );
    }
    this.octaGeometry.setAttribute('position', new THREE.BufferAttribute(this.octaPositions, 3));
    this.octaGeometry.setAttribute('color', new THREE.BufferAttribute(this.octaColors, 3));
    this.octaGeometry.setIndex(new THREE.BufferAttribute(octaIndices, 1));

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
    // 平面着色 + 关深度测试：既保留 x-ray 的"穿透模型看骨骼"，
    // 又能像 DCC 那样看清明暗与朝向
    const octaMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.DoubleSide,
      roughness: 0.5,
      metalness: 0.05,
      transparent: true,
      opacity: 0.96,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.pointGeometry, pointsMaterial);
    this.lines = new THREE.LineSegments(this.lineGeometry, lineMaterial);
    this.octaMesh = new THREE.Mesh(this.octaGeometry, octaMaterial);
    this.points.renderOrder = 999;
    this.lines.renderOrder = 998;
    this.octaMesh.renderOrder = 997;
    this.points.frustumCulled = false;
    this.lines.frustumCulled = false;
    this.octaMesh.frustumCulled = false;

    this.root.add(this.lines, this.octaMesh, this.points);
    this.buildTree();
    this.applyMode();
    this.refreshPositions();
    this.refreshColors();
  }

  /** 按当前显示方式切换线框 / 八面体 */
  private applyMode(): void {
    this.lines.visible = this.mode === 'stick';
    this.octaMesh.visible = this.mode === 'bone';
    // 骨头模式下关节圆点稍大些，读起来更接近 DCC 里的关节球
    (this.points.material as THREE.PointsMaterial).size = this.mode === 'bone' ? this.basePointSize * 1.25 : this.basePointSize;
  }

  get displayMode(): BoneDisplayMode {
    return this.mode;
  }

  setDisplayMode(mode: BoneDisplayMode): void {
    this.mode = mode;
    this.applyMode();
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

  /** 按模型尺寸调整关节圆点大小（拾取是按屏幕距离算的，不需要阈值） */
  calibrate(modelHeight: number): void {
    this.basePointSize = Math.max(0.02, modelHeight * 0.016);
    this.applyMode();
  }

  setSelection(ids: readonly string[]): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.refreshColors();
  }

  setHovered(id: string | null): void {    if (this.hoveredId === id) return;
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
    // 八面体按"拥有这块骨头"的骨骼着色（父→子这条边属于父骨骼）
    for (let shape = 0; shape < this.boneShapes.length; shape += 1) {
      const owner = this.bones[this.boneShapes[shape]!.owner]!;
      const color = this.selected.has(owner.uuid)
        ? SELECTED_COLOR
        : owner.uuid === this.hoveredId
          ? HOVER_COLOR
          : DEFAULT_COLOR;
      const offset = shape * 18;
      for (let vertex = 0; vertex < 6; vertex += 1) {
        this.octaColors[offset + vertex * 3] = color.r;
        this.octaColors[offset + vertex * 3 + 1] = color.g;
        this.octaColors[offset + vertex * 3 + 2] = color.b;
      }
    }
    this.pointGeometry.getAttribute('color').needsUpdate = true;
    this.lineGeometry.getAttribute('color').needsUpdate = true;
    this.octaGeometry.getAttribute('color').needsUpdate = true;
  }

  /**
   * 生成八面体骨头的顶点：头部一个点 → 腰身四个点 → 尾部一个点。
   * 腰身位置与半径都取骨长的固定比例，因此骨长变化不影响形状比例。
   */
  private refreshBoneShapes(): void {
    for (let shape = 0; shape < this.boneShapes.length; shape += 1) {
      const { owner, child } = this.boneShapes[shape]!;
      const base = shape * 18;

      const hx = this.pointPositions[owner * 3]!;
      const hy = this.pointPositions[owner * 3 + 1]!;
      const hz = this.pointPositions[owner * 3 + 2]!;

      let tx: number;
      let ty: number;
      let tz: number;
      if (child >= 0) {
        tx = this.pointPositions[child * 3]!;
        ty = this.pointPositions[child * 3 + 1]!;
        tz = this.pointPositions[child * 3 + 2]!;
      } else {
        // 末端骨骼：顺着父骨方向补一小截，让手指尖、脚趾尖也有骨头形状
        const parent = this.parentIndex[owner]!;
        if (parent >= 0) {
          const dx = hx - this.pointPositions[parent * 3]!;
          const dy = hy - this.pointPositions[parent * 3 + 1]!;
          const dz = hz - this.pointPositions[parent * 3 + 2]!;
          tx = hx + dx * LEAF_RATIO;
          ty = hy + dy * LEAF_RATIO;
          tz = hz + dz * LEAF_RATIO;
        } else {
          tx = hx;
          ty = hy + 1;
          tz = hz;
        }
      }

      const ax = tx - hx;
      const ay = ty - hy;
      const az = tz - hz;
      const length = Math.hypot(ax, ay, az);

      if (length < 1e-6) {
        // 退化骨骼（头尾重合）：收成一个点，避免出现 NaN
        for (let vertex = 0; vertex < 6; vertex += 1) {
          const at = base + vertex * 3;
          this.octaPositions[at] = hx;
          this.octaPositions[at + 1] = hy;
          this.octaPositions[at + 2] = hz;
        }
        continue;
      }

      const ux = ax / length;
      const uy = ay / length;
      const uz = az / length;

      // 取一个与骨轴不平行的参考向量，构造腰身的正交基
      const rx = Math.abs(uy) > 0.9 ? 1 : 0;
      const ry = Math.abs(uy) > 0.9 ? 0 : 1;
      let px = ry * uz;
      let py = -rx * uz;
      let pz = rx * uy - ry * ux;
      const pLength = Math.hypot(px, py, pz) || 1;
      px /= pLength;
      py /= pLength;
      pz /= pLength;
      const qx = uy * pz - uz * py;
      const qy = uz * px - ux * pz;
      const qz = ux * py - uy * px;

      const waist = length * OCTA_WAIST_RATIO;
      const cx = hx + ux * waist;
      const cy = hy + uy * waist;
      const cz = hz + uz * waist;

      // 头部
      this.octaPositions[base] = hx;
      this.octaPositions[base + 1] = hy;
      this.octaPositions[base + 2] = hz;
      // 腰身四点：沿 p / q 两个正交方向依次绕一圈（+p → +q → -p → -q）
      const ring: [number, number, number][] = [
        [px, py, pz],
        [qx, qy, qz],
        [-px, -py, -pz],
        [-qx, -qy, -qz],
      ];
      for (let vertex = 0; vertex < 4; vertex += 1) {
        const [ox, oy, oz] = ring[vertex]!;
        const at = base + (vertex + 1) * 3;
        this.octaPositions[at] = cx + ox * waist;
        this.octaPositions[at + 1] = cy + oy * waist;
        this.octaPositions[at + 2] = cz + oz * waist;
      }
      // 尾部
      this.octaPositions[base + 15] = tx;
      this.octaPositions[base + 16] = ty;
      this.octaPositions[base + 17] = tz;
    }
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

    this.refreshBoneShapes();

    this.pointGeometry.getAttribute('position').needsUpdate = true;
    this.lineGeometry.getAttribute('position').needsUpdate = true;
    this.octaGeometry.getAttribute('position').needsUpdate = true;
    this.pointGeometry.computeBoundingSphere();
    this.lineGeometry.computeBoundingSphere();
    this.octaGeometry.computeBoundingSphere();
  }

  /**
   * 屏幕空间拾取：把每根骨骼投影到屏幕上，取离光标最近的那一根。
   *
   * 这里刻意不用「射线到点云的距离」：`raycaster.params.Points.threshold` 是**世界单位**，
   * 投影到屏幕上的可点半径会随距离线性变大，远处的骨骼反而拥有一大片可点区域，
   * 于是经常抢走光标正对着的那根骨骼（表现就是"点不准"）。
   * 改成按屏幕像素距离比较后，可点区域就是屏幕上看得见的那个圆点本身。
   */
  pick(camera: THREE.PerspectiveCamera, width: number, height: number, x: number, y: number): string | null {
    if (this.bones.length === 0 || width <= 0 || height <= 0) return null;

    const worldRadius = (this.points.material as THREE.PointsMaterial).size * 0.5;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);

    let bestIndex = -1;
    let bestDistance = Infinity;
    let bestDepth = Infinity;

    for (let index = 0; index < this.bones.length; index += 1) {
      const world = this.worldPoint.set(
        this.pointPositions[index * 3]!,
        this.pointPositions[index * 3 + 1]!,
        this.pointPositions[index * 3 + 2]!,
      );

      // 屏幕半径按到相机的距离换算，与 sizeAttenuation 下实际画出的圆点一致
      const depth = camera.position.distanceTo(world);
      this.projected.copy(world).project(camera);
      if (this.projected.z > 1) continue; // 在相机后方

      const screenX = (this.projected.x * 0.5 + 0.5) * width;
      const screenY = (-this.projected.y * 0.5 + 0.5) * height;
      const distance = Math.hypot(screenX - x, screenY - y);

      const pixelRadius = depth > 0 ? (worldRadius / (depth * tanHalfFov)) * (height * 0.5) : 0;
      // 可点半径：跟着圆点在屏幕上的大小走，并给出一个舒适的最小值。
      // 因为取的是"离光标最近"的那根，半径放宽不会像以前那样抢错骨骼。
      const limit = Math.min(40, Math.max(16, pixelRadius * 2));
      if (distance > limit) continue;

      // 距离更近者优先；差在 2px 以内时选更靠前（不被遮挡）的那根
      if (distance < bestDistance - 2 || (distance < bestDistance + 2 && this.projected.z < bestDepth)) {
        bestIndex = index;
        bestDistance = distance;
        bestDepth = this.projected.z;
      }
    }

    return bestIndex >= 0 ? this.bones[bestIndex]!.uuid : null;
  }

  dispose(): void {
    this.pointGeometry.dispose();
    this.lineGeometry.dispose();
    this.octaGeometry.dispose();
    (this.points.material as THREE.Material).dispose();
    (this.lines.material as THREE.Material).dispose();
    (this.octaMesh.material as THREE.Material).dispose();
    this.root.clear();
  }
}
