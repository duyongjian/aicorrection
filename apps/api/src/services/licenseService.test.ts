/**
 * 卡密服务（线下分发 MVP）服务层单元测试 —— node:test + node:assert/strict。
 *
 * 运行：npm run test -w @aicorrection/api
 *
 * 隔离（关键）：
 *  - 在任何业务模块 import 之前就把 AICORRECTION_DB_PATH / UPLOAD_DIR 指向
 *    os.tmpdir() 下的随机临时目录，并用动态 import 加载业务模块，确保 env.ts
 *    在模块加载时快照到的也是临时路径，绝不触碰 apps/api/data/aicorrection.db。
 *  - before 钩子里再显式设定库路径并 __resetDbSingleton()，然后第一次 getDb()
 *    建库 + 跑迁移；after 关闭连接并删除临时库（含 -wal/-shm/-journal）与目录。
 *  - 另设 process.on('exit') 兜底清理，防止 after 因断言失败未执行。
 *  - 用例「隔离性」用 PRAGMA database_list 反查实际连接文件，证明连的是临时库。
 *
 * 门禁（LICENSE_GATE_ENABLED）由 beforeEach 统一重置为「未开启」，需要开启的
 * 用例在内部显式 setGate('true')，避免用例之间互相污染。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- 顶层：先设置环境变量，再动态 import 业务模块（顺序不可调换）----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-license-test-'));
const dbPath = path.join(tmpDir, 'license-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
delete process.env.LICENSE_GATE_ENABLED;

const {
  canonicalCode,
  isLicenseGateEnabled,
  generateLicenses,
  redeemLicense,
  verifyLicenseToken,
  getLicenseStatus,
  getLicensePlan,
  renewLicense,
  createSubscription,
  revokeLicense,
  listLicenses,
} = await import('./licenseService');
const { getDb, __resetDbSingleton } = await import('../db');
const { HttpError } = await import('../middleware/errorHandler');
const { ERROR_CODES, LICENSE_TIERS, TIER_ENTITLEMENTS } = await import('@aicorrection/shared');

type HttpErr = InstanceType<typeof HttpError>;
type Card = ReturnType<typeof generateLicenses>[number];
type LicenseRow = ReturnType<typeof listLicenses>[number];

/** 与实现一致的去歧义字母表（去掉 I/L/O/0/1）。 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function setGate(value: string | undefined): void {
  if (value === undefined) delete process.env.LICENSE_GATE_ENABLED;
  else process.env.LICENSE_GATE_ENABLED = value;
}

/** 断言 fn 抛出 HttpError，并核对 code /（可选）httpStatus。 */
function expectHttpError(
  fn: () => unknown,
  code: number,
  label: string,
  httpStatus?: number
): void {
  let thrown: unknown;
  let didThrow = false;
  try {
    fn();
  } catch (e) {
    thrown = e;
    didThrow = true;
  }
  assert.ok(didThrow, `${label}：应抛 HttpError，实际未抛`);
  assert.ok(thrown instanceof HttpError, `${label}：应为 HttpError，实际 ${String(thrown)}`);
  const e = thrown as HttpErr;
  assert.equal(e.code, code, `${label}：错误码`);
  if (httpStatus !== undefined) {
    assert.equal(e.httpStatus, httpStatus, `${label}：httpStatus`);
  }
}

function countUsers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

function issueOne(batchId: string, extra: { expiresAt?: string; note?: string } = {}): Card {
  const [card] = generateLicenses({ count: 1, batchId, ...extra });
  assert.ok(card, `发卡应返回 1 张（${batchId}）`);
  return card;
}

function assertCodeShape(code: string, label: string): void {
  assert.match(code, /^AC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, `${label}：展示格式`);
  const body = code.replace(/[^A-Z0-9]/g, '').slice(2);
  assert.equal(body.length, 12, `${label}：主体长度 12`);
  for (const ch of body) {
    assert.ok(ALPHABET.includes(ch), `${label}：主体含字母表外字符 ${ch}`);
  }
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
  // 满足隔离要求：before 内显式指向临时库并重置单例，随后才第一次 getDb()。
  process.env.AICORRECTION_DB_PATH = dbPath;
  process.env.UPLOAD_DIR = uploadDir;
  setGate(undefined);
  __resetDbSingleton();
  assert.ok(getDb(), '第一次 getDb() 应成功建库并执行迁移');
});

