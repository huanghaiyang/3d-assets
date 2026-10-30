import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { animationCover, COVER_CACHE_VERSION } from '../services/covers.js';
import { getFingerPoseLibrary } from '../services/fingerPoses.js';
import {
  clipsOf,
  countTracks,
  importedOf,
  isNameTaken,
  listProjects,
  listTrash,
  normalizeName,
  normalizeComposition,
  projectId,
  purgeProject,
  readProject,
  readTrashProject,
  renameProject,
  restoreProject,
  summaryOf,
  trashProject,
  writeProject,
  type SavedProject,
} from '../services/animProjects.js';

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
/** 单个 FBX 的体积上限：再大就不适合整块读进内存（避免误读超大文件把服务拖住） */
const MAX_FBX_BYTES = 200 * 1024 * 1024;

function isFbx(name: string): boolean {
  return path.extname(name).toLowerCase() === '.fbx';
}

/** target 是否落在某个已记录的文件夹内（Windows 下路径大小写不敏感） */
function insideDir(target: string, dir: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const file = normalize(target);
  const root = normalize(dir);
  return file === root || file.startsWith(`${root}${path.sep}`) || file.startsWith(`${root}/`);
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

  /** 手指形态库：从现有 Mixamo 动画缓存里采样去重，左右手分别返回 */
  app.get('/api/anim/finger-poses', async (request) => {
    const query = request.query as { refresh?: string };
    return getFingerPoseLibrary(query.refresh === '1' || query.refresh === 'true');
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
   *
   * 两种取图方式：
   *   - ?path=<fbx>          动画库里的原始 FBX，取文件自带动画的某一帧
   *   - ?project=<id>        新建动画项目：用基础模型 + 项目里保存的动画数据取姿势，
   *                          这样卡片封面展示的是实际编辑出来的动作（例如 kimodo 导入的动作），
   *                          而不是基础模型自带的 Mixamo 动作。
   */
  app.get('/api/anim/cover', async (request, reply) => {
    const query = request.query as {
      path?: string;
      project?: string;
      size?: string;
      pose?: string;
      refresh?: string;
    };

    let target: string;
    let animation: unknown = null;
    let animationOnly = false;
    let cacheTag = '';

    const rawProject = query.project?.trim();
    if (rawProject) {
      const id = projectId(rawProject);
      if (!id) return reply.code(400).send({ error: '无效的项目 id' });
      const record = await readProject(id);
      if (!record) return reply.code(404).send({ error: '项目不存在' });
      target = path.resolve(record.basePath);
      if (!record.basePath || !isFbx(target)) {
        return reply.code(415).send({ error: '项目没有可用的 .fbx 基础模型' });
      }
      animation = record.data;
      // 新建动画的基础模型应是无动画的：只用项目动画数据，没有数据就回到绑定姿态
      animationOnly = true;
      cacheTag = `${record.updatedAt}|${record.hasData ? '1' : '0'}`;
    } else {
      const raw = query.path?.trim();
      if (!raw) return reply.code(400).send({ error: '缺少 path 参数' });
      target = path.resolve(raw);
      if (!isFbx(target)) return reply.code(415).send({ error: '动画封面只支持 .fbx 文件' });
    }

    const { dirs } = await effectiveDirs();
    const inside = dirs.some((dir) => insideDir(target, dir));
    if (!inside) return reply.code(403).send({ error: '只能为已记录的动画文件夹生成封面' });

    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return reply.code(404).send({ error: '文件不存在' });

    const size = Math.min(384, Math.max(96, Number(query.size) || 256));
    const pose = Math.min(1, Math.max(0, Number(query.pose ?? 0.35)));
    const refresh = query.refresh === '1' || query.refresh === 'true';
    // ETag 带上渲染器版本与项目更新时间：渲染逻辑升级、或项目动画改动后浏览器不会继续用旧图
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}-${size}-${pose}-v${COVER_CACHE_VERSION}-${cacheTag}"`;
    if (!refresh && request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }

    try {
      const png = await animationCover(target, {
        size,
        poseFraction: pose,
        refresh,
        animation,
        animationOnly,
        cacheTag,
      });
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

    // 只允许读取已记录文件夹内的文件：否则任意绝对路径都能被读走
    const { dirs } = await effectiveDirs();
    if (!dirs.some((dir) => insideDir(target, dir))) {
      return reply.code(403).send({ error: '只能读取已记录的动画文件夹内的文件' });
    }

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return reply.code(404).send({ error: '文件不存在' });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: '不是文件' });
    // 整块读入内存前先按体积拒绝：既防误读超大文件，也避免一个请求吃掉大量内存
    if (stat.size > MAX_FBX_BYTES) {
      return reply.code(413).send({
        error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），动画预览上限 ${MAX_FBX_BYTES / 1024 / 1024} MB`,
      });
    }

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

  // ===== 新建动画 / 拼接动画：保存 / 读取 / 删除 =====
  //
  // 新建动画由前端用内置白模创建，导入的动画 JSON 与项目名保存到项目自己的
  // data/anim-projects 目录（gitignore），不会写入任何 FBX 源文件夹。
  //
  // 本轮新增：「拼接工作区」的产物与普通新建动画共用同一套项目接口，区别只在
  // 请求体是否带 composition 字段——带上即为拼接动画（读回后前端按 kind === 'strips'
  // 分类，并在拼接工作区里继续编辑）；不带或传 null 则是普通新建动画。
  // 项目记录的统一形状与 normalize 规则见 services/animProjects.ts。

  /**
   * 项目列表。
   * 只返回摘要（ProjectSummary，不含 data），动画数据按 id 单独取，避免一次传输几百 MB。
   * 每项含服务端派生的 kind（'clip' | 'strips'）与 stripCount（拼接轨道数，0–5）。
   * @returns 200 `{ projects: ProjectSummary[] }`，按 createdAt 升序
   */
  app.get('/api/anim/projects', async () => {
    return { projects: await listProjects() };
  });

  /**
   * 读取单个项目详情。
   * @param params.id 项目 id，需匹配 [A-Za-z0-9_-]{1,80}
   * @returns 200 `{ ...ProjectSummary, data }`（含烘焙动画数据本体，拼接项目另含 composition）；
   *          400 id 非法；404 项目不存在（含文件损坏被 normalize 判为无效的情况）
   */
  app.get('/api/anim/projects/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    const record = await readProject(id);
    if (!record) return reply.code(404).send({ error: '项目不存在' });
    return { ...summaryOf(record), data: record.data };
  });

  /**
   * 新建或更新项目（同一个 id 再次 PUT 即为更新，语义是整体覆盖）。
   *
   * 请求体（PUT /api/anim/projects/:id）：
   *  - name?: string         展示名；缺省 / 空白时沿用原项目的名称，新项目回落「新建动画」
   *  - basePath?: string     基础模型 FBX 绝对路径；缺省沿用旧值
   *  - baseName?: string     基础模型展示名；缺省沿用旧值
   *  - data?: unknown | null 烘焙动画数据；非 null 时必须形如
   *                          `{ format: 'fbx-animation-data', clips: [...] }`，否则 400
   *  - imported?: unknown    导入摘要（name / clipCount / trackCount）；非法或缺失时沿用旧值
   *  - composition?: unknown 拼接编排（tracks 数组 + basePath / baseName / duration）。
   *                          不传＝保持旧 composition 不变；传 null＝清除（改回普通新建动画）；
   *                          传对象＝经 normalizeComposition 校验后覆盖
   *
   * createdAt 保留原值，updatedAt 每次写入刷新；clipCount / trackCount / hasData 由 data 推导。
   *
   * @param params.id 项目 id
   * @returns 200 ProjectSummary（不含 data）；400 id 非法或动画数据格式不符；
   *          409 名称与本项目外的未删除项目重名；500 磁盘写入失败
   */
  app.put('/api/anim/projects/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });

    const body = (request.body ?? {}) as {
      name?: unknown;
      basePath?: unknown;
      baseName?: unknown;
      data?: unknown;
      imported?: unknown;
      /** 拼接工作区的编排；传 null 表示把项目改回普通新建动画 */
      composition?: unknown;
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
        ? normalizeName(body.name as string)
        : (existing?.name ?? '新建动画');
    // 重名校验：同一时间只允许一个未删除项目使用同一个名称
    if (await isNameTaken(name, id)) {
      return reply.code(409).send({ error: `名称「${name}」已被使用` });
    }

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
      composition: normalizeComposition(body.composition, existing?.composition ?? null),
    };

    try {
      await writeProject(record);
    } catch (err) {
      return reply.code(500).send({ error: `保存失败：${(err as Error).message}` });
    }
    log.info(`新建动画已保存：${record.name}（${record.clipCount} 个片段）`);
    return summaryOf(record);
  });

  /**
   * 重命名（只改名称，不动动画数据与拼接编排）。
   * @param params.id 项目 id
   * @body name: string 新名称（必填字符串，服务端再规范化）
   * @returns 200 ProjectSummary；400 id 非法或 name 不是字符串 / 为空；
   *          404 项目不存在；409 与本项目外的未删除项目重名
   */
  app.patch('/api/anim/projects/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== 'string') return reply.code(400).send({ error: 'name 必须是字符串' });
    const result = await renameProject(id, body.name);
    if ('error' in result) return reply.code(result.status).send({ error: result.error });
    log.info(`新建动画已重命名：${result.project.name}`);
    return result.project;
  });

  /**
   * 删除 = 移入回收站（软删除），可在回收站恢复。
   * 幂等：项目不存在时也返回 200，只是 ok / trashed 为 false。
   * @param params.id 项目 id
   * @returns 200 `{ ok, trashed }`（两者同值，trashed 表示是否确实移入了回收站）；
   *          400 id 非法
   */
  app.delete('/api/anim/projects/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    const trashed = await trashProject(id);
    return { ok: trashed, trashed };
  });

  /** 回收站列表：返回摘要（含 kind / stripCount），按删除时间倒序 */
  app.get('/api/anim/trash', async () => {
    return { projects: await listTrash() };
  });

  /**
   * 回收站项目详情（含动画数据，只读预览用）。
   * @param params.id 项目 id
   * @returns 200 `{ ...ProjectSummary, data }`；400 id 非法；404 回收站里没有该项目
   */
  app.get('/api/anim/trash/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    const record = await readTrashProject(id);
    if (!record) return reply.code(404).send({ error: '回收站里没有该项目' });
    return { ...summaryOf(record), data: record.data };
  });

  /**
   * 从回收站恢复（清空 deletedAt、刷新 updatedAt、写回主目录）。
   * @param params.id 项目 id
   * @returns 200 `{ ok: true, renamed, project }`，renamed 为 true 表示重名已自动改名；
   *          400 id 非法；404 回收站里没有该项目
   */
  app.post('/api/anim/projects/:id/restore', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    const result = await restoreProject(id);
    if (!result) return reply.code(404).send({ error: '回收站里没有该项目' });
    log.info(`新建动画已恢复：${result.project.name}${result.renamed ? '（重名，已自动改名）' : ''}`);
    return { ok: true, renamed: result.renamed, project: result.project };
  });

  /**
   * 彻底删除回收站项目（不可恢复）。
   * @param params.id 项目 id
   * @returns 200 `{ ok }`，ok 为 false 表示回收站里没有该项目；400 id 非法
   */
  app.delete('/api/anim/trash/:id', async (request, reply) => {
    const id = projectId((request.params as { id?: string }).id);
    if (!id) return reply.code(400).send({ error: '无效的项目 id' });
    return { ok: await purgeProject(id) };
  });
}


