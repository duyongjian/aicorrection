/**
 * 线下分发 MVP：卡密门禁端到端回归（真实 HTTP + 完全隔离的临时库）
 *
 * 覆盖：未激活 401 → 兑换 → 带凭证业务可用 → 原图 cookie 路径 → 停用后 401
 *      → 门禁关闭时零变化。
 *
 * 用法：npm run build:shared && tsx scripts/license-e2e.mjs
 *
 * 数据主权：临时库在系统 temp 下随机目录，绝不读写 apps/api/data/aicorrection.db。
 * 明文卡密只在本次进程内出现，不落盘、不打印完整值。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 环境变量必须在任何业务模块 import 之前设置：env.ts 在模块加载时快照部分配置。
const TMP = mkdtempSync(path.join(tmpdir(), 'aicorrection-license-e2e-'));
process.env.AICORRECTION_DB_PATH = path.join(TMP, 'dist.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.LICENSE_GATE_ENABLED = 'true';
process.env.NODE_ENV = 'test';
// 避免真实模型探活 / 联网：本脚本只验证门禁链路，业务接口只需返回 HTTP 200。
process.env.LLM_PROVIDER = 'mock';
process.env.AUTO_FALLBACK_TO_MOCK = 'true';

const { createApp } = await import('../apps/api/src/app.ts');
const { getDb, __resetDbSingleton } = await import('../apps/api/src/db/index.ts');
const { generateLicenses, revokeLicense } = await import(
  '../apps/api/src/services/licenseService.ts'
);
const { ERROR_CODES } = await import('@aicorrection/shared');

let server;
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(port, method, urlPath, { token, cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-license-token'] = token;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 二进制 / 空响应 */
  }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