beforeEach(() => {
  setGate(undefined);
});

after(() => {
  cleanup();
});

process.on('exit', cleanup);

// ===================== 1. canonicalCode =====================

test('canonicalCode：展示格式 AC-XXXX-XXXX-XXXX 正确归一化为 12 位主体', () => {
  assert.equal(canonicalCode('AC-ABCD-EFGH-JKMN'), 'ABCDEFGHJKMN');
});

test('canonicalCode：裸 12 位主体按原样归一化', () => {
  assert.equal(canonicalCode('ABCDEFGHJKMN'), 'ABCDEFGHJKMN');
});

test('canonicalCode：主体本身以 AC 开头的裸 12 位不得被误剥前缀（缺陷回归）', () => {
  // 真实缺陷：若写成 startsWith('AC') ? slice(2) : s，这类主体会被误剥成 10 位。
  assert.equal(canonicalCode('ACBCDEFGHJKM'), 'ACBCDEFGHJKM', '裸 12 位以 AC 开头必须整段保留');
  // 展示格式下主体同样以 AC 开头，仍应精确剥掉 2 位前缀得到完整 12 位主体。
  assert.equal(canonicalCode('AC-ACBC-DEFG-HJKM'), 'ACBCDEFGHJKM', '展示格式应剥前缀后保留以 AC 开头的主体');
});

test('canonicalCode：小写 / 空格 / 多余连字符可容错', () => {
  assert.equal(canonicalCode('ac-abcd-efgh-jkmn'), 'ABCDEFGHJKMN', '全小写');
  assert.equal(canonicalCode('  AC-ABCD-EFGH-JKMN  '), 'ABCDEFGHJKMN', '前后空格');
  assert.equal(canonicalCode('AC--ABCD--EFGH--JKMN'), 'ABCDEFGHJKMN', '多余连字符');
  assert.equal(canonicalCode('aC ab cd eFgH jKmN'), 'ABCDEFGHJKMN', '空格分隔 + 大小写混合');
  assert.equal(canonicalCode('ac__abcd--efgh  jkmn'), 'ABCDEFGHJKMN', '混合分隔符');
});

test('canonicalCode：长度不对或含字母表外字符(I/L/O/0/1)返回 null', () => {
  const bad: Array<string | null | undefined> = [
    'AC-ABCD-EFGH',           // 去分隔符后 10 字符
    'ABCDEFGHJKM',            // 11 位
    'ABCDEFGHJKMNP',          // 13 位
    '',                       // 空
    null,
    undefined,
    'AC-ABCD-EFGH-JKMI',      // I
    'AC-ABCD-EFGH-JKML',      // L
    'AC-ABCD-EFGH-JKMO',      // O
    'AC-ABCD-EFGH-JKM0',      // 0
    'AC-ABCD-EFGH-JKM1',      // 1
    'ABCDEFGHJKMI',           // 裸 12 位含 I
    'ac-abcd-efgh-jkm0',      // 小写 0
  ];
  for (const raw of bad) {
    assert.equal(canonicalCode(raw as string), null, `应判无效：${String(raw)}`);
  }
});

// ===================== 2. 发卡 =====================

