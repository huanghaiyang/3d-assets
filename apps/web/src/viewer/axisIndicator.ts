import * as THREE from 'three';

/**
 * 视口角落的 XYZ 轴向指示器。
 *
 * 做法：把世界坐标轴用**当前相机朝向**正交投影到屏幕，用内联 SVG 画出三根彩色轴
 * （X 红 / Y 绿 / Z 蓝），随视图旋转实时更新。相比在 three.js 场景里再开一个渲染通道，
 * 这种覆盖层不碰 WebGL 状态、不影响截图（缩略图里不会出现指示器），也不受模型缩放影响。
 *
 * 工作台视口（ModelViewer）与动画预览视口（FbxPlayer）共用这一个实现，保证两处观感一致。
 *
 * 调整与锁定：右上角小齿轮点开可调大小 / 透明度，右下角小握柄可拖动换位置。
 * 图形本体不接收鼠标事件，指针落在指示器上时仍然能旋转视角、滚轮缩放；
 * 只有轴端点（字母 / 圆点）、齿轮、握柄和设置面板会截获操作。
 * 点击轴端点会让相机切到该世界轴的正 / 负方向视角（实心圆点 + 字母 = 正方向，
 * 空心圆环 + -X/-Y/-Z 字母 + 半根轴线 = 负方向，由播放器回调 onAxisSelect 完成），
 * 四个工作区共用；「锁定朝向」后禁用切换，三轴固定显示世界坐标系。
 * 「锁定位置」后不可拖动或重置。
 * 设置按工作区分别存进 localStorage（见 AxisIndicatorOptions.storageKey）。
 */

/** 三根世界轴的名字，也是「点击轴端点切换视角」的入参 */
export type AxisName = 'x' | 'y' | 'z';
/** 轴向正负：1 = +X/+Y/+Z（实心端点），-1 = -X/-Y/-Z（空心端点） */
export type AxisSign = 1 | -1;

