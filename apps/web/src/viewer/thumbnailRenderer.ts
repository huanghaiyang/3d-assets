import type { Asset } from '@/api/types';
import { ModelViewer } from './ModelViewer';
import { pickPreviewTarget } from './assetTarget';

/**
 * 离屏缩略图渲染器。
 *
 * 上传的模型没有接口返回的预览图，需要在浏览器里渲染一张。
 * 这里用一个挂在屏幕外、固定 512×512 的 ModelViewer 顺序渲染，
 * 与主视口互不干扰（不改变当前选中项，也不会闪屏）。
 */

const THUMB_SIZE = 512;

let holder: HTMLDivElement | null = null;
let viewer: ModelViewer | null = null;
/** WebGL 上下文创建失败时不再反复重试 */
let unavailable = false;

function ensureViewer(): ModelViewer {
  if (viewer) return viewer;
  holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${THUMB_SIZE}px`,
    `height:${THUMB_SIZE}px`,
    'pointer-events:none',
    'opacity:0',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(holder);
  viewer = new ModelViewer(holder);
  viewer.setGrid(false);
  return viewer;
}

/** 释放离屏渲染器，回收 WebGL 上下文 */
export function releaseThumbnailRenderer(): void {
  viewer?.dispose();
  viewer = null;
  holder?.remove();
  holder = null;
}

export function isThumbnailRendererBusy(): boolean {
  return viewer !== null;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** 渲染一个素材的缩略图，返回 PNG data URL；不可预览或渲染失败时返回 null */
export async function renderAssetThumbnail(asset: Asset, size = THUMB_SIZE): Promise<string | null> {
  if (unavailable) return null;
  const target = pickPreviewTarget(asset);
  if (!target) return null;

  try {
    const instance = ensureViewer();
    await instance.load(target);
    instance.setGrid(false);
    // 等两帧，确保贴图上传完成后再截图
    await nextFrame();
    const dataUrl = instance.captureThumbnail(size);
    return dataUrl && dataUrl.length > 128 ? dataUrl : null;
  } catch {
    // 第二次 WebGL 上下文创建失败等情况：放弃批量生成，不影响其它功能
    unavailable = true;
    releaseThumbnailRenderer();
    return null;
  }
}
