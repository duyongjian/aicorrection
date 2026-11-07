/**
 * 五步闭环补全服务（v0.2：R04 同类题 / R05 复述 / R06 追问验证）单元测试。
 *
 * 隔离：同 licenseService.test.ts —— 顶层先设临时库路径再动态 import。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-learn-test-'));
const dbPath = path.join(tmpDir, 'learn-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;

const { getDb, __resetDbSingleton } = await import('../db');
const {
  generatePractice,
  gradePractice,
  submitRestate,
  verifyProbe,
  verify,
} = await import('./learningService');
const { ERROR_CODES } = await import('@aicorrection/shared');

const KP = '一元一次方程';
const ESSENCE = '移项要变号，合并同类项后系数化为 1';
const ANSWER = 'x=2';

function seed(loopId: string, anonUserId: string) {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`
  ).run(anonUserId);
  db.prepare(
    `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
     VALUES (?, ?, 'kaoyan', 'sess-1', datetime('now'), 0)`
  ).run(loopId, anonUserId);
  db.prepare(
    `INSERT INTO attributions (attribution_id, loop_id, anon_user_id, cause, knowledge_point, essence, correct_answer, knowledge_point_id, cause_id)
     VALUES (?, ?, ?, '概念理解偏差', ?, ?, ?, 'kp_001', 'concept_confusion')`
  ).run(`attr-${loopId}`, loopId, anonUserId, KP, ESSENCE, ANSWER);
  db.prepare(
    `INSERT INTO qbank_items (item_id, subject, question_text, answer_text, knowledge_point, embedding_status)
     VALUES (?, 'math', ?, ?, ?, 'pending')`
  ).run(`qb-${loopId}`, `解方程：${KP} 3x+1=7`, ANSWER, KP);
}

before(() => {
  __resetDbSingleton();
  getDb(); // 触发建库 + 迁移
});

after(() => {
  __resetDbSingleton();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
});

test('R04 同类题：优先从题库按知识点取题（source=qbank）且标记 has_practice', () => {
  seed('L1', 'u1');
  const r = generatePractice('L1', 'u1');
  assert.equal(r.source, 'qbank');
  assert.ok(r.practice_id.startsWith('prac-'));
  const row = getDb()
    .prepare('SELECT has_practice FROM loop_sessions WHERE loop_id=?')
    .get('L1') as { has_practice: number };
  assert.equal(row.has_practice, 1);
});

test('R04 判分：答案正确 → is_correct=1', () => {
  seed('L2', 'u2');
  const r = generatePractice('L2', 'u2');
  const g = gradePractice(r.practice_id, ANSWER);
  assert.equal(g.is_correct, 1);
  assert.equal(g.graded_by, 'heuristic');
});

test('R04 判分：答案错误 → is_correct=0 且反馈含参考答案', () => {
  seed('L3', 'u3');
  const r = generatePractice('L3', 'u3');
  const g = gradePractice(r.practice_id, 'x=3');
  assert.equal(g.is_correct, 0);
  assert.match(g.feedback, /参考答案/);
});

test('R05 复述：直接复制 AI 本质 → restate_is_copy=1', () => {
  seed('L4', 'u4');
  const r = submitRestate('L4', 'u4', `因为${ESSENCE}，所以要小心`);
  assert.equal(r.restate_is_copy, 1);
  assert.ok(r.restate_len > 0);
});

test('R05 复述：用自己的话 → restate_is_copy=0', () => {
  seed('L5', 'u5');
  const r = submitRestate('L5', 'u5', '我就是没注意等号两边要同时变号，导致算错了');
  assert.equal(r.restate_is_copy, 0);
});

test('R06 探针：返回问题并写回 verify_prompt', () => {
  seed('L6', 'u6');
  const r = verifyProbe('L6', 'u6');
  assert.ok(r.question.includes(KP));
  const row = getDb()
    .prepare('SELECT verify_prompt FROM loop_sessions WHERE loop_id=?')
    .get('L6') as { verify_prompt: string };
  assert.ok(row.verify_prompt.includes(KP));
});

test('R06 验证：充分回答 → result=pass', () => {
  seed('L7', 'u7');
  const r = verify('L7', 'u7', '我移项时把 1 移到右边变成 -1，再合并同类项得到 3x=6，最后 x=2');
  assert.equal(r.result, 'pass');
  const row = getDb()
    .prepare('SELECT verify_result FROM loop_sessions WHERE loop_id=?')
    .get('L7') as { verify_result: string };
  assert.equal(row.verify_result, 'pass');
});

test('R06 验证：放弃 → result=give_up', () => {
  seed('L8', 'u8');
  const r = verify('L8', 'u8', '放弃');
  assert.equal(r.result, 'give_up');
});

test('身份不匹配 → 404 PARAM_INVALID', () => {
  seed('L9', 'u9');
  assert.throws(() => generatePractice('L9', 'other'), (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID);
});

test('空作答被拒', () => {
  seed('L10', 'u10');
  const r = generatePractice('L10', 'u10');
  assert.throws(() => gradePractice(r.practice_id, '   '), (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID);
});
