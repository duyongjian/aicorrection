/**
 * LlmProvider 工厂（§7.5）
 * 启动时根据 env + 探活选型；AUTO_FALLBACK_TO_MOCK=true 时 Ollama 不可达自动降级 Mock。
 *
 * 「识别 / 视觉」与「分析 / 归因」在 provider 层已分家：
 *  - getProvider() / getRecognitionProvider()：走 LLM_* + VISION_*，服务题目识别与 OCR。
 *  - getAnalysisProvider()：走 ANALYSIS_*（未配置时回落 LLM_*），服务归因与追问。
 * 关键点：ANALYSIS_* 全部未配置时，两段指向同一端点同一模型，行为与分家前完全一致。
 */
import { env } from '../../config/env';
import { OllamaProvider } from './ollamaProvider';
import { MockProvider } from './mockProvider';
import type { LlmProvider } from './provider';

let provider: LlmProvider | null = null;
let analysisProvider: LlmProvider | null = null;

/**
 * 构造识别端 provider。
 * 无覆盖参数调用 → 等价于改造前的 `new OllamaProvider()`（只读 env 的 LLM_* / VISION_*）。
 */
function createRecognition(): LlmProvider {
  return env.LLM_PROVIDER === 'mock' ? new MockProvider() : new OllamaProvider();
}

/** 构造分析端 provider（ANALYSIS_*；未配置时回落 LLM_*，与识别端等价）。 */
function createAnalysis(): LlmProvider {
  return env.LLM_PROVIDER === 'mock'
    ? new MockProvider()
    : new OllamaProvider({
        baseUrl: env.ANALYSIS_BASE_URL,
        textModel: env.ANALYSIS_MODEL,
        apiKey: env.ANALYSIS_API_KEY,
      });
}

/** AUTO_FALLBACK_TO_MOCK=true 时探活，不可达则降级 Mock；关闭时原样返回真实 provider。 */
async function resolveWithFallback(p: LlmProvider): Promise<LlmProvider> {
  if (!env.AUTO_FALLBACK_TO_MOCK) return p;
  const available = await p.isAvailable().catch(() => false);
  return available ? p : new MockProvider();
}

export async function initProvider(): Promise<LlmProvider> {
  if (!provider) {
    // mock 模式直接返回 Mock，不做探活（与改造前语义一致）
    provider =
      env.LLM_PROVIDER === 'mock'
        ? new MockProvider()
        : await resolveWithFallback(new OllamaProvider());
  }
  // 分析端随启动一并初始化；AUTO_FALLBACK_TO_MOCK 打开时同样按可达性降级。
  if (!analysisProvider) {
    analysisProvider =
      env.LLM_PROVIDER === 'mock'
        ? new MockProvider()
        : await resolveWithFallback(createAnalysis());
  }
  return provider;
}

export function getProvider(): LlmProvider {
  if (!provider) {
    throw new Error('LLM provider 尚未初始化，请在启动时调用 initProvider()');
  }
  return provider;
}

/** 识别端 provider（getProvider 的语义别名）：题目识别 / OCR 走这段，行为完全不变。 */
export function getRecognitionProvider(): LlmProvider {
  return getProvider();
}

/**
 * 分析端 provider：归因 / 追问走这段。
 * 未配置 ANALYSIS_* 时与识别端同端点同模型；配置了则指向独立的本地强模型。
 */
export function getAnalysisProvider(): LlmProvider {
  if (!analysisProvider) {
    // lazy 兜底：未走 initProvider 时按需创建
    //（默认 AUTO_FALLBACK_TO_MOCK=false，此处与启动初始化结果等价）
    analysisProvider = createAnalysis();
  }
  return analysisProvider;
}

export type { LlmProvider, LlmMessage, LlmOptions, LlmResult } from './provider';
