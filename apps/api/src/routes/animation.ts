import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { joinData } from '../lib/paths.js';
import { createLogger } from '../lib/logger.js';
import { animationCover, COVER_CACHE_VERSION } from '../services/covers.js';

const log = createLogger('anim');

/**
 * 动画预览用的文件夹浏览接口。
 *
 * 严格只读：这里只使用 fs.readdir / fs.stat / fs.readFile，
 * 不做任何写入，也不会在目标目录里生成缩略图或缓存文件。
 * fs.readFile 打开后立即读完并关闭句柄（libuv 以共享方式打开），
 * 因此不会锁住文件，游戏引擎等其它进程仍可正常读写这些 FBX。
 */

const MAX_FILES = 3000;
const MAX_DEPTH = 4;

function isFbx(name: string): boolean {
  return path.extname(name).toLowerCase() === '.fbx';
}

interface AnimationFile {
  name: string;
  /** 相对所属文件夹的路径 */
  relative: string;
  /** 绝对路径，供前端回传取流 */
  path: string;
  /** 所属的根文件夹（多文件夹时用于分组与筛选） */
  sourceDir: string;
  /** 根文件夹名，界面上做标签 */
  sourceLabel: string;
  size: number;
  mtime: number;
}

interface ScanResult {
  dir: string;
  files: AnimationFile[];
  truncated: boolean;
}

/** 取文件夹名作为标签；同名时退化为最后两段路径 */
function labelFor(dir: string, used: Set<string>): string {
  const base = path.basename(dir) || dir;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const parts = dir.split(path.sep).filter(Boolean);
  const longer = parts.slice(-2).join('/');
  used.add(longer);
  return longer;
}

async function resolveDir(input: string): Promise<string> {
  const dir = path.resolve(input.trim());
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error('不是文件夹');
  return dir;
}

