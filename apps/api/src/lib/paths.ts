import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/api/src/lib` (dev) 或 `apps/api/dist/lib` (build) */
const here = path.dirname(fileURLToPath(import.meta.url));

/** `apps/api` */
export const apiRoot = path.resolve(here, '..', '..');

/** repository root */
export const repoRoot = path.resolve(apiRoot, '..', '..');

export const webDistDir = path.join(repoRoot, 'apps', 'web', 'dist');

export function joinData(...parts: string[]): string {
  return path.join(repoRoot, 'data', ...parts);
}

export const dataDir = joinData();
export const storageDir = joinData('storage');
export const payloadDir = joinData('payloads');
/** 上传文件的暂存目录（提交成素材后立即清理） */
export const uploadsStagingDir = joinData('uploads', '.staging');
export const stateFile = joinData('state.json');
export const settingsFile = joinData('settings.json');
