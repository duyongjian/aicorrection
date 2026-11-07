/**
 * 闭环会话流服务（v0.3：R07 闭环完成 / 状态聚合 / 防刷护栏）单元测试。
 * 隔离：同 learningService.test.ts。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-loop-test-'));
const dbPath = path.join(tmpDir, 'loop-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;

const { getDb, __resetDbSingleton } = await import('../db');
const { getLoopSummary, completeLoop, computeLoopHealth } = await import('./loopService');
const { ERROR_CODES } = await import('@aicorrection/shared');

function seed(loopId: string, anonUserId: string, opts: { attr?: boolean; practice?: boolean; restate?: boolean; verify?: boolean } = {}) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`).run(anonUserId);
  db.prepare(
    `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete, has_practice, restate_text, verify_result)
     VALUES (?, ?, 'kaoyan', 's', datetime('now','-600 seconds'), 0, ?, ?, ?)`
  ).run(loopId, anonUserId, opts.practice ? 1 : 0, opts.restate ? '我用自己的话复述了' : null, opts.verify ? 'pass' : null);
  if (opts.attr) {
    db.prepare(
      `INSERT INTO attributions (attribution_id, loop_id, anon_user_id, cause, knowledge_point, essence, rate_action)
       VALUES (?, ?, ?, '概念理解偏差', 'kp', '本质', 'approve')`
    ).run(`attr-${loopId}`, loopId, anonUserId);
  }
}

before(() => {
  __resetDbSingleton();
  getDb();
});

after(() => {
  __resetDbSingleton();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
});

test('getLoopSummary：六步进度随状态推进', () => {
  seed('L1', 'u1', { attr: true, practice: true, restate: true, verify: true });
  const s = getLoopSummary('L1');
  assert.equal(s.has_upload, true);
  assert.equal(s.has_attribution, true);
  assert.equal(s.rated, true);
  assert.equal(s.has_practice, true);
  assert.equal(s.has_restate, true);
  assert.equal(s.has_verify, true);
  assert.equal(s.progress, 1);
});

test('getLoopSummary：仅上传时为 1/6', () => {
  seed('L2', 'u2', {});
  const s = getLoopSummary('L2');
  assert.equal(s.progress, Math.round((1 / 6) * 100) / 100);
  assert.equal(s.has_attribution, false);
});

test('completeLoop：标记完成并聚合五步状态', () => {
  seed('L3', 'u3', { attr: true, practice: true });
  const s = completeLoop('L3', 'u3');
  assert.equal(s.loop_complete, true);
  const row = getDb().prepare('SELECT loop_complete, duration_ms FROM loop_sessions WHERE loop_id=?').get('L3') as { loop_complete: number; duration_ms: number };
  assert.equal(row.loop_complete, 1);
  assert.ok(row.duration_ms >= 0);
});

test('completeLoop：身份不匹配 → 404', () => {
  seed('L4', 'u4', {});
  assert.throws(() => completeLoop('L4', 'other'), (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID);
});

test('getLoopSummary：不存在 → 404', () => {
  assert.throws(() => getLoopSummary('nope'), (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID);
});

test('computeLoopHealth：返回结构且异常数组为数组', () => {
  seed('L5', 'u5', { attr: true });
  seed('L6', 'u5', { attr: true, practice: true, verify: true });
  const h = computeLoopHealth(14);
  assert.ok(h.total_loops >= 2);
  assert.ok(Array.isArray(h.daily_anomalies));
  assert.ok('completion_rate' in h && 'median_duration_ms' in h);
});
