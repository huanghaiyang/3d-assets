import fs from 'node:fs/promises';
import path from 'node:path';
import { joinData } from '../lib/paths.js';

/**
 * 新建动画 / 拼接动画项目的磁盘持久化层。
 *
 * 存储位置与命名规则：
 *  - 主目录：`joinData('anim-projects')`，即仓库根的 `data/anim-projects/`
 *    （joinData 固定拼 repoRoot/data，不读 H3D_DATA_DIR；回收站同理在 `data/anim-projects-trash/`）。
 *  - 一个项目一个 JSON 文件，文件名严格为 `<id>.json`；id 由 projectId() 校验，
 *    只允许 1–80 位的 [A-Za-z0-9_-]，避免拼出 `../` 之类的目录穿越路径。
 *  - 文件内容就是 SavedProject 序列化后的整体（含动画数据本体 data），
 *    单文件可能达到几十 MB，因此列表接口只返回不含 data 的摘要。
 *  - 删除为软删除：先把「附加了 deletedAt 的记录」写入回收站目录，再删除主目录文件；
 *    「彻底删除」只删回收站文件。
 *
 * data 与 composition 的区别：
 *  - `data` 是烘焙后的关键帧数据（format 为 `fbx-animation-data`，内含 clips[]），
 *    供动画工作区播放 / 导出使用，是不可逆的结果，体积大。
 *  - `composition` 是拼接工作区的编排快照（基础模型 + 最多 5 条 Strip 轨道 + 时间轴时长），
 *    体积小，用于之后再次打开继续编辑；它缺失时项目仍可播放，只是无法还原拼接参数。
 *  - 两者同时存在时 summaryOf() 派生 `kind: 'strips'`，否则为 `'clip'`。
 *
 * 读取侧兼容策略：旧项目可能没有 composition，或字段被手改脏，
 * 因此所有读盘都经过 normalizeRecord() → compositionOf()，只保留合法结构并补齐默认值，
 * 避免脏数据把前端弄崩（坏文件会被当作「项目不存在」跳过，而不是让整个列表失败）。
 */

/** 项目主目录：`<repoRoot>/data/anim-projects`，存未删除项目（gitignore） */
export const projectsDir = joinData('anim-projects');
/** 回收站目录：`<repoRoot>/data/anim-projects-trash`，存已软删除项目 */
export const trashDir = joinData('anim-projects-trash');

/** 导入动画 JSON 后记录在项目里的摘要（随项目一起保存，非导入项目为 null） */
export interface ProjectImportedSummary {
  /** 导入来源名称（用户选择的动画文件名 / 片段名） */
  name: string;
  /** 导入时该 JSON 内含的片段数量 */
  clipCount: number;
  /** 导入时所有片段的轨道总数 */
  trackCount: number;
}

/**
 * 一个项目在磁盘上的完整结构，即 `<id>.json` 的全部内容。
 *
 * 读盘时统一由 normalizeRecord() 生成：缺失字段补默认值，
 * clipCount / trackCount / hasData 一律由 data 重新推导，不信任文件里的旧值。
 */
export interface SavedProject {
  /** 项目 id，同时是文件名（`<id>.json`）；只允许 [A-Za-z0-9_-]{1,80} */
  id: string;
  /** 展示名，经 normalizeName 规范化（去首尾空白、压缩空格、≤80 字符）；空名回落「新建动画」 */
  name: string;
  /** 基础模型（动画库里的 Mixamo FBX）绝对路径；拼接项目加载以此为准 */
  basePath: string;
  /** 基础模型展示名，仅用于 UI，加载不依赖它 */
  baseName: string;
  /** 创建时间，ISO 8601 字符串；列表按它升序 */
  createdAt: string;
  /** 最后修改时间，ISO 8601 字符串；封面 ETag 也依赖它做缓存失效 */
  updatedAt: string;
  /** 导入摘要；不是「导入动画 JSON」来源的项目为 null */
  imported: ProjectImportedSummary | null;
  /** data.clips 的片段数（派生值，读盘时重算） */
  clipCount: number;
  /** 所有片段里 tracks 数组长度之和（派生值，读盘时重算） */
  trackCount: number;
  /** 是否已有动画数据（等价于 `data !== null`） */
  hasData: boolean;
  /** 烘焙后的动画数据本体：`{ format: 'fbx-animation-data', clips: [...] }`，无数据时为 null */
  data: unknown;
  /** 拼接工作区的编排（Strip 列表与基础模型），有它即视为「拼接动画」 */
  composition?: ProjectComposition | null;
  /** 进入回收站的时间（只在回收站文件里出现） */
  deletedAt?: string;
}