async function resolveDirs(input: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const item of input) {
    const resolved = await resolveDir(item);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/** 递归扫描单个目录下的 .fbx（只读），并打上来源标签 */
async function scanDir(root: string, sourceLabel: string, budget: number): Promise<ScanResult> {
  const files: AnimationFile[] = [];
  let truncated = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      log.warn(`读取目录失败 ${current}: ${(err as Error).message}`);
      return;
    }

    for (const entry of entries) {
      if (files.length >= budget) {
        truncated = true;
        return;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // 跳过子目录里的隐藏目录（类似 .git），但浏览根目录本身可以是隐藏目录
        if (depth >= MAX_DEPTH || entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && isFbx(entry.name)) {
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) continue;
        files.push({
          name: entry.name,
          relative: path.relative(root, full).split(path.sep).join('/'),
          path: full,
          sourceDir: root,
          sourceLabel,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  }

  await walk(root, 0);
  files.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-Hans-CN', { numeric: true }));
  return { dir: root, files, truncated };
}

export interface AnimationDeps {
  /** 读取/保存用户选择的文件夹（持久记录） */
  getDirs: () => string[];
  setDirs: (dirs: string[]) => Promise<void>;
}

export async function registerAnimationRoutes(app: FastifyInstance, deps: AnimationDeps): Promise<void> {
  const MAX_DIRS = 20;

  /** 当前生效的文件夹：用户保存过的优先，否则用默认目录 */
  async function effectiveDirs(): Promise<{ dirs: string[]; missing: string[] }> {
    const saved = deps.getDirs();
    const candidates = saved.length > 0 ? saved : [path.resolve(config.animationDir)];
    const missing: string[] = [];
    const dirs: string[] = [];
    for (const item of candidates) {
      const resolved = path.resolve(item);
      const stat = await fs.stat(resolved).catch(() => null);
      if (stat?.isDirectory()) {
        if (!dirs.includes(resolved)) dirs.push(resolved);
      } else {
        missing.push(resolved);
      }
    }
    return { dirs, missing };
  }

  app.get('/api/anim/info', async () => {
    const { dirs, missing } = await effectiveDirs();
    const defaultDir = path.resolve(config.animationDir);
    return {
      defaultDir,
      parent: path.dirname(defaultDir),
      exists: (await fs.stat(defaultDir).catch(() => null))?.isDirectory() ?? false,
      dirs,
      missing,
      extensions: ['fbx'],
      readOnly: true,
      limits: { maxFiles: MAX_FILES, maxDepth: MAX_DEPTH, maxDirs: MAX_DIRS },
    };
  });

  /** 读取已记录的文件夹列表 */
  app.get('/api/anim/dirs', async () => {
    const { dirs, missing } = await effectiveDirs();
    return { dirs, missing, defaultDir: path.resolve(config.animationDir), saved: deps.getDirs() };
  });

  /** 保存文件夹列表（持久化到 data/state.json，只做校验，不写目标目录） */
  app.put('/api/anim/dirs', async (request, reply) => {
    const body = (request.body ?? {}) as { dirs?: unknown };
    if (!Array.isArray(body.dirs)) return reply.code(400).send({ error: 'dirs 必须是数组' });
    const raw = body.dirs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (raw.length > MAX_DIRS) return reply.code(400).send({ error: `最多记录 ${MAX_DIRS} 个文件夹` });

    let resolved: string[];
    try {
      resolved = await resolveDirs(raw);
    } catch (err) {
      return reply.code(400).send({ error: `文件夹不可用：${(err as Error).message}` });
    }
    await deps.setDirs(resolved);
    log.info(`动画文件夹已更新：${resolved.length} 个`);
    return { dirs: resolved, missing: [], defaultDir: path.resolve(config.animationDir), saved: resolved };
  });

  /**
   * 列出多个文件夹下的 .fbx（递归，只读）。
   * 支持重复的 ?dir= 参数；不带参数时使用已记录的文件夹。
   */
  app.get('/api/anim/list', async (request, reply) => {
    const raw = (request.query as { dir?: string | string[] }).dir;
    const requested = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((item) => item.trim()).filter(Boolean);

    const missing: string[] = [];
    let dirs: string[];
    try {
      if (requested.length > 0) {
        dirs = await resolveDirs(requested);
      } else {
        const effective = await effectiveDirs();
        dirs = effective.dirs;
        missing.push(...effective.missing);
      }
    } catch (err) {
      return reply.code(400).send({ error: `无法读取文件夹：${(err as Error).message}` });
    }

    const labels = new Set<string>();
    const files: AnimationFile[] = [];
    let truncated = false;
    let budget = MAX_FILES;

    for (const dir of dirs) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const result = await scanDir(dir, labelFor(dir, labels), budget);
      files.push(...result.files);
      budget -= result.files.length;
      if (result.truncated) truncated = true;
    }

    // 多个文件夹可能有包含关系，按绝对路径去重
    const seen = new Set<string>();
    const unique = files.filter((file) => {
      if (seen.has(file.path)) return false;
      seen.add(file.path);
      return true;
    });
    unique.sort((a, b) =>
      a.sourceLabel === b.sourceLabel
        ? a.relative.localeCompare(b.relative, 'zh-Hans-CN', { numeric: true })
        : a.sourceLabel.localeCompare(b.sourceLabel, 'en', { numeric: true }),
    );

    log.debug(`扫描 ${dirs.length} 个文件夹 → ${unique.length} 个 FBX`);
    return { dirs, files: unique, truncated, missing };
  });

  /**
   * 动画封面（由后端子线程渲染，浏览器只负责显示 <img>）。
   * 只允许已记录文件夹内的 .fbx；带 ETag，重复请求命中缓存直接 304。
   */
  app.get('/api/anim/cover', async (request, reply) => {
    const query = request.query as { path?: string; size?: string; pose?: string; refresh?: string };
    const raw = query.path?.trim();
    if (!raw) return reply.code(400).send({ error: '缺少 path 参数' });

    const target = path.resolve(raw);
    if (!isFbx(target)) return reply.code(415).send({ error: '动画封面只支持 .fbx 文件' });

    const { dirs } = await effectiveDirs();
    const inside = dirs.some(
      (dir) => target === dir || target.startsWith(`${dir}${path.sep}`) || target.startsWith(`${dir}/`),
    );
    if (!inside) return reply.code(403).send({ error: '只能为已记录的动画文件夹生成封面' });

    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return reply.code(404).send({ error: '文件不存在' });

    const size = Math.min(384, Math.max(96, Number(query.size) || 256));
    const pose = Math.min(1, Math.max(0, Number(query.pose ?? 0.35)));
    const refresh = query.refresh === '1' || query.refresh === 'true';
    // ETag 带上渲染器版本：渲染逻辑升级后浏览器不会继续用旧图（例如修掉 T-pose 封面）
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}-${size}-${pose}-v${COVER_CACHE_VERSION}"`;
    if (!refresh && request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }

    try {
      const png = await animationCover(target, { size, poseFraction: pose, refresh });
      return reply
        .header('Content-Type', 'image/png')
        .header('Content-Length', String(png.length))
        // 必须回源校验：前端 URL 带的 v 只用于升级时换缓存，平时靠 ETag 304 省流量
        .header('Cache-Control', refresh ? 'no-store' : 'no-cache')
        .header('ETag', etag)
        .send(png);
    } catch (err) {
      log.warn(`动画封面生成失败 ${path.basename(target)}: ${(err as Error).message}`);
      return reply.code(500).send({ error: `封面生成失败：${(err as Error).message}` });
    }
  });

  /** 浏览子目录，用于“选择文件夹” */
  app.get('/api/anim/browse', async (request, reply) => {
    const query = request.query as { dir?: string };
    try {
      const fallback = (await effectiveDirs()).dirs[0] ?? path.resolve(config.animationDir);
      const dir = query.dir?.trim() ? await resolveDir(query.dir) : await resolveDir(fallback);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        let fbxCount = 0;
        try {
          const children = await fs.readdir(full, { withFileTypes: true });
          fbxCount = children.filter((child) => child.isFile() && isFbx(child.name)).length;
        } catch {
          /* 权限不足时忽略 */
        }
        dirs.push({ name: entry.name, path: full, fbxCount, hidden: entry.name.startsWith('.') });
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      const parent = path.dirname(dir);
      return {
        dir,
        parent: parent === dir ? null : parent,
        dirs,
        fbxCount: entries.filter((entry) => entry.isFile() && isFbx(entry.name)).length,
      };
    } catch (err) {
      return reply.code(400).send({ error: `无法浏览该路径：${(err as Error).message}` });
    }
  });

  /**
   * 读取单个 FBX 文件内容（只读、不落盘、不缓存）。
   * 整块读入内存后立即关闭句柄，因此不会锁文件。
   */
  app.get('/api/anim/file', async (request, reply) => {
    const query = request.query as { path?: string; dir?: string; name?: string };

    let target: string;
    if (query.path) {
      target = path.resolve(query.path);
    } else if (query.dir && query.name) {
      const dir = path.resolve(query.dir);
      target = path.resolve(dir, query.name);
      // 防止用 ../ 跳出所浏览的目录
      if (target !== dir && !target.startsWith(dir + path.sep)) {
        return reply.code(403).send({ error: '禁止访问该路径' });
      }
    } else {
      return reply.code(400).send({ error: '缺少 path 或 dir+name 参数' });
    }

    if (!isFbx(target)) {
      return reply.code(415).send({ error: '动画预览只读取 .fbx 文件' });
    }

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return reply.code(404).send({ error: '文件不存在' });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: '不是文件' });

    try {
      const data = await fs.readFile(target);
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(data.length))
        .header('Cache-Control', 'no-store')
        .header('X-Anim-Name', encodeURIComponent(path.basename(target)))
        .send(data);
    } catch (err) {
      return reply.code(500).send({ error: `读取失败：${(err as Error).message}` });
    }
  });

  // ===== 新建动画：保存 / 读取 / 删除 =====
  //
  // 新建动画由前端用内置白模创建，导入的动画 JSON 与项目名保存到项目自己的
  // data/anim-projects 目录（gitignore），不会写入任何 FBX 源文件夹。

  /** 项目列表：只返回摘要，动画数据按 id 单独取，避免一次传输几百 MB */
  app.get('/api/anim/projects', async () => {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const projects: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      const record = await readProject(id);
      if (record) projects.push(summaryOf(record));
    }
    projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { projects };
  });

  app.get('/api/anim/projects/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    const record = await readProject(id);
    if (!record) return reply.code(404).send({ error: '项目不存在' });
    return { ...summaryOf(record), data: record.data };
  });

  app.put('/api/anim/projects/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });

    const body = (request.body ?? {}) as {
      name?: unknown;
      basePath?: unknown;
      baseName?: unknown;
      data?: unknown;
      imported?: unknown;
    };
    const data = body.data ?? null;
    if (data !== null) {
      const candidate = data as { format?: unknown; clips?: unknown };
      if (candidate.format !== 'fbx-animation-data' || !Array.isArray(candidate.clips)) {
        return reply.code(400).send({ error: '动画数据格式不正确（需要 fbx-animation-data）' });
      }
    }

    const existing = await readProject(id);
    const now = new Date().toISOString();
    const clips = clipsOf(data);
    const trackCount = countTracks(clips);
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 80)
        : (existing?.name ?? '新建动画');

    const record: SavedProject = {
      id,
      name,
      basePath:
        typeof body.basePath === 'string' && body.basePath.trim()
          ? body.basePath
          : (existing?.basePath ?? ''),
      baseName:
        typeof body.baseName === 'string' && body.baseName.trim()
          ? body.baseName
          : (existing?.baseName ?? ''),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      imported: importedOf(body.imported) ?? existing?.imported ?? null,
      clipCount: clips.length,
      trackCount,
      hasData: data !== null,
      data,
    };

    try {
      await fs.mkdir(projectsDir, { recursive: true });
      await fs.writeFile(projectPath(id), JSON.stringify(record), 'utf8');
    } catch (err) {
      return reply.code(500).send({ error: `保存失败：${(err as Error).message}` });
    }
    log.info(`新建动画已保存：${record.name}（${record.clipCount} 个片段）`);
    return summaryOf(record);
  });

  app.delete('/api/anim/projects/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    const removed = await fs.rm(projectPath(id), { force: true }).then(
      () => true,
      () => false,
    );
    return { ok: removed };
  });
}

