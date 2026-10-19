import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createLogger } from '../lib/logger.js';
import { extensionOf, safeFileName } from '../lib/ids.js';
import { storageDir } from '../lib/paths.js';
import type { Asset, AssetFile, AssetFileEntry, FileRole, GenerationParams, InputMode } from '../store/types.js';
import type { Downloader, ProviderFile } from '../providers/types.js';

const log = createLogger('assets');

export const MODEL_EXTENSIONS = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'usdz'] as const;
const MODEL_PREFERENCE = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'usdz'];
export const TEXTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'ktx2', 'hdr'];
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export function roleFor(ext: string): FileRole {
  if ((MODEL_EXTENSIONS as readonly string[]).includes(ext)) return 'model';
  if (ext === 'mtl') return 'material';
  if (TEXTURE_EXTENSIONS.includes(ext)) return 'texture';
  return 'other';
}

/** 生成可被浏览器直接访问的文件 URL（逐段编码，保留子目录结构） */
export function fileUrl(jobId: string, relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/files/${encodeURIComponent(jobId)}/${encoded}`;
}

export function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

export function sanitizeEntryPath(entryName: string): string {
  return entryName
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map((segment) => safeFileName(segment, 'file'))
    .join('/');
}

export interface MaterializeOptions {
  /** 下载远端结果文件（由当前生成引擎实现，可能是带鉴权的请求） */
  download: Downloader;
  jobId: string;
  name: string;
  prompt: string;
  mode: InputMode;
  params: GenerationParams;
  files: ProviderFile[];
  creditConsumed: number | null;
  creditDetails: string | null;
}

/**
 * 把远端结果（24 小时有效）转存到本地素材目录。
 * OBJ 等格式通常以 zip 打包返回，这里自动解包并识别主模型/材质/贴图。
 */
export async function materializeAsset(options: MaterializeOptions): Promise<Asset> {
  const { download, jobId } = options;
  const assetDir = path.join(storageDir, jobId);
  await fs.rm(assetDir, { recursive: true, force: true });
  await fs.mkdir(assetDir, { recursive: true });

  const stored: AssetFile[] = [];
  let bytes = 0;
  let thumbnailUrl: string | null = null;
  let previewRemoteUrl: string | null = null;

  for (const remote of options.files) {
    if (!remote.url) continue;
    const type = (remote.type || extensionOf(remote.url) || 'FILE').toUpperCase();
    const typeSlug = safeFileName(type.toLowerCase(), 'model');
    try {
      const { buffer } = await download(remote.url);
      bytes += buffer.length;

      if (isZip(buffer)) {
        const zip = new AdmZip(buffer);
        const entries: AssetFileEntry[] = [];
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const rel = sanitizeEntryPath(entry.entryName);
          if (!rel) continue;
          const target = path.join(assetDir, typeSlug, rel);
          if (!target.startsWith(path.join(assetDir, typeSlug))) continue;
          await fs.mkdir(path.dirname(target), { recursive: true });
          const data = entry.getData();
          await fs.writeFile(target, data);
          entries.push({
            name: rel,
            size: data.length,
            url: fileUrl(jobId, `${typeSlug}/${rel}`),
            role: roleFor(extensionOf(rel)),
          });
        }
        const primary = pickPrimary(entries);
        const material = entries.find((entry) => entry.role === 'material') ?? null;
        stored.push({
          type,
          sourceUrl: remote.url,
          storedName: typeSlug,
          size: buffer.length,
          wasZip: true,
          format: primary ? extensionOf(primary.name) : '',
          entries,
          primaryUrl: primary?.url ?? null,
          materialUrl: material?.url ?? null,
        });
      } else {
        const ext = extensionOf(remote.url) || 'bin';
        const name = `${typeSlug}.${ext}`;
        await fs.writeFile(path.join(assetDir, name), buffer);
        const entry: AssetFileEntry = {
          name,
          size: buffer.length,
          url: fileUrl(jobId, name),
          role: roleFor(ext),
        };
        stored.push({
          type,
          sourceUrl: remote.url,
          storedName: name,
          size: buffer.length,
          wasZip: false,
          format: ext,
          entries: [entry],
          primaryUrl: entry.role === 'model' ? entry.url : null,
          materialUrl: null,
        });
      }
    } catch (err) {
      log.warn(`下载结果文件失败 ${remote.url}: ${(err as Error).message}`);
    }
  }

  // 缩略图：优先使用接口返回的预览图
  for (const remote of options.files) {
    const previewUrl = remote.previewImageUrl;
    if (!previewUrl) continue;
    previewRemoteUrl = previewUrl;
    try {
      const { buffer, contentType } = await download(previewUrl);
      const ext = IMAGE_CONTENT_TYPES[contentType.split(';')[0]?.trim() ?? ''] ?? (extensionOf(previewUrl) || 'png');
      const name = `thumb.${ext}`;
      await fs.writeFile(path.join(assetDir, name), buffer);
      bytes += buffer.length;
      thumbnailUrl = fileUrl(jobId, name);
      break;
    } catch (err) {
      log.warn(`下载预览图失败: ${(err as Error).message}`);
    }
  }

  return {
    id: jobId,
    createdAt: new Date().toISOString(),
    name: options.name,
    prompt: options.prompt,
    mode: options.mode,
    params: options.params,
    thumbnailUrl,
    previewRemoteUrl,
    files: stored,
    creditConsumed: options.creditConsumed,
    creditDetails: options.creditDetails,
    bytes,
  };
}

export function pickPrimary(entries: AssetFileEntry[]): AssetFileEntry | null {
  const models = entries.filter((entry) => entry.role === 'model');
  if (models.length === 0) return null;
  return models.sort((a, b) => {
    const ai = MODEL_PREFERENCE.indexOf(extensionOf(a.name));
    const bi = MODEL_PREFERENCE.indexOf(extensionOf(b.name));
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  })[0]!;
}

/** 删除素材目录 */
export async function removeAssetFiles(jobId: string): Promise<void> {
  await fs.rm(path.join(storageDir, jobId), { recursive: true, force: true });
}

/**
 * 启动时清理素材目录：删除没有对应任务记录的目录（例如删除任务与写缩略图竞争留下的），
 * 以及空目录。
 */
export async function sweepStorage(workspace: { jobs: readonly { id: string }[] }): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fs.readdir(storageDir);
  } catch {
    return 0;
  }
  const known = new Set(workspace.jobs.map((job) => job.id));

  // 安全阀：状态里一个任务都没有、却有一堆素材目录时，几乎一定是 state.json 丢了/坏了。
  // 此时绝不能按“无对应任务”批量删除，否则模型文件会被一起清空。
  if (known.size === 0 && names.length > 0) {
    log.warn(
      `状态中没有任务记录，但发现 ${names.length} 个素材目录：已跳过素材清理以避免误删（确认无用后可手动清空 data/storage）`,
    );
    return 0;
  }

  for (const name of names) {
    const dir = path.join(storageDir, name);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const orphan = !known.has(name);
    const children = await fs.readdir(dir).catch(() => ['?']);
    if (orphan || children.length === 0) {
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
      log.info(`清理素材目录 ${name}（${orphan ? '无对应任务' : '空目录'}）`);
    }
  }
  return removed;
}

const THUMB_DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/s;

/** 保存浏览器回填的缩略图，返回可访问 URL */
export async function saveThumbnailDataUrl(jobId: string, dataUrl: string): Promise<string | null> {
  const match = THUMB_DATA_URL_RE.exec(dataUrl.trim());
  if (!match) return null;
  const ext = match[1] === 'png' ? 'png' : 'jpg';
  const rel = `thumb.${ext}`;
  try {
    const dir = path.join(storageDir, jobId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, rel), Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64'));
    return fileUrl(jobId, rel);
  } catch (err) {
    log.error(`写入缩略图失败: ${(err as Error).message}`);
    return null;
  }
}

/** 保存后端子线程渲染出的封面 PNG，返回可访问 URL */
export async function saveThumbnailBuffer(jobId: string, png: Buffer, ext = 'png'): Promise<string | null> {
  const rel = `thumb.${ext}`;
  try {
    const dir = path.join(storageDir, jobId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, rel), png);
    return fileUrl(jobId, rel);
  } catch (err) {
    log.error(`写入封面失败: ${(err as Error).message}`);
    return null;
  }
}

/** 封面渲染支持的格式（与浏览器可预览格式保持一致） */
const COVER_FORMAT_PREFERENCE = ['glb', 'gltf', 'obj', 'fbx', 'stl'] as const;

/**
 * 找出素材里最适合做封面的本地模型文件（绝对路径）。
 * 优先单文件 GLB，其次 glTF/OBJ/FBX/STL；找不到返回 null。
 */
export async function pickCoverSourcePath(
  jobId: string,
  asset: Pick<Asset, 'files'>,
): Promise<{ filePath: string; format: string } | null> {
  for (const format of COVER_FORMAT_PREFERENCE) {
    for (const file of asset.files) {
      for (const entry of file.entries) {
        if (entry.role !== 'model') continue;
        if (extensionOf(entry.name) !== format) continue;
        const filePath = path.join(storageDir, jobId, ...entry.name.split('/'));
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat?.isFile()) return { filePath, format };
      }
    }
  }
  return null;
}

/** 从提示词生成一个可读的默认名称 */
export function deriveName(prompt: string, mode: InputMode, fileName?: string | null): string {
  const base = prompt.trim() || (mode === 'text' ? '' : fileName ?? '');
  const cleaned = base.replace(/\s+/g, ' ').trim();
  if (!cleaned) return mode === 'text' ? '未命名模型' : '图生3D 模型';
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned;
}
