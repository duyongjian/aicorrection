/**
 * P1 强化期单元测试（R09 错因聚合 / R10 薄弱点 / R14 掌握判定 / R11 答案沉淀 / R13 针对性题组）。
 * 隔离：顶层先设临时库路径再动态 import。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-p1-test-'));
const dbPath = path.join(tmpDir, 'p1-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;

const { getDb, __resetDbSingleton } = await import('../db');
const {
  getCauseAggregation,
  getWeakPoints,
  refreshAllMastery,
  getMasteryState,
  deriveMasteryLevel,
} = await import('./aggregationService');
const { sedimentAnswer, generateTargetedGroup } = await import('./learningService');
const { ERROR_CODES } = await import('@aicorrection/shared');

const U = 'u1';

function seed() {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`).run(U);
  // 三道归因：kp_001 错 2 次（概念混淆），kp_002 错 1 次（方法错误）
  db.prepare(
    `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
     VALUES ('l_a1', ?, 'kaoyan', 's1', datetime('now'), 0)`
  ).run(U);
  db.prepare(
    `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
     VALUES ('l_a2', ?, 'kaoyan', 's1', datetime('now'), 0)`
  ).run(U);
  db.prepare(
    `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
     VALUES ('l_a3', ?, 'kaoyan', 's1', datetime('now'), 0)`
  ).run(U);
  db.prepare(
    `INSERT INTO attributions (attribution_id, loop_id, anon_user_id, knowledge_point, knowledge_point_id, cause_id)
     VALUES ('a1','l_a1',?,'一元一次方程','kp_001','concept_confusion'),
            ('a2','l_a2',?,'一元一次方程','kp_001','concept_confusion'),
            ('a3','l_a3',?,'函数定义域','kp_002','method_error')`
  ).run(U, U, U);
  // kp_001 练习 6 次：对对错对对对 → streak=3，correct=5 → mastered
  const seq = [1, 1, 0, 1, 1, 1];
  seq.forEach((c, i) => {
    db.prepare(
      `INSERT INTO practice_items (practice_id, loop_id, anon_user_id, kp_id, question_text, answer_text, source, is_correct, group_seq, created_at)
       VALUES (?, 'l_p', ?, 'kp_001', 'q', 'a', 'qbank', ?, ?, datetime('now', '+' || ? || ' seconds'))`
    ).run(`p_${i}`, U, c, i + 1, i);
  });
  // qbank：一元一次方程两题（供 R13 命中 source=qbank）
  db.prepare(
    `INSERT INTO qbank_items (item_id, subject, question_text, answer_text, knowledge_point, embedding_status)
     VALUES ('qb-1','math','解一元一次方程 2x+3=7','x=2','一元一次方程','pending'),
            ('qb-2','math','解一元一次方程 5x-1=9','x=2','一元一次方程','pending')`
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

test('R09 错因聚合：分布与占比正确，标签来自 CAUSE_TAXONOMY', () => {
  const r = getCauseAggregation(U);
  assert.equal(r.total, 3);
  const byCause = Object.fromEntries(r.items.map((i) => [i.cause_id, i]));
  assert.equal(byCause['concept_confusion'].count, 2);
  assert.equal(byCause['concept_confusion'].cause_label, '概念混淆');
  assert.equal(byCause['concept_confusion'].pct, 0.6667);
  assert.equal(byCause['method_error'].count, 1);
  // 降序
  assert.ok(r.items[0].count >= r.items[1].count);
});

test('R10 薄弱点：按错误数降序，含主要错因与掌握等级', () => {
  refreshAllMastery(U);
  const r = getWeakPoints(U);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].kp_key, 'kp_001');
  assert.equal(r.items[0].error_count, 2);
  assert.equal(r.items[0].top_cause_label, '概念混淆');
  assert.equal(r.items[0].mastery_level, 'mastered');
  assert.equal(r.items[1].kp_key, 'kp_002');
  assert.equal(r.items[1].mastery_level, 'not_started');
});

test('R14 deriveMasteryLevel：状态机边界', () => {
  assert.equal(deriveMasteryLevel(0, 0, 0), 'not_started');
  assert.equal(deriveMasteryLevel(1, 1, 1), 'learning');
  assert.equal(deriveMasteryLevel(2, 2, 0), 'familiar');
  assert.equal(deriveMasteryLevel(5, 5, 3), 'mastered');
  // 连续答对 3 高于累计 2
  assert.equal(deriveMasteryLevel(3, 2, 3), 'mastered');
});

test('R14 掌握判定：重算 kp_001=mastered，kp_002=not_started', () => {
  const list = refreshAllMastery(U);
  const m1 = list.items.find((m) => m.kp_key === 'kp_001')!;
  assert.equal(m1.level, 'mastered');
  assert.equal(m1.attempts, 6);
  assert.equal(m1.correct, 5);
  assert.equal(m1.correct_streak, 3);
  const m2 = getMasteryState(U, 'kp_002');
  assert.equal(m2.level, 'not_started');
});

test('R11 答案沉淀：UGC 入库 pending，不存 PII', async () => {
  const r = await sedimentAnswer({
    anon_user_id: U,
    question: '请证明勾股定理',
    answer: '利用面积法，构造直角三角形外接正方形……',
    knowledge_point: '勾股定理',
  });
  assert.ok(r.item_id.startsWith('ugc-'));
  assert.equal(r.status, 'pending');
  const row = getDb()
    .prepare('SELECT review_status, contributor_hash, sedimented_from_loop FROM qbank_items WHERE item_id = ?')
    .get(r.item_id) as { review_status: string; contributor_hash: string; sedimented_from_loop: string | null };
  assert.equal(row.review_status, 'pending');
  assert.match(row.contributor_hash, /^[0-9a-f]{16}$/);
  assert.equal(row.sedimented_from_loop, null);
});

test('R11 答案沉淀：缺 anon_user_id → 400 PARAM_INVALID', async () => {
  await assert.rejects(
    () => sedimentAnswer({ anon_user_id: '', question: 'x', answer: 'y' }),
    (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID
  );
});

test('R13 针对性题组：命中题库 source=qbank 且 kp 对齐', async () => {
  const r = await generateTargetedGroup({ anon_user_id: U, target_kp: '一元一次方程', count: 3, kp_key: 'kp_001' });
  assert.ok(r.group_id.startsWith('grp-'));
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].kp_id, 'kp_001');
  assert.equal(r.items[0].source, 'qbank');
  assert.equal(r.items[0].group_seq, 1);
  assert.equal(r.items[2].group_seq, 3);
});

test('R13 针对性题组：无题库回落 LLM 兜底题', async () => {
  const r = await generateTargetedGroup({ anon_user_id: U, target_kp: '不存在的知识点XYZ', count: 2 });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].source, 'llm');
  assert.equal(r.items[0].kp_id, 'txt:不存在的知识点XYZ');
});
