import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('prompt');

/**
 * 把用户的自然语言（可带参考图片）转译成 Kimodo 能理解的英文动作提示词。
 *
 * Kimodo 是纯人体骨骼文生动作模型（SOMA 30 关节，没有物体、场景与接触条件），
 * 所以这里除了翻译，还负责把「掀桌子」这类物体动作改写成等价的身体动力学描述，
 * 并给出动作拆解与分段建议，供前端展示和分段生成。
 *
 * 走 OpenAI 兼容的 /chat/completions（厂商由 KIMODO_PROMPT_PROVIDER 决定，默认 DeepSeek），
 * Key 只在服务端从 .env 读取；前端只传文字与图片的 data URL，
 * 永远拿不到 Key，也拿不到接口域名与模型配置以外的服务端信息。
 */

/** 单张参考图的体积上限（base64 解码前的字符数） */
const MAX_IMAGE_CHARS = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** 模型本身的限制：没有道具、场景和物体接触，只能用身体动作表达意图 */
const MOTION_RULES = [
  'The target model renders ONE human body (30 joints) with no props, no scene and no object contact.',
  'Describe only body mechanics: which body parts move, in which direction, with what force and speed, and the start/end pose.',
  'If the request mentions an object, tool or furniture, never name it inside "prompt"; describe the body motion that would manipulate it instead, and list the object nouns only in "objects".',
  'Never downgrade a forceful action into a generic reach, grab or pick-up. Preserve the requested force, tempo and direction.',
  'Use only motion-capture vocabulary: walk, step, turn, bend, squat, stand up, lean, reach, raise, lower, swing, push, pull, lift, throw, punch, thrust, kick, jump, wave. Avoid object verbs such as grip, flip, overturn, open, close, hold or place.',
  'Use absolute spatial directions (forward, upward, downward, to the left or right, behind the body) instead of relative ones (backward, inward), and always state the final hand position in absolute terms: say "arms extended forward at chest height", never "arms pushed backward".',
  'Translate martial-arts idioms into literal body mechanics instead of keeping the metaphor: for example 回马枪 means turn the body around, step back, then thrust both arms forward at chest height.',
  'Always state where the hands start and where they end (for example "from knee height up to shoulder height"), so the limb path cannot be read backwards.',
  'For forceful actions keep the arms extended away from the torso with the elbows nearly straight. Hands tucked in near the chest or face, a bowed head or trembling shoulders read as crying, so never describe them unless the user asks for crying or sadness.',
  'Distinguish similar actions: grab/pick up = hand closes slowly close to the body; push = lean forward, extend the arm, shift weight forward; thrust/punch = arms shoot straight forward from the chest with the elbows snapping straight; flip/overturn = bend first, then an explosive two-handed upward swing with the torso extending and leaning back; throw = wind-up then a fast release; kick = lift one knee, then swing the lower leg fast.',
  'Write in the style of motion-capture captions: present tense, "a person ...", one sentence, under 45 words, no camera, clothing, identity or rendering words.',
].join(' ');

/**
 * Kimodo 的动作语义库：它的文本编码器是按 mocap caption 训练的，
 * 只有落在这些原型附近的描述才能被稳定编码。让模型先选原型再填参数，
 * 比直接翻译用户原话更不容易漂移到无关动作（如掀桌子→哭泣、回马枪→下按）。
 */
const MOTION_MAP = [
  '- stand: a person stands still in place',
  '- walk: a person walks forward at a steady pace',
  '- run: a person runs forward quickly',
  '- step: a person steps forward or backward with one foot',
  '- turn: a person turns the body around to face the opposite direction',
  '- bend: a person bends the torso forward and down',
  '- lean_back: a person leans the torso backward',
  '- squat: a person squats down and stands up again',
  '- reach: a person reaches one or both arms forward at shoulder height',
  '- lift: a person lowers both hands to knee height, then lifts them while straightening the legs',
  '- push: a person pushes both arms forward and leans the body weight forward',
  '- pull: a person pulls both arms toward the chest and steps back',
  '- punch: a person punches both arms straight forward at chest height',
  '- swing: a person swings one or both arms horizontally across the body',
  '- extend_back: a person extends both arms straight backward behind the body at chest height and keeps the torso upright',
  '- throw: a person winds up and throws one arm forward fast',
  '- kick: a person lifts one knee and kicks the lower leg forward',
  '- wave: a person raises one arm and waves the hand side to side',
  '- jump: a person jumps upward and lands on both feet',
  '- crouch: a person crouches low and holds still',
  '- cover_face: a person raises both hands to the face and bows the head',
].join('\n');

