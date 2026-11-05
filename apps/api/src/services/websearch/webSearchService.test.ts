/**
 * 联网搜索单元测试（node:test）
 *
 * 覆盖：
 *  1) sanitizeSearchQuery：剔除作答 / 手机号 / 邮箱，截断长度。
 *  2) parseBing / parseDuckDuckGo / parseSearXNG：喂样本提取条目。
 *  3) retrieveWebSearch：关闭→empty；脱敏后为空→empty；fetch 抛错→unavailable（不抛错）；
 *     mock fetch 返回 Bing HTML→ok 且条目被解析。
 *
 * 运行：tsx --test src/services/websearch/webSearchService.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeSearchQuery } from './sanitize';
import { parseBing, parseDuckDuckGo, parseSearXNG } from './parsers';
import { retrieveWebSearch } from './webSearchService';
import { env } from '../../config/env';

const here = path.dirname(fileURLToPath(import.meta.url));
const envTsPath = path.resolve(here, '../../config/env.ts');

const BING_HTML = `
<li class="b_algo"><h2><a href="https://example.com/implicit">隐函数求导 链式法则</a></h2><p>对方程两边求导，注意 y 是 x 的函数，乘 y'。</p></li>
<li class="b_algo"><h2><a href="https://example.com/chain">复合函数求导</a></h2><p>外层导数乘内层导数。</p></li>
`;

const DDG_HTML = `
<a class="result__a" href="https://ddg.example/implicit">隐函数微分法</a>
<a class="result__snippet">把 y 视为 x 的函数求导。</a>
<a class="result__a" href="https://ddg.example/part">分词作状语</a>
<a class="result__snippet">判断主谓语态。</a>
`;

test('sanitizeSearchQuery 剔除作答/PII 并截断', () => {
  const q1 = sanitizeSearchQuery('求隐函数导数 dy/dx', '我算成了 2x', 'math');
  assert.ok(q1.includes('math'));
  assert.ok(q1.includes('隐函数导数'));
  assert.ok(!q1.includes('我算成了')); // 作答不出现

  const q2 = sanitizeSearchQuery('联系我 13800138000 或 a@b.com 讲题', undefined, 'english');
  assert.ok(!/\d{11}/.test(q2), '手机号应被剔除');
  assert.ok(!/a@b\.com/.test(q2), '邮箱应被剔除');

  const longQ = 'x'.repeat(200);
  assert.ok(sanitizeSearchQuery(longQ).length <= 80, '超长应截断');
});

test('sanitizeSearchQuery 优先用知识点作检索词（P2 增强）', () => {
  const q = sanitizeSearchQuery(
    'Find dy/dx if x^2 + y^2 = 25',
    'I got x/y but unsure',
    'math',
    '隐函数求导（链式法则）'
  );
  assert.ok(q.includes('隐函数求导'), '应优先用知识点作检索词');
  assert.ok(!q.includes('Find dy/dx'), '原始题干不应出现在检索词中');
  assert.ok(q.includes('math'), '学科前缀保留');
  assert.ok(!q.includes('I got x/y'), '学生作答绝不出现');
});

test('parseBing 抽取标题/链接/摘要', () => {
  const r = parseBing(BING_HTML);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://example.com/implicit');
  assert.ok(r[0].title.includes('隐函数求导'));
  assert.ok(r[0].snippet.includes('y 是 x 的函数'));
});

test('parseDuckDuckGo 抽取标题/链接/摘要', () => {
  const r = parseDuckDuckGo(DDG_HTML);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://ddg.example/implicit');
  assert.ok(r[0].snippet.includes('y 视为 x 的函数'));
});

test('parseSearXNG 解析 JSON', () => {
  const json = {
    results: [
      { title: '隐函数', url: 'https://sx.example/1', content: '两边求导' },
      { title: '坏链接', url: 'javascript:alert(1)', content: 'x' },
    ],
  };
  const r = parseSearXNG(json);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://sx.example/1');
});

test('retrieveWebSearch 关闭时返回 empty（不触达网络）', async () => {
  const prev = env.WEB_SEARCH_ENABLED;
  env.WEB_SEARCH_ENABLED = false;
  try {
    const r = await retrieveWebSearch('求隐函数导数', { subject: 'math' });
    assert.equal(r.status, 'empty');
    assert.deepEqual(r.items, []);
  } finally {
    env.WEB_SEARCH_ENABLED = prev;
  }
});

test('retrieveWebSearch 脱敏后为空返回 empty', async () => {
  const prev = env.WEB_SEARCH_ENABLED;
  env.WEB_SEARCH_ENABLED = true;
  try {
    // 空题干且无学科 → 脱敏后为空 → 提前返回 empty（不触达网络）
    const r = await retrieveWebSearch('');
    assert.equal(r.status, 'empty');
  } finally {
    env.WEB_SEARCH_ENABLED = prev;
  }
});

test('retrieveWebSearch fetch 抛错返回 unavailable（不抛错）', async () => {
  const prevEnabled = env.WEB_SEARCH_ENABLED;
  const prevProvider = env.WEB_SEARCH_PROVIDER;
  const prevAudit = env.WEB_SEARCH_AUDIT;
  env.WEB_SEARCH_ENABLED = true;
  env.WEB_SEARCH_PROVIDER = 'engine-html';
  env.WEB_SEARCH_AUDIT = false; // 单测不写本地审计日志，保持审计证据链干净
  const realFetch = globalThis.fetch;
  // 强制 fetch 失败
  (globalThis as unknown as { fetch: unknown }).fetch = () =>
    Promise.reject(new Error('network down'));
  try {
    const r = await retrieveWebSearch('求隐函数导数', { subject: 'math' });
    assert.equal(r.status, 'unavailable');
    assert.deepEqual(r.items, []);
  } finally {
    env.WEB_SEARCH_ENABLED = prevEnabled;
    env.WEB_SEARCH_PROVIDER = prevProvider;
    env.WEB_SEARCH_AUDIT = prevAudit;
    globalThis.fetch = realFetch;
  }
});

test('retrieveWebSearch mock fetch 返回 Bing HTML → ok 且条目被解析', async () => {
  const prevEnabled = env.WEB_SEARCH_ENABLED;
  const prevProvider = env.WEB_SEARCH_PROVIDER;
  const prevEngine = env.WEB_SEARCH_ENGINE;
  const prevAudit = env.WEB_SEARCH_AUDIT;
  env.WEB_SEARCH_ENABLED = true;
  env.WEB_SEARCH_PROVIDER = 'engine-html';
  env.WEB_SEARCH_ENGINE = 'bing';
  env.WEB_SEARCH_AUDIT = false; // 单测不写本地审计日志，保持审计证据链干净
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(BING_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
  try {
    const r = await retrieveWebSearch('求隐函数导数 dy/dx', { subject: 'math' });
    assert.equal(r.status, 'ok');
    assert.ok(r.items.length >= 1);
    assert.equal(r.items[0].url, 'https://example.com/implicit');
  } finally {
    env.WEB_SEARCH_ENABLED = prevEnabled;
    env.WEB_SEARCH_PROVIDER = prevProvider;
    env.WEB_SEARCH_ENGINE = prevEngine;
    env.WEB_SEARCH_AUDIT = prevAudit;
    globalThis.fetch = realFetch;
  }
});

// ===== P0 数据主权铁律防回归（2026-11-05）=====
// 背景：WEB_SEARCH_ENABLED 曾默认 true，题干被发往第三方搜索引擎（审计日志 79 条实证）。
// 以下三条锁死护栏：默认值文本 / 关闭时零对外请求 / 显式开启时作答不外发。

test('P0-A env.ts 的 WEB_SEARCH_ENABLED 默认值必须为 false', () => {
  const src = fs.readFileSync(envTsPath, 'utf-8');
  assert.match(
    src,
    /WEB_SEARCH_ENABLED:\s*toBool\(process\.env\.WEB_SEARCH_ENABLED,\s*false\)/,
    '默认值改回 true 会静默把用户题干外发到第三方搜索引擎；如需开启必须由数据主体显式逐次确认，并同步本测试'
  );
});

test('P0-B 关闭状态下 retrieveWebSearch 零对外 fetch（比 status=empty 更强）', async () => {
  const prevEnabled = env.WEB_SEARCH_ENABLED;
  const prevAudit = env.WEB_SEARCH_AUDIT;
  env.WEB_SEARCH_ENABLED = false;
  env.WEB_SEARCH_AUDIT = false;
  const realFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    calls += 1;
    return new Response(BING_HTML, { status: 200 });
  };
  try {
    const r = await retrieveWebSearch('已知函数 f(x)=x^3-3x，求单调区间。', {
      subject: 'math',
      userAnswer: '我的私人作答-绝不可外发',
    });
    assert.equal(calls, 0, '关闭状态下不得发出任何对外 fetch');
    assert.equal(r.status, 'empty');
    assert.deepEqual(r.items, []);
  } finally {
    env.WEB_SEARCH_ENABLED = prevEnabled;
    env.WEB_SEARCH_AUDIT = prevAudit;
    globalThis.fetch = realFetch;
  }
});

test('P0-C 显式开启时学生作答绝不进入外发检索词', async () => {
  const prevEnabled = env.WEB_SEARCH_ENABLED;
  const prevAudit = env.WEB_SEARCH_AUDIT;
  env.WEB_SEARCH_ENABLED = true;
  env.WEB_SEARCH_AUDIT = false;
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  const secret = '我的私人作答SECRET-99123';
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
    urls.push(String(url));
    return new Response(BING_HTML, { status: 200 });
  };
  try {
    await retrieveWebSearch('已知函数 f(x)=x^3-3x，求单调区间。', {
      subject: 'math',
      userAnswer: secret,
      knowledgePoint: '导数与单调性判定',
    });
    assert.ok(urls.length > 0, '显式开启后应发起检索');
    for (const u of urls) {
      assert.ok(!u.includes(secret), '外发 URL 不得含学生作答明文');
      assert.ok(!u.includes(encodeURIComponent(secret)), '外发 URL 不得含学生作答编码');
    }
  } finally {
    env.WEB_SEARCH_ENABLED = prevEnabled;
    env.WEB_SEARCH_AUDIT = prevAudit;
    globalThis.fetch = realFetch;
  }
});