/**
 * 拼接编排的外层结构。服务端只校验这一层，tracks 元素内部字段由前端定义
 * （web 侧实际写入的是 StripDef，最多 5 条，对应 5 个身体部位）。
 */
export interface ProjectComposition {
  /** 协议版本，缺省补 1；目前前端固定写 1 */
  version?: number;
  /** 基础模型 FBX 绝对路径；重新打开拼接工作区时先加载它 */
  basePath?: string;
  /** 基础模型展示名（仅 UI / 元信息，加载以 basePath 为准） */
  baseName?: string;
  /** 轨道（StripDef）数组；不是数组即视为脏数据，整份 composition 作废为 null */
  tracks: unknown[];
  /** 时间轴总时长（秒），缺省补 0 */
  duration?: number;
}

/**
 * 列表 / 保存响应里返回的项目摘要：不含 data 本体，额外派生 kind 与 stripCount。
 */
export type ProjectSummary = Omit<SavedProject, 'data'> & {
  /** 拼接动画（带 composition）与普通新建动画的区分，前端按它分类 */
  kind: 'clip' | 'strips';
  /** composition 里的源动画数量（最多 5） */
  stripCount: number;
};

/**
 * 校验并归一化路径参数 / 文件名里的项目 id。
 * @param raw 原始 id，可能为 undefined 或带首尾空白
 * @returns 合法 id（已 trim），或 null。规则：1–80 位的 [A-Za-z0-9_-]；
 *          含 `.`、`/`、`\`、空格或超长一律视为非法，调用方通常回 400
 */