/** 统一的推导顺序：先选语义原型，再用绝对方向/高度/节奏实例化 */
const DERIVE_STEPS = [
  'Derive the answer in this order:',
  '(1) name the intended body mechanics of the request;',
  '(2) pick the closest archetypes from the semantic map above, in time order, combining several for a compound action;',
  '(3) instantiate each archetype with explicit absolute direction, hand height, tempo and start/end pose, reusing the wording of the map;',
  '(4) never invent motion verbs outside the map; when nothing matches, approximate with the nearest archetype instead of translating the original words literally.',
].join(' ');

/** 统一的结构化输出约定，方便前端展示拆解并直接用分段提示词生成 */
const OUTPUT_SPEC = [
  'Return STRICT JSON only, no markdown and no prose, with exactly these keys:',
  '{"prompt":"<one English motion sentence, max 45 words>",',
  '"steps":["<2 to 5 very short Chinese phrases describing the body motion chain in time order>"],',
  '"segments":["<2 to 4 consecutive English sentences; each is one complete phase such as approach, contact/force, recovery>"],',
  '"objects":["<object nouns mentioned by the user; empty array if none>"],',
  '"note":"<one short Chinese sentence: say the model has no object contact and the motion was rewritten as body mechanics, or say 无需改写 if no object was involved>"}',
].join(' ');

/** 易混动作的 few-shot，用来压住「物体动作一律退化成拿取」的倾向 */
const EXAMPLES = [
  'Examples:',
  '用户：掀桌子 → {"prompt":"a person bends deeply forward, reaches both hands down in front of the knees, straightens up quickly while sweeping both arms forward and up to shoulder height, leans the torso back, and takes one step backward","steps":["身体前屈，双手下探到膝盖前方","快速直起身体，双臂向前上方横扫到肩高","躯干后仰并退后一步站稳"],"segments":["a person bends deeply forward and reaches both hands down in front of the knees","a person straightens up quickly, sweeping both arms forward and up to shoulder height and leaning back","a person takes one step backward and holds the final pose"],"objects":["桌子"],"note":"模型没有物体接触，已把掀桌改写为下探、爆发上挥加后仰退步"}',
  '用户：回马枪 → {"prompt":"a person turns around quickly to face the opposite direction, steps back with one foot, then punches both arms straight forward at chest height and holds the pose","steps":["身体快速转身面向反方向","后撤一步稳住重心","双臂向正前方直刺到胸高","保持前刺姿态"],"segments":["a person turns around quickly to face the opposite direction","a person steps back with one foot and punches both arms straight forward at chest height","a person holds the forward punch pose"],"objects":[],"note":"无需改写，已把回马枪拆成转身、后撤、前刺"}',
  '用户：哭泣 → {"prompt":"a person stands with the head bowed, raises both hands to cover the face, and shakes the shoulders up and down while staying in place","steps":["低头垂肩","双手抬到脸前遮住面部","肩膀上下抽动，原地不动"],"segments":["a person stands with the head bowed and raises both hands to the face","a person shakes the shoulders repeatedly while staying in place"],"objects":[],"note":"无需改写"}',
  '用户：拿杯子 → {"prompt":"a person reaches forward with one hand, closes the hand slowly, lifts it to chest height, and holds it steady","steps":["单手向前伸出","手指缓慢合拢","把手抬到胸前并停住"],"segments":["a person reaches forward with one hand and closes the hand","a person lifts the hand to chest height and holds it steady"],"objects":["杯子"],"note":"无需改写作物体接触，按单手拿取描述"}',
  '用户：用力推门 → {"prompt":"a person steps forward, leans the body weight into both hands, and pushes forward steadily with both arms extending","steps":["向前迈步","身体前倾，双手向前伸","双臂蹬直持续发力"],"segments":["a person steps forward and places both hands forward","a person leans in and pushes forward steadily"],"objects":["门"],"note":"模型没有物体接触，已改写为前倾双手持续发力的推门动作"}',
  '用户：一脚踹门 → {"prompt":"a person shifts weight onto one leg, lifts the other knee quickly, then kicks forward hard and fast while leaning back slightly","steps":["重心移到支撑腿","抬起另一侧膝盖","小腿快速向前蹬出","收腿站稳"],"segments":["a person shifts weight onto one leg and lifts the other knee","a person kicks forward hard and fast, then pulls the leg back"],"objects":["门"],"note":"模型没有物体接触，已改写为快速提膝前蹬的踹门动作"}',
].join(' ');

const TEXT_SYSTEM_PROMPT = [
  'You are an animation prompt engineer for Kimodo, a text-to-motion model.',
  'Kimodo was trained on motion-capture captions and only renders motions close to the semantic map below.',
  MOTION_MAP,
  DERIVE_STEPS,
  MOTION_RULES,
  EXAMPLES,
  OUTPUT_SPEC,
].join(' ');

