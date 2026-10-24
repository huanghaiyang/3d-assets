import { request } from './client';

export interface KimodoStatus {
  running: boolean;
  port: number;
  url: string;
  pid: number | null;
  startedAt: number | null;
  error: string | null;
  outputDir: string;
}

export interface KimodoAnimation {
  id: string;
  prompt: string;
  frames: number;
  diffusion_steps: number;
  seed: number;
  created_at: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  error?: string;
  model: string;
  text_quantization: string;
}

export interface KimodoGenerateBody {
  prompt: string;
  frames?: number;
  steps?: number;
  seed?: number;
  model?: string;
  text_quantization?: string;
  segments?: { prompt: string; frames: number }[];
  transition_frames?: number;
}

export interface KimodoImportResult {
  ok: boolean;
  data: unknown;
  clipName: string;
}

export const kimodoApi = {
  status: () => request<KimodoStatus>('/api/kimodo/status'),
  start: () => request<KimodoStatus>('/api/kimodo/start', { method: 'POST' }),
  stop: () => request<KimodoStatus>('/api/kimodo/stop', { method: 'POST' }),

  /** 触发生成（透传到 kimodo demo） */
  generate: (body: KimodoGenerateBody) =>
    request<KimodoAnimation>('/api/kimodo/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 列出 demo 里的所有动画（含 queued/running/ready） */
  animations: () => request<KimodoAnimation[]>('/api/kimodo/animations'),

  /** 把指定动画转换成 Mixamo 动画 JSON 并返回 */
  importAnimation: (id: string, clipName?: string) => {
    const query = clipName ? `?clipName=${encodeURIComponent(clipName)}` : '';
    return request<KimodoImportResult>(`/api/kimodo/import/${encodeURIComponent(id)}${query}`);
  },

  /** iframe 内嵌用的地址（注入了 postMessage 桥） */
  frameUrl: () => '/api/kimodo/frame',
};
