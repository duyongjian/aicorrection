/**
 * Ollama Provider（OpenAI 兼容）
 * 通过 openai SDK 指向 LLM_BASE_URL（如 http://localhost:11434/v1），
 * 切 MiniMax/DeepSeek/OpenAI 仅改环境变量，业务代码零改动。
 */
import OpenAI from 'openai';
import { env } from '../../config/env';
import type { LlmMessage, LlmOptions, LlmProvider, LlmResult } from './provider';

/** 构造参数覆盖项：用于把同一批 LLM 逻辑指向不同端点/模型（识别 vs 分析）。 */
export interface OllamaProviderOptions {
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  apiKey?: string;
  /** 关闭思考链（thinking）：请求体带 chat_template_kwargs.enable_thinking=false。 */
  disableThinking?: boolean;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  private client: OpenAI;
  private textModel: string;
  private visionModel: string;
  private disableThinking: boolean;

  /** 无参调用时行为与改造前完全一致（全部读 env 的 LLM_* / VISION_*，不关 thinking）。 */
  constructor(opts?: OllamaProviderOptions) {
    this.client = new OpenAI({
      baseURL: opts?.baseUrl ?? env.LLM_BASE_URL,
      apiKey: opts?.apiKey ?? env.LLM_API_KEY,
      // 显式超时：必须 ≥ 后端 ATTRIBUTION_MS(900s)，否则 SDK 默认 600s 会在后端闸门之前
      // 自行 abort，把"慢模型"误判成超时 → 后端返回 analyzing 降级态（用户看到"超时/分析失败"）。
      // 由后端 withTimeout 做唯一决策；此处仅兜底，绝不早于后端截断。
      timeout: 900_000,
      // 后端已有自有重试（ANALYSIS_MAX_RETRIES 仅重试非超时错误），关闭 SDK 默认 2 次重试，
      // 避免对慢失败/瞬时错误的请求叠加放大延迟。
      maxRetries: 1,
    });
    this.textModel = opts?.textModel ?? env.LLM_MODEL;
    this.visionModel = opts?.visionModel ?? env.VISION_MODEL;
    this.disableThinking = opts?.disableThinking ?? false;
  }

  /**
   * 关闭 thinking 的扩展请求体（llama.cpp / Ollama 支持的 chat_template_kwargs）。
   * 分析强模型 Qwen3.8-27B 在 8GB 显存下开启 thinking 需 266s，关闭后 161s。
   * 未开启本开关时返回空对象 —— 请求体与改造前完全一致。
   */
  private thinkingParams(): Record<string, unknown> {
    return this.disableThinking
      ? { chat_template_kwargs: { enable_thinking: false } }
      : {};
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.client.models.list();
      // 注意：llama.cpp 单模型服务端返回的 id 未必等于配置的 LLM_MODEL
      //（常为 `-m` 路径或文件名），精确匹配会误判“不可用”→ 静默走 Mock。
      // 故只要端点可达且有模型在服，即视为可用；具体 model 路由交由 chat 兜底。
      return Array.isArray(res.data) && res.data.length > 0;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.client.models.list();
      if (!Array.isArray(res.data)) return [];
      return res.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async chat(
    messages: LlmMessage[],
    opts?: LlmOptions
  ): Promise<LlmResult> {
    const t0 = Date.now();
    const res = await this.client.chat.completions.create({
      model: opts?.model ?? this.textModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts?.temperature ?? 0.3,
      max_tokens: opts?.maxTokens ?? 2048,
      ...this.thinkingParams(),
    });
    const text = extractContent(res.choices?.[0]?.message as RawMsg | undefined);
    return {
      text,
      model: opts?.model ?? this.textModel,
      latencyMs: Date.now() - t0,
    };
  }

  async chatWithImage(
    imageBase64: string,
    prompt: string,
    opts?: LlmOptions
  ): Promise<LlmResult> {
    const t0 = Date.now();
    const res = await this.client.chat.completions.create({
      model: opts?.model ?? this.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: opts?.maxTokens ?? 2048,
      ...this.thinkingParams(),
    });
    const text = extractContent(res.choices?.[0]?.message as RawMsg | undefined);
    return {
      text,
      model: opts?.model ?? this.visionModel,
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * 抽取模型回复文本。
 * 推理类本地模型（如 MiniCPM-V-4.5）会把完整答案放进非标准的 `reasoning_content`，
 * 而标准 `content` 为空 —— 直接读 content 会导致"出方案"拿到空串。
 * 故：content 非空优先；否则回退到 reasoning_content（此时它即解法本身）。
 */
type RawMsg = { content?: string | null; reasoning_content?: string | null };
function extractContent(msg: RawMsg | undefined): string {
  if (!msg) return '';
  const c = typeof msg.content === 'string' ? msg.content : '';
  if (c.trim()) return c;
  const r = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  return r;
}
