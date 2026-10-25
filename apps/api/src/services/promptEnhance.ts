import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('prompt');

/**
 * 把用户的自然语言（可带参考图片）转译成 Kimodo 能理解的英文动作提示词。
 *
 * 走 DeepSeek 的 OpenAI 兼容接口，Key 只在服务端从 .env 读取，
 * 前端只传文字与图片的 data URL，永远拿不到 Key，也拿不到接口域名。
 */

/** 单张参考图的体积上限（base64 解码前的字符数） */
const MAX_IMAGE_CHARS = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const SYSTEM_PROMPT = [
  'You are an animation prompt engineer for a text-to-motion model.',
  'Translate the user request (Chinese or English) and the optional reference image into ONE concise English motion description.',
  'Describe only whole-body motion: action, direction, speed, repetition, start/end pose.',
  'Ignore identity, clothing, background, camera, lighting, and rendering style.',
  'Use plain present-tense verbs, e.g. "a person walks forward slowly and waves the right hand".',
  'Output ONLY the English sentence without quotes, numbering, or explanations.',
  'Keep it under 40 words.',
].join(' ');

export interface EnhancePromptInput {
  /** 用户描述（可为空，只靠图片） */
  prompt?: string;
  /** 参考图片的 data URL，如 data:image/png;base64,... */
  image?: string | null;
}

export interface EnhancePromptResult {
  prompt: string;
  model: string;
  usedImage: boolean;
}

/** 是否配置了提示词模型 */
export function promptEnhancerReady(): boolean {
  return Boolean(config.kimodo.promptApiKey);
}

function parseImage(dataUrl: string): { mime: string; base64: string } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) throw new Error('参考图片格式不正确，请上传 PNG / JPEG / WebP / GIF');
  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mime)) {
    throw new Error(`不支持 ${mime} 图片，请改用 PNG / JPEG / WebP / GIF`);
  }
  const base64 = match[2].replace(/\s+/g, '');
  if (base64.length > MAX_IMAGE_CHARS) throw new Error('参考图片过大，请压缩到 8MB 以内');
  return { mime, base64 };
}

/** 清理模型偶发的多余包裹（引号、编号、前缀） */
function sanitize(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^(["'`“”‘’]+)|(["'`“”‘’]+)$/g, '').trim();
  text = text.replace(/^(prompt|description|animation|motion)\s*[:：]\s*/i, '').trim();
  text = text.replace(/^\d+[.)]\s*/, '').trim();
  return text;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
      .trim();
  }
  return '';
}

export async function enhancePrompt(input: EnhancePromptInput): Promise<EnhancePromptResult> {
  const apiKey = config.kimodo.promptApiKey;
  if (!apiKey) {
    throw new Error('尚未配置 DEEPSEEK_API_KEY，无法使用 AI 转译提示词');
  }

  const text = (input.prompt ?? '').trim();
  const image = input.image?.trim() ? parseImage(input.image) : null;
  if (!text && !image) throw new Error('请先填写描述文字或上传参考图片');

  const userText = text || 'Describe the motion shown in this reference image.';
  const userContent = image
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
      ]
    : userText;

  const body = {
    model: config.kimodo.promptModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 200,
    stream: false,
  };

  let response: Response;
  try {
    response = await fetch(`${config.kimodo.promptBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.kimodo.promptTimeoutMs),
    });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? '请求超时' : (err as Error).message;
    log.warn(`提示词转译请求失败：${reason}`);
    throw new Error(`调用提示词模型失败：${reason}`);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: unknown };
    choices?: { message?: { content?: unknown } }[];
  };
  if (!response.ok) {
    const detail =
      typeof payload.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`;
    log.warn(`提示词转译被拒绝：${detail}`);
    throw new Error(`提示词模型返回错误：${detail}`);
  }

  const content = contentToText(payload.choices?.[0]?.message?.content);
  const prompt = sanitize(content);
  if (!prompt) throw new Error('提示词模型没有返回内容，请重试');

  log.info(`提示词转译完成${image ? '（含参考图）' : ''}：${prompt.slice(0, 80)}`);
  return { prompt, model: config.kimodo.promptModel, usedImage: image !== null };
}
