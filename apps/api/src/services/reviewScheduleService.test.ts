/**
 * P2 间隔复习单元测试（R15 间隔复习 / R16 复习列表 / R12 变式题）。
 * 隔离：顶层先设临时库路径再动态 import。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-p2-review-test-'));
const dbPath = path.join(tmpDir, 'p2-review-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;

const { getDb, __resetDbSingleton } = await import('../db');
const {
  scheduleReview,
  getDueReviewsList,
  createReview,
  completeReview,
  generateVariant,
} = await import('./reviewScheduleService');
const { ERROR_CODES } = await import('@aicorrection/shared');

const U = 'u-review';

function seed() {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`).run(U);
  db.prepare(
    `INSERT INTO qbank_items (item_id, subject, question_text, answer_text, knowledge_point, embedding_status)
     VALUES ('qb-r1','math','解 x+1=3','x=2','一元一次方程','pending')`
  ).run();
}

before(() => {
  __resetDbSingleton();
  getDb();
  seed();
});

after(() => {
  __resetDbSingleton();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
});

test('R15 scheduleReview：首次排程 interval=1 且明天到期；重复调用不重置', () => {
  const r1 = scheduleReview(U, 'kp_x', '一元一次方程');
  assert.equal(r1.interval_days, 1);
  assert.ok(r1.next_review_ts !== null && r1.next_review_ts > new Date().toISOString());
  const r2 = scheduleReview(U, 'kp_x', '一元一次方程');
  assert.equal(r2.next_review_ts, r1.next_review_ts); // 幂等
});

test('R16 getDueReviewsList：含 is_due 标记（未来到期=false，过去到期=true）', () => {
  // 已排程的 kp_x 是明天 → is_due=false
  const before = getDueReviewsList(U);
  const kpX = before.items.find((i) => i.kp_key === 'kp_x')!;
  assert.ok(kpX, '应包含 kp_x');
  assert.equal(kpX.is_due, false);

  // 直接插入一条过去到期的计划 → is_due=true
  getDb()
    .prepare(
      `INSERT INTO review_schedule (anon_user_id, kp_key, kp_text, interval_days, next_review_ts)
       VALUES (?, 'kp_past', '过去的知识点', 1, '2000-01-01T00:00:00.000Z')`
    )
    .run(U);
  const after = getDueReviewsList(U);
  const past = after.items.find((i) => i.kp_key === 'kp_past')!;
  assert.ok(past, '应包含 kp_past');
  assert.equal(past.is_due, true);
});

test('R12 generateVariant：命中题库返回 source=variant；无题库返回 generic', () => {
  const v1 = generateVariant('一元一次方程');
  assert.equal(v1.source, 'variant');
  const v2 = generateVariant('完全不存在的知识点ZZZ');
  assert.equal(v2.source, 'generic');
});

test('R15/R12 createReview：返回 is_variant=1 的变式题', () => {
  const r = createReview(U, 'kp_x', '一元一次方程');
  assert.ok(r.review_id.startsWith('r-'));
  assert.equal(r.is_variant, 1);
  assert.equal(r.source, 'variant');
  assert.ok(r.question_text.length > 0);
});

test('R15 completeReview：正确→间隔翻倍，错误→间隔归 1', () => {
  // kp_x 当前 interval=1（scheduleReview 奠定）
  const start = getDb().prepare('SELECT interval_days FROM review_schedule WHERE anon_user_id=? AND kp_key=?').get(U, 'kp_x') as { interval_days: number };
  assert.equal(start.interval_days, 1);

  const rid = createReview(U, 'kp_x', '一元一次方程').review_id;
  const c1 = completeReview(rid, 'correct');
  assert.equal(c1.interval_days, 2); // 1*2
  assert.ok(c1.next_review_ts !== null && c1.next_review_ts > new Date().toISOString());

  const rid2 = createReview(U, 'kp_x', '一元一次方程').review_id;
  const c2 = completeReview(rid2, 'wrong');
  assert.equal(c2.interval_days, 1); // 错误归 1
});

test('R15 completeReview：未知 review_id → 404 PARAM_INVALID', () => {
  assert.throws(
    () => completeReview('r-not-exist', 'correct'),
    (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID
  );
});
