import { request } from './client';
/** 拼接编排的类型定义在 viewer/strips/StripTypes 里（与时间轴/渲染层共享，避免循环依赖） */
import type { StripsComposition } from '@/viewer/strips/StripTypes';

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

/** 导入动画 JSON 后的摘要（随新建动画一起保存） */
export interface AnimationImportSummary {
  name: string;
  clipCount: number;
  trackCount: number;
}

/**
 * 已保存的动画项目（列表项 / 保存响应，不含动画数据本体）。
 *
 * 两种项目共用这一结构，靠 `kind` 区分：
 *  - `'clip'`  普通新建动画（只有烘焙数据 data）；
 *  - `'strips'`拼接工作区的产物（额外带 composition，可再次打开继续编辑）。
 * kind / stripCount 由后端 summaryOf() 派生，旧项目缺 composition 时即为 'clip'。
 */
export interface SavedAnimationProject {
  /** 项目 id，同时是服务端文件名 `<id>.json`；保存时同一 id 再次提交即为更新 */
  id: string;
  /** 展示名（服务端规范化，最长 80 字符，不可与其它未删除项目重名） */
  name: string;
  /** 基础模型（动画库里的 Mixamo FBX 绝对路径） */
  basePath: string;
  /** 基础模型展示名（仅 UI） */
  baseName: string;
  /** 创建时间，ISO 8601 字符串 */
  createdAt: string;
  /** 最后修改时间，ISO 8601 字符串；封面缓存失效也看它 */
  updatedAt: string;
  /** 导入动画 JSON 得到的摘要；非导入来源的项目为 null */
  imported: AnimationImportSummary | null;
  /** data 里的片段数量（服务端派生） */
  clipCount: number;
  /** 所有片段的轨道总数（服务端派生） */
  trackCount: number;
  /** 是否已有烘焙动画数据 */
  hasData: boolean;
  /** 项目类别：带拼接编排的项目为 strips，动画工作区里单独分类 */
  kind?: 'clip' | 'strips';
  /** 拼接编排里的源动画数量（最多 5，对应 5 个身体部位）；普通项目为 0 */
  stripCount?: number;
  /**
   * 拼接工作区的编排快照；普通新建动画为 null。
   * 读取时可能缺失（旧项目），已由后端 normalizeComposition 补齐默认值。
   */
  composition?: StripsComposition | null;
  /** 进入回收站的时间（只有回收站里的项目才有） */
  deletedAt?: string;
}

/** 项目详情：在列表项基础上带上烘焙动画数据本体（取单个项目时才传输） */
export interface SavedAnimationProjectDetail extends SavedAnimationProject {
  /** 原始动画数据；由 store 侧校验格式后再使用 */
  data: unknown;
}

export type FingerSide = 'left' | 'right';

/** 从现有 Mixamo 动画里采样得到的一种手型（只含手指骨局部旋转） */
export interface FingerPosePreset {
  id: string;
  side: FingerSide;
  name: string;
  /** 拇指、食指、中指、无名指、小指的弯曲度，0–1 */
  curls: number[];
  /** 关节名（已去掉 mixamorig 前缀）→ 局部四元数 xyzw */
  bones: Record<string, [number, number, number, number]>;
  source: { clip: string; file: string; time: number };
  /** 同一形态在动画库里出现的次数 */
  samples: number;
}

export interface FingerPoseLibrary {
  version: number;
  available: boolean;
  message: string | null;
  generatedAt: string;
  scanned: number;
  poses: number;
  left: FingerPosePreset[];
  right: FingerPosePreset[];
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

  // ===== 新建动画 / 拼接动画（内置白模 + 导入/烘焙的动画数据） =====

  /** 手指形态库（从现有 Mixamo 动画采样去重；refresh 时后台重建） */
  fingerPoses: (refresh = false) =>
    request<FingerPoseLibrary>(`/api/anim/finger-poses${refresh ? '?refresh=1' : ''}`),

  /**
   * 项目列表（摘要，不含动画数据本体，避免一次传输几百 MB）。
   * @returns `{ projects }`，按创建时间升序；每项含后端派生的 kind 与 stripCount，
   *          前端据此把「拼接动画」与普通新建动画分开归类
   */
  projects: () => request<{ projects: SavedAnimationProject[] }>('/api/anim/projects'),

