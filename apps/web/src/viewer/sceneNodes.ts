import * as THREE from 'three';

/** 场景节点树的一个节点（对象层级） */
export interface SceneNode {
  id: string;
  name: string;
  /** 友好类型名：Mesh / SkinnedMesh / Bone / Group / Object3D … */
  type: string;
  isBone: boolean;
  /** 子树（含自身）里的网格数与骨骼数，用于在树上做提示 */
  meshCount: number;
  boneCount: number;
  children: SceneNode[];
}

const HIGHLIGHT_COLOR = new THREE.Color('#fbbf24');

/**
 * 把 Object3D 层级变成可渲染的节点树。
 * 工作台的 ModelViewer 与动画页的 FbxPlayer 共用。
 * 传入 index 时顺便建立 id → Object3D 的索引（高亮用）。
 */
export function buildSceneTree(
  root: THREE.Object3D | null,
  index?: Map<string, THREE.Object3D>,
): SceneNode[] {
  if (!root) return [];

  const walk = (object: THREE.Object3D): SceneNode => {
    const child = object as THREE.Object3D & {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      isBone?: boolean;
      isGroup?: boolean;
      isLight?: boolean;
      isCamera?: boolean;
    };
    const type = child.isBone
      ? 'Bone'
      : child.isSkinnedMesh
        ? 'SkinnedMesh'
        : child.isMesh
          ? 'Mesh'
          : child.isGroup
            ? 'Group'
            : child.isLight
              ? 'Light'
              : child.isCamera
                ? 'Camera'
                : object.type || 'Object3D';
    const node: SceneNode = {
      id: object.uuid,
      name: object.name || `(${type})`,
      type,
      isBone: Boolean(child.isBone),
      meshCount: child.isMesh ? 1 : 0,
      boneCount: child.isBone ? 1 : 0,
      children: [],
    };
    for (const item of object.children) {
      const childNode = walk(item);
      node.meshCount += childNode.meshCount;
      node.boneCount += childNode.boneCount;
      node.children.push(childNode);
    }
    index?.set(node.id, object);
    return node;
  };

  return [walk(root)];
}

/**
 * 节点高亮：给选中对象套包围盒线框，并给它下面的网格加一层很淡的自发光。
 *
 * 只在真的"点了一个节点"时才改材质自发光，且记录原值随时还原，
 * 所以不影响线框模式、缩略图等其它渲染状态。
 */
export class NodeHighlighter {
  private readonly nodesById = new Map<string, THREE.Object3D>();
  private readonly selected = new Set<string>();
  private readonly boxes: THREE.Box3Helper[] = [];
  private readonly materials = new Map<THREE.Material, { emissive: THREE.Color; intensity: number }>();

  constructor(private readonly scene: THREE.Scene) {}

  /** 换模型时重建索引并清空选择；返回新的节点树 */
  reset(root: THREE.Object3D | null): SceneNode[] {
    this.clear();
    this.nodesById.clear();
    return buildSceneTree(root, this.nodesById);
  }

  get selection(): string[] {
    return [...this.selected];
  }

  /** 直接指定要高亮的节点（加选/取消的判定交给调用方，两边的 store 各自维护选中态） */
  setSelection(ids: readonly string[]): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.refresh();
  }

  clear(): void {
    this.selected.clear();
    this.refresh();
  }

  /** 每帧调用：包围盒跟着动画/旋转刷新 */
  refreshBoxes(): void {
    if (this.boxes.length === 0) return;
    const ids = [...this.selected];
    this.boxes.forEach((helper, index) => {
      const node = this.nodesById.get(ids[index] ?? '');
      if (!node) return;
      helper.box.copy(new THREE.Box3().setFromObject(node));
    });
  }

  dispose(): void {
    this.clear();
    this.nodesById.clear();
  }

  private restoreMaterials(): void {
    for (const [material, saved] of this.materials) {
      const target = material as THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number };
      if (target.emissive) target.emissive.copy(saved.emissive);
      if (target.emissiveIntensity !== undefined) target.emissiveIntensity = saved.intensity;
    }
    this.materials.clear();
  }

  private disposeBoxes(): void {
    for (const helper of this.boxes) {
      this.scene.remove(helper);
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    this.boxes.length = 0;
  }

  private refresh(): void {
    this.restoreMaterials();
    this.disposeBoxes();
    if (this.selected.size === 0) return;

    for (const id of this.selected) {
      const node = this.nodesById.get(id);
      if (!node) continue;
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) continue;

      const helper = new THREE.Box3Helper(box, HIGHLIGHT_COLOR);
      const material = helper.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.transparent = true;
      helper.renderOrder = 995;
      helper.frustumCulled = false;
      this.scene.add(helper);
      this.boxes.push(helper);

      // 网格：只叠一层很淡的暖色自发光，主要靠包围盒指认，别把模型糊成一片纯色
      node.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          const target = material as THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number };
          if (!target.emissive || this.materials.has(target)) continue;
          this.materials.set(target, {
            emissive: target.emissive.clone(),
            intensity: target.emissiveIntensity ?? 1,
          });
          target.emissive.copy(HIGHLIGHT_COLOR);
          target.emissiveIntensity = 0.18;
        }
      });
    }
  }
}

function findById(root: THREE.Object3D, id: string): THREE.Object3D | null {
  if (root.uuid === id) return root;
  for (const child of root.children) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}

export { findById };
