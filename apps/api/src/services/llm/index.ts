/**
 * LlmProvider 工厂（§7.5）
 * 启动时根据 env + 探活选型；AUTO_FALLBACK_TO_MOCK=true 时 Ollama 不可达自动降级 Mock。
 */
import { env } from '../../config/env';
import { OllamaProvider } from './ollamaProvider';
import { MockProvider } from './mockProvider';
import type { LlmProvider } from './provider';

let provider: LlmProvider | null = null;

export async function initProvider(): Promise<LlmProvider> {
  if (provider) return provider;
  if (env.LLM_PROVIDER === 'mock') {
    provider = new MockProvider();
    return provider;
  }
  const ollama = new OllamaProvider();
  if (env.AUTO_FALLBACK_TO_MOCK) {
    const available = await ollama.isAvailable().catch(() => false);
    provider = available ? ollama : new MockProvider();
  } else {
    provider = ollama;
  }
  return provider;
}

export function getProvider(): LlmProvider {
  if (!provider) {
    throw new Error('LLM provider 尚未初始化，请在启动时调用 initProvider()');
  }
  return provider;
}

export type { LlmProvider, LlmMessage, LlmOptions, LlmResult } from './provider';