try {
  // 触发建库 + 全部迁移（014_license.sql 会被自动应用）
  getDb();
  console.log(`[e2e] 隔离库: ${process.env.AICORRECTION_DB_PATH}`);

  // 造一张原图，用于验证 <img> 场景下的 cookie 凭证路径
  const imgName = 'e2e-probe.txt';
  writeFileSync(path.join(TMP, 'uploads', imgName), 'fake-upload-asset', 'utf8');

  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const BASE = '/api/v1';
  console.log(`[e2e] 服务端口: ${port}\n`);

  // ---- 1. 天然放行路径 ----
  const health = await call(port, 'GET', '/health');
  check('GET /health 无需凭证', health.status === 200, `status=${health.status}`);

  // 单端口分发：静态前端在 base 之外，未激活用户必须能打开激活页所在的 index.html
  const indexRes = await fetch(`http://127.0.0.1:${port}/`);
  const indexHtml = await indexRes.text();
  check(
    '未激活用户仍可打开前端首页（单端口托管）',
    indexRes.status === 200 && /<html/i.test(indexHtml),
    `status=${indexRes.status}`
  );

  const status0 = await call(port, 'GET', `${BASE}/license/status`);
  check(
    'GET /license/status 匿名可访问且始终 200',
    status0.status === 200 && status0.data?.data?.active === false,
    `status=${status0.status} body=${JSON.stringify(status0.data?.data)}`
  );
  check(
    'status 上报 gate_enabled=true（门禁已开启）',
    status0.data?.data?.gate_enabled === true,
    `gate_enabled=${status0.data?.data?.gate_enabled}`
  );
  check(
    '未激活原因标注为 missing',
    status0.data?.data?.reason === 'missing',
    `reason=${status0.data?.data?.reason}`
  );

  // ---- 2. 未激活业务请求一律 401 ----
  const blocked = await call(port, 'POST', `${BASE}/account`, {
    body: { segment: 'kaoyan' },
  });
  check(
    '未激活 POST /account 返回 401 + LICENSE_REQUIRED',
    blocked.status === 401 && blocked.data?.code === ERROR_CODES.LICENSE_REQUIRED,
    `status=${blocked.status} code=${blocked.data?.code}`
  );

  const blockedImg = await call(port, 'GET', `${BASE}/uploads/${imgName}`);
  check(
    '未激活原图不可匿名读取（无 cookie 时 401）',
    blockedImg.status === 401,
    `status=${blockedImg.status}`
  );

  // ---- 3. 无效卡密 ----
  const bad = await call(port, 'POST', `${BASE}/license/redeem`, {
    body: { code: 'AC-IIII-LLLL-OOOO', segment: 'kaoyan' },
  });
  check(
    '非法字符卡密被拒（LICENSE_INVALID）',
    bad.data?.code === ERROR_CODES.LICENSE_INVALID,
    `status=${bad.status} code=${bad.data?.code}`
  );

  // ---- 4. 发卡 → 兑换 ----
  const [card] = generateLicenses({ count: 1, batchId: 'e2e-batch' });
  check('发卡返回展示格式 AC-XXXX-XXXX-XXXX', /^AC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(card.code));

  const redeemed = await call(port, 'POST', `${BASE}/license/redeem`, {
    body: { code: card.code, segment: 'kaoyan' },
  });
  const token = redeemed.data?.data?.license_token;
  const anonUserId = redeemed.data?.data?.anon_user_id;
  check(
    '兑换成功返回 license_token + anon_user_id',
    redeemed.status === 200 && typeof token === 'string' && token.length >= 32 && !!anonUserId,
    `status=${redeemed.status}`
  );
  check(
    '兑换响应下发 HttpOnly 图片 cookie',
    !!redeemed.setCookie && /HttpOnly/i.test(redeemed.setCookie) && /aicorrection_license=/.test(redeemed.setCookie),
    `set-cookie=${redeemed.setCookie}`
  );
  check(
    '图片 cookie 的 path 收窄到 uploads',
    !!redeemed.setCookie && /Path=\/api\/v1\/uploads/i.test(redeemed.setCookie),
    `set-cookie=${redeemed.setCookie}`
  );

  // ---- 5. 带凭证业务可用 ----
  const okBusiness = await call(port, 'POST', `${BASE}/account`, {
    token,
    body: { segment: 'kaoyan' },
  });
  check(
    '带凭证 POST /account 放行',
    okBusiness.status === 200 && okBusiness.data?.code === 0,
    `status=${okBusiness.status} code=${okBusiness.data?.code}`
  );

  const okStatus = await call(port, 'GET', `${BASE}/license/status`, { token });
  check(
    '带凭证 status 为 active 且 identity 一致',
    okStatus.data?.data?.active === true && okStatus.data?.data?.anon_user_id === anonUserId,
    JSON.stringify(okStatus.data?.data)
  );

  // 浏览器 <img> 场景：只有 cookie，没有任何自定义 header
  const cookieOnly = redeemed.setCookie?.split(';')[0] ?? '';
  const okImg = await fetch(`http://127.0.0.1:${port}${BASE}/uploads/${imgName}`, {
    headers: { Cookie: cookieOnly },
  });
  check('仅凭 cookie 可读取原图（img 场景不白图）', okImg.status === 200, `status=${okImg.status}`);

  // cookie 不能当业务接口凭证（防 CSRF 扩散）
  const cookieAsApi = await call(port, 'POST', `${BASE}/account`, {
    cookie: cookieOnly,
    body: { segment: 'kaoyan' },
  });
  check(
    'cookie 在业务接口不被接受（仍 401）',
    cookieAsApi.status === 401,
    `status=${cookieAsApi.status}`
  );

  // ---- 6. 重复兑换 ----
  const dup = await call(port, 'POST', `${BASE}/license/redeem`, {
    body: { code: card.code, segment: 'kaoyan' },
  });
  check(
    '同一卡密重复兑换被拒（LICENSE_ALREADY_USED）',
    dup.data?.code === ERROR_CODES.LICENSE_ALREADY_USED,
    `status=${dup.status} code=${dup.data?.code}`
  );

  // ---- 7. 停用后立即失效 ----
  const revoked = revokeLicense(card.code);
  check('停用卡密成功', revoked.ok === true, revoked.message);

  const afterRevoke = await call(port, 'POST', `${BASE}/account`, {
    token,
    body: { segment: 'kaoyan' },
  });
  check(
    '停用后带原 token 返回 401 + LICENSE_REVOKED',
    afterRevoke.status === 401 && afterRevoke.data?.code === ERROR_CODES.LICENSE_REVOKED,
    `status=${afterRevoke.status} code=${afterRevoke.data?.code}`
  );

  const revokedStatus = await call(port, 'GET', `${BASE}/license/status`, { token });
  check(
    '停用后 status 为 active=false / reason=revoked',
    revokedStatus.status === 200 &&
      revokedStatus.data?.data?.active === false &&
      revokedStatus.data?.data?.reason === 'revoked',
    JSON.stringify(revokedStatus.data?.data)
  );

  // ---- 8. 门禁关闭时零变化（开发态） ----
  delete process.env.LICENSE_GATE_ENABLED;
  const noGate = await call(port, 'POST', `${BASE}/account`, {
    body: { segment: 'gaozhong' },
  });
  check(
    '门禁关闭后无凭证业务请求放行',
    noGate.status === 200,
    `status=${noGate.status}`
  );
  const statusNoGate = await call(port, 'GET', `${BASE}/license/status`);
  check(
    '门禁关闭时 status 为 active=true / gate_enabled=false（前端不会锁死）',
    statusNoGate.data?.data?.active === true && statusNoGate.data?.data?.gate_enabled === false,
    JSON.stringify(statusNoGate.data?.data)
  );
} catch (e) {
  failed += 1;
  failures.push(`脚本异常: ${e?.stack ?? e}`);
  console.error('[e2e] 异常:', e);
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  __resetDbSingleton();
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log('\n[e2e] 临时库已清理');
  } catch (e) {
    console.log(`\n[e2e] 临时目录清理失败（可手动删除）: ${TMP} — ${e?.message}`);
  }
}

console.log(`\n[e2e] 结果: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('[e2e] 失败明细:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
