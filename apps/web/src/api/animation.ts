import { request } from './client';

export interface AnimationFile {
  name: string;
  /** 相对所属文件夹的路径 */
  relative: string;
  /** 绝对路径，供前端回传取流 */
  path: string;
  /** 所属根文件夹（多文件夹时用于分组筛选） */
  sourceDir: string;
  /** 根文件夹名，界面上做标签 */
  sourceLabel: string;
  size: number;
  mtime: number;
}

export interface AnimationListResponse {
  dirs: string[];
  files: AnimationFile[];
  truncated: boolean;
  missing: string[];
}

export interface AnimationDirEntry {
  name: string;
  path: string;
  fbxCount: number;
  hidden: boolean;
}

export interface AnimationBrowseResponse {
  dir: string;
  parent: string | null;
  dirs: AnimationDirEntry[];
  fbxCount: number;
}

export interface AnimationInfoResponse {
  defaultDir: string;
  parent: string;
  exists: boolean;
  /** 当前生效的文件夹列表 */
  dirs: string[];
  /** 记录过但已不存在的文件夹 */
  missing: string[];
  extensions: string[];
  readOnly: boolean;
  limits: { maxFiles: number; maxDepth: number; maxDirs: number };
}

export interface AnimationDirsResponse {
  dirs: string[];
  missing: string[];
  defaultDir: string;
  saved: string[];
}

/**
 * 封面缓存版本：后端渲染逻辑升级（例如修复 T-pose）时 +1，
 * 让所有已缓存在浏览器/中间的旧封面 URL 直接失效。
 */
export const ANIMATION_COVER_VERSION = 3;

export const animationApi = {
  info: () => request<AnimationInfoResponse>('/api/anim/info'),

  /** 列出多个文件夹下的 .fbx；不传则使用服务端记录的文件夹 */
  list: (dirs?: string[]) => {
    if (!dirs || dirs.length === 0) return request<AnimationListResponse>('/api/anim/list');
    const query = dirs.map((dir) => `dir=${encodeURIComponent(dir)}`).join('&');
    return request<AnimationListResponse>(`/api/anim/list?${query}`);
  },

  dirs: () => request<AnimationDirsResponse>('/api/anim/dirs'),
  /** 保存文件夹列表（服务端持久化，只做校验，不写目标目录） */
  saveDirs: (dirs: string[]) =>
    request<AnimationDirsResponse>('/api/anim/dirs', { method: 'PUT', body: JSON.stringify({ dirs }) }),

  browse: (dir?: string) =>
    request<AnimationBrowseResponse>(`/api/anim/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),

  /** 只取流，不进 HTTP 缓存（服务端 no-store，客户端只在内存里留一份） */
  fileUrl: (filePath: string) => `/api/anim/file?path=${encodeURIComponent(filePath)}`,

  /** 封面：后端 worker 子线程渲染（浏览器只当图片加载，不占主线程） */
  animationCoverUrl: (
    filePath: string,
    size = 192,
    pose = 0.35,
    options: { version?: string | number; refresh?: boolean } = {},
  ) => {
    const params = new URLSearchParams({
      path: filePath,
      size: String(size),
      pose: String(pose),
      v: String(options.version ?? ANIMATION_COVER_VERSION),
    });
    if (options.refresh) params.set('refresh', '1');
    return `/api/anim/cover?${params.toString()}`;
  },
};
