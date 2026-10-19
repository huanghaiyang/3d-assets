import fs from 'node:fs/promises';
import path from 'node:path';
import { payloadDir } from '../lib/paths.js';
import { safeFileName } from '../lib/ids.js';
import { createLogger } from '../lib/logger.js';
import type { ViewType } from '../store/types.js';

const log = createLogger('payload');

export interface JobPayload {
  prompt: string;
  /** 原始 base64（不含 data URI 前缀） */
  imageBase64: string | null;
  imageName: string | null;
  views: { viewType: ViewType; base64: string; name: string }[];
}

function payloadFile(jobId: string): string {
  return path.join(payloadDir, `${safeFileName(jobId, 'job')}.json`);
}

export async function savePayload(jobId: string, payload: JobPayload): Promise<void> {
  await fs.mkdir(payloadDir, { recursive: true });
  await fs.writeFile(payloadFile(jobId), JSON.stringify(payload), 'utf8');
}

export async function loadPayload(jobId: string): Promise<JobPayload | null> {
  try {
    const raw = await fs.readFile(payloadFile(jobId), 'utf8');
    return JSON.parse(raw) as JobPayload;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`读取 payload 失败 ${jobId}: ${(err as Error).message}`);
    }
    return null;
  }
}

export async function deletePayload(jobId: string): Promise<void> {
  await Promise.all([fs.rm(payloadFile(jobId), { force: true }), fs.rm(previewFile(jobId), { force: true })]);
}

function previewFile(jobId: string): string {
  return path.join(payloadDir, `${safeFileName(jobId, 'job')}.preview`);
}

/** 保存前端压缩后的输入预览图（data URL 形式） */
export async function savePreview(jobId: string, dataUrl: string): Promise<void> {
  await fs.mkdir(payloadDir, { recursive: true });
  await fs.writeFile(previewFile(jobId), dataUrl, 'utf8');
}

export async function loadPreview(jobId: string): Promise<{ mime: string; buffer: Buffer } | null> {
  try {
    const dataUrl = (await fs.readFile(previewFile(jobId), 'utf8')).trim();
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) return null;
    return { mime: match[1]!, buffer: Buffer.from(match[2]!, 'base64') };
  } catch {
    return null;
  }
}
