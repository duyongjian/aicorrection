/**
 * 题库 RAG 单元测试（node:test）
 *
 * 通过临时 DB 隔离，验证：
 *  1) localHashEmbed 确定性 + L2 模≈1
 *  2) query 对"隐函数求导"召回 M-impl-diff 且分数高于无关题（E-virtual）
 *  3) buildReferenceBlock 不含四标记词（错因/错误原因/知识点/本质）
 *  4) retrieveReferences：已索引 → ok 非空；空库 → empty；嵌入异常 → unavailable（不抛错）
 *
 * 运行：npm -w @aicorrection/api run test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 在 import 业务模块前设定临时 DB，确保 getDb 落到隔离库（不污染真库）。
const tmpDb = path.join(os.tmpdir(), `qbank-rag-test-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

const { localHashEmbed, embed, embedBatch, RAG_DIM, embedItemSource } = await import(
  './embeddingService'
);
const { cosineSimilarity } = await import('../../utils/math');
const { buildReferenceBlock } = await import('../attribution/prompt');
const { insertQbankItem, updateEmbedding, getQbankById, getAllQbankForEmbedding } =
  await import('../../models/qbankModel');
const { query, upsertVec } = await import('./vectorStore');
const { retrieveReferences } = await import('./ragService');
const env = (await import('../../config/env')).env;
const { getDb, __resetDbSingleton } = await import('../../db');

// 退出时清理临时 DB（含 WAL/日志）
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-journal', '-shm']) {
    try {
      fs.rmSync(tmpDb + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
});

const M_IMPL_DIFF = {
  item_id: 'M-impl-diff',
  subject: 'math',
  question_text: '求由方程 x^2 + y^2 = 25 所确定的隐函数 y 对 x 的导数 dy/dx。',
  answer_text: '对方程两边关于 x 求导，注意 y 是 x 的函数，得 2x + 2y·y\' = 0，故 y\' = -x/y。',
  knowledge_point: '隐函数求导（链式法则）',
};

const E_VIRTUAL = {
  item_id: 'E-virtual',
  subject: 'english',
  question_text: 'If I ___ (be) you, I would take the job.',
  answer_text: '填 were（虚拟语气中不论人称均用 were）。与现在事实相反的条件句，主句用 would。',
  knowledge_point: '虚拟语气（与现在事实相反）',
};

function seedIndexed(): void {
  getDb(); // 触发迁移
  insertQbankItem({ ...M_IMPL_DIFF, solution_steps: null });
  insertQbankItem({ ...E_VIRTUAL, solution_steps: null });
  const a = getQbankById(M_IMPL_DIFF.item_id)!;
  const b = getQbankById(E_VIRTUAL.item_id)!;
  upsertVec(a.item_id, embed(embedItemSource(a)));
  upsertVec(b.item_id, embed(embedItemSource(b)));
}

test('localHashEmbed 确定性 + L2 模≈1', () => {
  const v1 = localHashEmbed('隐函数求导 链式法则');
  const v2 = localHashEmbed('隐函数求导 链式法则');
  assert.deepEqual(v1, v2);
  assert.equal(v1.length, RAG_DIM);
  const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `L2 norm 应≈1，实际 ${norm}`);
});

test('embed / embedBatch 一致且可复现', () => {
  const single = embed('链式法则 漏系数');
  const batch = embedBatch(['链式法则 漏系数']);
  assert.deepEqual(single, batch[0]);
});

test('query 对"隐函数求导"召回 M-impl-diff 且分数高于无关题', () => {
  seedIndexed();
  const q = embed('隐函数求导 dy/dx 隐函数方程 两边求导');
  const scored = query(q, 4);
  assert.ok(scored.length >= 1, '应至少召回 1 条');
  assert.equal(scored[0].item_id, 'M-impl-diff', '最相关应为 M-impl-diff');
  const mScore = scored.find((s) => s.item_id === 'M-impl-diff')!.score;
  const eScore = scored.find((s) => s.item_id === 'E-virtual')!.score;
  assert.ok(mScore > eScore, `M-impl-diff(${mScore}) 应高于 E-virtual(${eScore})`);
});

test('buildReferenceBlock 不含四标记词', () => {
  const ref = {
    status: 'ok' as const,
    source: 'qbank' as const,
    items: [
      {
        item_id: 'M-impl-diff',
        title: '隐函数求导',
        snippet: '对方程两边求导注意 y 是 x 的函数',
        knowledge_point: '隐函数求导',
        score: 0.91,
      },
    ],
  };
  const block = buildReferenceBlock(ref);
  assert.ok(block.length > 0, 'ok 状态应渲染参考块');
  assert.ok(
    !/错因|知识点|本质|错误原因/.test(block),
    `参考块不得含契约标记词，实际：${block}`
  );
});

test('buildReferenceBlock 在 empty/unavailable 时返回空串', () => {
  assert.equal(buildReferenceBlock({ status: 'empty', source: 'qbank', items: [] }), '');
  assert.equal(
    buildReferenceBlock({ status: 'unavailable', source: 'qbank', items: [] }),
    ''
  );
});

test('retrieveReferences 已索引返回 ok 非空，且不抛错', async () => {
  seedIndexed();
  const r = await retrieveReferences('隐函数求导 dy/dx');
  assert.equal(r.source, 'qbank');
  assert.equal(r.status, 'ok');
  assert.ok(r.items.length >= 1);
  assert.equal(r.items[0].item_id, 'M-impl-diff');
  assert.ok(r.items[0].score >= 0 && r.items[0].score <= 1);
});

test('retrieveReferences 空库返回 empty（不抛错）', async () => {
  // env.DB_PATH 为导入时快照、getDb 又是单例，故须同时改 env.DB_PATH 并复位单例才能切到新空库。
  const emptyDb = path.join(os.tmpdir(), `qbank-rag-empty-${Date.now()}.db`);
  const prevPath = env.DB_PATH;
  env.DB_PATH = emptyDb;
  __resetDbSingleton();
  getDb(); // 新空库，迁移建表（含 009 qbank_items），但无题库项
  const r = await retrieveReferences('任何题干');
  assert.equal(r.status, 'empty');
  assert.deepEqual(r.items, []);
  // 还原主测试库，避免影响后续用例
  env.DB_PATH = prevPath;
  __resetDbSingleton();
  getDb();
  for (const s of ['', '-wal', '-journal', '-shm']) {
    try {
      fs.rmSync(emptyDb + s, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test('retrieveReferences 嵌入异常返回 unavailable（不抛错）', async () => {
  const prev = env.RAG_EMBED_MODEL;
  env.RAG_EMBED_MODEL = 'bge'; // 触发 embed 抛错（未接入）
  try {
    const r = await retrieveReferences('测试');
    assert.equal(r.status, 'unavailable');
    assert.deepEqual(r.items, []);
  } finally {
    env.RAG_EMBED_MODEL = prev; // 还原，避免影响其他用例
  }
});

test('getAllQbankForEmbedding 仅返回未完成项（断点续跑）', () => {
  seedIndexed();
  // 两条都已 done → 不应再出现在待嵌入列表
  const pending = getAllQbankForEmbedding();
  assert.ok(!pending.some((p) => p.item_id === 'M-impl-diff'));
  assert.ok(!pending.some((p) => p.item_id === 'E-virtual'));
});

void cosineSimilarity; // 保留引用（部分用例直接使用）
