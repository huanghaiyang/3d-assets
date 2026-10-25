import fs from 'node:fs/promises';
import path from 'node:path';
import { joinData } from '../lib/paths.js';

/**
 * 新建动画项目的磁盘存储。
 *
 * 每个项目一个 JSON 文件，放在 data/anim-projects 下；删除是软删除，
 * 文件会移到 data/anim-projects-trash，可恢复或彻底清除。
 */

export const projectsDir = joinData('anim-projects');
export const trashDir = joinData('anim-projects-trash');

export interface ProjectImportedSummary {
  name: string;
  clipCount: number;
  trackCount: number;
}

export interface SavedProject {
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
  /** 进入回收站的时间（只在回收站文件里出现） */
  deletedAt?: string;
}

export type ProjectSummary = Omit<SavedProject, 'data'>;

/** 只允许字母数字下划线短横线，避免拼出目录穿越路径 */
export function projectId(raw: string | undefined): string | null {
  const id = (raw ?? '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/** 名称规范化：去首尾空白、压缩连续空格、限制长度 */
export function normalizeName(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function projectPath(id: string): string {
  return path.join(projectsDir, `${id}.json`);
}

export function trashPath(id: string): string {
  return path.join(trashDir, `${id}.json`);
}

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
    deletedAt: typeof value.deletedAt === 'string' ? value.deletedAt : undefined,
  };
}

export function clipsOf(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const clips = (data as { clips?: unknown }).clips;
  return Array.isArray(clips) ? clips : [];
}

export function countTracks(clips: unknown[]): number {
  let total = 0;
  for (const clip of clips) {
    const tracks = (clip as { tracks?: unknown }).tracks;
    if (Array.isArray(tracks)) total += tracks.length;
  }
  return total;
}

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
    deletedAt: record.deletedAt,
  };
}

async function readJson(file: string, id: string): Promise<SavedProject | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return normalizeRecord(JSON.parse(text), id);
  } catch {
    return null;
  }
}

export async function readProject(id: string): Promise<SavedProject | null> {
  return readJson(projectPath(id), id);
}

/** 读取回收站里的项目（含动画数据，供只读预览） */
export async function readTrashProject(id: string): Promise<SavedProject | null> {
  return readJson(trashPath(id), id);
}

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

export async function writeProject(record: SavedProject): Promise<void> {
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(projectPath(record.id), JSON.stringify(record), 'utf8');
}

/** 软删除：把项目文件移到回收站，并记录删除时间 */
export async function trashProject(id: string): Promise<boolean> {
  const record = await readProject(id);
  if (!record) return false;
  record.deletedAt = new Date().toISOString();
  await fs.mkdir(trashDir, { recursive: true });
  await fs.writeFile(trashPath(id), JSON.stringify(record), 'utf8');
  await fs.rm(projectPath(id), { force: true });
  return true;
}

/** 从回收站恢复；名称与现有项目冲突时自动加「(恢复)」后缀 */
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

/** 彻底删除回收站里的项目 */
export async function purgeProject(id: string): Promise<boolean> {
  const record = await readJson(trashPath(id), id);
  if (!record) return false;
  await fs.rm(trashPath(id), { force: true });
  return true;
}

/** 重命名已保存项目；返回错误字符串表示校验失败 */
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
