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
import { sanitizeSearchQuery } from './sanitize';
import { parseBing, parseDuckDuckGo, parseSearXNG } from './parsers';
import { retrieveWebSearch } from './webSearchService';
import { env } from '../../config/env';

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
  env.WEB_SEARCH_ENABLED = true;
  env.WEB_SEARCH_PROVIDER = 'engine-html';
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
    globalThis.fetch = realFetch;
  }
});

test('retrieveWebSearch mock fetch 返回 Bing HTML → ok 且条目被解析', async () => {
  const prevEnabled = env.WEB_SEARCH_ENABLED;
  const prevProvider = env.WEB_SEARCH_PROVIDER;
  const prevEngine = env.WEB_SEARCH_ENGINE;
  env.WEB_SEARCH_ENABLED = true;
  env.WEB_SEARCH_PROVIDER = 'engine-html';
  env.WEB_SEARCH_ENGINE = 'bing';
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
    globalThis.fetch = realFetch;
  }
});