/**
 * 带参考图时的系统提示：
 * 先让模型逐部位观察图片（躯干朝向、双臂、双腿、运动方向），再输出同样的结构化结果，
 * 比直接“看图写一句话”更稳定地识别出动作细节。
 */
const VISION_SYSTEM_PROMPT = [
  'You are an animation prompt engineer for Kimodo, a text-to-motion model.',
  'A reference image is provided. First analyse it silently, part by part:',
  '- torso orientation and overall body lean;',
  '- both arms (raised, forward, bent, spread) and hand height;',
  '- both legs (standing, stepped, crouched) and foot placement;',
  '- the direction and phase of the motion the pose implies.',
  'If several poses are visible, treat them as consecutive frames and describe the whole sequence.',
  'Then combine that analysis with the user note (if any) and rewrite it as pure body motion.',
  'Kimodo only renders motions close to the semantic map below; map the observed motion to those archetypes before writing.',
  MOTION_MAP,
  DERIVE_STEPS,
  MOTION_RULES,
  EXAMPLES,
  OUTPUT_SPEC,
].join(' ');

/** 用户手动改过拆解后，按步骤重新生成英文提示词与分段 */
const REFINE_SYSTEM_PROMPT = [
  'You rewrite an edited Chinese body-motion breakdown into Kimodo motion prompts.',
  'The numbered steps are the source of truth: keep their order, directions, force and tempo, and do not add, remove or reorder actions.',
  'The target model renders one human body with no props and no scene: never name objects, describe body mechanics only.',
  'Kimodo only renders motions close to the semantic map below: map each step to the nearest archetype, then instantiate it.',
  'Keep every direction, height and tempo written in the steps; use the map only to choose the closest motion pattern.',
  MOTION_MAP,
  DERIVE_STEPS,
  MOTION_RULES,
  'Write in motion-capture caption style: present tense, "a person ...", one sentence under 45 words for "prompt".',
  'Split the steps into 2 to 4 consecutive English sentences for "segments", one per phase; if there are only one or two steps, 1 or 2 segments are fine.',
  'Return STRICT JSON only, no markdown and no prose: {"prompt":"<one English sentence>","segments":["<consecutive English sentences>"]}',
].join(' ');

export interface EnhancePromptInput {
  /** 用户描述（可为空，只靠图片） */
  prompt?: string;
  /** 参考图片的 data URL，如 data:image/png;base64,... */
  image?: string | null;
}

/** 动作拆解（给用户看的中文提示） */
export interface PromptDecomposition {
  /** 按时间顺序的身体动作链 */
  steps: string[];
  /** 用户描述里的物体名（模型无法模拟接触） */
  objects: string[];
  /** 一句话说明是否做过改写 */
  note: string;
}

export interface EnhancePromptResult {
  prompt: string;
  model: string;
  usedImage: boolean;
  /** 解析成功时给出拆解，失败时为 null */
  decomposition: PromptDecomposition | null;
  /** 2–4 段英文提示词，可交给后端分段生成 */
  segments: string[];
}

export interface RefinePromptInput {
  /** 用户修改后的中文动作链（按顺序） */
  steps: string[];
  /** 原描述里的物体（仅用于提示模型不要写物体） */
  objects?: string[];
  /** 上次转译的说明，帮助模型保持上下文 */
  note?: string;
}

