export interface PreparedImage {
  /** data URL，用于界面预览 */
  dataUrl: string;
  /** 去掉前缀的纯 base64，提交给混元接口 */
  base64: string;
  width: number;
  height: number;
  /** 编码后的字节数 */
  bytes: number;
  name: string;
  mime: string;
}

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_LONG_EDGE = 1600;
const MIN_SIDE = 128;
/** 接口限制单图 base64 ≤ 6MB */
const MAX_ENCODED_BYTES = 6 * 1024 * 1024;

export function base64Bytes(base64: string): number {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export async function prepareImageFile(file: File): Promise<PreparedImage> {
  if (!ACCEPTED_MIME.includes(file.type)) {
    throw new Error(`不支持的图片格式 ${file.type || '(未知)'}，请使用 PNG / JPG / WEBP`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩后再上传`);
  }

  const bitmap = await loadBitmap(file);
  try {
    const { width, height } = bitmap;
    if (Math.min(width, height) < MIN_SIDE) {
      throw new Error(`图片分辨率过低（${width}×${height}），混元要求单边不小于 ${MIN_SIDE}px`);
    }

    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 Canvas，无法处理图片');
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    // PNG 保留透明通道（草图/线稿更清晰），其余用 JPEG 控制体积
    const isPng = file.type === 'image/png';
    let mime = isPng ? 'image/png' : 'image/jpeg';
    let quality = isPng ? undefined : 0.92;
    let dataUrl = canvas.toDataURL(mime, quality);

    // 体积超限时逐级降低 JPEG 质量
    const attempts = [0.85, 0.75, 0.62];
    for (const nextQuality of attempts) {
      if (base64Bytes(dataUrl.split(',')[1] ?? '') <= MAX_ENCODED_BYTES) break;
      mime = 'image/jpeg';
      quality = nextQuality;
      dataUrl = canvas.toDataURL(mime, quality);
    }

    const base64 = dataUrl.split(',')[1] ?? '';
    const bytes = base64Bytes(base64);
    if (bytes > MAX_ENCODED_BYTES) {
      throw new Error(`图片编码后仍超过 ${(MAX_ENCODED_BYTES / 1024 / 1024).toFixed(0)}MB，请换一张更小的图片`);
    }

    return {
      dataUrl,
      base64,
      width: targetWidth,
      height: targetHeight,
      bytes,
      name: file.name || `image.${isPng ? 'png' : 'jpg'}`,
      mime,
    };
  } finally {
    bitmap.close?.();
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // 回退到 <img> 解码
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('图片解码失败，请换一张图片'));
        image.src = url;
      });
      return await createImageBitmap(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** 从剪贴板事件中取出图片文件 */
export function imageFileFromClipboard(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`;
}