export function projectId(raw: string | undefined): string | null {
  const id = (raw ?? '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/**
 * 名称规范化：去首尾空白、压缩连续空格、限制长度。
 * @param raw 原始名称，可为 undefined
 * @returns 规范化后的名称；空输入得到空串，由调用方决定回落文案（如「新建动画」）
 */
export function normalizeName(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * 项目主文件的绝对路径（不读盘、不校验）。
 * @param id 已通过 projectId 校验的 id；本函数不再校验
 * @returns `<repoRoot>/data/anim-projects/<id>.json`
 */
export function projectPath(id: string): string {
  return path.join(projectsDir, `${id}.json`);
}

/**
 * 回收站文件的绝对路径（不读盘、不校验）。
 * @param id 已通过 projectId 校验的 id
 * @returns `<repoRoot>/data/anim-projects-trash/<id>.json`
 */
export function trashPath(id: string): string {
  return path.join(trashDir, `${id}.json`);
}

/**
 * 从任意请求体值里提取「导入摘要」，非法值统一返回 null 而不抛错。
 * @param raw 任意 unknown（通常来自 JSON body 的 imported 字段）
 * @returns 名称是非空字符串时返回摘要对象，clipCount / trackCount 非有限数字时记为 0；
 *          否则返回 null（表示不是导入来源的项目）
 */
export function importedOf(raw: unknown): ProjectImportedSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { name?: unknown; clipCount?: unknown; trackCount?: unknown };
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  return {
    name: value.name,
    clipCount: Number.isFinite(value.clipCount) ? Number(value.clipCount) : 0,
    trackCount: Number.isFinite(value.trackCount) ? Number(value.trackCount) : 0,
  };
}

/**
 * 把磁盘上的原始 JSON 归一化成 SavedProject；所有读盘路径都必须经过它。
 *
 * 兼容旧数据的处理：
 *  - 名称缺失 / 为空 → 「新建动画」；basePath、baseName 非字符串 → 空串；
 *  - createdAt、updatedAt 非字符串 → 当前时间（仅用于展示，不会因此回写磁盘）；
 *  - clipCount、trackCount、hasData 由 data 重新推导，忽略文件里的旧值；
 *  - imported 经 importedOf() 校验；composition 经 compositionOf() 校验，
 *    字段缺失或结构不合法时得到 null（旧项目即视为普通新建动画）。
 *
 * @param raw JSON.parse 后的任意值
 * @param id 由文件名推出的项目 id（文件内容里的 id 不可信，一律以此参数为准）
 * @returns 归一化后的项目；raw 不是对象时返回 null（调用方按「不存在 / 损坏」处理）
 * @throws 本函数不抛错；JSON.parse 的异常由 readJson 捕获
 */
export function normalizeRecord(raw: unknown, id: string): SavedProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SavedProject>;
  const now = new Date().toISOString();
  const data = value.data ?? null;
  const clips = clipsOf(data);
  return {
    id,
    name: normalizeName(value.name) || '新建动画',
    basePath: typeof value.basePath === 'string' ? value.basePath : '',
    baseName: typeof value.baseName === 'string' ? value.baseName : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
    imported: importedOf(value.imported),
    clipCount: clips.length,
    trackCount: countTracks(clips),
    hasData: data !== null,
    data,
    composition: compositionOf(value.composition),
    deletedAt: typeof value.deletedAt === 'string' ? value.deletedAt : undefined,
  };
}

/**
 * 保存时决定项目最终的 composition：区分「请求体未提供」与「显式清除」。
 *
 * 处理规则：
 *  - `raw === undefined`（请求体没带该字段）→ 返回 fallback，保持旧值不变；
 *  - `raw === null`（显式传 null）→ 返回 null，把拼接项目改回普通新建动画；
 *  - 其它值 → 走 compositionOf() 做结构校验，不合法同样得到 null。
 *
 * @param raw 请求体里的 composition（unknown，未校验）
 * @param fallback 旧项目已有的 composition（新建项目传 null）；仅在 raw 为 undefined 时使用
 * @returns 合法的 ProjectComposition，或 null（表示该项目不是拼接动画）
 */
export function normalizeComposition(
  raw: unknown,
  fallback: SavedProject['composition'] = null,
): SavedProject['composition'] {
  if (raw === undefined) return fallback;
  if (raw === null) return null;
  return compositionOf(raw);
}

/**
 * composition 的结构校验与默认值补齐（不导出，供 normalizeRecord / normalizeComposition 复用）。
 * @param raw 任意值
 * @returns 结构合法时返回新对象：version 非数字补 1、basePath / baseName 非字符串补空串、
 *          duration 非数字补 0，tracks 原样透传（元素内部不校验）；
 *          raw 不是对象或 tracks 不是数组时返回 null（整份编排作废）
 */
function compositionOf(raw: unknown): SavedProject['composition'] {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ProjectComposition>;
  if (!Array.isArray(value.tracks)) return null;
  return {
    version: typeof value.version === 'number' ? value.version : 1,
    basePath: typeof value.basePath === 'string' ? value.basePath : '',
    baseName: typeof value.baseName === 'string' ? value.baseName : '',
    tracks: value.tracks,
    duration: typeof value.duration === 'number' ? value.duration : 0,
  };
}

/**
 * 从动画数据里取片段数组。
 * @param data 任意动画数据（期望形状 `{ clips: unknown[] }`）
 * @returns clips 数组；data 为空或 clips 不是数组时返回空数组（不抛错）
 */
export function clipsOf(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const clips = (data as { clips?: unknown }).clips;
  return Array.isArray(clips) ? clips : [];
}

/**
 * 统计片段里所有轨道总数，用于列表页展示「N 条轨道」。
 * @param clips clipsOf() 的结果；每个元素期望形状 `{ tracks?: unknown[] }`
 * @returns tracks 为数组的片段其长度之和；结构不合法的片段按 0 计，不抛错
 */
export function countTracks(clips: unknown[]): number {
  let total = 0;
  for (const clip of clips) {
    const tracks = (clip as { tracks?: unknown }).tracks;
    if (Array.isArray(tracks)) total += tracks.length;
  }
  return total;
}

/**
 * 把完整项目裁剪成列表 / 保存响应使用的摘要，并派生前端分类字段。
 *
 * 派生规则：
 *  - `kind`：有 composition 即 `'strips'`（拼接动画），否则 `'clip'`（普通新建动画）；
 *  - `stripCount`：`composition.tracks.length`，无 composition 时为 0；
 *    因 tracks 最多 5 条，取值范围是 0–5；
 *  - `composition` 缺省统一输出 null（而非省略字段），方便前端判空；
 *  - 丢弃 `data`，避免列表传输几十 MB 的关键帧数据。
 *
 * @param record 归一化后的完整项目
 * @returns 不含 data 的摘要对象，其余字段与 SavedProject 一一对应
 */
export function summaryOf(record: SavedProject): ProjectSummary {
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
    composition: record.composition ?? null,
    kind: record.composition ? 'strips' : 'clip',
    stripCount: record.composition?.tracks.length ?? 0,
    deletedAt: record.deletedAt,
  };
}

