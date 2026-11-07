/**
 * 真实账号服务单元测试 —— node:test + node:assert/strict。
 * 隔离机制与 licenseService.test.ts 一致：临时库 + 动态 import + __resetDbSingleton。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-auth-test-'));
const dbPath = path.join(tmpDir, 'auth-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
delete process.env.SMS_PROVIDER;
delete process.env.EMAIL_PROVIDER;
delete process.env.WECHAT_APP_ID;
delete process.env.WECHAT_APP_SECRET;

const auth = await import('./authService');
const { getDb, __resetDbSingleton } = await import('../db');
const { HttpError } = await import('../middleware/errorHandler');
const { ERROR_CODES } = await import('@aicorrection/shared');

function expectHttpError(fn: () => unknown, code: number, label: string): void {
  let thrown: unknown;
  let didThrow = false;
  try {
    fn();
  } catch (e) {
    thrown = e;
    didThrow = true;
  }
  assert.ok(didThrow, `${label}：应抛 HttpError`);
  assert.ok(thrown instanceof HttpError, `${label}：应为 HttpError`);
  assert.equal((thrown as InstanceType<typeof HttpError>).code, code, `${label}：错误码`);
}

function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}
function countCredentials(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
}

function cleanup(): void {
  try {
    __resetDbSingleton();
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

before(() => {
  process.env.AICORRECTION_DB_PATH = dbPath;
  process.env.UPLOAD_DIR = uploadDir;
  __resetDbSingleton();
  assert.ok(getDb(), '第一次 getDb() 应成功建库并执行迁移（含 015_auth）');
});

beforeEach(() => {
  // 每个用例前清空业务表，保持独立（保留迁移结构）
  const db = getDb();
  db.exec('DELETE FROM auth_sessions; DELETE FROM accounts; DELETE FROM sms_codes; DELETE FROM magic_tokens; DELETE FROM license_sessions; DELETE FROM license_keys; DELETE FROM users;');
});

after(() => {
  cleanup();
});

process.on('exit', cleanup);

// ===================== 1. 邮箱密码：注册 / 登录 =====================

test('注册：返回 token+anon_user_id，users 与 accounts 各增 1', () => {
  const before = countUsers();
  const r = auth.registerWithPassword({ email: 'A@Example.com', password: 'secret123', segment: 'kaoyan' });
  assert.ok(r.auth_token && r.auth_token.length === 64, 'auth_token 为 64 位 hex');
  assert.ok(r.anon_user_id, '有 anon_user_id');
  assert.equal(r.provider, 'password');
  assert.equal(countUsers(), before + 1, '新增一个用户');
  assert.equal(countCredentials(), 1, '新增一条 password 凭证');
  // 邮箱大小写归一化：用大写再登应成功
  const login = auth.loginWithPassword({ email: 'a@example.com', password: 'secret123' });
  assert.equal(login.anon_user_id, r.anon_user_id, '归一化后登录命中同一账号');
});

test('注册弱密码（<8 位）：抛 AUTH_PASSWORD_WEAK', () => {
  expectHttpError(
    () => auth.registerWithPassword({ email: 'b@x.com', password: '123', segment: 'gaozhong' }),
    ERROR_CODES.AUTH_PASSWORD_WEAK,
    '弱密码'
  );
});

test('重复邮箱注册：抛 AUTH_EMAIL_TAKEN，且不新增账号', () => {
  auth.registerWithPassword({ email: 'dup@x.com', password: 'secret123', segment: 'gaozhong' });
  const before = countUsers();
  expectHttpError(
    () => auth.registerWithPassword({ email: 'dup@x.com', password: 'secret123', segment: 'gaozhong' }),
    ERROR_CODES.AUTH_EMAIL_TAKEN,
    '重复邮箱'
  );
  assert.equal(countUsers(), before, '重复注册不新增账号');
});

test('登录密码错误：抛 AUTH_INVALID', () => {
  auth.registerWithPassword({ email: 'c@x.com', password: 'secret123', segment: 'gaozhong' });
  expectHttpError(
    () => auth.loginWithPassword({ email: 'c@x.com', password: 'wrongpass' }),
    ERROR_CODES.AUTH_INVALID,
    '密码错误'
  );
});

test('登录不存在的邮箱：抛 AUTH_INVALID', () => {
  expectHttpError(
    () => auth.loginWithPassword({ email: 'nobody@x.com', password: 'secret123' }),
    ERROR_CODES.AUTH_INVALID,
    '邮箱不存在'
  );
});

// ===================== 2. token 校验 / 状态 / 登出 =====================

test('token 校验：注册后 verify 成功、status active、logout 后失效', () => {
  const r = auth.registerWithPassword({ email: 'd@x.com', password: 'secret123', segment: 'kaoyan' });
  const v = auth.verifyAuthToken(r.auth_token);
  assert.ok(v.ok && v.anonUserId === r.anon_user_id, 'verify 命中');
  const st = auth.getAuthStatus(r.auth_token);
  assert.equal(st.active, true);
  assert.deepEqual(st.providers, ['password']);
  // logout
  auth.logout(r.auth_token);
  assert.equal(auth.verifyAuthToken(r.auth_token).ok, false, '登出后 token 失效');
  assert.equal(auth.getAuthStatus(r.auth_token).active, false);
});

test('无效 token：verify 返回 ok:false invalid', () => {
  assert.equal(auth.verifyAuthToken('deadbeef').ok, false);
  assert.equal(auth.getAuthStatus(null).active, false);
});

// ===================== 3. 短信验证码（dev 回显） =====================

test('短信发送回显 dev_code；用 dev_code 登录/注册成功并建用户', async () => {
  const send = await auth.sendSmsCode({ phone: '13800138000' });
  assert.ok(send.dev_code && send.dev_code.length === 6, 'dev 模式回显 6 位验证码');
  const before = countUsers();
  const r = auth.verifySmsLogin({ phone: '13800138000', code: send.dev_code!, segment: 'kaogong' });
  assert.equal(r.provider, 'sms');
  assert.equal(countUsers(), before + 1, '短信首次登录创建新用户');
  // 再次用同一手机号+验证码应失败（已 consume）
  expectHttpError(
    () => auth.verifySmsLogin({ phone: '13800138000', code: send.dev_code!, segment: 'kaogong' }),
    ERROR_CODES.AUTH_CODE_INVALID,
    '已消费的验证码'
  );
});

test('短信错误验证码：抛 AUTH_CODE_INVALID', async () => {
  const send = await auth.sendSmsCode({ phone: '13900139000' });
  expectHttpError(
    () => auth.verifySmsLogin({ phone: '13900139000', code: '000000', segment: 'gaozhong' }),
    ERROR_CODES.AUTH_CODE_INVALID,
    '错误验证码'
  );
  // dev_code 仍可成功（确认上面是「验证码错」而非「无码」）
  auth.verifySmsLogin({ phone: '13900139000', code: send.dev_code!, segment: 'gaozhong' });
});

test('短信登录/注册复用同一用户：第二次不新建账号', async () => {
  const send = await auth.sendSmsCode({ phone: '13700137000' });
  const r1 = auth.verifySmsLogin({ phone: '13700137000', code: send.dev_code!, segment: 'gaozhong' });
  // 重新发送并再次校验（模拟再次登录），应命中同一 anon_user_id 且不新增用户
  const send2 = await auth.sendSmsCode({ phone: '13700137000' });
  const r2 = auth.verifySmsLogin({ phone: '13700137000', code: send2.dev_code!, segment: 'gaozhong' });
  assert.equal(r2.anon_user_id, r1.anon_user_id, '同一手机号复用同一身份');
  assert.equal(countUsers(), 1, '未新增用户');
});

// ===================== 4. 魔法链接（dev 回显） =====================

test('魔法链接发送回显 dev_token；用 dev_token 登录/注册成功', async () => {
  const send = await auth.magicSend({ email: 'magic@x.com' });
  assert.ok(send.dev_token, 'dev 模式回显 token');
  const before = countUsers();
  const r = auth.magicVerify({ token: send.dev_token!, segment: 'kaoyan' });
  assert.equal(r.provider, 'magic');
  assert.equal(countUsers(), before + 1);
  // 已消费：再次用同 token 失败
  expectHttpError(
    () => auth.magicVerify({ token: send.dev_token! }),
    ERROR_CODES.AUTH_CODE_INVALID,
    '已消费的魔法链接'
  );
});

// ===================== 5. 微信：未配置 → AUTH_PROVIDER_NOT_CONFIGURED =====================

test('微信登录未配置：抛 AUTH_PROVIDER_NOT_CONFIGURED', async () => {
  await assert.rejects(
    () => auth.wechatAuth({ code: 'abc' }),
    (e: unknown) => e instanceof HttpError && e.code === ERROR_CODES.AUTH_PROVIDER_NOT_CONFIGURED,
    '微信未配置（async）'
  );
});

// ===================== 6. 迁移：卡密/匿名用户补绑真实账号 =====================

test('link_anon_user_id：把新邮箱绑定到已有身份，不新建用户', () => {
  const acc = auth.registerWithPassword({ email: 'link1@x.com', password: 'secret123', segment: 'kaoyan' });
  const before = countUsers();
  // 同一邮箱再次注册（应邮箱已存在），但用 link_anon_user_id 把另一邮箱绑到同一身份
  const r = auth.registerWithPassword({
    email: 'link2@x.com',
    password: 'secret123',
    segment: 'kaoyan',
    link_anon_user_id: acc.anon_user_id,
  });
  assert.equal(r.anon_user_id, acc.anon_user_id, '绑定到已有身份');
  assert.equal(countUsers(), before, '未新建用户');
  const me = auth.getMe(r.auth_token);
  // link2 是新邮箱 → 新增一条 password 凭证挂在同一身份下（两邮箱并存）
  assert.equal(me.anon_user_id, acc.anon_user_id, 'me 命中同一身份');
  assert.equal(me.providers.length, 2, '同一身份下挂了两条 password 凭证');
});

test('link_anon_user_id 指向不存在的 anon_user_id：仍按注册新建用户', () => {
  const before = countUsers();
  const r = auth.registerWithPassword({
    email: 'link3@x.com',
    password: 'secret123',
    segment: 'gaozhong',
    link_anon_user_id: 'u_does_not_exist',
  });
  assert.equal(countUsers(), before + 1, '无效 link 退化为新建');
  assert.ok(r.anon_user_id !== 'u_does_not_exist');
});

// ===================== 7. 隔离性：连的是临时库，非生产库 =====================

test('隔离性：getDb() 实际连接的是临时库，绝非生产库', () => {
  const lists = getDb().prepare('PRAGMA database_list').all() as Array<{ file: string }>;
  const files = lists.map((l) => l.file);
  assert.ok(files.some((f) => f === dbPath), `应连接临时库 ${dbPath}，实际 ${files.join(',')}`);
  assert.ok(!files.some((f) => f.includes('apps/api/data/aicorrection.db')), '不得连接生产库');
});
