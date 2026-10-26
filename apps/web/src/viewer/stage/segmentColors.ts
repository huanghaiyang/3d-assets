/**
 * 分段标识色：序号 → 颜色。
 *
 * 动画序列没有上限，固定调色板很快会循环出重复色，所以按黄金角在色相环上
 * 连续取色，任意多个段都能得到彼此可区分的颜色。
 * 段上显式写了 color 时优先用自定义色。
 */

/** 黄金角（度）：相邻序号色相差，保证任意相邻段都能一眼区分 */
const GOLDEN_ANGLE = 137.508;

/** 起始色相取偏蓝的 210°，和舞台默认高亮色接近 */
const BASE_HUE = 210;

function hueOf(index: number): number {
  const hue = (BASE_HUE + index * GOLDEN_ANGLE) % 360;
  return hue < 0 ? hue + 360 : hue;
}

/** HSL（h 度，s/l 0–1）→ #rrggbb */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60) % 6;
  const rgb: [number, number, number] =
    sector === 0 ? [c, x, 0]
      : sector === 1 ? [x, c, 0]
        : sector === 2 ? [0, c, x]
          : sector === 3 ? [0, x, c]
            : sector === 4 ? [x, 0, c]
              : [c, 0, x];
  const toByte = (value: number): number => Math.round((value + m) * 255);
  return `#${[toByte(rgb[0]), toByte(rgb[1]), toByte(rgb[2])]
    .map((value) => Math.min(255, Math.max(0, value)).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** 该序号的默认颜色（#rrggbb） */
export function segmentColorHex(index: number): string {
  // 明度在 0.58–0.68 之间轻微起伏，避免多段同屏时亮度过于一致
  const lightness = 0.6 + ((index % 3) - 1) * 0.04;
  return hslToHex(hueOf(index), 0.68, lightness);
}

/** 段最终使用的颜色：自定义色优先 */
export function resolveSegmentColor(index: number, override?: string | null): string {
  return override && /^#[0-9a-f]{6}$/i.test(override) ? override.toLowerCase() : segmentColorHex(index);
}

/** 转成 three.js 材质用的数值色 */
export function segmentColorNumber(index: number, override?: string | null): number {
  return Number.parseInt(resolveSegmentColor(index, override).slice(1), 16);
}
