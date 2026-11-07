/**
 * quality-rubric.test.mjs — 归因质量量尺（A 层）离线单测
 *
 * 运行：node --test apps/api/src/tests/quality-rubric.test.mjs
 * 边界：纯离线，只读内存对象，不连模型、不启 3001、不碰生产库。
 * 重点防线：机器绝不给本质分 / 可指导分；接线不得破坏 auto-eval 原有判定导出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as autoEval from './auto-eval.mjs';
import {
  evaluateQualitySignals,
  summarizeQuality,
  buildReviewQueue,
  deriveDepthSignalLevel,
  extractExpectedCause,
  HUMAN_ONLY_DIMENSIONS,
  DEPTH_LEVELS,
  MACHINE_PROXY_KEYS,
} from './quality-rubric.mjs';

function diag(overrides = {}) {
  return {
    case_id: 'rm01',
    mode: 'diagnose',
    variant: 'v0.2b-guard-trap',
    trap: false,
    text: '错因：粗心\n知识点：等价无穷小\n本质：需展开到足够阶',
    fields: { cause: '粗心', knowledge_point: '等价无穷小', essence: '需展开到足够阶', hasThree: true },
    ...overrides,
  };
}

function teach(overrides = {}) {
  return {
    case_id: 'tm01',
    mode: 'teach',
    variant: 'v0.2b-guard-trap',
    trap: false,
    text: '正确答案：2\n正确推导：\n$$A$$\n$$B$$\n常见陷阱：忘记负号\n知识点：牛顿-莱布尼茨\n本质：端点差',
    fields: {
      correct_answer: '2',
      derivation: '$$A$$\n$$B$$',
      pitfalls: '忘记负号',
      knowledge_point: '牛顿-莱布尼茨公式',
      essence: '端点差',
      hasCore: true,
    },
    ...overrides,
  };
}

test('人工维度恒为 null，机器绝不产出 1–5 质量分', () => {
  assert.deepEqual([...HUMAN_ONLY_DIMENSIONS], [
    'essence_score_1_5', 'guide_score_1_5', 'preference', 'cohens_kappa',
  ]);
  for (const r of [diag(), teach()]) {
    const s = evaluateQualitySignals(r, {});
    assert.deepEqual(Object.keys(s.human_only), [...HUMAN_ONLY_DIMENSIONS]);
    assert.ok(Object.values(s.human_only).every((v) => v === null), '人工维度出现非 null 值');
    assert.equal(s.review_required, true);
    assert.ok(!('essence_score' in s) && !('guide_score' in s), '不得偷渡自动质量分字段');
  }
});

test('MACHINE_PROXY_KEYS 全部出现在单条结果中', () => {
  const s = evaluateQualitySignals(diag(), {});
  for (const k of MACHINE_PROXY_KEYS) assert.ok(k in s, `缺少代理量 ${k}`);
});

test('空标签错因被识别为结构缺口，机制词不误判', () => {
  const empty = evaluateQualitySignals(diag(), {});
  assert.equal(empty.cause_has_empty_label, true);
  assert.equal(empty.cause_has_mechanism, false);
  assert.equal(empty.depth_signal_level, 'L1');

  const mechanism = evaluateQualitySignals(diag({
    text: '错因：误把等价无穷小直接代换到加减运算，导致主部抵消\n知识点：x\n本质：y',
    fields: {
      cause: '误把等价无穷小直接代换到加减运算，导致主部抵消',
      knowledge_point: 'x', essence: 'y', hasThree: true,
    },
  }), {});
  assert.equal(mechanism.cause_has_empty_label, false);
  assert.equal(mechanism.cause_has_mechanism, true);
});

test('讲解模式 cause_* 代理量恒为 null（不冒充诊断结论）', () => {
  const s = evaluateQualitySignals(teach(), {});
  assert.equal(s.cause_has_empty_label, null);
  assert.equal(s.cause_has_mechanism, null);
  assert.equal(s.derivation_blocks, 2);
  assert.equal(s.pitfall_section, true);
  assert.equal(s.contract_complete, true);
});

test('契约缺项 → L1，且 structured_ids_present 能检出 KPI §6.3.1 缺口', () => {
  const broken = evaluateQualitySignals(diag({ fields: { cause: '粗心', hasThree: false } }), {});
  assert.equal(broken.contract_complete, false);
  assert.equal(broken.depth_signal_level, 'L1');

  const plain = evaluateQualitySignals(diag(), {});
  assert.equal(plain.structured_ids_present, false);
  const withIds = evaluateQualitySignals(diag({
    text: '{"kq_id":"math.limit.taylor","cause_id":"equiv_sub_in_sum"}',
  }), {});
  assert.equal(withIds.structured_ids_present, true);
});

test('depth_target 未提供如实计为 unspecified，不猜测、不填占位', () => {
  const unset = evaluateQualitySignals(diag(), {});
  assert.equal(unset.depth_target, null);
  assert.equal(unset.depth_target_status, 'unspecified');
  const set = evaluateQualitySignals(diag(), { depth_target: 'L3' });
  assert.equal(set.depth_target, 'L3');
  assert.equal(set.depth_target_status, 'set');
  const bad = evaluateQualitySignals(diag(), { depth_target: 'L9' });
  assert.equal(bad.depth_target_status, 'unspecified');
  assert.equal(Object.keys(DEPTH_LEVELS).length, 4);
});

test('deriveDepthSignalLevel 映射 L1–L4（结构信号，不是分数）', () => {
  const base = {
    contract_complete: true, cause_has_mechanism: false, derivation_blocks: 0,
    explains_why: false, actionable_hint: false, transfer_hint: false,
  };
  assert.equal(deriveDepthSignalLevel({ ...base, contract_complete: false }), 'L1');
  assert.equal(deriveDepthSignalLevel({ ...base, derivation_blocks: 1 }), 'L2');
  assert.equal(deriveDepthSignalLevel({ ...base, derivation_blocks: 2, actionable_hint: true }), 'L3');
  assert.equal(deriveDepthSignalLevel({ ...base, derivation_blocks: 2, explains_why: true, transfer_hint: true }), 'L4');
});

test('summarizeQuality 汇总比例、未标定计数与人工待评状态', () => {
  const list = [
    evaluateQualitySignals(diag({ case_id: 'a' }), {}),
    evaluateQualitySignals(diag({ case_id: 'b' }), { depth_target: 'L3' }),
    evaluateQualitySignals(teach({ case_id: 'c' }), {}),
  ];
  const s = summarizeQuality(list);
  assert.equal(s.n, 3);
  assert.equal(s.diagnose_n, 2);
  assert.equal(s.teach_n, 1);
  assert.equal(s.proxies.contract_complete.hits, 3);
  assert.equal(s.depth_target_unspecified_count, 2);
  assert.equal(s.review_queue_size, 3);
  assert.equal(s.human_only.status, 'PENDING_HUMAN_BLIND_REVIEW');
  assert.equal(s.human_only.values, null);
  assert.match(s.proxy_caveat, /未校准/);
  assert.match(s.proxy_caveat, /未命中 ≠ 质量差/);
  assert.match(s.disclaimer, /不得据本汇总推断 M1/);
});

test('buildReviewQueue 陷阱题 P0 > 诊断 P1 > 讲解 P2，且排序稳定', () => {
  const list = [
    evaluateQualitySignals(teach({ case_id: 't1' }), {}),
    evaluateQualitySignals(diag({ case_id: 'd1' }), {}),
    evaluateQualitySignals(diag({ case_id: 'trap1' }), { trap: true }),
  ];
  const q = buildReviewQueue(list);
  assert.equal(q.length, 3);
  assert.deepEqual(q.map((r) => r.priority), ['P0', 'P1', 'P2']);
  assert.equal(q[0].case_id, 'trap1');
  assert.equal(q[0].trap, true);
});

test('extractExpectedCause 只做展示抽取，无显式「错因：」时返回 null', () => {
  assert.equal(
    extractExpectedCause('正确答案为 1/2。错因：对相减的分子不能直接代换。应展开到足够阶。'),
    '对相减的分子不能直接代换',
  );
  assert.equal(extractExpectedCause('$\\int_0^\\pi\\sin x\\,dx=2$。'), null);
});

test('接线不破坏 auto-eval 原有判定导出（历史回放零变化的前置条件）', () => {
  for (const k of ['scoreResult', 'evalNumericFacts', 'evalTeach', 'evalDiagnose', 'computeTruthHitRate']) {
    assert.equal(typeof autoEval[k], 'function', `auto-eval 导出 ${k} 丢失`);
  }
  for (const k of ['evaluateQualitySignals', 'summarizeQuality', 'buildReviewQueue', 'HUMAN_ONLY_DIMENSIONS']) {
    assert.ok(k in autoEval, `auto-eval 未转出 ${k}`);
  }
  // 同一输入两次评分一致：新增只读字段不得渗入 verdict
  const r = diag({
    text: '错因：误把等价无穷小直接代换到加减运算\n知识点：x\n本质：y',
    fields: { cause: '误把等价无穷小直接代换到加减运算', knowledge_point: 'x', essence: 'y', hasThree: true },
  });
  const ctx = { truth: '错因：对相减的分子不能直接把各项用等价无穷小替换后再相减，否则会丢项。', isTrap: false };
  const a = autoEval.scoreResult(r, ctx);
  const b = autoEval.scoreResult(r, ctx);
  assert.deepEqual(a, b);
  assert.ok(['PASS', 'PARTIAL', 'FAIL'].includes(a.verdict));
});
