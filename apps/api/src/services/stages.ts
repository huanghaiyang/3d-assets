import fs from 'node:fs/promises';
import path from 'node:path';
import { joinData } from '../lib/paths.js';

/**
 * 舞台文档的磁盘存储。
 *
 * 每份舞台一个 JSON 文件，放在 data/stages 下；删除是软删除（移到 data/stages-trash）。
 * 只保存编排信息（角色、摆放、片段序列），不含任何模型或动画数据本体。
 */

export const stagesDir = joinData('stages');
export const stageTrashDir = joinData('stages-trash');

export interface StoredActor {
  id: string;
  name: string;
  kind: 'fbx' | 'soma';
  modelPath?: string;
  transform: { x: number; z: number; yaw: number };
  visible: boolean;
}

export interface StoredSegment {
  id: string;
  actorId: string;
  source:
    | { kind: 'fbx-clip'; fbxPath: string; clipName: string }
    | { kind: 'kimodo'; animationId: string }
    | { kind: 'anim-project'; projectId: string; projectName: string };
  trimStart: number;
  trimEnd: number;
  blendIn: number;
  /** 该段的独立站位（相对角色摆放的偏移）；缺省表示沿用角色摆放 */
  pose?: { x: number; z: number; yaw: number };
  /** 由「过渡动画生成」得到的过渡段：记录它连接的前后两段 */
  transition?: { prevId: string; nextId: string };
}

export interface StoredStage {
  id: string;
  name: string;
  actors: StoredActor[];
  segments: StoredSegment[];
  loop: boolean;
  createdAt: string;
  updatedAt: string;
  /** 只在回收站文件里出现 */
  deletedAt?: string;
}

export type StageSummary = Omit<StoredStage, 'actors' | 'segments'> & {
  actorCount: number;
  segmentCount: number;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function stageId(raw: string | undefined): string | null {
  const id = (raw ?? '').trim();
  return ID_PATTERN.test(id) ? id : null;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeActor(raw: unknown, index: number): StoredActor | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const kind = value.kind === 'soma' ? 'soma' : value.kind === 'fbx' ? 'fbx' : null;
  if (!kind) return null;
  const transform = (value.transform ?? {}) as Record<string, unknown>;
  return {
    id: text(value.id, `actor-${index}`) || `actor-${index}`,
    name: text(value.name, '角色').slice(0, 80) || '角色',
    kind,
    ...(typeof value.modelPath === 'string' && value.modelPath ? { modelPath: value.modelPath } : {}),
    transform: { x: finite(transform.x), z: finite(transform.z), yaw: finite(transform.yaw) },
    visible: value.visible !== false,
  };
}

function normalizeSegment(raw: unknown, index: number): StoredSegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const source = value.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') return null;

  let normalized: StoredSegment['source'];
  if (source.kind === 'fbx-clip') {
    if (typeof source.fbxPath !== 'string' || !source.fbxPath) return null;
    normalized = {
      kind: 'fbx-clip',
      fbxPath: source.fbxPath,
      clipName: text(source.clipName),
    };
  } else if (source.kind === 'kimodo') {
    if (typeof source.animationId !== 'string' || !source.animationId) return null;
    normalized = { kind: 'kimodo', animationId: source.animationId };
  } else if (source.kind === 'anim-project') {
    if (typeof source.projectId !== 'string' || !source.projectId) return null;
    normalized = {
      kind: 'anim-project',
      projectId: source.projectId,
      projectName: text(source.projectName).slice(0, 80),
    };
  } else {
    return null;
  }

  const pose = value.pose as Record<string, unknown> | undefined;
  const hasPose =
    !!pose &&
    typeof pose === 'object' &&
    (typeof pose.x === 'number' || typeof pose.z === 'number' || typeof pose.yaw === 'number');

  const link = value.transition as Record<string, unknown> | undefined;
  const hasLink =
    !!link &&
    typeof link === 'object' &&
    typeof link.prevId === 'string' &&
    typeof link.nextId === 'string';

  return {
    id: text(value.id, `segment-${index}`) || `segment-${index}`,
    actorId: text(value.actorId),
    source: normalized,
    trimStart: Math.max(0, finite(value.trimStart)),
    trimEnd: Math.max(0, finite(value.trimEnd)),
    blendIn: Math.max(0, finite(value.blendIn)),
    ...(hasPose ? { pose: { x: finite(pose?.x), z: finite(pose?.z), yaw: finite(pose?.yaw) } } : {}),
    ...(hasLink ? { transition: { prevId: link!.prevId as string, nextId: link!.nextId as string } } : {}),
  };
}

/** 规范化一份舞台文档；结构不合法时返回 null */
export function normalizeStage(raw: unknown, id: string): StoredStage | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const now = new Date().toISOString();

  const actors = Array.isArray(value.actors)
    ? value.actors.map(normalizeActor).filter((actor): actor is StoredActor => actor !== null)
    : [];
  const actorIds = new Set(actors.map((actor) => actor.id));
  const segments = Array.isArray(value.segments)
    ? value.segments
        .map(normalizeSegment)
        .filter((segment): segment is StoredSegment => segment !== null && actorIds.has(segment.actorId))
    : [];

  return {
    id,
    name: text(value.name, '未命名舞台').trim().slice(0, 80) || '未命名舞台',
    actors,
    segments,
    loop: value.loop !== false,
    createdAt: text(value.createdAt, now),
    updatedAt: now,
    ...(typeof value.deletedAt === 'string' ? { deletedAt: value.deletedAt } : {}),
  };
}

export function summaryOf(stage: StoredStage): StageSummary {
  return {
    id: stage.id,
    name: stage.name,
    loop: stage.loop,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
    deletedAt: stage.deletedAt,
    actorCount: stage.actors.length,
    segmentCount: stage.segments.length,
  };
}

function stagePath(id: string): string {
  return path.join(stagesDir, `${id}.json`);
}

function trashPath(id: string): string {
  return path.join(stageTrashDir, `${id}.json`);
}

async function readJson(file: string, id: string): Promise<StoredStage | null> {
  const content = await fs.readFile(file, 'utf8').catch(() => null);
  if (content === null) return null;
  try {
    return normalizeStage(JSON.parse(content), id);
  } catch {
    return null;
  }
}

export async function readStage(id: string): Promise<StoredStage | null> {
  return readJson(stagePath(id), id);
}

export async function listStages(): Promise<StageSummary[]> {
  const entries = await fs.readdir(stagesDir, { withFileTypes: true }).catch(() => []);
  const stages: StageSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    const stage = await readJson(stagePath(id), id);
    if (stage) stages.push(summaryOf(stage));
  }
  stages.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return stages;
}

export async function writeStage(stage: StoredStage): Promise<void> {
  await fs.mkdir(stagesDir, { recursive: true });
  const file = stagePath(stage.id);
  const temp = `${file}.tmp`;
  // 先写临时文件再改名，避免写入过程中断留下半份 JSON
  await fs.writeFile(temp, JSON.stringify(stage), 'utf8');
  await fs.rename(temp, file);
}

export async function trashStage(id: string): Promise<boolean> {
  const existing = await readStage(id);
  if (!existing) return false;
  await fs.mkdir(stageTrashDir, { recursive: true });
  const record: StoredStage = { ...existing, deletedAt: new Date().toISOString() };
  await fs.writeFile(trashPath(id), JSON.stringify(record), 'utf8');
  await fs.rm(stagePath(id), { force: true });
  return true;
}