test('发卡：count 边界 0 / 负数 / >1000 / NaN / Infinity 抛 PARAM_INVALID', () => {
  const bads: Array<[number, string]> = [
    [0, '0'],
    [-1, '-1'],
    [-100, '-100'],
    [1001, '1001'],
    [5000, '5000'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, '+Infinity'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
  ];
  for (const [count, label] of bads) {
    expectHttpError(
      () => generateLicenses({ count, batchId: 'batch-invalid-count' }),
      ERROR_CODES.PARAM_INVALID,
      `count=${label}`,
      400
    );
  }
  // 字符串非数字（绕过 TS 类型的运行时脏输入）也应被拒：Number('abc') → NaN → !isInteger。
  for (const raw of ['abc', '', '12xyz']) {
    expectHttpError(
      () =>
        generateLicenses({
          count: raw as unknown as number,
          batchId: 'batch-invalid-count',
        }),
      ERROR_CODES.PARAM_INVALID,
      `count=字符串 ${JSON.stringify(raw)}`,
      400
    );
  }
  // expiresAt 非法日期同样应在发卡阶段被拒。
  expectHttpError(
    () => generateLicenses({ count: 1, batchId: 'batch-bad-date', expiresAt: 'not-a-date' }),
    ERROR_CODES.PARAM_INVALID,
    'expiresAt 非法日期',
    400
  );
  assert.equal(listLicenses('batch-invalid-count').length, 0, '校验失败不得写库');
});

// 规格（任务清单「count 非整数抛错」）要求非整数被拒。后端 licenseService.ts:117-118
// 已改为先 Number.isInteger 校验再使用，不再 Math.floor 静默取整，此处回归守护该契约。
test('发卡：非整数 count 抛 PARAM_INVALID（守护「1–1000 整数」契约）', () => {
  for (const bad of [1.5, 2.5, 999.9]) {
    assert.throws(
      () => generateLicenses({ count: bad, batchId: 'batch-float' }),
      (err: unknown) => {
        assert.ok(err instanceof HttpError, `count=${bad} 应抛 HttpError`);
        assert.equal(
          (err as HttpErr).code,
          ERROR_CODES.PARAM_INVALID,
          `count=${bad} 错误码应为 PARAM_INVALID`
        );
        assert.equal((err as HttpErr).httpStatus, 400, `count=${bad} httpStatus`);
        return true;
      },
      `count=${bad} 非整数应被拒`
    );
  }
  assert.equal(listLicenses('batch-float').length, 0, '被拒的非整数不得写库');
});

test('发卡：整数边界 count=1 / count=1000 成功（上限不被误拒）', () => {
  const one = generateLicenses({ count: 1, batchId: 'batch-count-1' });
  assert.equal(one.length, 1, 'count=1 应成功发 1 张');
  assert.equal(listLicenses('batch-count-1').length, 1);

  const upper = generateLicenses({ count: 1000, batchId: 'batch-count-1000' });
  assert.equal(upper.length, 1000, 'count=1000 应成功发 1000 张');
  assert.equal(new Set(upper.map((c) => c.code)).size, 1000, '1000 张卡密互不相同');
  assert.equal(listLicenses('batch-count-1000').length, 1000, '1000 张全部落库');
});

test('发卡与 listLicenses：数量/格式/唯一性/hint 脱敏/初始 unused/batch 筛选/元数据', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const cards = generateLicenses({
    count: 5,
    batchId: 'batch-gen',
    note: '线下试用批次',
    expiresAt: future,
  });
  assert.equal(cards.length, 5, '生成数量正确');

  for (const c of cards) {
    assert.equal(c.batch_id, 'batch-gen');
    assert.equal(c.note, '线下试用批次', 'note 透传');
    assert.equal(c.expires_at, future, 'expires_at 透传（ISO 字符串）');
    assertCodeShape(c.code, '生成的卡密');
  }
  assert.equal(new Set(cards.map((c) => c.code)).size, 5, '卡密互不相同');

  // hint 必须是 ****-末4位，绝不含任何一张完整卡密。
  const allRows = listLicenses();
  for (const c of cards) {
    for (const r of allRows) {
      assert.ok(!r.hint.includes(c.code), `hint 不得含完整卡密：${r.hint}`);
    }
  }
  const rows: LicenseRow[] = listLicenses('batch-gen');
  assert.equal(rows.length, 5, '同一 batch 可精确筛选');
  for (const r of rows) {
    assert.match(r.hint, /^\*\*\*\*-[A-Z0-9]{4}$/, 'hint 形如 ****-ABCD');
    assert.equal(r.status, 'unused', '初始状态 unused');
    assert.equal(r.note, '线下试用批次');
    assert.equal(r.expires_at, future);
    assert.equal(r.anon_user_id, null, '未兑换不绑定账号');
    assert.equal(r.redeemed_at, null);
  }
  // 每张卡密的末 4 位应与对应 hint 对得上。
  for (const c of cards) {
    const body = c.code.replace(/[^A-Z0-9]/g, '').slice(2);
    assert.ok(
      rows.some((r) => r.hint === `****-${body.slice(-4)}`),
      `末 4 位应出现在 hint 中：${c.code}`
    );
  }

  // 另一 batch 独立可筛选；不存在的 batch 返回空。
  generateLicenses({ count: 2, batchId: 'batch-other' });
  assert.equal(listLicenses('batch-gen').length, 5, 'batch 之间互不干扰');
  assert.equal(listLicenses('batch-other').length, 2);
  assert.equal(listLicenses('batch-nonexistent').length, 0);
});