// ===== 新建动画项目的磁盘格式 =====

const projectsDir = joinData('anim-projects');

interface ProjectImportedSummary {
  name: string;
  clipCount: number;
  trackCount: number;
}

interface SavedProject {
  id: string;
  name: string;
  basePath: string;
  baseName: string;
  createdAt: string;
  updatedAt: string;
  imported: ProjectImportedSummary | null;
  clipCount: number;
  trackCount: number;
  hasData: boolean;
  data: unknown;
}

type ProjectSummary = Omit<SavedProject, 'data'>;

/** 只允许字母数字下划线短横线，避免拼出目录穿越路径 */
function projectId(raw: string | undefined): string | null {
  const id = (raw ?? '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function projectPath(id: string): string {
  return path.join(projectsDir, `${id}.json`);
}

function importedOf(raw: unknown): ProjectImportedSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { name?: unknown; clipCount?: unknown; trackCount?: unknown };
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  return {
    name: value.name,
    clipCount: Number.isFinite(value.clipCount) ? Number(value.clipCount) : 0,
    trackCount: Number.isFinite(value.trackCount) ? Number(value.trackCount) : 0,
  };
}

function normalizeRecord(raw: unknown, id: string): SavedProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SavedProject>;
  const now = new Date().toISOString();
  const data = value.data ?? null;
  const clips = clipsOf(data);
  return {
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : '新建动画',
    basePath: typeof value.basePath === 'string' ? value.basePath : '',
    baseName: typeof value.baseName === 'string' ? value.baseName : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
    imported: importedOf(value.imported),
    clipCount: clips.length,
    trackCount: countTracks(clips),
    hasData: data !== null,
    data,
  };
}

/** 从动画数据里取出片段数组（格式不对时返回空数组） */
function clipsOf(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const clips = (data as { clips?: unknown }).clips;
  return Array.isArray(clips) ? clips : [];
}

/** 统计片段里的轨迹总数 */
function countTracks(clips: unknown[]): number {
  let total = 0;
  for (const clip of clips) {
    const tracks = (clip as { tracks?: unknown }).tracks;
    if (Array.isArray(tracks)) total += tracks.length;
  }
  return total;
}

async function readProject(id: string): Promise<SavedProject | null> {
  const text = await fs.readFile(projectPath(id), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return normalizeRecord(JSON.parse(text), id);
  } catch {
    return null;
  }
}

function summaryOf(record: SavedProject): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    basePath: record.basePath,
    baseName: record.baseName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    imported: record.imported,
    clipCount: record.clipCount,
    trackCount: record.trackCount,
    hasData: record.hasData,
  };
}
