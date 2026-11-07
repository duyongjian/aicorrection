/**
 * P2 知识点/错因单元测试（R17 自定义知识点 / R20 手动错因 / R18 知识图谱）。
 * 隔离：顶层先设临时库路径再动态 import。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-p2-know-test-'));
const dbPath = path.join(tmpDir, 'p2-know-test.db');
const uploadDir = path.join(tmpDir, 'uploads');

process.env.AICORRECTION_DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;

const { getDb, __resetDbSingleton } = await import('../db');
const {
  createCustomKp,
  listCustomKps,
  setManualCause,
  getKnowledgeGraph,
} = await import('./knowledgeService');
const { ERROR_CODES } = await import('@aicorrection/shared');

const U = 'u-know';

function seed() {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`).run(U);
  // attributions.loop_id 引用 loop_sessions，必须先建父行
  for (const lid of ['lk1', 'lk2', 'lk3', 'lkx']) {
    db.prepare(
      `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
       VALUES (?, ?, 'kaoyan', 's1', datetime('now'), 0)`
    ).run(lid, U);
  }
  // 三条归因：kp_001 与 kp_002 共享 concept_confusion（应连边）；kp_003 用 method_error（孤立）
  db.prepare(
    `INSERT INTO attributions (attribution_id, loop_id, anon_user_id, knowledge_point, knowledge_point_id, cause_id)
     VALUES ('ka1','lk1',?,'一元一次方程','kp_001','concept_confusion'),
            ('ka2','lk2',?,'函数','kp_002','concept_confusion'),
            ('ka3','lk3',?,'导数','kp_003','method_error')`
  ).run(U, U, U);
  // 供 R20 覆盖测试
  db.prepare(
    `INSERT INTO attributions (attribution_id, loop_id, anon_user_id, knowledge_point, knowledge_point_id, cause_id)
     VALUES ('kx1','lkx',?,'几何','kp_old','concept_confusion')`
  ).run(U);
  // R18 图专用隔离数据（独立用户 UG，避免被 R20 的 cause 改写影响）
  const UG = 'u-graph';
  db.prepare(`INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`).run(UG);
  for (const lid of ['lg1', 'lg2', 'lg3']) {
    db.prepare(
      `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
       VALUES (?, ?, 'kaoyan', 's1', datetime('now'), 0)`
    ).run(lid, UG);
  }
  db.prepare(
    `INSERT INTO attributions (attribution_id, loop_id, anon_user_id, knowledge_point, knowledge_point_id, cause_id)
     VALUES ('kg1','lg1',?,'一元一次方程','kp_001','concept_confusion'),
            ('kg2','lg2',?,'函数','kp_002','concept_confusion'),
            ('kg3','lg3',?,'导数','kp_003','method_error')`
  ).run(UG, UG, UG);
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

test('R17 createCustomKp：kp_id 以 ckp_ 前缀，listCustomKps 可查', () => {
  const r = createCustomKp({ anon_user_id: U, kp_text: '极限' });
  assert.ok(r.kp_id.startsWith('ckp_'));
  assert.equal(r.kp_text, '极限');
  const list = listCustomKps(U);
  assert.ok(list.items.some((i) => i.kp_id === r.kp_id && i.kp_text === '极限'));
});

test('R17 缺 kp_text → 400 PARAM_INVALID', () => {
  assert.throws(
    () => createCustomKp({ anon_user_id: U, kp_text: '' }),
    (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID
  );
});

test('R20 setManualCause：覆盖 cause_id 生效', () => {
  const r = setManualCause({ loop_id: 'lkx', anon_user_id: U, cause_id: 'method_error' });
  assert.equal(r.cause_id, 'method_error');
  const row = getDb().prepare('SELECT cause_id FROM attributions WHERE loop_id=?').get('lkx') as { cause_id: string };
  assert.equal(row.cause_id, 'method_error');
});

test('R20 非法 cause_id → 400 PARAM_INVALID', () => {
  assert.throws(
    () => setManualCause({ loop_id: 'lkx', anon_user_id: U, cause_id: 'not_a_real_cause' }),
    (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID
  );
});

test('R20 越权/不存在 loop → 404 NOT_FOUND', () => {
  assert.throws(
    () => setManualCause({ loop_id: 'no-such-loop', anon_user_id: U, cause_id: 'method_error' }),
    (e: Error) => (e as { code?: number }).code === ERROR_CODES.NOT_FOUND
  );
});

test('R18 getKnowledgeGraph：共享错因连边，孤立点无连接', () => {
  const g = getKnowledgeGraph('u-graph');
  const keys = new Set(g.nodes.map((n) => n.kp_key));
  assert.ok(keys.has('kp_001'));
  assert.ok(keys.has('kp_002'));
  assert.ok(keys.has('kp_003'));
  // kp_001 与 kp_002 共享 concept_confusion → 一条边
  const edge = g.edges.find(
    (e) => (e.source === 'kp_001' && e.target === 'kp_002') || (e.source === 'kp_002' && e.target === 'kp_001')
  );
  assert.ok(edge, 'kp_001 与 kp_002 应有共现边');
  assert.equal(edge!.weight, 1);
  // kp_003 使用不同错因，不应与任何点相连
  const edgesTouching003 = g.edges.filter((e) => e.source === 'kp_003' || e.target === 'kp_003');
  assert.equal(edgesTouching003.length, 0);
  // 节点 error_count 累计
  const n001 = g.nodes.find((n) => n.kp_key === 'kp_001')!;
  assert.equal(n001.error_count, 1);
});