// ===================== 隔离性 =====================

test('隔离性：getDb() 实际连接的是临时库，绝非生产库', () => {
  const rows = getDb().prepare('PRAGMA database_list').all() as Array<{
    seq: number;
    name: string;
    file: string;
  }>;
  const main = rows.find((r) => r.name === 'main');
  assert.ok(main, '应能查到 main 数据库');
  const opened = path.resolve(main.file);
  assert.equal(opened, path.resolve(dbPath), '实际打开路径应为临时库');
  const rel = path.relative(path.resolve(tmpDir), opened);
  assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), '连接应落在系统临时目录内');
  assert.ok(fs.existsSync(dbPath), '临时库文件已创建');
});

// ===================== 3/4/5/6. 兑换 / 重复 / 停用 / 过期 =====================

test('兑换：返回 token+anon_user_id，verify ok，status active/gate_enabled=true，卡密变 redeemed', () => {
  setGate('true');
  const card = issueOne('batch-redeem');
  const res = redeemLicense({ code: card.code, segment: 'gaozhong' });
  assert.ok(typeof res.license_token === 'string' && res.license_token.length > 0, '应返回 license_token');
  assert.match(res.license_token, /^[0-9a-f]+$/, 'token 为 hex 字符串');
  assert.ok(typeof res.anon_user_id === 'string' && res.anon_user_id.length > 0, '应返回 anon_user_id');
  assert.equal(res.segment, 'gaozhong');
  assert.equal(res.batch_id, 'batch-redeem');

  const v = verifyLicenseToken(res.license_token);
  assert.equal(v.ok, true, 'verifyLicenseToken 应通过');
  if (v.ok) {
    assert.equal(v.anonUserId, res.anon_user_id);
    assert.equal(v.segment, 'gaozhong');
    assert.equal(v.batchId, 'batch-redeem');
  }

  const s = getLicenseStatus(res.license_token);
  assert.equal(s.active, true, '门禁开启且凭证有效应 active');
  assert.equal(s.gate_enabled, true);
  assert.equal(s.anon_user_id, res.anon_user_id);
  assert.equal(s.segment, 'gaozhong');

  const rows = listLicenses('batch-redeem');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'redeemed', '卡密状态变 redeemed');
  assert.equal(rows[0].anon_user_id, res.anon_user_id, '绑定兑换所得账号');
  assert.ok(rows[0].redeemed_at, 'redeemed_at 已写入');
});

test('重复兑换：抛 LICENSE_ALREADY_USED，且不新增匿名账号（原子占用）', () => {
  const card = issueOne('batch-dup');
  const first = redeemLicense({ code: card.code, segment: 'kaoyan' });
  const before = countUsers();

  expectHttpError(
    () => redeemLicense({ code: card.code, segment: 'kaoyan' }),
    ERROR_CODES.LICENSE_ALREADY_USED,
    '同一卡密第二次兑换',
    409
  );

  assert.equal(countUsers(), before, '重复兑换不得再建匿名账号（事务不应进入 createAccount）');
  const rows = listLicenses('batch-dup');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'redeemed');
  assert.equal(rows[0].anon_user_id, first.anon_user_id, '仍绑定首次兑换的账号');
});