export interface RefinePromptResult {
  prompt: string;
  segments: string[];
  model: string;
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

/** 清理模型偶发的多余包裹（代码块、引号、编号、前缀）；仅用于非 JSON 回退 */
function sanitizePlain(raw: string): string {
  let text = raw.trim();
  text = text.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1').trim();
  text = text.replace(/^(["'`“”‘’]+)|(["'`“”‘’]+)$/g, '').trim();
  text = text.replace(/^(prompt|description|animation|motion)\s*[:：]\s*/i, '').trim();
  text = text.replace(/^\d+[.)]\s*/, '').trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) text = lines[lines.length - 1] ?? text;
  return text.replace(/\s+/g, ' ').trim();
}

/** 内容看起来是（可能被截断的）JSON 时不能当作提示词回退使用 */
function looksLikeJsonPayload(raw: string): boolean {
  const text = raw.trim();
  return /^[[{]/.test(text) || /"prompt"\s*:/.test(text);
}

function toStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, limit);
}

interface ParsedOutput {
  prompt: string;
  steps: string[];
  segments: string[];
  objects: string[];
  note: string;
}

/**
 * 解析模型返回的结构化 JSON。
 *
 * 不同厂商偶尔仍会包代码块或加解释，这里先剥掉 ``` 包裹，再取第一个 `{` 到最后一个 `}`，
 * 解析失败就返回 null，让调用方回退到「整段文字当作提示词」的旧行为。
 */
function parseModelOutput(raw: string): ParsedOutput | null {
  const text = raw.trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const prompt = typeof parsed.prompt === 'string' ? sanitizePlain(parsed.prompt) : '';
  if (!prompt) return null;
  return {
    prompt,
    steps: toStringList(parsed.steps, 6),
    segments: toStringList(parsed.segments, 4),
    objects: toStringList(parsed.objects, 6),
    note: typeof parsed.note === 'string' ? parsed.note.trim() : '',
  };
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
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    // 转译要求忠实于用户意图，温度过高会让「掀桌子」漂移成别的动作
    temperature: config.kimodo.promptTemperature,
    stream: false,
  };
  // 默认不传 max_tokens（0），由接口按模型自身的输出上限处理，避免思考 token 把正文挤掉
  if (maxTokens > 0) body.max_tokens = maxTokens;

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
  let parsed = parseModelOutput(result.content);
  // 推理模型可能把 token 预算花在 reasoning 上，导致 JSON 被截断（finish=length）；
  // 只要没解析出结构化结果就加倍预算重试一次。
  if (!parsed && result.finishReason === 'length') {
    const retryTokens =
      config.kimodo.promptMaxTokens > 0 ? config.kimodo.promptMaxTokens * 2 : 8192;
    log.warn(`提示词模型输出被截断（finish=length），用 ${retryTokens} 重试`);
    result = await complete(model, system, userContent, retryTokens);
    parsed = parseModelOutput(result.content);
  }

  // 模型没按 JSON 返回时，退化成「整段文字就是提示词」；被截断的 JSON 不能当提示词
  const fallback = parsed || looksLikeJsonPayload(result.content) ? '' : sanitizePlain(result.content);
  const prompt = parsed?.prompt ?? fallback;
  if (!prompt) {
    log.warn(`提示词模型没有返回完整结果（${model}，finish=${result.finishReason || 'unknown'}）`);
    throw new Error('提示词模型输出不完整，请重试');
  }

  const decomposition: PromptDecomposition | null =
    parsed && (parsed.steps.length > 0 || parsed.objects.length > 0 || parsed.note)
      ? { steps: parsed.steps, objects: parsed.objects, note: parsed.note }
      : null;

  log.info(
    `提示词转译完成（${config.kimodo.promptProviderLabel} / ${model}${image ? '，含参考图' : ''}）：${prompt.slice(0, 80)}`,
  );
  return {
    prompt,
    model,
    usedImage: image !== null,
    decomposition,
    segments: parsed?.segments ?? [],
  };
}

/**
 * 按用户手动修改后的拆解重新生成英文提示词与分段。
 *
 * 这一步不再重新理解原始意图，只把步骤当作唯一事实来源做「中译英 + 分段」，
 * 避免模型又按自己的理解把动作改回去。
 */
export async function refinePrompt(input: RefinePromptInput): Promise<RefinePromptResult> {
  if (!promptEnhancerReady()) {
    throw new Error(
      '尚未配置提示词模型：请在 .env 设置 KIMODO_PROMPT_PROVIDER 与对应的 API Key（默认 DeepSeek 用 DEEPSEEK_API_KEY）',
    );
  }

  const steps = input.steps
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (steps.length === 0) throw new Error('动作拆解不能为空');

  const objects = (input.objects ?? []).map((item) => item.trim()).filter(Boolean);
  const model = config.kimodo.promptModel;
  const userText = [
    `Objects mentioned by the user (cannot be simulated, never name them): ${objects.length ? objects.join('、') : 'none'}`,
    input.note ? `Previous note: ${input.note}` : '',
    'Motion steps in order:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ]
    .filter(Boolean)
    .join('\n');

  let result = await complete(model, REFINE_SYSTEM_PROMPT, userText, config.kimodo.promptMaxTokens);
  let parsed = parseModelOutput(result.content);
  if (!parsed && result.finishReason === 'length') {
    const retryTokens =
      config.kimodo.promptMaxTokens > 0 ? config.kimodo.promptMaxTokens * 2 : 8192;
    log.warn(`按拆解重新生成被截断（finish=length），用 ${retryTokens} 重试`);
    result = await complete(model, REFINE_SYSTEM_PROMPT, userText, retryTokens);
    parsed = parseModelOutput(result.content);
  }

  const prompt =
    parsed?.prompt ?? (looksLikeJsonPayload(result.content) ? '' : sanitizePlain(result.content));
  if (!prompt) throw new Error('提示词模型输出不完整，请重试');

  log.info(`按拆解重新生成（${model}）：${prompt.slice(0, 80)}`);
  return { prompt, segments: parsed?.segments ?? [], model };
}