interface AxisSpec {
  name: AxisName;
  label: string;
  dir: THREE.Vector3;
  color: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const STYLE_ID = 'axis-indicator-styles';

const DEFAULT_SIZE = 76;
const MIN_SIZE = 44;
const MAX_SIZE = 140;
const MIN_OPACITY = 0.3;
const DEFAULT_OPACITY = 1;
/** 设置面板与指示器之间的间距 */
const PANEL_GAP = 8;

const IDENTITY = new THREE.Quaternion();

/** 三个世界轴的正方向：点击轴端点后相机摆到该方向看向目标 */
const AXIS_DIRECTIONS: Record<AxisName, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

const AXES: AxisSpec[] = [
  { name: 'x', label: 'X', dir: AXIS_DIRECTIONS.x, color: '#ff6b6b' },
  { name: 'y', label: 'Y', dir: AXIS_DIRECTIONS.y, color: '#7ee787' },
  { name: 'z', label: 'Z', dir: AXIS_DIRECTIONS.z, color: '#5aa9ff' },
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
  /**
   * 设置持久化键：不同工作区各存一份（例如 workbench / animation），
   * 不传则不写入 localStorage（离屏缩略图这类一次性渲染不需要记住）。
   */
  storageKey?: string;
  /**
   * 点击轴端点（字母 / 圆点）时回调，参数是被点击的世界轴。
   * 播放器用它把相机切到对应轴向视角；不传则轴端点不可点击。
   */
  onAxisSelect?: (axis: AxisName, sign: AxisSign) => void;
}

interface AxisIndicatorSettings {
  size: number;
  opacity: number;
  /** 锁定位置：不可拖动、不可重置 */
  locked: boolean;
  /** 锁定朝向：三轴固定显示世界坐标系，不随相机旋转 */
  orientLocked: boolean;
  /** 指示器中心相对容器的位置（0..1）；null 表示仍按角落锚点定位 */
  pos: { x: number; y: number } | null;
}

interface AxisNode {
  spec: AxisSpec;
  group: SVGGElement;
  line: SVGLineElement;
  dot: SVGCircleElement;
  label: SVGTextElement;
  /** 正方向端点的透明热区：扩大点击范围，悬停时整根轴高亮 */
  hit: SVGCircleElement;
  /** 反方向（-X/-Y/-Z）端点：空心小圆，点击后相机切到负方向视角 */
  negDot: SVGCircleElement;
  /** 反方向的半根轴线 */
  negLine: SVGLineElement;
  /** 反方向字母（-X / -Y / -Z） */
  negLabel: SVGTextElement;
  /** 反方向端点的透明热区 */
  negHit: SVGCircleElement;
}

interface DragState {
  pointerId: number;
  /** 按下点相对指示器左上角的偏移 */
  offsetX: number;
  offsetY: number;
  moved: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** OrbitControls 的最小结构：切换轴向视角只需要观察目标与 update() */
export interface AxisViewControls {
  target: THREE.Vector3;
  update: () => unknown;
}

/**
 * 把相机摆到指定世界轴的正 / 负方向看向目标点，保持当前观察距离。
 * 点击轴向指示器的轴端点时由各播放器调用。
 * Y 轴是俯视 / 仰视，视线与 camera.up 平行，给一个极小的 z 偏移避免 lookAt 退化后画面乱翻。
 *
 * @param axis 世界轴
 * @param sign 1 = 相机在该轴正方向（+X/+Y/+Z），-1 = 负方向（-X/-Y/-Z）
 */
export function snapCameraToAxis(
  camera: THREE.Camera,
  controls: AxisViewControls,
  axis: AxisName,
  sign: AxisSign = 1,
): void {
  const distance = camera.position.distanceTo(controls.target);
  if (!(distance > 1e-6)) return;
  camera.position
    .copy(controls.target)
    .addScaledVector(AXIS_DIRECTIONS[axis], distance * sign);
  if (axis === 'y') camera.position.z += distance * 1e-4;
  camera.lookAt(controls.target);
  controls.update();
}

/** 全局只注入一次样式，避免每个实例都往 head 里塞一份 CSS */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.axis-indicator{position:absolute;z-index:3;touch-action:none;user-select:none;pointer-events:none;}
.axis-indicator__surface{display:block;pointer-events:none;}
.axis-indicator__axis{cursor:pointer;}
.axis-indicator__dot,.axis-indicator__label{pointer-events:auto;}
.axis-indicator__hit{pointer-events:all;}
.axis-indicator__axis:hover{filter:brightness(1.35);}
.axis-indicator.is-orient-locked .axis-indicator__axis{cursor:not-allowed;}
.axis-indicator.is-orient-locked .axis-indicator__axis:hover{filter:none;}
.axis-indicator__gear{position:absolute;top:-3px;right:-3px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:rgba(16,18,23,.86);color:#aeb6c4;opacity:.45;pointer-events:auto;transition:opacity .15s ease,color .15s ease;cursor:pointer;z-index:4;}
.axis-indicator__gear:hover,.axis-indicator.is-open .axis-indicator__gear,.axis-indicator__gear:focus-visible{opacity:1;color:#e6e9f0;border-color:rgba(255,255,255,.25);}
.axis-indicator.is-locked .axis-indicator__gear{color:#f2b45a;}
.axis-indicator__grip{position:absolute;right:-3px;bottom:-3px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:rgba(16,18,23,.86);color:#aeb6c4;opacity:.45;pointer-events:auto;transition:opacity .15s ease,color .15s ease;cursor:grab;z-index:4;}
.axis-indicator__grip:hover,.axis-indicator.is-dragging .axis-indicator__grip{opacity:1;color:#e6e9f0;border-color:rgba(255,255,255,.25);}
.axis-indicator.is-dragging .axis-indicator__grip{cursor:grabbing;}
.axis-indicator.is-locked .axis-indicator__grip{display:none;}
.axis-indicator__pop{display:none;position:absolute;width:208px;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(22,23,27,.96);box-shadow:0 10px 26px rgba(0,0,0,.45);backdrop-filter:blur(10px);color:#c6ccd8;font-size:11px;pointer-events:auto;z-index:5;}
.axis-indicator.is-open .axis-indicator__pop{display:block;}
.axis-indicator__pop-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:#e6e8ee;font-size:11.5px;font-weight:600;}
.axis-indicator__pop-close{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:4px;background:transparent;color:#8b93a3;font-size:13px;line-height:1;cursor:pointer;}
.axis-indicator__pop-close:hover{background:rgba(255,255,255,.08);color:#e6e8ee;}
.axis-indicator__row{display:grid;grid-template-columns:40px 1fr 40px;align-items:center;gap:6px;margin:0 0 7px;}
.axis-indicator__row input[type=range]{width:100%;height:14px;accent-color:#7c5cff;}
.axis-indicator__value{text-align:right;color:#cfd5e2;font-variant-numeric:tabular-nums;}
.axis-indicator__check{display:flex;align-items:center;gap:6px;margin:4px 0;cursor:pointer;}
.axis-indicator__check input{accent-color:#7c5cff;margin:0;}
.axis-indicator__note{margin:6px 0 0;color:#8b93a3;font-size:10.5px;line-height:1.5;}
.axis-indicator__reset{width:100%;height:24px;margin-top:8px;border-radius:5px;border:1px solid rgba(124,92,255,.45);background:rgba(124,92,255,.16);color:#c4b5fd;font-size:11px;cursor:pointer;}
.axis-indicator__reset:hover:not(:disabled){background:rgba(124,92,255,.28);}
.axis-indicator__reset:disabled{opacity:.45;cursor:not-allowed;}
`;
  document.head.appendChild(style);
}

export class AxisIndicator {
  private readonly container: HTMLElement;
  private readonly element: HTMLDivElement;
  private readonly surface: SVGSVGElement;
  private readonly backdrop: SVGCircleElement;
  private readonly layer: SVGGElement;
  private readonly gear: HTMLButtonElement;
  /** 右下角小握柄：拖动它才移动指示器（图形本体不接收鼠标事件，避免挡住视角旋转） */
  private readonly grip: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  /** 视口 canvas：齿轮 / 握柄上的滚轮要转发给它，保证小控件上方也能缩放 */
  private canvas: HTMLCanvasElement | null;
  private readonly nodes: AxisNode[];
  private readonly settings: AxisIndicatorSettings;
  /** 点击轴端点时通知播放器切换相机视角 */
  private readonly onAxisSelect: ((axis: AxisName, sign: AxisSign) => void) | null;
  private readonly storageKey: string | null;
  private readonly corner: 'bottom-left' | 'bottom-right';
  private readonly bottom: number;
  private readonly side: number;
  private readonly inverse = new THREE.Quaternion();
  private readonly scratch = new THREE.Vector3();
  /** 最近一次相机朝向：解锁朝向时直接恢复，不必等下一帧 update */
  private readonly lastQuaternion = new THREE.Quaternion();
  private readonly resizeObserver: ResizeObserver;

  private size: number;
  private center: number;
  private reach: number;
  private drag: DragState | null = null;
  private disposed = false;

  constructor(container: HTMLElement, options: AxisIndicatorOptions = {}) {
    ensureStyles();
    this.container = container;
    this.corner = options.corner ?? 'bottom-right';
    this.bottom = options.bottom ?? 14;
    this.side = options.side ?? 14;
    this.storageKey = options.storageKey ?? null;
    this.onAxisSelect = options.onAxisSelect ?? null;
    this.settings = this.loadSettings(options.size ?? DEFAULT_SIZE);
    this.size = this.settings.size;
    this.center = this.size / 2;
    this.reach = this.size / 2 - 14;

    const element = document.createElement('div');
    element.className = 'axis-indicator';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('axis-indicator__surface');

    // 底衬：半透明圆 + 细边，避免在亮色模型上看不清
    const backdrop = document.createElementNS(SVG_NS, 'circle');
    backdrop.setAttribute('fill', 'rgba(16, 18, 23, 0.55)');
    backdrop.setAttribute('stroke', 'rgba(255, 255, 255, 0.12)');
    backdrop.setAttribute('stroke-width', '1');
    svg.appendChild(backdrop);

    this.layer = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(this.layer);

    this.nodes = AXES.map((spec) => {
      const group = document.createElementNS(SVG_NS, 'g');
      group.classList.add('axis-indicator__axis');
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('stroke', spec.color);
      line.setAttribute('stroke-width', '1.8');
      line.setAttribute('stroke-linecap', 'round');

      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', '2.4');
      dot.setAttribute('fill', spec.color);
      dot.classList.add('axis-indicator__dot');

      const label = document.createElementNS(SVG_NS, 'text');
      label.textContent = spec.label;
      label.setAttribute('fill', spec.color);
      label.setAttribute('font-weight', '700');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'middle');
      label.classList.add('axis-indicator__label');

      // 透明热区：圆点 + 字母太小，扩大成能点的区域；填充透明才算可命中
      const hit = document.createElementNS(SVG_NS, 'circle');
      hit.setAttribute('fill', 'transparent');
      hit.classList.add('axis-indicator__hit');

      // 反方向：半根轴线 + 空心圆点 + 字母（-X/-Y/-Z），与正方向对称但更淡
      const negLine = document.createElementNS(SVG_NS, 'line');
      negLine.setAttribute('stroke', spec.color);
      negLine.setAttribute('stroke-width', '1.2');
      negLine.setAttribute('stroke-linecap', 'round');

      const negDot = document.createElementNS(SVG_NS, 'circle');
      negDot.setAttribute('r', '2.4');
      negDot.setAttribute('fill', 'transparent');
      negDot.setAttribute('stroke', spec.color);
      negDot.setAttribute('stroke-width', '1.2');
      negDot.classList.add('axis-indicator__dot');
      negDot.classList.add('axis-indicator__neg');

      const negLabel = document.createElementNS(SVG_NS, 'text');
      negLabel.textContent = `-${spec.label}`;
      negLabel.setAttribute('fill', spec.color);
      negLabel.setAttribute('font-weight', '600');
      negLabel.setAttribute('text-anchor', 'middle');
      negLabel.setAttribute('dominant-baseline', 'middle');
      negLabel.classList.add('axis-indicator__label');

      const negHit = document.createElementNS(SVG_NS, 'circle');
      negHit.setAttribute('fill', 'transparent');
      negHit.classList.add('axis-indicator__hit');

      group.append(negLine, line, dot, label, hit, negDot, negLabel, negHit);
      // 点击端点：通知播放器把相机切到该轴向（锁定朝向后 requestAxis 会忽略）。
      // 正方向：圆点 / 字母 / 热区；负方向：空心圆环 / -X 字母 / 热区
      const select = (sign: AxisSign) => () => this.requestAxis(spec.name, sign);
      dot.addEventListener('click', select(1));
      label.addEventListener('click', select(1));
      hit.addEventListener('click', select(1));
      negDot.addEventListener('click', select(-1));
      negLabel.addEventListener('click', select(-1));
      negHit.addEventListener('click', select(-1));
      // 轴端点上的滚轮也转发给 canvas，避免挡住视口缩放
      group.addEventListener('wheel', this.onControlWheel, { passive: false });
      this.layer.appendChild(group);
      return { spec, group, line, dot, label, hit, negDot, negLine, negLabel, negHit };
    });

    this.gear = this.buildGear();
    this.grip = this.buildGrip();
    this.panel = this.buildPanel();
    element.append(svg, this.gear, this.grip, this.panel);
    container.appendChild(element);

    this.element = element;
    this.surface = svg;
    this.backdrop = backdrop;
    // 播放器都先建 canvas 再建指示器；取不到时 onControlWheel 会再试一次
    this.canvas = container.querySelector<HTMLCanvasElement>('canvas');

    if (this.settings.locked) element.classList.add('is-locked');
    // 锁定朝向时轴端点不可切换：光标改成 not-allowed 给出提示
    if (this.settings.orientLocked) element.classList.add('is-orient-locked');

    this.applySize(this.settings.size);
    this.applyOpacity(this.settings.opacity);
    // 先按「相机看向 -Z」的默认朝向排一次，避免动画循环启动前的空帧里三个字母堆在左上角
    this.applyOrientation(IDENTITY);

    this.setupPanel();
    // 拖动入口只在小握柄上：图形本体 pointer-events:none，指针落在指示器上仍然是旋转视角
    this.grip.addEventListener('pointerdown', this.onGripPointerDown);
    // pointermove / pointerup 在开始拖动时才挂到 document 上（见 onGripPointerDown）
    // 小控件截获了滚轮事件（canvas 是兄弟节点，不会自动转发），这里补一份到 canvas
    this.gear.addEventListener('wheel', this.onControlWheel, { passive: false });
    this.grip.addEventListener('wheel', this.onControlWheel, { passive: false });
    // 指示器悬浮在视口上方：拦掉冒泡，避免工作区把拖动 / 点击当成旋转视角或点选
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu'] as const) {
      element.addEventListener(type, this.stopViewportEvent);
    }
    this.gear.addEventListener('click', this.onGearClick);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.disposed) this.applyPosition();
    });
    this.resizeObserver.observe(container);
  }

  /** 每帧调用：按相机的世界朝向更新三个轴的方向（锁定朝向时保持世界坐标系） */
  update(camera: THREE.Camera): void {
    if (this.disposed) return;
    this.lastQuaternion.copy(camera.quaternion);
    this.applyOrientation(this.orientation());
  }

  /** 锁定朝向时固定为世界坐标系，否则跟随相机 */
  private orientation(): THREE.Quaternion {
    return this.settings.orientLocked ? IDENTITY : this.lastQuaternion;
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

      // 点击热区跟着端点走：透明填充只负责放大命中范围
      node.hit.setAttribute('cx', endX.toFixed(2));
      node.hit.setAttribute('cy', endY.toFixed(2));

      // 负方向端点落在中心的正对面；半轴 / 圆环 / 字母都比正方向淡，避免抢视觉
      const negX = this.center * 2 - endX;
      const negY = this.center * 2 - endY;
      node.negLine.setAttribute('x2', negX.toFixed(2));
      node.negLine.setAttribute('y2', negY.toFixed(2));
      node.negLine.setAttribute('opacity', (opacity * 0.55).toFixed(2));
      node.negLine.setAttribute('stroke-width', (1 + 0.5 * towardViewer).toFixed(2));

      node.negDot.setAttribute('cx', negX.toFixed(2));
      node.negDot.setAttribute('cy', negY.toFixed(2));
      node.negDot.setAttribute('opacity', (opacity * 0.8).toFixed(2));
      node.negHit.setAttribute('cx', negX.toFixed(2));
      node.negHit.setAttribute('cy', negY.toFixed(2));

      node.negLabel.setAttribute('x', (this.center - unitX * (radius + 9)).toFixed(2));
      node.negLabel.setAttribute('y', (this.center - unitY * (radius + 9)).toFixed(2));
      node.negLabel.setAttribute('opacity', (0.5 + 0.3 * towardViewer).toFixed(2));

      node.label.setAttribute('x', labelX.toFixed(2));
      node.label.setAttribute('y', labelY.toFixed(2));
      node.label.setAttribute('opacity', (0.7 + 0.3 * towardViewer).toFixed(2));

      // 调整绘制顺序
      this.layer.appendChild(node.group);
    }
  }

  /** 尺寸变化：同步 SVG 视框、底衬、字号，再重排三轴与位置 */
  private applySize(size: number): void {
    this.size = clamp(Math.round(size), MIN_SIZE, MAX_SIZE);
    this.settings.size = this.size;
    this.center = this.size / 2;
    this.reach = this.size / 2 - 14;

    this.element.style.width = `${this.size}px`;
    this.element.style.height = `${this.size}px`;
    this.surface.setAttribute('viewBox', `0 0 ${this.size} ${this.size}`);
    this.surface.setAttribute('width', String(this.size));
    this.surface.setAttribute('height', String(this.size));

    this.backdrop.setAttribute('cx', String(this.center));
    this.backdrop.setAttribute('cy', String(this.center));
    this.backdrop.setAttribute('r', String(this.size / 2 - 1));

    const fontSize = Math.round(clamp((this.size * 9) / DEFAULT_SIZE, 8, 12));
    // 反方向字母多一个「-」，字号略小一点才能塞进圆内
    const negFontSize = Math.max(7, Math.round(fontSize * 0.85));
    // 热区随尺寸放大：76px 时约 10px 半径，缩到 44px 也还有 8px，手指/鼠标都够点
    const hitRadius = Math.max(8, Math.round(this.size / 8));
    // 负方向热区略小，避免两根轴都退化到圆心时互相抢点击
    const negHitRadius = Math.max(6, Math.round(this.size / 10));
    for (const node of this.nodes) {
      node.line.setAttribute('x1', String(this.center));
      node.line.setAttribute('y1', String(this.center));
      node.negLine.setAttribute('x1', String(this.center));
      node.negLine.setAttribute('y1', String(this.center));
      node.label.setAttribute('font-size', String(fontSize));
      node.negLabel.setAttribute('font-size', String(negFontSize));
      node.hit.setAttribute('r', String(hitRadius));
      node.negHit.setAttribute('r', String(negHitRadius));
    }

    this.applyPosition();
    this.applyOrientation(this.orientation());
  }

  private applyOpacity(opacity: number): void {
    this.settings.opacity = clamp(opacity, MIN_OPACITY, DEFAULT_OPACITY);
    this.surface.style.opacity = String(this.settings.opacity);
  }

  private applyLocked(locked: boolean): void {
    this.settings.locked = locked;
    this.element.classList.toggle('is-locked', locked);
    if (locked) this.finishDrag();
  }

  /**
   * 点击轴端点：通知播放器把相机切到该轴向；锁定朝向时忽略（锁定后禁用切换）。
   *
   * @param axis 世界轴
   * @param sign 1 = 正方向视角，-1 = 负方向视角
   */
  private requestAxis(axis: AxisName, sign: AxisSign): void {
    if (this.disposed || this.settings.orientLocked) return;
    this.onAxisSelect?.(axis, sign);
  }

  /**
   * 位置：未拖动过时按角落锚点定位；拖动过后按「中心相对容器的比例」复原，
   * 这样视口尺寸变化时指示器仍落在用户放的地方。
   */
  private applyPosition(): void {
    const pos = this.settings.pos;
    if (!pos) {
      this.element.style.left = this.corner === 'bottom-left' ? `${this.side}px` : 'auto';
      this.element.style.right = this.corner === 'bottom-right' ? `${this.side}px` : 'auto';
      this.element.style.bottom = `${this.bottom}px`;
      this.element.style.top = 'auto';
      return;
    }

    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const left = clamp(pos.x * rect.width - this.size / 2, 0, Math.max(0, rect.width - this.size));
    const top = clamp(pos.y * rect.height - this.size / 2, 0, Math.max(0, rect.height - this.size));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.element.style.right = 'auto';
    this.element.style.bottom = 'auto';
  }

  private readonly onGripPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.settings.locked || this.disposed) return;
    const box = this.element.getBoundingClientRect();
    // 偏移量统一用「视口绝对坐标」算：按下点相对指示器左上角的距离。
    // 不能拿 clientX 去减容器内坐标（box.left - rect.left），否则会把容器在页面里的
    // 位置（左侧面板 + 顶栏）额外算进去，结果就是拖动时永远差一段距离。
    this.drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
      moved: false,
    };
    // 拖出指示器、拖到视口外都还能继续：move / up 挂在 document 上而不是握柄自己身上。
    // 必须用捕获阶段：指示器自己注册了 stopPropagation（避免事件冒到视口），
    // 拖拽时指针往往还压在握柄上，冒泡到 document 的 pointerup 会被拦掉，
    // 结果就是松开鼠标后 document 监听没移除，指示器继续跟着走。
    document.addEventListener('pointermove', this.onGripPointerMove, true);
    document.addEventListener('pointerup', this.onGripPointerUp, true);
    document.addEventListener('pointercancel', this.onGripPointerUp, true);
    this.element.classList.add('is-dragging');
    event.preventDefault();
  };

  private readonly onGripPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rect = this.container.getBoundingClientRect();
    const maxLeft = Math.max(0, rect.width - this.size);
    const maxTop = Math.max(0, rect.height - this.size);
    const left = clamp(event.clientX - rect.left - drag.offsetX, 0, maxLeft);
    const top = clamp(event.clientY - rect.top - drag.offsetY, 0, maxTop);
    drag.moved = true;
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.element.style.right = 'auto';
    this.element.style.bottom = 'auto';
  };

  private readonly onGripPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.moved) {
      const rect = this.container.getBoundingClientRect();
      const box = this.element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.settings.pos = {
          x: clamp((box.left - rect.left + this.size / 2) / rect.width, 0, 1),
          y: clamp((box.top - rect.top + this.size / 2) / rect.height, 0, 1),
        };
        this.persist();
      }
    }
    this.finishDrag();
  };

  private finishDrag(): void {
    this.drag = null;
    document.removeEventListener('pointermove', this.onGripPointerMove, true);
    document.removeEventListener('pointerup', this.onGripPointerUp, true);
    document.removeEventListener('pointercancel', this.onGripPointerUp, true);
    this.element.classList.remove('is-dragging');
  }

  /**
   * 齿轮 / 握柄上的滚轮转给 canvas：这两个小控件 pointer-events:auto，
   * 滚轮落在它们身上不会像图形本体那样穿透到 canvas，转一次保证缩放手感一致。
   */
  private readonly onControlWheel = (event: WheelEvent): void => {
    if (this.disposed) return;
    if (!this.canvas || !this.canvas.isConnected) {
      this.canvas = this.container.querySelector<HTMLCanvasElement>('canvas');
    }
    const canvas = this.canvas;
    if (!canvas) return;
    event.preventDefault();
    event.stopPropagation();
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  private readonly stopViewportEvent = (event: Event): void => {
    event.stopPropagation();
  };

  private readonly onGearClick = (event: MouseEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    if (this.element.classList.contains('is-open')) this.closePanel();
    else this.openPanel();
  };

  private openPanel(): void {
    this.element.classList.add('is-open');
    // 面板显示后才有高度：先加类再量高度，决定放在指示器上方还是下方
    this.positionPanel();
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown);
  }

  private closePanel(): void {
    this.element.classList.remove('is-open');
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown);
  }

  /** 点面板外部关闭（齿轮自己的点击由 onGearClick 处理，这里要跳过） */
  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (this.panel.contains(target) || this.gear.contains(target)) return;
    this.closePanel();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    this.closePanel();
  };

  private positionPanel(): void {
    const rect = this.container.getBoundingClientRect();
    const box = this.element.getBoundingClientRect();
    const panelHeight = this.panel.offsetHeight;
    const above = box.top - rect.top >= panelHeight + PANEL_GAP;
    this.panel.style.top = above ? `${-panelHeight - PANEL_GAP}px` : `${this.size + PANEL_GAP}px`;
    this.panel.style.bottom = 'auto';
    const alignLeft = box.left - rect.left + box.width / 2 <= rect.width / 2;
    this.panel.style.left = alignLeft ? '0px' : 'auto';
    this.panel.style.right = alignLeft ? 'auto' : '0px';
  }

  private buildGear(): HTMLButtonElement {
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'axis-indicator__gear';
    gear.title = '指示器设置（大小 / 位置 / 锁定）';
    gear.setAttribute('aria-label', '轴向指示器设置');

    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('width', '12');
    icon.setAttribute('height', '12');
    icon.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < 6; i += 1) {
      const angle = (i * Math.PI) / 3;
      const tooth = document.createElementNS(SVG_NS, 'line');
      tooth.setAttribute('x1', (8 + Math.cos(angle) * 4.2).toFixed(2));
      tooth.setAttribute('y1', (8 + Math.sin(angle) * 4.2).toFixed(2));
      tooth.setAttribute('x2', (8 + Math.cos(angle) * 6).toFixed(2));
      tooth.setAttribute('y2', (8 + Math.sin(angle) * 6).toFixed(2));
      tooth.setAttribute('stroke', 'currentColor');
      tooth.setAttribute('stroke-width', '1.5');
      tooth.setAttribute('stroke-linecap', 'round');
      icon.appendChild(tooth);
    }

    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', '8');
    ring.setAttribute('cy', '8');
    ring.setAttribute('r', '3.1');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'currentColor');
    ring.setAttribute('stroke-width', '1.3');

    const hub = document.createElementNS(SVG_NS, 'circle');
    hub.setAttribute('cx', '8');
    hub.setAttribute('cy', '8');
    hub.setAttribute('r', '1.1');
    hub.setAttribute('fill', 'currentColor');

    icon.append(ring, hub);
    gear.appendChild(icon);
    return gear;
  }

  private buildGrip(): HTMLButtonElement {
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'axis-indicator__grip';
    grip.title = '拖动可移动指示器';
    grip.setAttribute('aria-label', '拖动调整轴向指示器位置');

    // 四向箭头：提示这里可以拖动
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('width', '11');
    icon.setAttribute('height', '11');
    icon.setAttribute('aria-hidden', 'true');

    const arrows = document.createElementNS(SVG_NS, 'path');
    arrows.setAttribute(
      'd',
      'M8 2.6V13.4M2.6 8H13.4M5.5 5.2 8 2.7 10.5 5.2M5.5 10.8 8 13.3 10.5 10.8M5.2 5.5 2.7 8 5.2 10.5M10.8 5.5 13.3 8 10.8 10.5',
    );
    arrows.setAttribute('fill', 'none');
    arrows.setAttribute('stroke', 'currentColor');
    arrows.setAttribute('stroke-width', '1.2');
    arrows.setAttribute('stroke-linecap', 'round');

    icon.appendChild(arrows);
    grip.appendChild(icon);
    return grip;
  }

  private buildPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.className = 'axis-indicator__pop';
    const zoom = Math.round(this.settings.opacity * 100);
    const note = this.settings.locked
      ? '位置已锁定：解锁后才能拖动或重置。'
      : '拖动右下角握柄可移动到视口任意位置。';
    panel.innerHTML = `
  <div class="axis-indicator__pop-head">
    <span>轴向指示器</span>
    <button type="button" class="axis-indicator__pop-close" data-axis-close aria-label="关闭">×</button>
  </div>
  <label class="axis-indicator__row">
    <span>大小</span>
    <input type="range" data-axis-size min="${MIN_SIZE}" max="${MAX_SIZE}" step="2" value="${this.settings.size}" />
    <span class="axis-indicator__value" data-axis-size-value>${this.settings.size}px</span>
  </label>
  <label class="axis-indicator__row">
    <span>透明度</span>
    <input type="range" data-axis-opacity min="30" max="100" step="1" value="${zoom}" />
    <span class="axis-indicator__value" data-axis-opacity-value>${zoom}%</span>
  </label>
  <label class="axis-indicator__check">
    <input type="checkbox" data-axis-lock${this.settings.locked ? ' checked' : ''} />
    <span>锁定位置（不可拖动）</span>
  </label>
  <label class="axis-indicator__check">
    <input type="checkbox" data-axis-orient${this.settings.orientLocked ? ' checked' : ''} />
    <span>锁定朝向（固定世界坐标）</span>
  </label>
  <p class="axis-indicator__note">点击实心圆点 / 字母 = 正方向视角；空心圆环 / -X 字母 = 负方向视角。锁定朝向后禁用。</p>
  <p class="axis-indicator__note" data-axis-note>${note}</p>
  <button type="button" class="axis-indicator__reset" data-axis-reset${this.settings.locked ? ' disabled' : ''}>重置位置</button>
`;
    return panel;
  }

  private setupPanel(): void {
    const sizeInput = this.panel.querySelector<HTMLInputElement>('[data-axis-size]');
    const sizeValue = this.panel.querySelector<HTMLElement>('[data-axis-size-value]');
    const opacityInput = this.panel.querySelector<HTMLInputElement>('[data-axis-opacity]');
    const opacityValue = this.panel.querySelector<HTMLElement>('[data-axis-opacity-value]');
    const lockInput = this.panel.querySelector<HTMLInputElement>('[data-axis-lock]');
    const orientInput = this.panel.querySelector<HTMLInputElement>('[data-axis-orient]');
    const resetButton = this.panel.querySelector<HTMLButtonElement>('[data-axis-reset]');
    const note = this.panel.querySelector<HTMLElement>('[data-axis-note]');
    const closeButton = this.panel.querySelector<HTMLButtonElement>('[data-axis-close]');
    if (
      !sizeInput ||
      !sizeValue ||
      !opacityInput ||
      !opacityValue ||
      !lockInput ||
      !orientInput ||
      !resetButton ||
      !note ||
      !closeButton
    ) {
      return;
    }

    sizeInput.addEventListener('input', () => {
      this.applySize(Number(sizeInput.value));
      sizeValue.textContent = `${this.size}px`;
      this.persist();
    });

    opacityInput.addEventListener('input', () => {
      this.applyOpacity(Number(opacityInput.value) / 100);
      opacityValue.textContent = `${Math.round(this.settings.opacity * 100)}%`;
      this.persist();
    });

    lockInput.addEventListener('change', () => {
      this.applyLocked(lockInput.checked);
      resetButton.disabled = lockInput.checked;
      note.textContent = lockInput.checked
        ? '位置已锁定：解锁后才能拖动或重置。'
        : '拖动右下角握柄可移动到视口任意位置。';
      this.persist();
    });

    orientInput.addEventListener('change', () => {
      this.settings.orientLocked = orientInput.checked;
      // 锁定/解锁朝向后，轴端点的可点击状态跟着变
      this.element.classList.toggle('is-orient-locked', this.settings.orientLocked);
      this.applyOrientation(this.orientation());
      this.persist();
    });

    resetButton.addEventListener('click', () => {
      if (this.settings.locked) return;
      this.settings.pos = null;
      this.applyPosition();
      this.persist();
    });

    closeButton.addEventListener('click', () => this.closePanel());
  }

  private loadSettings(defaultSize: number): AxisIndicatorSettings {
    const fallback: AxisIndicatorSettings = {
      size: clamp(defaultSize, MIN_SIZE, MAX_SIZE),
      opacity: DEFAULT_OPACITY,
      locked: false,
      orientLocked: false,
      pos: null,
    };
    if (!this.storageKey) return fallback;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<AxisIndicatorSettings>;
      const pos = parsed.pos;
      return {
        size: typeof parsed.size === 'number' ? clamp(parsed.size, MIN_SIZE, MAX_SIZE) : fallback.size,
        opacity: typeof parsed.opacity === 'number' ? clamp(parsed.opacity, MIN_OPACITY, 1) : fallback.opacity,
        locked: parsed.locked === true,
        orientLocked: parsed.orientLocked === true,
        pos:
          pos && typeof pos.x === 'number' && typeof pos.y === 'number'
            ? { x: clamp(pos.x, 0, 1), y: clamp(pos.y, 0, 1) }
            : null,
      };
    } catch {
      // 隐私模式 / 手工改坏数据：回落到默认值，不影响视口
      return fallback;
    }
  }

  private persist(): void {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
    } catch {
      // 存储不可用时只是不记住设置
    }
  }

  /** 供需要手动隐藏（例如离屏缩略图渲染器）的调用方使用 */
  setVisible(visible: boolean): void {
    this.element.style.display = visible ? 'block' : 'none';
    if (!visible) this.closePanel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishDrag();
    this.closePanel();
    this.resizeObserver.disconnect();
    this.element.remove();
  }
}
