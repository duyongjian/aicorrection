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
  getKpMistakes,
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

  // R18 断链回归：真实归因写库时 id 恒 null，只有 knowledge_point 文本。
  const UT = 'u-graph-text';
  db.prepare(`INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`).run(UT);
  for (const lid of ['lt1', 'lt2', 'lt3', 'lt4', 'lt5']) {
    db.prepare(
      `INSERT INTO loop_sessions (loop_id, anon_user_id, segment, session_id, start_ts, loop_complete)
       VALUES (?, ?, 'kaoyan', 's1', datetime('now'), 0)`
    ).run(lid, UT);
  }
  db.prepare(
    `INSERT INTO attributions
       (attribution_id, loop_id, anon_user_id, question, cause, knowledge_point, knowledge_point_id, cause_id)
     VALUES ('kt1','lt1',?,'求数列极限 A','概念混淆A','数列极限',NULL,'concept_confusion'),
            ('kt2','lt2',?,'求数列极限 B','概念混淆B','数列极限',NULL,'concept_confusion'),
            ('kt3','lt3',?,'判断连续性','概念混淆C','函数连续性',NULL,'concept_confusion'),
            ('kt4','lt4',?,'无知识点题目',NULL,NULL,NULL,NULL),
            ('kt5','lt5',?,'空白知识点题目',NULL,'   ',NULL,NULL)`
  ).run(UT, UT, UT, UT, UT);
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

test('R18 断链回归：只有 knowledge_point 文本（id=null）的归因也进入图谱', () => {
  const g = getKnowledgeGraph('u-graph-text');
  const limit = g.nodes.find((n) => n.kp_key === 'txt:数列极限');
  assert.ok(limit, '应生成 txt:数列极限 节点');
  assert.equal(limit!.kp_text, '数列极限', '显示文本必须是真实知识点，而不是 id');
  assert.equal(limit!.error_count, 2);
  assert.ok(g.nodes.some((n) => n.kp_key === 'txt:函数连续性'));
  // 知识点与题面均为空的老数据不应制造噪声节点
  assert.ok(!g.nodes.some((n) => n.kp_key === 'txt:（未标注知识点）'));
  const edge = g.edges.find(
    (e) =>
      (e.source === 'txt:数列极限' && e.target === 'txt:函数连续性') ||
      (e.target === 'txt:数列极限' && e.source === 'txt:函数连续性')
  );
  assert.ok(edge, '文本知识点共享 concept_confusion，应连边');
  assert.equal(edge!.weight, 1);
});

test('R18 getKpMistakes：txt: 与受控 id 两种 kp_key 都能命中', () => {
  const textRes = getKpMistakes('u-graph-text', 'txt:数列极限');
  assert.equal(textRes.kp_key, 'txt:数列极限');
  assert.equal(textRes.kp_text, '数列极限');
  assert.equal(textRes.items.length, 2);
  assert.ok(textRes.items.every((i) => i.knowledge_point === '数列极限'));
  assert.ok(textRes.items.some((i) => i.question === '求数列极限 A'));
  assert.ok(textRes.items.every((i) => i.created_at));

  const idRes = getKpMistakes('u-graph', 'kp_001');
  assert.equal(idRes.kp_text, '一元一次方程');
  assert.equal(idRes.items.length, 1);
  assert.equal(idRes.items[0].attribution_id, 'kg1');

  // kp_key 首尾空白归一化，与 normalizeKpKey 口径一致
  assert.equal(getKpMistakes('u-graph-text', '  txt:数列极限  ').items.length, 2);
  assert.equal(getKpMistakes('u-graph-text', 'txt:不存在的知识点').items.length, 0);
});

test('R18 getKpMistakes：参数缺失 → 400 PARAM_INVALID', () => {
  assert.throws(
    () => getKpMistakes('u-graph', ''),
    (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID
  );
  assert.throws(
    () => getKpMistakes('', 'kp_001'),
    (e: Error) => (e as { code?: number }).code === ERROR_CODES.PARAM_INVALID
  );
});
