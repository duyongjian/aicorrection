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
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  private client: OpenAI;
  private textModel: string;
  private visionModel: string;

  /** 无参调用时行为与改造前完全一致（全部读 env 的 LLM_* / VISION_*）。 */
  constructor(opts?: OllamaProviderOptions) {
    this.client = new OpenAI({
      baseURL: opts?.baseUrl ?? env.LLM_BASE_URL,
      apiKey: opts?.apiKey ?? env.LLM_API_KEY,
    });
    this.textModel = opts?.textModel ?? env.LLM_MODEL;
    this.visionModel = opts?.visionModel ?? env.VISION_MODEL;
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