test('停用：verify→revoked、status→active:false/reason:revoked、重复停用 ok:false', () => {
  setGate('true');
  const card = issueOne('batch-revoke');
  const res = redeemLicense({ code: card.code, segment: 'kaoyan' });
  assert.equal(verifyLicenseToken(res.license_token).ok, true, '停用前凭证有效');

  const r1 = revokeLicense(card.code);
  assert.equal(r1.ok, true, '首次停用成功');

  assert.deepEqual(
    verifyLicenseToken(res.license_token),
    { ok: false, reason: 'revoked' },
    '停用后 verify 应返回 revoked'
  );
  const s = getLicenseStatus(res.license_token);
  assert.equal(s.active, false);
  assert.equal(s.gate_enabled, true);
  assert.equal(s.reason, 'revoked');

  const r2 = revokeLicense(card.code);
  assert.equal(r2.ok, false, '重复停用应返回 ok:false');
});

test('revokeLicense 成功 message 只含 ****-掩码、不含完整明文卡密（数据主权回归护栏）', () => {
  const card = issueOne('batch-revoke-msg');
  redeemLicense({ code: card.code, segment: 'kaoyan' }); // 停用前原状态为 redeemed
  const r = revokeLicense(card.code);
  assert.equal(r.ok, true, '停用成功');
  const body = card.code.replace(/[^A-Z0-9]/g, '').slice(2);
  assert.ok(r.message.includes(`****-${body.slice(-4)}`), `message 掩码应为末 4 位，实际：${r.message}`);
  assert.ok(!r.message.includes(card.code), 'message 不得含完整展示卡密');
  assert.ok(!r.message.includes('AC-'), 'message 不得含 AC- 开头完整卡密');
  assert.ok(!r.message.includes(body), 'message 不得含 12 位明文主体');
  assert.match(r.message, /原状态/, '应保留原状态信息');
});

test('过期：expiresAt 为过去时间的卡，兑换抛 LICENSE_EXPIRED', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const card = issueOne('batch-expired', { expiresAt: past });
  expectHttpError(
    () => redeemLicense({ code: card.code, segment: 'kaoyan' }),
    ERROR_CODES.LICENSE_EXPIRED,
    '过期卡兑换',
    403
  );
  assert.equal(listLicenses('batch-expired')[0].status, 'unused', '过期卡不得被占用');
});

test('兑换已停用卡：抛 LICENSE_REVOKED', () => {
  const card = issueOne('batch-redeem-revoked');
  const r = revokeLicense(card.code);
  assert.equal(r.ok, true);
  expectHttpError(
    () => redeemLicense({ code: card.code, segment: 'kaoyan' }),
    ERROR_CODES.LICENSE_REVOKED,
    '兑换已停用卡',
    403
  );
});

// ===================== 7. 门禁关闭语义 =====================

test('门禁关闭语义：未设置/false → active:true/gate_enabled:false；true 且无 token → active:false/reason:missing', () => {
  // 默认（未设置）：门禁关闭，前端必须直接放行，不能被激活页锁死。
  setGate(undefined);
  assert.equal(isLicenseGateEnabled(), false);
  let s = getLicenseStatus(null);
  assert.equal(s.active, true, '门禁关闭应直接放行');
  assert.equal(s.gate_enabled, false);
  assert.equal(s.reason, undefined, '放行时不应带失效原因');

  // 显式 false 等价。
  setGate('false');
  assert.equal(isLicenseGateEnabled(), false);
  s = getLicenseStatus(null);
  assert.equal(s.active, true);
  assert.equal(s.gate_enabled, false);

  // 开启门禁但无凭证 → 要求激活。
  setGate('true');
  assert.equal(isLicenseGateEnabled(), true);
  s = getLicenseStatus(null);
  assert.equal(s.active, false);
  assert.equal(s.gate_enabled, true);
  assert.equal(s.reason, 'missing');
});

// ===================== 8. 无效 token =====================

test('verifyLicenseToken：无效 / 随机 token 返回 ok:false，不抛异常', () => {
  const badTokens: Array<string | null | undefined> = [
    null,
    undefined,
    '',
    'not-a-token',
    'deadbeef',
    '0'.repeat(64),
    'zz'.repeat(32),
  ];
  for (const t of badTokens) {
    assert.doesNotThrow(() => verifyLicenseToken(t), `token=${String(t)} 不得抛异常`);
    const v = verifyLicenseToken(t);
    assert.equal(v.ok, false, `token=${String(t)} 应判无效`);
    if (!v.ok) assert.equal(v.reason, 'invalid');
  }
});