/**
 * 读取并解析单个项目文件（内部工具，主目录与回收站共用）。
 *
 * 失败路径全部返回 null、不抛错：
 *  - 文件不存在 / 无权限 → 读文件被 catch 成 null；
 *  - 内容不是合法 JSON → JSON.parse 异常被捕获；
 *  - 结构不合法（normalizeRecord 返回 null）。
 * @param file 项目 JSON 的绝对路径
 * @param id 由文件名推出的 id，用于覆盖文件内容里的 id
 */
async function readJson(file: string, id: string): Promise<SavedProject | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return normalizeRecord(JSON.parse(text), id);
  } catch {
    return null;
  }
}

/**
 * 读取未删除的项目。
 * @param id 已通过 projectId 校验的 id
 * @returns 归一化后的项目；文件不存在、不是合法 JSON 或结构损坏时返回 null
 */
export async function readProject(id: string): Promise<SavedProject | null> {
  return readJson(projectPath(id), id);
}

/**
 * 读取回收站里的项目（含动画数据，供只读预览）。
 * @param id 已通过 projectId 校验的 id
 * @returns 归一化后的项目（deletedAt 有值）；回收站里没有该文件或文件损坏时返回 null
 */
export async function readTrashProject(id: string): Promise<SavedProject | null> {
  return readJson(trashPath(id), id);
}

/**
 * 列出所有未删除项目（只读目录，不写盘）。
 *
 * 目录不存在时按空列表处理；只扫描 `<id>.json` 形式的普通文件（忽略子目录）。
 * 单个文件损坏被 readJson 返回 null 时静默跳过，不影响其它项目。
 * @returns 摘要列表（不含 data），按 createdAt 升序（旧的在前）
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    const record = await readJson(projectPath(id), id);
    if (record) projects.push(summaryOf(record));
  }
  projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return projects;
}

/**
 * 列出回收站项目（只读目录，不写盘）。
 * @returns 摘要列表（不含 data），按 deletedAt 降序（最近删除的在前）；
 *          deletedAt 缺失的排在最后。目录不存在时返回空列表
 */
export async function listTrash(): Promise<ProjectSummary[]> {
  const entries = await fs.readdir(trashDir, { withFileTypes: true }).catch(() => []);
  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    const record = await readJson(trashPath(id), id);
    if (record) projects.push(summaryOf(record));
  }
  projects.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  return projects;
}

