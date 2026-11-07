/**
 * 真实账号体系端到端回归（真实 HTTP + 完全隔离的临时库）
 *
 * 覆盖：门禁拒绝无凭证 → 邮箱密码注册/登录 → 业务可用 → 短信 dev 流程
 *      → 魔法链接 dev 流程 → 卡密身份迁移（link_anon_user_id）→ 公开端点放行。
 *
 * 用法：npm run build:shared && tsx scripts/auth-e2e.mjs
 *
 * 数据主权：临时库在系统 temp 下随机目录，绝不读写 apps/api/data/aicorrection.db。
 * 明文 token / 验证码只在本次进程内出现，不落盘、不打印完整值。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'aicorrection-auth-e2e-'));
process.env.AICORRECTION_DB_PATH = path.join(TMP, 'dist.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.LICENSE_GATE_ENABLED = 'true';
process.env.NODE_ENV = 'test';
process.env.LLM_PROVIDER = 'mock';
process.env.AUTO_FALLBACK_TO_MOCK = 'true';

const { createApp } = await import('../apps/api/src/app.ts');
const { getDb, __resetDbSingleton } = await import('../apps/api/src/db/index.ts');
const { generateLicenses } = await import('../apps/api/src/services/licenseService.ts');
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
  if (token) headers['x-auth-token'] = token;
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

const BASE = '/api/v1';

try {
  getDb();
  console.log(`[e2e] 隔离库: ${process.env.AICORRECTION_DB_PATH}`);

  const imgName = 'auth-probe.txt';
  writeFileSync(path.join(TMP, 'uploads', imgName), 'fake-upload-asset', 'utf8');

  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  console.log(`[e2e] 服务端口: ${port}\n`);

  // ---- 1. 无凭证业务请求一律 401 ----
  const blocked = await call(port, 'POST', `${BASE}/account`, { body: { segment: 'kaoyan' } });
  check(
    '未登录 POST /account 返回 401 + LICENSE_REQUIRED',
    blocked.status === 401 && blocked.data?.code === ERROR_CODES.LICENSE_REQUIRED,
    `status=${blocked.status} code=${blocked.data?.code}`
  );

  // ---- 2. 真实账号端点公开可访问 ----
  const reg = await call(port, 'POST', `${BASE}/auth/register`, {
    body: { email: 'alice@example.com', password: 'supersecret', segment: 'kaoyan' },
  });
  const authToken = reg.data?.data?.auth_token;
  const authAnon = reg.data?.data?.anon_user_id;
  check(
    '邮箱密码注册成功返回 auth_token + anon_user_id',
    reg.status === 200 && typeof authToken === 'string' && authToken.length >= 32 && !!authAnon,
    `status=${reg.status}`
  );
  check(
    '注册下发 uploads 专用 HttpOnly cookie（AUTH_COOKIE_NAME）',
    !!reg.setCookie && /HttpOnly/i.test(reg.setCookie) && /aicorrection_auth=/.test(reg.setCookie),
    `set-cookie=${reg.setCookie}`
  );
  check(
    'uploads cookie path 收窄到 uploads',
    !!reg.setCookie && /Path=\/api\/v1\/uploads/i.test(reg.setCookie),
    `set-cookie=${reg.setCookie}`
  );

  // ---- 3. 带 auth token 业务可用 + status ----
  const okBusiness = await call(port, 'POST', `${BASE}/account`, {
    token: authToken,
    body: { segment: 'kaoyan' },
  });
  check(
    '带 auth token POST /account 放行',
    okBusiness.status === 200 && okBusiness.data?.code === 0,
    `status=${okBusiness.status} code=${okBusiness.data?.code}`
  );
  const authStatus = await call(port, 'GET', `${BASE}/auth/status`, { token: authToken });
  check(
    'GET /auth/status 返回 active + provider=password + segment',
    authStatus.data?.data?.active === true &&
      authStatus.data?.data?.provider === 'password' &&
      authStatus.data?.data?.segment === 'kaoyan',
    JSON.stringify(authStatus.data?.data)
  );

  // ---- 4. 错误密码被拒 ----
  const badLogin = await call(port, 'POST', `${BASE}/auth/login`, {
    body: { email: 'alice@example.com', password: 'wrongpass' },
  });
  check(
    '错误密码登录被拒（AUTH_INVALID）',
    badLogin.data?.code === ERROR_CODES.AUTH_INVALID,
    `code=${badLogin.data?.code}`
  );
  const goodLogin = await call(port, 'POST', `${BASE}/auth/login`, {
    body: { email: 'alice@example.com', password: 'supersecret' },
  });
  check(
    '正确密码登录成功返回新 token',
    goodLogin.status === 200 && typeof goodLogin.data?.data?.auth_token === 'string',
    `status=${goodLogin.status}`
  );

  // ---- 5. 短信 dev 流程 ----
  const smsSend = await call(port, 'POST', `${BASE}/auth/sms/send`, {
    body: { phone: '13800138000' },
  });
  const devCode = smsSend.data?.data?.dev_code;
  check(
    '短信发送（dev 模式）回显 dev_code',
    smsSend.status === 200 && typeof devCode === 'string' && devCode.length === 6,
    `dev_code=${devCode}`
  );
  const smsVerify = await call(port, 'POST', `${BASE}/auth/sms/verify`, {
    body: { phone: '13800138000', code: devCode, segment: 'gaozhong' },
  });
  check(
    '短信验证码登录成功返回 token',
    smsVerify.status === 200 && typeof smsVerify.data?.data?.auth_token === 'string',
    `status=${smsVerify.status}`
  );

  // ---- 6. 魔法链接 dev 流程 ----
  const magicSend = await call(port, 'POST', `${BASE}/auth/magic/send`, {
    body: { email: 'bob@example.com' },
  });
  const devToken = magicSend.data?.data?.dev_token;
  check(
    '魔法链接发送（dev 模式）回显 dev_token',
    magicSend.status === 200 && typeof devToken === 'string' && devToken.length >= 16,
    `dev_token=${devToken?.slice(0, 4)}…`
  );
  const magicVerify = await call(port, 'POST', `${BASE}/auth/magic/verify`, {
    body: { token: devToken, segment: 'kaogong' },
  });
  check(
    '魔法链接验证登录成功返回 token',
    magicVerify.status === 200 && typeof magicVerify.data?.data?.auth_token === 'string',
    `status=${magicVerify.status}`
  );

  // ---- 7. 卡密身份迁移（link_anon_user_id） ----
  const [card] = generateLicenses({ count: 1, batchId: 'auth-migrate-batch' });
  const redeemed = await call(port, 'POST', `${BASE}/license/redeem`, {
    body: { code: card.code, segment: 'kaoyan' },
  });
  const licAnon = redeemed.data?.data?.anon_user_id;
  const migrated = await call(port, 'POST', `${BASE}/auth/register`, {
    body: {
      email: 'carol@example.com',
      password: 'anotherpass',
      segment: 'kaoyan',
      link_anon_user_id: licAnon,
    },
  });
  check(
    '卡密用户补绑真实账号：anon_user_id 与卡密身份一致（零数据丢失）',
    migrated.status === 200 && migrated.data?.data?.anon_user_id === licAnon,
    `lic=${licAnon} reg=${migrated.data?.data?.anon_user_id}`
  );

  // ---- 8. uploads：auth cookie 可读取原图（与 license 对称） ----
  const authCookie = reg.setCookie?.split(';')[0] ?? '';
  const okImg = await fetch(`http://127.0.0.1:${port}${BASE}/uploads/${imgName}`, {
    headers: { Cookie: authCookie },
  });
  check('仅凭 auth uploads cookie 可读取原图', okImg.status === 200, `status=${okImg.status}`);

  // ---- 9. 微信未配置 → AUTH_PROVIDER_NOT_CONFIGURED ----
  const wechat = await call(port, 'POST', `${BASE}/auth/wechat`, { body: { code: 'xyz' } });
  check(
    '微信未配置被拒（AUTH_PROVIDER_NOT_CONFIGURED）',
    wechat.data?.code === ERROR_CODES.AUTH_PROVIDER_NOT_CONFIGURED,
    `code=${wechat.data?.code}`
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
