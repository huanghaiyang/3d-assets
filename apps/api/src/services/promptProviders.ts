/**
 * 提示词转译大模型预设。
 *
 * 所有厂商统一走 OpenAI 兼容的 POST {baseUrl}/chat/completions，
 * 所以切换厂商只需要改 KIMODO_PROMPT_PROVIDER 并配置对应厂商的 API Key。
 * 具体 Key / 接口域名 / 模型都可以再用 KIMODO_PROMPT_* 变量单独覆盖。
 */

export interface PromptProviderPreset {
  id: string;
  /** 界面上展示的厂商名 */
  label: string;
  /** OpenAI 兼容接口根地址（不含 /chat/completions） */
  baseUrl: string;
  /** 纯文字转译的默认模型 */
  model: string;
  /** 带参考图时优先使用的视觉模型（为空表示与 model 相同） */
  visionModel: string;
  /** .env 里该厂商 API Key 的变量名 */
  envKey: string;
  /** .env 里该厂商接口域名的变量名 */
  envBaseUrl: string;
}

export const PROMPT_PROVIDERS: Record<string, PromptProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    visionModel: 'deepseek-flash',
    envKey: 'DEEPSEEK_API_KEY',
    envBaseUrl: 'DEEPSEEK_BASE_URL',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    envBaseUrl: 'OPENAI_BASE_URL',
  },
  qwen: {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    visionModel: 'qwen-vl-plus',
    envKey: 'DASHSCOPE_API_KEY',
    envBaseUrl: 'DASHSCOPE_BASE_URL',
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    visionModel: 'moonshot-v1-8k-vision-preview',
    envKey: 'MOONSHOT_API_KEY',
    envBaseUrl: 'MOONSHOT_BASE_URL',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    visionModel: 'glm-4v-flash',
    envKey: 'ZHIPU_API_KEY',
    envBaseUrl: 'ZHIPU_BASE_URL',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    visionModel: 'gemini-2.0-flash',
    envKey: 'GEMINI_API_KEY',
    envBaseUrl: 'GEMINI_BASE_URL',
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    visionModel: '',
    envKey: 'KIMODO_PROMPT_API_KEY',
    envBaseUrl: 'KIMODO_PROMPT_BASE_URL',
  },
};

/** 未知 id 回落到 custom（由 KIMODO_PROMPT_* 完全接管） */
export function promptProviderPreset(raw: string | null | undefined): PromptProviderPreset {
  const id = (raw ?? '').trim().toLowerCase();
  return PROMPT_PROVIDERS[id] ?? PROMPT_PROVIDERS.custom;
}
