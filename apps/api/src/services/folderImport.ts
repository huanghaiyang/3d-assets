import type { Dirent } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import type { Job } from '../store/types.js';
import type { Workspace } from '../store/workspace.js';
import { MAX_UPLOAD_BYTES, UploadError, importLocalModel } from './uploads.js';

const log = createLogger('folder-import');

/** 单次扫描最多处理的 GLB 数量：避免误选巨型素材目录时卡住服务 */
export const MAX_SCAN_FILES = 500;
/** 递归扫描的最大目录深度（防止软链接环 / 超深目录） */
const MAX_SCAN_DEPTH = 8;
/** 同时读取文件算 checksum 的并发数：避免 SSD 被打爆 */
const CHECKSUM_CONCURRENCY = 4;

export interface FolderImportResult {
  /** 规范化后的扫描根目录 */
  folder: string;
  /** 扫描到的 .glb 文件总数（含被跳过的） */
  scanned: number;
  /** 成功导入的素材 */
  created: Job[];
  /** 跳过总数（等于 skippedByPath + skippedByContent） */
  skipped: number;
  /** 因来源路径已导入过而跳过（路径去重，低成本） */
  skippedByPath: number;
  /** 因主模型文件的 SHA-256 已存在而跳过（内容级去重） */
  skippedByContent: number;
  /** 导入失败的文件与原因 */
  failed: Array<{ name: string; path: string; error: string }>;
  /** 达到上限后未处理的文件数 */
  overflow: number;
}

interface ScannedFile {
  filePath: string;
  relative: string;
  size: number;
  checksum: string;
}

/**
 * 递归扫描文件夹里的 .glb 文件。
 *
 * 规则：
 * - 只认 `.glb`（大小写不敏感），不处理 .gltf / .fbx 等需要附属文件的格式；
 * - 跳过隐藏文件 / 隐藏目录（名字以 `.` 开头）与符号链接，避免扫到系统目录或
 *   软链接环；
 * - 结果按路径排序，保证导入顺序稳定、可复现；
 * - 达到 MAX_SCAN_FILES 后停止收集，剩余数量通过 overflow 返回给前端提示。
 */
