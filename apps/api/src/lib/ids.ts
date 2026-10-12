import { randomBytes } from 'node:crypto';

/**
 * 生成短小、可按时间排序、适合作为目录名的 ID。
 * 形如 `j_m8f3k2p1_x9a4b7`
 */
export function newId(prefix = 'j'): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex').slice(0, 6);
  return `${prefix}_${time}_${rand}`;
}

/** 从文件名/URL 推断扩展名（小写、无点号） */
export function extensionOf(nameOrUrl: string): string {
  const clean = nameOrUrl.split('?')[0]?.split('#')[0] ?? '';
  const base = clean.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 安全化文件名，避免路径穿越与非法字符 */
export function safeFileName(name: string, fallback = 'file'): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}