// ===================== 9. 无效卡密 =====================

test('redeemLicense：格式非法(400) 与 格式合法但不存在(404) 均抛 LICENSE_INVALID', () => {
  // 格式非法：含字母表外字符 → canonicalCode 返回 null → 400。
  expectHttpError(
    () => redeemLicense({ code: 'AC-ABCD-EFGH-JKMI', segment: 'kaoyan' }),
    ERROR_CODES.LICENSE_INVALID,
    '格式非法（含 I）',
    400
  );
  expectHttpError(
    () => redeemLicense({ code: 'TOO-SHORT', segment: 'kaoyan' }),
    ERROR_CODES.LICENSE_INVALID,
    '格式非法（长度不对）',
    400
  );
  // 格式合法但从未发过 → 查库无记录 → 404，错误码同为 LICENSE_INVALID。
  expectHttpError(
    () => redeemLicense({ code: 'AC-ABCD-EFGH-JKMN', segment: 'kaoyan' }),
    ERROR_CODES.LICENSE_INVALID,
    '格式合法但不存在的卡密',
    404
  );
  expectHttpError(
    () => redeemLicense({ code: 'ABCDEFGHJKMN', segment: 'kaoyan' }),
    ERROR_CODES.LICENSE_INVALID,
    '裸 12 位格式合法但不存在的卡密',
    404
  );
});

test('revokeLicense：非法格式 / 不存在的卡返回 ok:false', () => {
  assert.equal(revokeLicense('AC-ABCD-EFGH-JKMI').ok, false, '非法格式');
  assert.equal(revokeLicense('AC-ABCD-EFGH-JKMN').ok, false, '格式合法但不存在');
});

// ===================== 商业化：卡密即权益层 =====================

test('发卡默认免费档；redeem 响应带回 tier=free 与 core_loop 权益', () => {
  setGate('true');
  const card = issueOne('batch-com-free');
  const res = redeemLicense({ code: card.code, segment: 'kaoyan' });
  assert.equal(res.tier, 'free', '未指定 tier 默认 free');
  assert.deepEqual(res.entitlements, TIER_ENTITLEMENTS.free, '免费档权益=core_loop');
  assert.ok(res.entitlements.includes('core_loop'));
});

test('pro 档卡密：redeem 返回 tier=pro 且含 spaced_review/custom_kp 等进阶权益', () => {
  setGate('true');
  const [card] = generateLicenses({ count: 1, batchId: 'batch-com-pro', tier: 'pro' });
  assert.ok(card, 'pro 卡应生成');
  const res = redeemLicense({ code: card.code, segment: 'kaoyan' });
  assert.equal(res.tier, 'pro');
  for (const ent of ['core_loop', 'unlimited_loops', 'spaced_review', 'custom_kp', 'knowledge_graph']) {
    assert.ok(res.entitlements.includes(ent as never), `pro 应含权益 ${ent}`);
  }
  // verify 后 tier 透传
  const v = verifyLicenseToken(res.license_token);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.tier, 'pro');
});

test('getLicenseStatus（门禁开启）：携带 tier / entitlements / is_expired', () => {
  setGate('true');
  const [card] = generateLicenses({ count: 1, batchId: 'batch-com-status', tier: 'max' });
  const res = redeemLicense({ code: card.code, segment: 'kaoyan' });
  const s = getLicenseStatus(res.license_token);
  assert.equal(s.active, true);
  assert.equal(s.tier, 'max');
  assert.deepEqual(s.entitlements, TIER_ENTITLEMENTS.max);
  assert.equal(s.is_expired, false);
});