async function scanGlbFiles(
  root: string,
  recursive: boolean,
): Promise<{ files: ScannedFile[]; overflow: number }> {
  const files: ScannedFile[] = [];
  let overflow = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(`无法读取目录 ${dir}: ${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (recursive && depth < MAX_SCAN_DEPTH) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (path.extname(entry.name).toLowerCase() !== '.glb') continue;
      if (files.length >= MAX_SCAN_FILES) {
        overflow += 1;
        continue;
      }
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      files.push({
        filePath: full,
        relative: path.relative(root, full),
        size: stat.size,
        checksum: '',
      });
    }
  };

  await walk(root, 0);
  files.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN'));
  return { files, overflow };
}

/** 统一 Windows 路径大小写，防止同一文件因盘符/大小写写法不同被重复导入 */
function normalizePathForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 并发受限 map，保持结果顺序 */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 为扫描到的文件批量计算 SHA-256 checksum。
 *
 * 优化策略：
 * - 只需要去重时才读整个文件；但为了拿到 checksum 必须读一遍内容，这是 I/O 下限；
 * - 并发 CHECKSUM_CONCURRENCY 路，顺序读 SSD 比随机读快很多，同时并发又能利用
 *   多通道；
 * - 读文件同时算哈希（crypto.createHash 边 update 边 digest），避免把整个文件
 *   长时间驻在内存里。
 */
async function computeChecksums(files: ScannedFile[]): Promise<void> {
  const results = await mapLimit(files, CHECKSUM_CONCURRENCY, async (file) => {
    try {
      const buffer = await fs.readFile(file.filePath);
      return crypto.createHash('sha256').update(buffer).digest('hex');
    } catch (err) {
      log.warn(`无法读取 ${file.filePath} 计算 checksum: ${(err as Error).message}`);
      return '';
    }
  });
  for (let i = 0; i < files.length; i += 1) {
    files[i]!.checksum = results[i]!;
  }
}

/**
 * 扫描指定文件夹并把其中所有 .glb 一次性导入素材库。
 *
 * 去重策略（两层，内容级为主、路径级兜底）：
 *
 *   ① **路径级去重**：历史素材里已有相同 sourcePath 的直接跳过，成本最低，
 *      覆盖「完全一样的文件夹再扫一次」这种场景。
 *
 *   ② **内容级去重**：扫描阶段批量计算每个文件的 SHA-256，和 workspace 里
 *      已有 Asset.checksum 比对。命中就跳过，不管路径、文件名是否相同。
 *      这解决「文件拷贝到另一文件夹后再次扫描」「直接上传了已经扫描过的模型」
 *      两类漏检。
 *
 *   历史素材（加 checksum 字段前创建的）没有 checksum，②会自动跳过；这些素材
 *   仍能被 ① 拦住。下次再次扫描同一文件夹时，新导入的素材就会带上 checksum，
 *   两层去重都生效。
 *
 * 入参 dir 必须是绝对路径（相对路径在不同进程工作目录下含义不一致，直接拒绝，
 * 避免误扫到服务目录）。
 *
 * @throws UploadError 路径参数不合法（供路由映射为 400）
 */
export async function importGlbFolder(
  workspace: Workspace,
  dir: string,
  recursive = true,
): Promise<FolderImportResult> {
  const raw = (dir ?? '').trim();
  if (!raw) throw new UploadError('请填写要扫描的文件夹路径');
  if (!path.isAbsolute(raw)) {
    throw new UploadError('请填写绝对路径（例如 D:\\models\\characters）');
  }
  const root = path.resolve(raw);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat) throw new UploadError(`文件夹不存在：${root}`);
  if (!stat.isDirectory()) throw new UploadError(`不是文件夹：${root}`);

  const { files, overflow } = await scanGlbFiles(root, recursive);
  await computeChecksums(files);

  // ===== 准备去重索引 =====
  // 路径级：所有历史素材的 sourcePath 集合（低成本，命中直接跳过）
  const existingPaths = new Set<string>();
  // 内容级：历史素材的 checksum 集合（新数据有、老数据没有，命中即跳过）
  const existingChecksums = new Set<string>();
  for (const job of workspace.jobs) {
    const asset = job.asset;
    if (!asset) continue;
    if (asset.sourcePath) existingPaths.add(normalizePathForCompare(asset.sourcePath));
    if (asset.checksum) existingChecksums.add(asset.checksum);
  }

  const result: FolderImportResult = {
    folder: root,
    scanned: files.length + overflow,
    created: [],
    skipped: 0,
    skippedByPath: 0,
    skippedByContent: 0,
    failed: [],
    overflow,
  };

  // 本次扫描内部也做一次 checksum 去重：同一文件夹里有两个一模一样的 GLB
  // （例如 a.glb 和 b.glb 内容完全相同），只导入第一个，第二个算内容重复
  const seenChecksumsInBatch = new Set<string>();

  for (const file of files) {
    const normalizedPath = normalizePathForCompare(file.filePath);
    const duplicateByPath = existingPaths.has(normalizedPath);
    const duplicateByContent =
      !duplicateByPath &&
      file.checksum &&
      (existingChecksums.has(file.checksum) || seenChecksumsInBatch.has(file.checksum));

    if (duplicateByPath) {
      result.skippedByPath += 1;
      result.skipped += 1;
      continue;
    }
    if (duplicateByContent) {
      result.skippedByContent += 1;
      result.skipped += 1;
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      result.failed.push({
        name: file.relative,
        path: file.filePath,
        error: `超过单文件上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`,
      });
      continue;
    }
    try {
      // persist=false：文件逐个落盘，状态在循环结束后统一写一次，减少磁盘写入
      const job = await importLocalModel(
        workspace,
        file.filePath,
        file.filePath,
        false,
        file.checksum || undefined,
      );
      result.created.push(job);
      // 新增素材也把路径和 checksum 加入本地索引，避免同一批次内重复
      existingPaths.add(normalizedPath);
      if (file.checksum) {
        existingChecksums.add(file.checksum);
        seenChecksumsInBatch.add(file.checksum);
      }
    } catch (err) {
      result.failed.push({
        name: file.relative,
        path: file.filePath,
        error: (err as Error).message,
      });
    }
  }

  if (result.created.length > 0) {
    await workspace.mutate((state) => {
      // 新的排在前面，并保持扫描顺序稳定（最后导入的在最上方）
      state.jobs.unshift(...result.created);
    });
  }

  log.info(
    `扫描文件夹 ${root}: 发现 ${result.scanned} 个 GLB，导入 ${result.created.length} 个，` +
      `跳过 ${result.skipped} 个（路径 ${result.skippedByPath}、内容 ${result.skippedByContent}），` +
      `失败 ${result.failed.length} 个`,
  );
  return result;
}