  /**
   * 读取单个项目详情（含 data）。
   * @param id 项目 id；会被 encodeURIComponent，非法 id 由服务端回 400
   * @returns 项目详情；项目不存在 / 文件损坏时服务端回 404（由 request 转成异常）
   */
  project: (id: string) =>
    request<SavedAnimationProjectDetail>(`/api/anim/projects/${encodeURIComponent(id)}`),

  /**
   * 新建或更新项目：对同一个 id 再次调用即为「更新」，服务端整体覆盖并刷新 updatedAt。
   *
   * 拼接工作区保存时同时提交两份数据：
   *  - `data`：烘焙后的关键帧数据（供动画工作区播放 / 导出）；
   *  - `composition`：可再编辑的编排快照（基础模型 + 最多 5 条 Strip 轨道）。
   *
   * @param project.id 项目 id（新建时由前端生成，需满足 [A-Za-z0-9_-]{1,80}）
   * @param project.name 展示名；与其它未删除项目重名时服务端回 409
   * @param project.basePath 基础模型 FBX 绝对路径
   * @param project.baseName 基础模型展示名
   * @param project.data 形如 `{ format: 'fbx-animation-data', clips: [...] }`，格式不符回 400
   * @param project.imported 导入摘要；非导入来源传 null
   * @param project.composition 拼接编排。不传＝保持旧编排不变；传 null＝清除（改回普通项目）；
   *                            传对象＝覆盖。轨道内部字段由前端定义，服务端只校验外层结构
   * @returns 保存后的项目摘要（不含 data）；磁盘写入失败时服务端回 500
   */
  saveProject: (project: {
    id: string;
    name: string;
    basePath: string;
    baseName: string;
    data: unknown;
    imported: AnimationImportSummary | null;
    /** 拼接编排；不传表示不修改，null 表示清除 */
    composition?: StripsComposition | null;
  }) =>
    request<SavedAnimationProject>(`/api/anim/projects/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      body: JSON.stringify(project),
    }),

  /** 删除 = 移入回收站（软删除） */
  deleteProject: (id: string) =>
    request<{ ok: boolean; trashed: boolean }>(`/api/anim/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /** 重命名；重名时服务端返回 409 */
  renameProject: (id: string, name: string) =>
    request<SavedAnimationProject>(`/api/anim/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  trash: () => request<{ projects: SavedAnimationProject[] }>('/api/anim/trash'),

  /** 回收站项目详情（含动画数据），用于只读预览 */
  trashProject: (id: string) =>
    request<SavedAnimationProject & { data: unknown }>(`/api/anim/trash/${encodeURIComponent(id)}`),

  restoreProject: (id: string) =>
    request<{ ok: boolean; renamed: boolean; project: SavedAnimationProject }>(
      `/api/anim/projects/${encodeURIComponent(id)}/restore`,
      { method: 'POST', body: '{}' },
    ),

  /** 彻底删除回收站里的项目（不可恢复） */
  purgeProject: (id: string) =>
    request<{ ok: boolean }>(`/api/anim/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * 生成 FBX 取流地址（给 GLTFLoader / 自定义 loader 直接当 URL 用）。
   * 只取流，不进 HTTP 缓存（服务端 Cache-Control: no-store，客户端只在内存里留一份）；
   * 服务端只允许读 .fbx，且对 dir+name 形式会做目录穿越校验。
   * @param filePath 动画库扫描结果里的绝对路径（AnimationFile.path）
   * @returns 形如 `/api/anim/file?path=<encoded>` 的地址
   */
  fileUrl: (filePath: string) => `/api/anim/file?path=${encodeURIComponent(filePath)}`,

  /**
   * 封面：后端 worker 子线程渲染（浏览器只当图片加载，不占主线程）。
   * 传 project 时按「项目动画数据」取姿势（新建动画卡片），否则按 FBX 自带动画取帧。
   */
  animationCoverUrl: (
    filePath: string,
    size = 192,
    pose = 0.35,
    options: { version?: string | number; refresh?: boolean; project?: string } = {},
  ) => {
    const params = new URLSearchParams({
      size: String(size),
      pose: String(pose),
      v: String(options.version ?? ANIMATION_COVER_VERSION),
    });
    if (options.project) params.set('project', options.project);
    else params.set('path', filePath);
    if (options.refresh) params.set('refresh', '1');
    return `/api/anim/cover?${params.toString()}`;
  },
};
