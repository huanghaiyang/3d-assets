/**
 * 腾讯混元生3D —— OpenAI 兼容接口的线上数据结构。
 *
 * 接口域名: https://api.ai3d.cloud.tencent.com
 *   POST /v1/ai3d/submit   提交混元生3D专业版任务
 *   POST /v1/ai3d/query    查询混元生3D专业版任务
 * 鉴权:     Authorization: sk-xxxxx
 *
 * 参考文档:
 *   https://cloud.tencent.com/document/product/1804/126189  (OpenAI 兼容接口调用示例)
 *   https://cloud.tencent.com/document/product/1804/123447  (提交任务参数)
 *   https://cloud.tencent.com/document/product/1804/123448  (查询任务返回)
 *
 * 注意：工作台自己的枚举（GenerateType / PolygonType / ResultFormat / ViewType）
 * 定义在 store/types.ts，这里是混元的线上协议。
 */

import type { GenerateType, PolygonType, ResultFormat, RemoteJobStatus, ViewType } from '../store/types.js';

export type { RemoteJobStatus };

/** 混元生3D 模型版本。3.1 不支持 LowPoly / Sketch。 */
export const MODEL_VERSIONS = ['3.0', '3.1'] as const;
export type ModelVersion = (typeof MODEL_VERSIONS)[number];

/** 3.1 版本才支持的多视角 */
export const VIEW_TYPES_31_ONLY: readonly ViewType[] = ['top', 'bottom', 'left_front', 'right_front'];

export interface MultiViewImage {
  ViewType?: ViewType;
  ViewImageUrl?: string;
  ViewImageBase64?: string;
}

export interface SubmitJobRequest {
  Model?: ModelVersion;
  /** 文生3D 提示词。与 ImageBase64 / ImageUrl 互斥（Sketch 模式除外） */
  Prompt?: string;
  /** 输入图 base64（不含 data URI 前缀） */
  ImageBase64?: string;
  ImageUrl?: string;
  MultiViewImages?: MultiViewImage[];
  EnablePBR?: boolean;
  FaceCount?: number;
  GenerateType?: GenerateType;
  PolygonType?: PolygonType;
  ResultFormat?: ResultFormat;
}

export interface SubmitJobData {
  /** 任务 ID，有效期 24 小时 */
  jobId: string;
  requestId: string;
}

export interface File3D {
  Type?: string;
  /** 文件下载地址，有效期 24 小时 */
  Url?: string;
  PreviewImageUrl?: string;
}

export interface QueryJobData {
  status: RemoteJobStatus;
  errorCode?: string;
  errorMessage?: string;
  files: File3D[];
  creditConsumed?: number;
  /** 形如 {"GenerateType-Normal":20,"Pbr":10} */
  creditDetails?: string;
  requestId?: string;
}
