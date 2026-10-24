/**
 * Ollama Provider（OpenAI 兼容）
 * 通过 openai SDK 指向 LLM_BASE_URL（如 http://localhost:11434/v1），
 * 切 MiniMax/DeepSeek/OpenAI 仅改环境变量，业务代码零改动。
 */
import OpenAI from 'openai';
import { env } from '../../config/env';
import type { LlmMessage, LlmOptions, LlmProvider, LlmResult } from './provider';

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  private client: OpenAI;
  private textModel: string;
  private visionModel: string;

  constructor() {
    this.client = new OpenAI({
      baseURL: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
    });
    this.textModel = env.LLM_MODEL;
    this.visionModel = env.VISION_MODEL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.client.models.list();
      if (!Array.isArray(res.data) || res.data.length === 0) return false;
      const ids = res.data.map((m) => m.id);
      // 必须包含配置的主文本模型，否则视为不可用 → 触发 Mock 兜底。
      // 避免“Ollama 服务在、但目标模型未拉取”导致归因调用立即报错并落 analyzing。
      return ids.includes(this.textModel);
    } catch {
      return false;
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
      max_tokens: opts?.maxTokens ?? 800,
    });
    const text = res.choices?.[0]?.message?.content ?? '';
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
      max_tokens: opts?.maxTokens ?? 800,
    });
    const text = res.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model: opts?.model ?? this.visionModel,
      latencyMs: Date.now() - t0,
    };
  }
}
