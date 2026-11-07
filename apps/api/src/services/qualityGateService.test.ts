/**
 * 质量优化服务单测（G1 闸门 / B·C·D 分层 / 代理↔质量校准）。
 * 纯函数（scoreGate / classifyStratum / calibrateQuality）无需 DB；
 * computeStrataReport 走临时库 + 种子数据，隔离运行。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-quality-test-'));
const dbPath = path.join(tmpDir, 'quality-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;

const { getDb, __resetDbSingleton } = await import('../db');
const {
  scoreGate,
  classifyStratum,
  calibrateQuality,
  computeStrataReport,
} = await import('./qualityGateService');

const U = 'u-quality';

before(() => {
  __resetDbSingleton();
  getDb();
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`
  ).run(U);

  // 预建 loop_sessions（attributions.loop_id 的父行，FK 约束）
  const loops: string[] = [];
  for (let i = 0; i < 25; i++) loops.push(`ql${i}`);
  const insLoop = db.prepare(
    `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
     VALUES (?, ?, 'kaoyan', 's1', datetime('now'), 0)`
  );
  for (const l of loops) insLoop.run(l, U);

  // 四个知识点，覆盖 A/B/C/D 四层：
  //  kp_D：12 条、主导 concept_confusion（>=10 且误解）→ D
  //  kp_B：5 条、cause=other（>=4 且非误解/非罕见）→ B
  //  kp_C：1 条、cause=memory_gap（罕见）→ C
  //  kp_A：3 条、cause=other（3 既非 <=2、非 >=4、非误解）→ A
  // 其中 kp_D 与 kp_A 各有一条已盲评（expert_accuracy 非 NULL），用于验证分层覆盖统计。
  const groups: Array<{ kp: string; n: number; cause: string; reviewed: boolean }> = [
    { kp: 'kp_D', n: 12, cause: 'concept_confusion', reviewed: true },
    { kp: 'kp_B', n: 5, cause: 'other', reviewed: false },
    { kp: 'kp_C', n: 1, cause: 'memory_gap', reviewed: false },
    { kp: 'kp_A', n: 3, cause: 'other', reviewed: true },
  ];
  let li = 0;
  const insAttr = db.prepare(
    `INSERT INTO attributions (attribution_id, loop_id, anon_user_id, knowledge_point, knowledge_point_id, cause_id, expert_accuracy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) {
      const reviewed = g.reviewed && i === 0 ? 'accurate' : null;
      insAttr.run(`qa_${g.kp}_${i}`, loops[li], U, `知识点-${g.kp}`, g.kp, g.cause, reviewed);
      li++;
    }
  }
});

// ----------------- G1 闸门（纯函数） -----------------

test('scoreGate：全部达标 → passed=true, score=1', () => {
  const r = scoreGate({
    approval_rate: 0.8,
    three_item_rate: 0.9,
    upload_fail_rate: 0.01,
    completion_rate: 0.6,
    review_coverage: 0.5,
  });
  assert.equal(r.passed, true);
  assert.equal(r.readiness, 'ship');
  assert.equal(r.blockers.length, 0);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.score, 1);
});

test('scoreGate：approval_rate 低于阈值 → 阻断（blocker）', () => {
  const r = scoreGate({
    approval_rate: 0.5, // < 0.7
    three_item_rate: 0.9,
    upload_fail_rate: 0.01,
    completion_rate: 0.6,
    review_coverage: 0.5,
  });
  assert.equal(r.passed, false);
  assert.equal(r.readiness, 'hold');
  assert.ok(r.blockers.includes('归因认可率'));
  // 权重：blocker=2 + 4×warning=1 → 总 6；approval 失败(0)，其余 4 通过(各 1) → 4/6≈0.6667
  assert.equal(r.score, 0.6667);
});

test('scoreGate：review_coverage 低于阈值 → 仅 warning，不阻断', () => {
  const r = scoreGate({
    approval_rate: 0.8,
    three_item_rate: 0.9,
    upload_fail_rate: 0.01,
    completion_rate: 0.6,
    review_coverage: 0.1, // < 0.3
  });
  assert.equal(r.passed, true); // 无 blocker
  assert.ok(r.warnings.includes('盲评覆盖率'));
});

test('scoreGate：upload_fail_rate 超阈值（max 型） → warning', () => {
  const r = scoreGate({
    approval_rate: 0.8,
    three_item_rate: 0.9,
    upload_fail_rate: 0.2, // > 0.05
    completion_rate: 0.6,
    review_coverage: 0.5,
  });
  assert.ok(r.warnings.includes('上传失败率'));
});

// ----------------- B·C·D 分层（纯函数） -----------------

test('classifyStratum：D 干扰陷阱（高频 + 误解）', () => {
  assert.equal(classifyStratum({ error_count: 12, dominant_cause: 'concept_confusion' }), 'D');
  assert.equal(classifyStratum({ error_count: 10, dominant_cause: 'method_error' }), 'D');
});

test('classifyStratum：C 极端罕见（低频 或 罕见错因）', () => {
  assert.equal(classifyStratum({ error_count: 1, dominant_cause: 'other' }), 'C');
  assert.equal(classifyStratum({ error_count: 5, dominant_cause: 'memory_gap' }), 'C');
  assert.equal(classifyStratum({ error_count: 9, dominant_cause: 'reading_error' }), 'C');
});

test('classifyStratum：B 边界（中高频 或 误解）', () => {
  assert.equal(classifyStratum({ error_count: 5, dominant_cause: 'other' }), 'B');
  assert.equal(classifyStratum({ error_count: 3, dominant_cause: 'method_error' }), 'B');
});

test('classifyStratum：A 通用（其余）', () => {
  assert.equal(classifyStratum({ error_count: 3, dominant_cause: 'other' }), 'A');
});

// ----------------- 代理↔质量校准（纯函数） -----------------

test('calibrateQuality：置信度=1 → 信任代理（=raw）', () => {
  const r = calibrateQuality({ raw_score: 0.9, confidence: 1 });
  assert.equal(r.calibrated, 0.9);
});

test('calibrateQuality：置信度=0 → 回落先验（=0.5）', () => {
  const r = calibrateQuality({ raw_score: 0.9, confidence: 0 });
  assert.equal(r.calibrated, 0.5);
});

test('calibrateQuality：单调性（raw 越高校准分越高）', () => {
  const lo = calibrateQuality({ raw_score: 0.3, confidence: 0.6 }).calibrated;
  const hi = calibrateQuality({ raw_score: 0.8, confidence: 0.6 }).calibrated;
  assert.ok(hi > lo, `期望 ${hi} > ${lo}`);
});

test('calibrateQuality：中段数值正确', () => {
  // 0.6*0.8 + 0.4*0.5 = 0.48 + 0.2 = 0.68
  const r = calibrateQuality({ raw_score: 0.8, confidence: 0.6 });
  assert.equal(r.calibrated, 0.68);
});

// ----------------- computeStrataReport（临时库） -----------------

test('computeStrataReport：四层计数与已盲评覆盖正确', () => {
  const r = computeStrataReport();
  const byStratum = new Map(r.items.map((it) => [it.stratum, it]));
  assert.equal(r.total_kp, 4);
  assert.equal(byStratum.get('D')!.kp_count, 1);
  assert.equal(byStratum.get('D')!.reviewed_count, 1, 'kp_D 有一条已盲评');
  assert.equal(byStratum.get('D')!.coverage, 1);
  assert.equal(byStratum.get('B')!.kp_count, 1);
  assert.equal(byStratum.get('A')!.kp_count, 1);
  assert.equal(byStratum.get('A')!.reviewed_count, 1, 'kp_A 有一条已盲评');
  assert.equal(byStratum.get('C')!.kp_count, 1);
  assert.equal(byStratum.get('C')!.reviewed_count, 0);
});
