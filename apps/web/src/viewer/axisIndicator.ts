import * as THREE from 'three';

/**
 * 视口角落的 XYZ 轴向指示器。
 *
 * 做法：把世界坐标轴用**当前相机朝向**正交投影到屏幕，用内联 SVG 画出三根彩色轴
 * （X 红 / Y 绿 / Z 蓝），随视图旋转实时更新。相比在 three.js 场景里再开一个渲染通道，
 * 这种覆盖层不碰 WebGL 状态、不影响截图（缩略图里不会出现指示器），也不受模型缩放影响。
 *
 * 工作台视口（ModelViewer）与动画预览视口（FbxPlayer）共用这一个实现，保证两处观感一致。
 */

interface AxisSpec {
  label: string;
  dir: THREE.Vector3;
  color: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const AXES: AxisSpec[] = [
  { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ff6b6b' },
  { label: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#7ee787' },
  { label: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#5aa9ff' },
];

export interface AxisIndicatorOptions {
  /** 组件边长（CSS 像素） */
  size?: number;
  /** 显示在视口左下角或右下角 */
  corner?: 'bottom-left' | 'bottom-right';
  /** 距底边的距离（动画预览页底部有播放控制条，需要抬高） */
  bottom?: number;
  /** 距侧边的距离 */
  side?: number;
}

interface AxisNode {
  spec: AxisSpec;
  group: SVGGElement;
  line: SVGLineElement;
  dot: SVGCircleElement;
  label: SVGTextElement;
}

export class AxisIndicator {
  private readonly element: HTMLDivElement;
  private readonly layer: SVGGElement;
  private readonly nodes: AxisNode[];
  private readonly center: number;
  private readonly reach: number;
  private readonly inverse = new THREE.Quaternion();
  private readonly scratch = new THREE.Vector3();
  private disposed = false;

  constructor(container: HTMLElement, options: AxisIndicatorOptions = {}) {
    const size = options.size ?? 76;
    const corner = options.corner ?? 'bottom-right';
    const bottom = options.bottom ?? 14;
    const side = options.side ?? 14;
    this.center = size / 2;
    // 留出标签的空间：半径 = 半边长 - 标签余量
    this.reach = size / 2 - 14;

    const element = document.createElement('div');
    element.className = 'axis-indicator';
    element.style.cssText = [
      'position:absolute',
      corner === 'bottom-left' ? `left:${side}px` : `right:${side}px`,
      `bottom:${bottom}px`,
      `width:${size}px`,
      `height:${size}px`,
      'pointer-events:none',
      'z-index:2',
      'user-select:none',
    ].join(';');
    element.setAttribute('aria-hidden', 'true');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.style.display = 'block';

    // 底衬：半透明圆 + 细边，避免在亮色模型上看不清
    const backdrop = document.createElementNS(SVG_NS, 'circle');
    backdrop.setAttribute('cx', String(this.center));
    backdrop.setAttribute('cy', String(this.center));
    backdrop.setAttribute('r', String(size / 2 - 1));
    backdrop.setAttribute('fill', 'rgba(16, 18, 23, 0.55)');
    backdrop.setAttribute('stroke', 'rgba(255, 255, 255, 0.12)');
    backdrop.setAttribute('stroke-width', '1');
    svg.appendChild(backdrop);

    this.layer = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(this.layer);

    this.nodes = AXES.map((spec) => {
      const group = document.createElementNS(SVG_NS, 'g');
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(this.center));
      line.setAttribute('y1', String(this.center));
      line.setAttribute('x2', String(this.center));
      line.setAttribute('y2', String(this.center));
      line.setAttribute('stroke', spec.color);
      line.setAttribute('stroke-width', '1.8');
      line.setAttribute('stroke-linecap', 'round');

      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(this.center));
      dot.setAttribute('cy', String(this.center));
      dot.setAttribute('r', '2.4');
      dot.setAttribute('fill', spec.color);

      const label = document.createElementNS(SVG_NS, 'text');
      label.textContent = spec.label;
      label.setAttribute('fill', spec.color);
      label.setAttribute('font-size', '9');
      label.setAttribute('font-weight', '700');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'middle');

      group.append(line, dot, label);
      this.layer.appendChild(group);
      return { spec, group, line, dot, label };
    });

    element.appendChild(svg);
    container.appendChild(element);
    this.element = element;
    // 先按「相机看向 -Z」的默认朝向排一次，避免动画循环启动前的空帧里三个字母堆在左上角
    this.applyOrientation(new THREE.Quaternion());
  }

  /** 每帧调用：按相机的世界朝向更新三个轴的方向 */
  update(camera: THREE.Camera): void {
    if (this.disposed) return;
    this.applyOrientation(camera.quaternion);
  }

  /** 世界方向 → 相机空间：正交投影下屏幕方向就是 (x, -y) */
  private applyOrientation(quaternion: THREE.Quaternion): void {
    this.inverse.copy(quaternion).invert();

    const projected = this.nodes.map((node) => {
      this.scratch.copy(node.spec.dir).applyQuaternion(this.inverse);
      return {
        node,
        x: this.scratch.x,
        y: -this.scratch.y,
        // 相机朝 -Z，z 越大离观察者越远
        depth: this.scratch.z,
      };
    });
    // 远的先画（SVG 后插入的在上层）
    projected.sort((a, b) => b.depth - a.depth);

    for (const item of projected) {
      const { node, x, y, depth } = item;
      const length = Math.hypot(x, y);
      const towardViewer = (1 - depth) / 2; // 1 = 正对观察者
      const opacity = 0.5 + 0.5 * towardViewer;

      // 轴几乎与视线平行时退化成圆点，避免长度塌成 0 后看不见
      const unitX = length > 1e-4 ? x / length : 0;
      const unitY = length > 1e-4 ? y / length : 0;
      const radius = this.reach * Math.max(length, 0.12);
      const endX = this.center + unitX * radius;
      const endY = this.center + unitY * radius;
      const labelX = this.center + unitX * (radius + 9);
      const labelY = this.center + unitY * (radius + 9);

      node.line.setAttribute('x2', endX.toFixed(2));
      node.line.setAttribute('y2', endY.toFixed(2));
      node.line.setAttribute('opacity', opacity.toFixed(2));
      node.line.setAttribute('stroke-width', (1.4 + 0.8 * towardViewer).toFixed(2));

      node.dot.setAttribute('cx', endX.toFixed(2));
      node.dot.setAttribute('cy', endY.toFixed(2));
      node.dot.setAttribute('opacity', opacity.toFixed(2));

      node.label.setAttribute('x', labelX.toFixed(2));
      node.label.setAttribute('y', labelY.toFixed(2));
      node.label.setAttribute('opacity', (0.7 + 0.3 * towardViewer).toFixed(2));

      // 调整绘制顺序
      this.layer.appendChild(node.group);
    }
  }

  /** 供需要手动隐藏（例如离屏缩略图渲染器）的调用方使用 */
  setVisible(visible: boolean): void {
    this.element.style.display = visible ? 'block' : 'none';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.remove();
  }
}