test('getLicensePlan：有效 pro 凭证返回 pro 档计划；无凭证返回免费默认档', () => {
  setGate('true');
  const [card] = generateLicenses({ count: 1, batchId: 'batch-com-plan', tier: 'pro' });
  const res = redeemLicense({ code: card.code, segment: 'kaoyan' });
  const plan = getLicensePlan(res.license_token);
  assert.equal(plan.tier, 'pro');
  assert.equal(plan.tier_label, '专业版');
  assert.equal(plan.entitlements.includes('spaced_review' as never), true);
  assert.equal(plan.can_renew, true);
  // 无凭证 → 免费默认档
  const def = getLicensePlan(null);
  assert.equal(def.tier, 'free');
  assert.equal(def.entitlements.includes('core_loop' as never), true);
});

test('renewLicense：延长有效期（默认按档位时长），is_expired 随之更新', () => {
  setGate('true');
  // pro 默认 365 天；发一张 1 天后过期，续费（不传 days）应延长到 约 366 天后
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const [card] = generateLicenses({ count: 1, batchId: 'batch-com-renew', tier: 'pro', expiresAt: future });
  const res = redeemLicense({ code: card.code, segment: 'kaoyan' });
  // 先让 status 显示未过期
  assert.equal(getLicensePlan(res.license_token).is_expired, false);
  const r = renewLicense({ license_token: res.license_token });
  assert.equal(r.ok, true);
  assert.ok(r.expires_at, '应返回新有效期');
  const newExpires = new Date(r.expires_at as string).getTime();
  // 原 future(~1天) + 默认365天 ≈ 366天后；允许 ±2天误差
  const expected = new Date(future).getTime() + 365 * 86_400_000;
  assert.ok(Math.abs(newExpires - expected) < 2 * 86_400_000, '续费后有效期≈原到期+档位默认时长');
  // 续费升档：pro→max
  const up = renewLicense({ license_token: res.license_token, tier: 'max' });
  assert.equal(up.tier, 'max');
  assert.equal(getLicensePlan(res.license_token).tier, 'max', '升档后查询应为 max');
});

test('renewLicense：无卡密定位抛 LICENSE_NOT_FOUND', () => {
  expectHttpError(
    () => renewLicense({}),
    ERROR_CODES.LICENSE_NOT_FOUND,
    '无任何可续费卡密',
    404
  );
});

test('createSubscription：未配置真实支付 provider 抛 PAYMENT_PROVIDER_NOT_CONFIGURED(501)', () => {
  delete process.env.PAYMENT_PROVIDER;
  expectHttpError(
    () => createSubscription({ anon_user_id: 'u-sub-1', tier: 'pro', provider: 'stripe' }),
    ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
    '未配置支付 provider',
    501
  );
});

test('createSubscription：provider=none（离线）成功创建订阅+支付台账', () => {
  delete process.env.PAYMENT_PROVIDER;
  // subscriptions/payments 外键引用 users，单测需先落一个用户行
  getDb()
    .prepare("INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))")
    .run('u-sub-2');
  const r = createSubscription({ anon_user_id: 'u-sub-2', tier: 'pro', provider: 'none' });
  assert.equal(r.ok, true, '离线模式应创建成功');
  assert.equal(r.provider, 'none');
  // 台账应落库
  const rows = getDb()
    .prepare('SELECT * FROM subscriptions WHERE anon_user_id = ?')
    .all('u-sub-2') as Array<{ tier: string; status: string }>;
  assert.equal(rows.length, 1, '应写入一条订阅');
  assert.equal(rows[0].tier, 'pro');
  assert.equal(rows[0].status, 'active');
  const pays = getDb()
    .prepare('SELECT COUNT(*) AS n FROM payments WHERE anon_user_id = ?')
    .get('u-sub-2') as { n: number };
  assert.equal(pays.n, 1, '应写入一条支付台账');
});

test('LICENSE_TIERS / TIER_ENTITLEMENTS 冻结映射自洽：free⊂pro⊂max', () => {
  assert.ok(LICENSE_TIERS.includes('free' as never));
  assert.ok(TIER_ENTITLEMENTS.free.every((e) => TIER_ENTITLEMENTS.pro.includes(e)), 'free 权益 ⊆ pro');
  assert.ok(TIER_ENTITLEMENTS.pro.every((e) => TIER_ENTITLEMENTS.max.includes(e)), 'pro 权益 ⊆ max');
});
