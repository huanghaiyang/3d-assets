import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '../lib/logger.js';

const log = createLogger('fs-browser');

/**
 * 通用文件系统浏览接口（只列文件夹），供应用内的「选择文件夹」对话框使用。
 *
 * 设计参考 torrent-manager 的 filebrowser：
 * - 单层最多返回 2000 个子文件夹，超出时 truncated=true，提示用户直接输入更深路径；
 * - 返回 parent 与 breadcrumbs，前端据此做「上一级」和面包屑导航；
 * - 标记隐藏目录（. / $ 开头、System Volume Information），由前端决定是否展示；
 * - 磁盘列表与「快速访问」由 /api/fs/locations 提供，弹窗第一次打开时拉取即可。
 *
 * 与业务无关：这里不关心文件夹里装的是什么，只按 ext 统计文件数，
 * 让调用方（动画工作区统计 fbx、素材库统计 glb）复用同一个选择器。
 */

/** 单层最多返回的子文件夹数 */
const MAX_ENTRIES = 2000;
/** 并行统计子目录文件数的并发上限：顺序读大目录会很慢，全并发又会打爆句柄 */
const COUNT_CONCURRENCY = 12;

export interface FsBreadcrumb {
  name: string;
  path: string;
}

export interface FsLocation {
  id: string;
  name: string;
  path: string;
  /** 前端 Icon 组件的图标名 */
  icon: string;
}

export interface FsDrive {
  root: string;
  name: string;
  /** 剩余空间（字节）；读不到时为 null */
  freeSpace: number | null;
}

/** 判断隐藏目录：`.` / `$` 开头，以及 Windows 的系统卷目录 */
function isHiddenDir(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('$') ||
    name.toLowerCase() === 'system volume information'
  );
}

/** 把绝对路径拆成「根 → 逐级目录」的面包屑 */
function buildBreadcrumbs(target: string): FsBreadcrumb[] {
  const root = path.parse(target).root;
  // Windows 下 root 形如 "D:\"，面包屑上显示成 "D:"
  const rootName = process.platform === 'win32' ? root.replace(/[\\/]+$/, '') || root : root;
  const crumbs: FsBreadcrumb[] = [{ name: rootName, path: root }];
  if (target === root) return crumbs;

  const parts = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

/** 把 Node 的文件系统错误翻译成带状态码的中文提示 */
function mapFsError(error: NodeJS.ErrnoException, target: string): { status: number; message: string } {
  if (error.code === 'ENOENT') return { status: 404, message: `文件夹不存在：${target}` };
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return { status: 403, message: `没有权限访问：${target}` };
  }
  if (error.code === 'ENOTDIR') return { status: 400, message: '目标路径不是文件夹' };
  return { status: 500, message: `无法读取文件夹：${error.message}` };
}

/** 并发受限的 map，保持结果顺序 */
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

/** 枚举磁盘；Windows 逐个盘符探测，其它系统只返回根目录 */
async function listDrives(): Promise<FsDrive[]> {
  if (process.platform !== 'win32') {
    try {
      const stats = await fs.statfs(path.parse(process.cwd()).root);
      return [{ root: '/', name: '/', freeSpace: stats.bavail * stats.bsize }];
    } catch {
      return [];
    }
  }

  const drives: FsDrive[] = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      const stats = await fs.statfs(root);
      drives.push({ root, name: `${letter}:`, freeSpace: stats.bavail * stats.bsize });
    } catch {
      /* 不存在的盘符直接跳过 */
    }
  }
  return drives;
}

/** 快速访问：个人目录下的常用文件夹，只返回真实存在的 */
async function listQuickLocations(): Promise<FsLocation[]> {
  const home = os.homedir();
  const candidates: FsLocation[] = [
    { id: 'home', name: '个人目录', path: home, icon: 'folder' },
    { id: 'desktop', name: '桌面', path: path.join(home, 'Desktop'), icon: 'grid' },
    { id: 'downloads', name: '下载', path: path.join(home, 'Downloads'), icon: 'download' },
    { id: 'documents', name: '文档', path: path.join(home, 'Documents'), icon: 'text' },
  ];

  const locations: FsLocation[] = [];
  for (const item of candidates) {
    try {
      const stat = await fs.stat(item.path);
      if (stat.isDirectory()) locations.push(item);
    } catch {
      /* 该机器上没有这个目录 */
    }
  }
  return locations;
}

export async function registerFsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 快速访问 + 磁盘列表。
   * 返回：{ locations: [{ id, name, path, icon }], drives: [{ root, name, freeSpace }] }
   */
  app.get('/api/fs/locations', async () => {
    const [locations, drives] = await Promise.all([listQuickLocations(), listDrives()]);
    return { locations, drives };
  });

  /**
   * 列出某个绝对路径下的子文件夹。
   *
   * 查询参数：
   * - dir：绝对路径，必须传
   * - ext：统计的扩展名（不含点，默认 fbx；素材库扫描传 glb）
   *
   * 返回：
   * { path, name, parent, breadcrumbs, entries: [{ name, path, hidden, fileCount }],
   *   total, truncated, fileCount, extension }
   */
  app.get('/api/fs/list', async (request, reply) => {
    const query = request.query as { dir?: string; ext?: string };
    // 扩展名只保留字母数字：它参与文件名后缀比较，避免奇怪字符混进来
    const extension = (query.ext ?? 'fbx').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'fbx';
    const requested = typeof query.dir === 'string' ? query.dir.trim() : '';
    if (!requested) return reply.code(400).send({ error: '缺少文件夹路径' });
    if (!path.isAbsolute(requested)) {
      return reply.code(400).send({ error: '请使用绝对路径，例如 D:\\models' });
    }

    const target = path.resolve(requested);
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) return reply.code(400).send({ error: '目标路径不是文件夹' });

      const dirents = await fs.readdir(target, { withFileTypes: true });
      const matchesExt = (name: string) => path.extname(name).slice(1).toLowerCase() === extension;

      // 先截断再统计文件数：目录里有几千个子文件夹时，逐个 readdir 会非常慢
      const dirDirents = dirents.filter((entry) => entry.isDirectory());
      const visible = dirDirents.slice(0, MAX_ENTRIES);
      const counts = await mapLimit(visible, COUNT_CONCURRENCY, async (entry) => {
        try {
          const children = await fs.readdir(path.join(target, entry.name), { withFileTypes: true });
          return children.filter((child) => child.isFile() && matchesExt(child.name)).length;
        } catch {
          /* 权限不足等异常不影响列表，按 0 处理 */
          return 0;
        }
      });

      const entries = visible
        .map((entry, index) => ({
          name: entry.name,
          path: path.join(target, entry.name),
          hidden: isHiddenDir(entry.name),
          fileCount: counts[index] ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));

      return {
        path: target,
        name: path.basename(target) || target,
        parent: target === path.parse(target).root ? null : path.dirname(target),
        breadcrumbs: buildBreadcrumbs(target),
        entries,
        total: dirDirents.length,
        truncated: dirDirents.length > MAX_ENTRIES,
        fileCount: dirents.filter((entry) => entry.isFile() && matchesExt(entry.name)).length,
        extension,
      };
    } catch (err) {
      const mapped = mapFsError(err as NodeJS.ErrnoException, target);
      if (mapped.status >= 500) log.warn(`浏览文件夹失败 ${target}: ${(err as Error).message}`);
      return reply.code(mapped.status).send({ error: mapped.message });
    }
  });
}
