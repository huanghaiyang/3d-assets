import { request } from './client';
import type { StageDoc, StageSummary } from '@/viewer/stage/StageTypes';

/** 舞台文档（只含编排信息）的读写接口 */
export const stageApi = {
  list: () => request<{ stages: StageSummary[] }>('/api/stage/list'),

  get: (id: string) => request<StageDoc>(`/api/stage/${encodeURIComponent(id)}`),

  /** 新建：服务端分配 id 并落盘，返回摘要 */
  create: (doc: StageDoc) =>
    request<StageSummary>('/api/stage', { method: 'POST', body: JSON.stringify(doc) }),

  save: (doc: StageDoc) =>
    request<StageDoc>(`/api/stage/${encodeURIComponent(doc.id)}`, {
      method: 'PUT',
      body: JSON.stringify(doc),
    }),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/stage/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
