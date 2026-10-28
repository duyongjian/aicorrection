/**
 * LlmProvider 统一抽象接口（§7.5）
 * 屏蔽 Ollama / OpenAI 兼容端点 / Mock 差异，业务侧零感知。
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmResult {
  text: string;
  model: string;
  latencyMs: number;
}

export interface LlmProvider {
  /** 提供方名称：ollama | mock | openai */
  readonly name: string;
  /** 文本对话（归因 / 追问主路径） */
  chat(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmResult>;
  /** 多模态对话（OCR 视觉模型） */
  chatWithImage(
    imageBase64: string,
    prompt: string,
    opts?: LlmOptions
  ): Promise<LlmResult>;
  /** 探活：返回该提供方当前是否可达 */
  isAvailable(): Promise<boolean>;
  /** 列出端点当前服务的模型 id（用于接线校验 / 状态接口） */
  listModels(): Promise<string[]>;
}