/** 名称是否已被其他未删除的项目使用（大小写不敏感） */
export async function isNameTaken(name: string, excludeId?: string): Promise<boolean> {
  const key = name.toLowerCase();
  const projects = await listProjects();
  return projects.some((item) => item.id !== excludeId && item.name.toLowerCase() === key);
}

/**
 * 把项目整体写入主目录（覆盖同名文件）。
 * @param record 完整项目记录；其 id 必须是已校验的合法值（否则会写到意料之外的路径）
 * @returns 写入完成（目录不存在会自动创建）
 * @throws 磁盘写入失败（权限 / 空间不足）时把 fs 异常向上抛，由路由层转 500
 */
export async function writeProject(record: SavedProject): Promise<void> {
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(projectPath(record.id), JSON.stringify(record), 'utf8');
}

/**
 * 软删除：把项目文件移到回收站，并记录删除时间。
 * 顺序是先写回收站副本、再删主目录文件，避免中途失败导致项目凭空消失。
 * @param id 已校验的 id
 * @returns 项目存在并成功移入回收站为 true；主目录里没有该项目为 false
 * @throws 磁盘写入 / 删除失败时向上抛
 */
export async function trashProject(id: string): Promise<boolean> {
  const record = await readProject(id);
  if (!record) return false;
  record.deletedAt = new Date().toISOString();
  await fs.mkdir(trashDir, { recursive: true });
  await fs.writeFile(trashPath(id), JSON.stringify(record), 'utf8');
  await fs.rm(projectPath(id), { force: true });
  return true;
}

/**
 * 从回收站恢复；名称与现有项目冲突时自动加「(恢复)」「(恢复 2)」…后缀。
 *
 * 恢复会清空 deletedAt、刷新 updatedAt，并重新写回主目录后删除回收站文件。
 * @param id 已校验的 id
 * @returns `{ project, renamed }`：project 是恢复后的摘要；renamed 表示是否因重名被改名。
 *          回收站里没有该项目（或文件损坏）时返回 null
 */
export async function restoreProject(
  id: string,
): Promise<{ project: ProjectSummary; renamed: boolean } | null> {
  const record = await readJson(trashPath(id), id);
  if (!record) return null;
  let name = record.name;
  let renamed = false;
  let suffix = 0;
  while (await isNameTaken(name, id)) {
    suffix += 1;
    name = `${record.name} (恢复${suffix > 1 ? ` ${suffix}` : ''})`;
    renamed = true;
  }
  record.name = name;
  record.deletedAt = undefined;
  record.updatedAt = new Date().toISOString();
  await writeProject(record);
  await fs.rm(trashPath(id), { force: true });
  return { project: summaryOf(record), renamed };
}

/**
 * 彻底删除回收站里的项目（不可恢复）。
 * @param id 已校验的 id
 * @returns 回收站里有该项目并已删除为 true；没有则为 false
 */
export async function purgeProject(id: string): Promise<boolean> {
  const record = await readJson(trashPath(id), id);
  if (!record) return false;
  await fs.rm(trashPath(id), { force: true });
  return true;
}

/**
 * 重命名已保存项目（只改名称与 updatedAt，不动 data / composition）。
 * @param id 已校验的 id
 * @param rawName 原始名称，经 normalizeName 规范化
 * @returns 成功：`{ project }`（改名后的摘要）；
 *          失败：`{ error, status }`——名称为空 400、项目不存在 404、重名 409，
 *          由路由层直接按 status 返回
 */
export async function renameProject(
  id: string,
  rawName: string,
): Promise<{ project: ProjectSummary } | { error: string; status: number }> {
  const name = normalizeName(rawName);
  if (!name) return { error: '名称不能为空', status: 400 };
  const record = await readProject(id);
  if (!record) return { error: '项目不存在', status: 404 };
  if (await isNameTaken(name, id)) return { error: `名称「${name}」已被使用`, status: 409 };
  record.name = name;
  record.updatedAt = new Date().toISOString();
  await writeProject(record);
  return { project: summaryOf(record) };
}
