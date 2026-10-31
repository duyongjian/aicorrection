/**
 * 搜索引擎结果解析（P2）
 *
 * 把抓取到的 HTML / JSON 解析为统一的 { title, url, snippet } 列表。
 * 解析器写成纯函数，便于单测（喂入样本 HTML，断言抽出的条目），避免对线上格式盲目信任。
 *
 * 引擎 URL 范式提取自本机 WorkBuddy 技能 `multi-search-engine`（无需 API key 的搜索页）。
 * 解析对页面结构变化有一定容忍度；任一引擎解析失败不影响其他引擎 / 主流程。
 */

export interface WebSearchRaw {
  title: string;
  url: string;
  snippet: string;
}

/** 反转义常见 HTML 实体。 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** 去除 HTML 标签并压缩空白。 */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 解析 Bing 搜索页（cn.bing.com）。结果块为 <li class="b_algo">。
 * 标题取块内 <h2> 中的 <a href> 文本；摘要取块内首个 <p>。
 */
export function parseBing(html: string): WebSearchRaw[] {
  const out: WebSearchRaw[] = [];
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const hrefM = /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!hrefM) continue;
    const url = decodeEntities(hrefM[1]);
    const title = stripTags(hrefM[2]);
    const pM = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = pM ? stripTags(pM[1]) : '';
    if (title && url.startsWith('http')) out.push({ title, url, snippet });
  }
  return out;
}

/**
 * 解析 DuckDuckGo HTML 版（duckduckgo.com/html）。结果链接带 class="result__a"，
 * 摘要带 class="result__snippet"。
 */
export function parseDuckDuckGo(html: string): WebSearchRaw[] {
  const out: WebSearchRaw[] = [];
  const re =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1]);
    const title = stripTags(m[2]);
    // 取该链接之后的摘要（最近的 result__snippet）
    const after = html.slice(m.index + m[0].length);
    const snipM = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(after);
    const snippet = snipM ? stripTags(snipM[1]) : '';
    if (title && url.startsWith('http')) out.push({ title, url, snippet });
  }
  return out;
}

/** 解析 SearXNG JSON 输出（需实例开启 json 格式）。 */
export function parseSearXNG(json: unknown): WebSearchRaw[] {
  const obj = json as { results?: Array<{ title?: string; url?: string; content?: string }> };
  if (!obj || !Array.isArray(obj.results)) return [];
  return obj.results
    .filter((r) => r.url && r.url.startsWith('http'))
    .map((r) => ({
      title: stripTags(r.title ?? ''),
      url: r.url as string,
      snippet: stripTags(r.content ?? ''),
    }));
}
