import { request } from './client';

/**
 * 通用文件系统浏览接口（只列文件夹）。
 * 供应用内的「选择文件夹」对话框使用，动画工作区与素材库扫描共用同一套接口。
 */

/** 面包屑的一节 */
export interface FsBreadcrumb {
  name: string;
  path: string;
}

/** 快速访问位置（个人目录 / 桌面 / 下载 / 文档） */
export interface FsLocation {
  id: string;
  name: string;
  path: string;
  /** 对应 Icon 组件的图标名 */
  icon: string;
}

/** 磁盘分区 */
export interface FsDrive {
  root: string;
  name: string;
  /** 剩余空间（字节）；读不到时为 null */
  freeSpace: number | null;
}

/** 一个子文件夹 */
export interface FsEntry {
  name: string;
  path: string;
  /** . / $ 开头或系统卷目录，默认不展示 */
  hidden: boolean;
  /** 该子目录里目标扩展名的文件数（动画统计 fbx，扫描统计 glb） */
  fileCount: number;
}

export interface FsListResponse {
  path: string;
  name: string;
  /** 上一级；已经是盘符根目录时为 null */
  parent: string | null;
  breadcrumbs: FsBreadcrumb[];
  entries: FsEntry[];
  /** 子文件夹总数（可能大于 entries.length） */
  total: number;
  /** 子文件夹超过单层上限被截断 */
  truncated: boolean;
  /** 当前目录下目标扩展名的文件数 */
  fileCount: number;
  /** 本次统计的扩展名（不含点，例如 fbx / glb） */
  extension: string;
}

export interface FsLocationsResponse {
  locations: FsLocation[];
  drives: FsDrive[];
}

export const fsApi = {
  /** 快速访问 + 磁盘列表 */
  locations: () => request<FsLocationsResponse>('/api/fs/locations'),

  /**
   * 列出某个绝对路径下的子文件夹。
   * @param dir 绝对路径（必须带盘符或 UNC 前缀）
   * @param ext 统计的扩展名（不含点），默认 fbx
   */
  list: (dir: string, ext = 'fbx') =>
    request<FsListResponse>(`/api/fs/list?dir=${encodeURIComponent(dir)}&ext=${encodeURIComponent(ext)}`),
};
