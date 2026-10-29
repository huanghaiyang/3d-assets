import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { extensionOf, newId, safeFileName } from '../lib/ids.js';
import { createLogger } from '../lib/logger.js';
import { storageDir, uploadsStagingDir } from '../lib/paths.js';
import type { Workspace } from '../store/workspace.js';
import type { Asset, AssetFile, AssetFileEntry, GenerationParams, Job } from '../store/types.js';
import { DEFAULT_PARAMS } from '../store/types.js';
import { fileUrl, isZip, pickPrimary, roleFor, sanitizeEntryPath } from './assets.js';

const log = createLogger('uploads');

/** 允许上传的扩展名 */
const STANDALONE_MODEL_EXT = ['glb', 'stl', 'fbx', 'usdz'];
const GROUP_MODEL_EXT = ['obj', 'gltf'];
const COMPANION_EXT = ['mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'ktx2', 'hdr'];
const ZIP_EXT = ['zip'];

export const ACCEPTED_UPLOAD_EXT = [
  ...STANDALONE_MODEL_EXT,
  ...GROUP_MODEL_EXT,
  ...COMPANION_EXT,
  ...ZIP_EXT,
];

/** 单文件上限 200MB */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface StagedFile {
  /** 落盘后的绝对路径 */
  filePath: string;
  /** 用户原始文件名 */
  name: string;
  size: number;
  ext: string;
  /** 本地来源绝对路径（仅「扫描文件夹导入」会带，用于重复扫描去重） */
  sourcePath?: string;
}

export interface UploadGroup {
  /** 主文件（决定素材格式与名称） */
  primary: StagedFile;
  /** 附属文件（材质 / 贴图 / bin / zip 内文件） */
  companions: StagedFile[];
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export function stagingDirFor(batchId: string): string {
  return path.join(uploadsStagingDir, batchId);
}

/**
 * 清理过期上传暂存目录（默认 24 小时）。
 * 正常批次在 commit / abort 时就会删掉，这里只兜底“浏览器中途关闭/进程崩溃”留下的残留。
 */
export async function sweepStaging(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(uploadsStagingDir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of entries) {
    const dir = path.join(uploadsStagingDir, name);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const age = now - stat.mtimeMs;
    if (age < maxAgeMs) continue;
    await fs.rm(dir, { recursive: true, force: true });
    removed += 1;
    log.info(`清理过期上传暂存目录 ${name}（${Math.round(age / 3_600_000)} 小时前）`);
  }
  return removed;
}

export async function ensureStagingDir(batchId: string): Promise<string> {
  const dir = stagingDirFor(batchId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function assertValidBatchId(batchId: string): void {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(batchId)) {
    throw new UploadError('批次 ID 不合法');
  }
}

/**
 * 读取暂存目录，按“主文件 + 附属文件”分组。
 *
 * - `.zip`：单独成组，提交时自动解包
 * - `.glb/.stl/.fbx/.usdz`：各自成组
 * - `.obj/.gltf`：成组，并吸收同批次中的 `.mtl/.bin/贴图`
 * - 只有附属文件而没有主文件：报错提示
 */
export async function readStagedBatch(batchId: string): Promise<UploadGroup[]> {
  const dir = stagingDirFor(batchId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    throw new UploadError('没有找到待提交的上传文件，请重新选择');
  }
  if (names.length === 0) throw new UploadError('没有找到待提交的上传文件，请重新选择');

  const files: StagedFile[] = [];
  for (const storedName of names) {
    const filePath = path.join(dir, storedName);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    // 暂存名为 `<随机前缀>__<原始文件名>`，取第一个 __ 之后的部分还原原名
    const separator = storedName.indexOf('__');
    const original = separator >= 0 ? storedName.slice(separator + 2) : storedName;
    files.push({ filePath, name: original, size: stat.size, ext: extensionOf(original) });
  }
  if (files.length === 0) throw new UploadError('没有找到待提交的上传文件，请重新选择');

  const groups: UploadGroup[] = [];
  const companions: StagedFile[] = [];
  let groupHost: UploadGroup | null = null;

  for (const file of files) {
    if (ZIP_EXT.includes(file.ext) || STANDALONE_MODEL_EXT.includes(file.ext)) {
      groups.push({ primary: file, companions: [] });
    } else if (GROUP_MODEL_EXT.includes(file.ext)) {
      const group: UploadGroup = { primary: file, companions: [] };
      groups.push(group);
      // 附属文件挂到第一个 obj/gltf 组上
      if (!groupHost) groupHost = group;
    } else if (COMPANION_EXT.includes(file.ext)) {
      companions.push(file);
    } else {
      throw new UploadError(`不支持的文件类型：${file.name}`);
    }
  }

  if (companions.length > 0) {
    if (!groupHost) {
      throw new UploadError(
        '材质 / 贴图文件需要和 .obj 或 .gltf 主文件一起上传；也可以把整个文件夹打包成 .zip 再上传。',
      );
    }
    groupHost.companions = companions;
  }

  return groups;
}

export interface CommitResult {
  jobs: Job[];
  warnings: string[];
}

/** 把一批暂存文件转成素材库条目 */
export async function commitBatch(workspace: Workspace, batchId: string): Promise<CommitResult> {
  const jobs: Job[] = [];
  const warnings: string[] = [];
  let failure: Error | null = null;

  try {
    const groups = await readStagedBatch(batchId);
    for (const group of groups) {
      try {
        jobs.push(await createAssetFromGroup(workspace, group));
      } catch (err) {
        const message = `${group.primary.name}: ${(err as Error).message}`;
        log.warn(`上传素材失败 ${message}`);
        warnings.push(message);
      }
    }
  } catch (err) {
    failure = err as Error;
  } finally {
    // 无论成功还是失败都清掉暂存目录，避免残留
    await fs.rm(stagingDirFor(batchId), { recursive: true, force: true });
  }

  if (failure) throw failure;
  if (jobs.length === 0) {
    throw new UploadError(warnings.length > 0 ? warnings.join('；') : '没有可提交的模型文件');
  }
  return { jobs, warnings };
}

export async function discardBatch(batchId: string): Promise<void> {
  await fs.rm(stagingDirFor(batchId), { recursive: true, force: true });
}

async function createAssetFromGroup(
  workspace: Workspace,
  group: UploadGroup,
  persist = true,
): Promise<Job> {
  const assetId = newId('u');
  const assetDir = path.join(storageDir, assetId);
  await fs.rm(assetDir, { recursive: true, force: true });
  await fs.mkdir(assetDir, { recursive: true });

  try {
    return await buildAsset(workspace, group, assetId, assetDir, persist);
  } catch (err) {
    // 中途失败时清掉半成品目录，避免残留空目录或残缺文件
    await fs.rm(assetDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 把一个本地磁盘上的独立模型文件导入素材库（「扫描文件夹」批量导入的底层实现）。
 *
 * 与浏览器上传的区别：文件已经在磁盘上，直接按路径读取并复制到素材存储目录，
 * 不需要经过暂存区。`persist=false` 时只落盘文件与返回 Job，由调用方批量写状态，
 * 避免一次扫描几百个模型时把 state.json 写几百遍。
 *
 * @param filePath 磁盘上的模型绝对路径（只读取，不修改源文件）
 * @param sourcePath 写入 Asset.sourcePath 的值，用于重复扫描去重
 */
export async function importLocalModel(
  workspace: Workspace,
  filePath: string,
  sourcePath: string,
  persist = true,
): Promise<Job> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new UploadError('路径不是文件');
  if (stat.size <= 0) throw new UploadError('文件为空');
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(`超过单文件上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
  }
  const name = path.basename(filePath);
  const group: UploadGroup = {
    primary: {
      filePath,
      name,
      size: stat.size,
      ext: extensionOf(name),
      sourcePath,
    },
    companions: [],
  };
  return createAssetFromGroup(workspace, group, persist);
}

async function buildAsset(
  workspace: Workspace,
  group: UploadGroup,
  assetId: string,
  assetDir: string,
  persist = true,
): Promise<Job> {
  const entries: AssetFileEntry[] = [];
  let bytes = 0;
  let storedName = '';
  let format = group.primary.ext;
  let wasZip = false;
  let size = 0;

  const primaryBuffer = await fs.readFile(group.primary.filePath);
  size += primaryBuffer.length;
  bytes += primaryBuffer.length;

  if (ZIP_EXT.includes(group.primary.ext)) {
    // zip：解包到 <type>/ 目录，与原接口结果的落盘方式保持一致
    wasZip = true;
    const slug = safeFileName('zip', 'zip');
    const zip = new AdmZip(primaryBuffer);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const relative = sanitizeEntryPath(entry.entryName);
      if (!relative) continue;
      const target = path.join(assetDir, slug, relative);
      if (!target.startsWith(path.join(assetDir, slug))) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      const data = entry.getData();
      await fs.writeFile(target, data);
      entries.push({
        name: relative,
        size: data.length,
        url: fileUrl(assetId, `${slug}/${relative}`),
        role: roleFor(extensionOf(relative)),
      });
    }
    if (entries.length === 0) throw new UploadError('zip 中没有可用的模型文件');
    const primary = pickPrimary(entries);
    if (!primary) throw new UploadError('zip 中没有找到受支持的模型文件（glb/gltf/obj/fbx/stl/usdz）');
    format = extensionOf(primary.name);
    storedName = slug;
  } else {
    // 普通文件：主文件 + 附属文件平铺到素材目录
    const used = new Set<string>();
    const writeOne = async (file: StagedFile, content?: Buffer): Promise<AssetFileEntry> => {
      let base = safeFileName(file.name, `file.${file.ext || 'bin'}`);
      while (used.has(base)) base = `_${base}`;
      used.add(base);
      const data = content ?? (await fs.readFile(file.filePath));
      await fs.writeFile(path.join(assetDir, base), data);
      bytes += data.length;
      return { name: base, size: data.length, url: fileUrl(assetId, base), role: roleFor(extensionOf(base)) };
    };

    const primaryEntry = await writeOne(group.primary, primaryBuffer);
    entries.push(primaryEntry);
    storedName = primaryEntry.name;
    for (const companion of group.companions) {
      entries.push(await writeOne(companion));
    }
  }

  const material = entries.find((entry) => entry.role === 'material') ?? null;
  const primaryEntry = pickPrimary(entries);
  if (!primaryEntry) throw new UploadError('没有找到可在浏览器中预览的模型文件');

  const assetFile: AssetFile = {
    type: format.toUpperCase(),
    sourceUrl: '',
    storedName,
    size,
    wasZip,
    format,
    entries,
    primaryUrl: primaryEntry.url,
    materialUrl: material?.url ?? null,
  };

  const params: GenerationParams = { ...DEFAULT_PARAMS };
  const now = new Date().toISOString();
  const fileName = group.primary.name;

  const asset: Asset = {
    id: assetId,
    createdAt: now,
    name: stripExtension(fileName),
    prompt: '',
    mode: 'upload',
    params,
    thumbnailUrl: null,
    previewRemoteUrl: null,
    files: [assetFile],
    creditConsumed: null,
    creditDetails: null,
    bytes,
    // 扫描文件夹导入时记录来源路径，重复扫描可以据此跳过
    ...(group.primary.sourcePath ? { sourcePath: group.primary.sourcePath } : {}),
  };

  const job: Job = {
    id: assetId,
    createdAt: now,
    updatedAt: now,
    name: asset.name,
    origin: 'uploaded',
    phase: 'done',
    params,
    input: {
      mode: 'upload',
      prompt: '',
      imageName: fileName,
      previewUrl: null,
      viewTypes: [],
    },
    remoteJobId: null,
    remoteStatus: null,
    providerMeta: {},
    requestId: null,
    error: null,
    errorCode: null,
    creditConsumed: null,
    creditDetails: null,
    attempts: 0,
    startedAt: now,
    finishedAt: now,
    cancelRequested: false,
    remoteFailed: false,
    asset,
  };

  if (persist) {
    await workspace.mutate((state) => {
      state.jobs.unshift(job);
    });
  }
  log.info(`已导入素材 ${assetId} (${fileName}, ${entries.length} 个文件)`);
  return job;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.slice(0, 60) || '上传模型';
}
