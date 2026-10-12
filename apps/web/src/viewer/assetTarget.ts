import type { Asset } from '@/api/types';
import { PREVIEWABLE_FORMATS, type LoadTarget } from './ModelViewer';

/** 预览时的格式优先级：优先用单文件、带材质的格式 */
const PREVIEW_ORDER = ['glb', 'gltf', 'obj', 'stl', 'fbx'];

/** 从素材里挑出可在浏览器中渲染的文件（供视口与缩略图生成共用） */
export function pickPreviewTarget(asset: Asset): LoadTarget | null {
  for (const format of PREVIEW_ORDER) {
    const file = asset.files.find((item) => item.format === format && item.primaryUrl);
    if (file?.primaryUrl) {
      return { url: file.primaryUrl, format: file.format, materialUrl: file.materialUrl };
    }
  }
  return null;
}

export function isPreviewable(asset: Asset): boolean {
  return asset.files.some((file) => PREVIEWABLE_FORMATS.includes(file.format) && file.primaryUrl);
}
