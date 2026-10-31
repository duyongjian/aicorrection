/**
 * 联网搜索服务（P2）
 *
 * 职责：把"脱敏后的题干主题词"发到搜索引擎 → 解析 top-k → 组装 AttributionWebSearch。
 * 数据主权铁律硬约束（详见 README / 设计文档）：
 *  - 默认 WEB_SEARCH_ENABLED=false：绝不外发任何内容到第三方。
 *  - 开启后只外发 sanitize 后的最小主题词（学科 + 知识点），绝不外发学生作答 / 姓名 / PII。
 *  - 任一异常（网络/解析/超时）一律返回 status='unavailable' 且 items=[]，绝不抛错、绝不虚构；
 *    归因流程会照常继续，搜索块只是可选 grounding。
 *  - 审计日志仅落本地（audit.ts），不离开本机。
 *
 * 引擎 URL 与"无需 API key"的搜索页范式提取自本机 WorkBuddy 技能 `multi-search-engine`。
 */
import { env } from '../../config/env';
import { sanitizeSearchQuery } from './sanitize';
import { logWebSearchAudit } from './audit';
import { parseBing, parseDuckDuckGo, parseSearXNG, type WebSearchRaw } from './parsers';
import type { AttributionWebSearch, AttributionWebSearchItem } from '@aicorrection/shared';

/** 无需 API key 的搜索页（与 multi-search-engine 技能对齐；{q} 占位符）。 */
const ENGINE_URL: Record<string, string> = {
  bing: 'https://cn.bing.com/search?q={q}',
  duckduckgo: 'https://duckduckgo.com/html/?q={q}',
  baidu: 'https://www.baidu.com/s?wd={q}',
  google: 'https://www.google.com/search?q={q}',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface RetrieveWebSearchOptions {
  /** 学科过滤 / 透传给脱敏 */
  subject?: string;
  /** 学生作答（刻意不用于外发，仅占位以明确语义） */
  userAnswer?: string;
  maxResults?: number;
  timeoutMs?: number;
}

/** 带超时的 fetch（AbortController 中断挂起的请求，避免拖垮归因）。 */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 抓取并解析"无需 key"的搜索页 HTML（Bing / DuckDuckGo 为主；百度/谷歌按 Bing 块解析做 best-effort）。 */
async function searchEngineHtml(
  engine: string,
  query: string,
  timeoutMs: number
): Promise<WebSearchRaw[]> {
  const tpl = ENGINE_URL[engine] ?? ENGINE_URL.bing;
  const url = tpl.replace('{q}', encodeURIComponent(query));
  const resp = await fetchWithTimeout(url, timeoutMs);
  if (!resp.ok) throw new Error(`engine ${engine} http ${resp.status}`);
  const html = await resp.text();
  if (engine === 'duckduckgo') return parseDuckDuckGo(html);
  return parseBing(html); // bing 块结构；baidu/google 近似容错
}

/** 抓取并解析 SearXNG 实例的 JSON 输出（需实例开启 json 格式）。 */
async function searchSearXNG(
  baseUrl: string,
  query: string,
  timeoutMs: number
): Promise<WebSearchRaw[]> {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${sep}q=${encodeURIComponent(query)}&format=json`;
  const resp = await fetchWithTimeout(url, timeoutMs);
  if (!resp.ok) throw new Error(`searxng http ${resp.status}`);
  return parseSearXNG(await resp.json());
}

/**
 * 检索与"题干"相关的网络参考。返回 AttributionWebSearch（ok/empty/unavailable）。本函数自身不抛错。
 */
export async function retrieveWebSearch(
  question: string,
  opts: RetrieveWebSearchOptions = {}
): Promise<AttributionWebSearch> {
  // 关闭开关：直接空（不触达网络），归因流程零影响。
  if (!env.WEB_SEARCH_ENABLED) {
    return { status: 'empty', source: 'web', items: [] };
  }

  // 脱敏：只发学科 + 知识点主题词；外发内容绝不含学生作答 / PII。
  const query = sanitizeSearchQuery(question, opts.userAnswer, opts.subject);
  if (!query) return { status: 'empty', source: 'web', items: [] };

  const maxResults = opts.maxResults ?? env.WEB_SEARCH_MAX_RESULTS;
  const timeoutMs = opts.timeoutMs ?? env.WEB_SEARCH_TIMEOUT_MS;
  const t0 = Date.now();

  try {
    let raw: WebSearchRaw[];
    if (env.WEB_SEARCH_PROVIDER === 'searxng') {
      if (!env.WEB_SEARCH_SEARXNG_URL) throw new Error('searxng 实例地址未配置');
      raw = await searchSearXNG(env.WEB_SEARCH_SEARXNG_URL, query, timeoutMs);
    } else {
      raw = await searchEngineHtml(env.WEB_SEARCH_ENGINE, query, timeoutMs);
    }

    const items: AttributionWebSearchItem[] = raw
      .slice(0, maxResults)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet.slice(0, 200),
        score: 1,
      }));

    logWebSearchAudit({
      ts: new Date().toISOString(),
      query,
      provider: env.WEB_SEARCH_PROVIDER,
      engine: env.WEB_SEARCH_ENGINE,
      result_count: items.length,
      duration_ms: Date.now() - t0,
    });

    return {
      status: items.length > 0 ? 'ok' : 'empty',
      source: 'web',
      items,
    };
  } catch {
    // 失败绝不抛错 / 绝不虚构：仅跳过网络参考块，归因照常进行。
    logWebSearchAudit({
      ts: new Date().toISOString(),
      query,
      provider: env.WEB_SEARCH_PROVIDER,
      engine: env.WEB_SEARCH_ENGINE,
      error: true,
      duration_ms: Date.now() - t0,
    });
    return { status: 'unavailable', source: 'web', items: [] };
  }
}
