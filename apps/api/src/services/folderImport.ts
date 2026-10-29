import type { Dirent } from 'node:fs';
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

export interface FolderImportResult {
  /** 规范化后的扫描根目录 */
  folder: string;
  /** 扫描到的 .glb 文件总数（含被跳过的） */
  scanned: number;
  /** 成功导入的素材 */
  created: Job[];
  /** 因已存在（同一路径导入过）而跳过的文件数 */
  skipped: number;
  /** 导入失败的文件与原因 */
  failed: Array<{ name: string; path: string; error: string }>;
  /** 达到上限后未处理的文件数 */
  overflow: number;
}

interface ScannedFile {
  filePath: string;
  relative: string;
  size: number;
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

/**
 * 扫描指定文件夹并把其中所有 .glb 一次性导入素材库。
 *
 * @param dir 用户输入的文件夹路径；必须是绝对路径（相对路径在不同进程工作目录下
 *            含义不一致，直接拒绝，避免误扫到服务目录）
 * @param recursive 是否递归子目录，默认 true
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

  // 已导入过的来源路径：重复扫描时直接跳过，避免素材库出现大量重复条目
  const existing = new Set<string>();
  for (const job of workspace.jobs) {
    const source = job.asset?.sourcePath;
    if (source) existing.add(normalizePathForCompare(source));
  }

  const result: FolderImportResult = {
    folder: root,
    scanned: files.length + overflow,
    created: [],
    skipped: 0,
    failed: [],
    overflow,
  };

  for (const file of files) {
    const key = normalizePathForCompare(file.filePath);
    if (existing.has(key)) {
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
      const job = await importLocalModel(workspace, file.filePath, file.filePath, false);
      result.created.push(job);
      existing.add(key);
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
      `跳过 ${result.skipped} 个，失败 ${result.failed.length} 个`,
  );
  return result;
}
