/**
 * 可选同源代理（Netlify Functions）。
 *
 * ⚠️ 仅在你不想配 CORS、希望 PWA 走 /api/v1 同源路径时使用。
 * 在 Netlify 控制台设置环境变量 BACKEND_ORIGIN（如 https://aicorrection.hf.space），
 * 并在 netlify.toml 取消 [[redirects]] 注释把 /api/v1/* 转发到本函数。
 *
 * 重要限制：Netlify Functions 免费档超时仅 10s。归因（尤其本地/慢模型）常 >10s，
 * 会在此处被判超时。最佳实践是用 VITE_API_ORIGIN 让 PWA 直连后端（CORS），绕开此限制。
 *
 * 本函数逻辑：把 /api/v1/* 透明转发到 BACKEND_ORIGIN/api/v1/*，
 * 原样透传 method / headers / query / body（含 multipart 二进制），
 * 回传后端状态码、响应头与响应体（二进制按 base64 回传）。
 */

interface NetlifyEvent {
  path: string;
  httpMethod: string;
  headers: Record<string, string>;
  queryStringParameters: Record<string, string> | null;
  body: string | null;
  isBase64Encoded: boolean;
}

interface NetlifyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

const SKIP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection']);
const SKIP_RESPONSE_HEADERS = new Set([
  'content-length',
  'connection',
  'transfer-encoding',
]);

function buildTarget(event: NetlifyEvent, backend: string): string {
  // 经由 redirect 转发后，event.path 形如 /.netlify/functions/api/<splat>
  const p = (event.path || '').replace(/^\/.netlify\/functions\/api\/?/, '');
  const targetPath = `/api/v1/${p}`.replace(/\/{2,}/g, '/');
  const qs = event.queryStringParameters
    ? new URLSearchParams(event.queryStringParameters).toString()
    : '';
  return `${backend.replace(/\/$/, '')}${targetPath}${qs ? `?${qs}` : ''}`;
}

export const handler = async (event: NetlifyEvent): Promise<NetlifyResponse> => {
  const backend = process.env.BACKEND_ORIGIN;
  if (!backend) {
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error:
          'BACKEND_ORIGIN 未配置：请在 Netlify 环境变量中设置后端地址（HF Spaces / Railway），或改用 VITE_API_ORIGIN 直连后端。',
      }),
    };
  }

  const url = buildTarget(event, backend);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    if (SKIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    if (v != null) headers[k] = v;
  }

  let body: BodyInit | undefined;
  if (event.body) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body;
  }

  try {
    const resp = await fetch(url, {
      method: event.httpMethod,
      headers,
      body: event.httpMethod === 'GET' || event.httpMethod === 'HEAD' ? undefined : body,
    });

    const buf = Buffer.from(await resp.arrayBuffer());
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      if (SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) return;
      respHeaders[k] = v;
    });

    const ct = respHeaders['content-type'] || '';
    const isText =
      ct.includes('application/json') ||
      ct.includes('text/') ||
      ct.includes('xml');
    return {
      statusCode: resp.status,
      headers: respHeaders,
      body: isText ? buf.toString('utf8') : buf.toString('base64'),
      isBase64Encoded: !isText,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: `代理后端失败：${(e as Error).message}`,
      }),
    };
  }
};
