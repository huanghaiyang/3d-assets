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

/** 运行期数据根目录：可用 H3D_DATA_DIR 覆盖（测试 / 独立实例 / 便携部署） */
const dataRoot = process.env.H3D_DATA_DIR ? path.resolve(process.env.H3D_DATA_DIR) : joinData();

export const dataDir = dataRoot;
export const storageDir = path.join(dataRoot, 'storage');
export const payloadDir = path.join(dataRoot, 'payloads');
/** 运行期缓存（封面 PNG 等）：放在项目 data/cache 下，已 gitignore，不写系统盘 */
export const cacheDir = path.join(dataRoot, 'cache');
export const coversCacheDir = path.join(cacheDir, 'covers');
/** 上传文件的暂存目录（提交成素材后立即清理） */
export const uploadsStagingDir = path.join(dataRoot, 'uploads', '.staging');
export const stateFile = path.join(dataRoot, 'state.json');
/** state.json 的启动快照：主文件损坏/丢失时用来恢复任务与素材记录 */
export const stateBackupFile = path.join(dataRoot, 'state.json.bak');
export const settingsFile = path.join(dataRoot, 'settings.json');
