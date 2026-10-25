import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('prompt');

/**
 * 把用户的自然语言（可带参考图片）转译成 Kimodo 能理解的英文动作提示词。
 *
 * 走 OpenAI 兼容的 /chat/completions（厂商由 KIMODO_PROMPT_PROVIDER 决定，默认 DeepSeek），
 * Key 只在服务端从 .env 读取；前端只传文字与图片的 data URL，
 * 永远拿不到 Key，也拿不到接口域名与模型配置以外的服务端信息。
 */

/** 单张参考图的体积上限（base64 解码前的字符数） */
const MAX_IMAGE_CHARS = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const TEXT_SYSTEM_PROMPT = [
  'You are an animation prompt engineer for a text-to-motion model.',
  'Translate the user request (Chinese or English) into ONE concise English motion description.',
  'Describe only whole-body motion: action, direction, speed, repetition, start/end pose.',
  'Ignore identity, clothing, background, camera, lighting, and rendering style.',
  'Use plain present-tense verbs, e.g. "a person walks forward slowly and waves the right hand".',
  'Output ONLY the English sentence without quotes, numbering, or explanations.',
  'Keep it under 40 words.',
].join(' ');

/**
 * 带参考图时的系统提示：
 * 先让模型逐部位观察图片（躯干朝向、双臂、双腿、运动方向），再输出一句话，
 * 比直接“看图写一句话”更稳定地识别出动作细节。
 */
const VISION_SYSTEM_PROMPT = [
  'You are an animation prompt engineer for a text-to-motion model.',
  'A reference image is provided. First analyse it silently, part by part:',
  '- torso orientation and overall body lean;',
  '- both arms (raised, forward, bent, spread) and hand height;',
  '- both legs (standing, stepped, crouched) and foot placement;',
  '- the direction and phase of the motion the pose implies.',
  'If several poses are visible, treat them as consecutive frames and describe the whole sequence.',
  'Then combine that analysis with the user note (if any) and output ONE concise English motion description.',
  'Describe only whole-body motion: action, direction, speed, repetition, start/end pose.',
  'Ignore identity, clothing, background, camera, lighting, and rendering style.',
  'Use plain present-tense verbs, e.g. "a person raises both arms above the head slowly".',
  'Output ONLY the final English sentence without quotes, numbering, or explanations.',
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

/** 提示词模型是否可用（Key、接口地址、模型名缺一不可） */
export function promptEnhancerReady(): boolean {
  return Boolean(config.kimodo.promptApiKey && config.kimodo.promptBaseUrl && config.kimodo.promptModel);
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

/** 清理模型偶发的多余包裹（代码块、引号、编号、前缀） */
function sanitize(raw: string): string {
  let text = raw.trim();
  // 去掉 ```...``` 代码块包裹
  text = text.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1').trim();
  text = text.replace(/^(["'`“”‘’]+)|(["'`“”‘’]+)$/g, '').trim();
  text = text.replace(/^(prompt|description|animation|motion)\s*[:：]\s*/i, '').trim();
  text = text.replace(/^\d+[.)]\s*/, '').trim();
  // 部分模型会把“先分析再输出”的分析也写进正文，这里取最后一个非空行
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) text = lines[lines.length - 1] ?? text;
  return text.replace(/\s+/g, ' ').trim();
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

interface CompletionResult {
  content: string;
  finishReason: string;
}

interface CompletionPayload {
  error?: { message?: unknown };
  choices?: {
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }[];
}

/** 调一次模型；错误统一转成可读文案（不暴露 Key / 域名） */
async function complete(
  model: string,
  system: string,
  userContent: unknown,
  maxTokens: number,
): Promise<CompletionResult> {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: false,
  };

  let response: Response;
  try {
    response = await fetch(`${config.kimodo.promptBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.kimodo.promptApiKey ?? ''}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.kimodo.promptTimeoutMs),
    });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? '请求超时' : (err as Error).message;
    log.warn(`提示词转译请求失败（${model}）：${reason}`);
    throw new Error(`调用提示词模型失败：${reason}`);
  }

  const payload = (await response.json().catch(() => ({}))) as CompletionPayload;
  if (!response.ok) {
    const detail =
      typeof payload.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`;
    log.warn(`提示词转译被拒绝（${model}）：${detail}`);
    throw new Error(`提示词模型返回错误：${detail}`);
  }

  const choice = payload.choices?.[0];
  const finishReason = String(choice?.finish_reason ?? '');
  return { content: contentToText(choice?.message?.content), finishReason };
}

export async function enhancePrompt(input: EnhancePromptInput): Promise<EnhancePromptResult> {
  if (!promptEnhancerReady()) {
    throw new Error(
      '尚未配置提示词模型：请在 .env 设置 KIMODO_PROMPT_PROVIDER 与对应的 API Key（默认 DeepSeek 用 DEEPSEEK_API_KEY）',
    );
  }

  const text = (input.prompt ?? '').trim();
  const image = input.image?.trim() ? parseImage(input.image) : null;
  if (!text && !image) throw new Error('请先填写描述文字或上传参考图片');

  // 带图时优先用视觉模型（默认与文字模型相同，可用 KIMODO_PROMPT_VISION_MODEL 单独指定）
  const model = image ? config.kimodo.promptVisionModel : config.kimodo.promptModel;
  const system = image ? VISION_SYSTEM_PROMPT : TEXT_SYSTEM_PROMPT;
  const userText = text || 'Describe the motion shown in this reference image.';
  const userContent = image
    ? [
        { type: 'text', text: userText },
        // detail: high 让支持该参数的厂商按高精度理解图片细节
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}`, detail: 'high' } },
      ]
    : userText;

  let result = await complete(model, system, userContent, config.kimodo.promptMaxTokens);
  // 推理模型可能把 token 预算全花在 reasoning 上（finish_reason=length、正文为空），
  // 这里自动加倍预算重试一次，避免用户直接看到失败。
  if (!sanitize(result.content) && result.finishReason === 'length') {
    const retryTokens = Math.min(config.kimodo.promptMaxTokens * 2, 8000);
    log.warn(
      `提示词模型正文为空（finish=length，max_tokens=${config.kimodo.promptMaxTokens}），用 ${retryTokens} 重试`,
    );
    result = await complete(model, system, userContent, retryTokens);
  }

  const prompt = sanitize(result.content);
  if (!prompt) {
    log.warn(`提示词模型没有返回内容（${model}，finish=${result.finishReason || 'unknown'}）`);
    throw new Error('提示词模型没有返回内容，请重试（推理模型可调大 KIMODO_PROMPT_MAX_TOKENS）');
  }

  log.info(
    `提示词转译完成（${config.kimodo.promptProviderLabel} / ${model}${image ? '，含参考图' : ''}）：${prompt.slice(0, 80)}`,
  );
  return { prompt, model, usedImage: image !== null };
}
