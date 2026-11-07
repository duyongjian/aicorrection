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
  resolveExpectedCause,
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
    // essence 刻意不含任何改错/迁移/解释词：本 fixture 用于检验「纯空标签 → L1」
    text: '错因：粗心\n知识点：等价无穷小\n本质：该知识点属于极限计算',
    fields: { cause: '粗心', knowledge_point: '等价无穷小', essence: '该知识点属于极限计算', hasThree: true },
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
  // 口径诚实性不变量（8283f96「非自证」措辞不实的回归护栏）：
  // 构造样本必须承认循环论证、不得包装成非自证；量尺不得据代理量给出质量结论。
  assert.match(s.proxy_caveat, /承认循环论证/);
  assert.match(s.proxy_caveat, /不得称为「非自证」/);
  assert.doesNotMatch(s.proxy_caveat, /不照词表写的|非自证构造样本/);
  assert.match(s.proxy_caveat, /不证明真实语料无误检/);
  assert.match(s.proxy_caveat, /命中 ≠ 质量达标/);
  assert.match(s.proxy_caveat, /本模块不提供质量结论/);
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

test('字段口径：actionable_hint / transfer_hint 纳入 essence，explains_why 排除以免恒真', () => {
  // 「本质」段是模型写改错指令与迁移提示的主要位置；v0.5-depth 明确要求写进这里。
  // 但 explains_why 词表含 /本质(上|是|在于)/，纳入会让该代理量恒真 → 必须继续排除。
  const r = diag({
    text: '错因：乘积求导少一项\n知识点：x\n本质：必须通过泰勒展开到三阶',
    fields: {
      cause: '乘积求导少一项',
      knowledge_point: 'x',
      essence: '必须通过泰勒展开到三阶；推广到更高阶相减情形同样适用。本质是精度不够',
      hasThree: true,
    },
  });
  const s = evaluateQualitySignals(r, {});
  assert.equal(s.actionable_hint, true, 'essence 里的改错指令必须被检出');
  assert.equal(s.transfer_hint, true, 'essence 里的迁移提示必须被检出');
  assert.equal(s.explains_why, false, 'essence 里的「本质是」不得造成 explains_why 恒真');

  // 把 essence 清空 → 两个代理量回到修复前口径（模拟回归）
  const stripped = diag({
    text: '错因：乘积求导少一项\n知识点：x\n本质：',
    fields: { cause: '乘积求导少一项', knowledge_point: 'x', essence: '', hasThree: true },
  });
  const s0 = evaluateQualitySignals(stripped, {});
  assert.equal(s0.actionable_hint, false);
  assert.equal(s0.transfer_hint, false);
});

test('口径修复副作用：essence 含改错指令会把结构等级由 L1 抬到 L2（预期，不是回归）', () => {
  const plain = evaluateQualitySignals(diag(), {});
  assert.equal(plain.actionable_hint, false);
  assert.equal(plain.depth_signal_level, 'L1');

  const withHint = evaluateQualitySignals(diag({
    fields: {
      cause: '粗心', knowledge_point: '等价无穷小',
      essence: '应展开到三阶再代入', hasThree: true,
    },
  }), {});
  assert.equal(withHint.actionable_hint, true);
  assert.equal(withHint.depth_signal_level, 'L2');
  // 口径变更后历史基线不可直接比较；A/B 两侧必须用同一口径重跑
  assert.equal(withHint.explains_why, false, 'explains_why 仍不得因 essence 恒真');
});

test('resolveExpectedCause 优先显式字段、陷阱题不回退猜测、否则回退「错因：」抽取', () => {
  assert.equal(
    resolveExpectedCause({ expected_cause: '漏掉 $uv\'$ 项', provisional_truth: '错因：不应采信此句' }),
    '漏掉 $uv\'$ 项',
  );
  assert.equal(
    resolveExpectedCause({
      expected_cause: null,
      expected_cause_status: 'not_applicable_trap',
      provisional_truth: '错因：陷阱题里即使写了这句也不得回退猜测',
    }),
    null,
  );
  assert.equal(
    resolveExpectedCause({ provisional_truth: '正确答案为 1/2。错因：对相减的分子不能直接代换。' }),
    '对相减的分子不能直接代换',
  );
  assert.equal(resolveExpectedCause({}), null);
  assert.equal(resolveExpectedCause({ expected_cause: '   ' }), null);
});

test('第二轮词表校准：构造样本（承认循环论证）不再漏检，且口径哨兵仍正确拒绝', () => {
  const diagWith = (cause, text) => diag({
    text: text || `错因：${cause}\n知识点：x\n本质：y`,
    fields: { cause, knowledge_point: 'x', essence: 'y', hasThree: true },
  });
  // 旧词表 17 条漏检里的代表性表达（不照正则写）
  assert.equal(evaluateQualitySignals(diagWith('疏忽大意'), {}).cause_has_empty_label, true);
  assert.equal(evaluateQualitySignals(diagWith('知识掌握得不扎实'), {}).cause_has_empty_label, true);
  assert.equal(evaluateQualitySignals(diagWith('把有序样本当无序组合计数'), {}).cause_has_mechanism, true);
  assert.equal(evaluateQualitySignals(diagWith('把 sinθ 与 cosθ 记反了'), {}).cause_has_mechanism, true);
  assert.equal(evaluateQualitySignals(diagWith('套用了并联公式，符号弄反'), {}).cause_has_mechanism, true);
  assert.equal(evaluateQualitySignals(diagWith('应当保留换元产生的 1/2 系数'), {}).actionable_hint, true);
  // 口径哨兵：空标签词 + 机制词 → 不得判为空标签
  assert.equal(evaluateQualitySignals(diagWith('概念混淆导致符号弄反'), {}).cause_has_empty_label, false);
  // 结构化 ID 不得把含 "id" 子串的普通词误判为 ID
  assert.equal(
    evaluateQualitySignals(diagWith('正确', 'considered valid width guide'), {}).structured_ids_present,
    false,
  );
  assert.equal(
    evaluateQualitySignals(diagWith('正确', '{"kq_id":"math.limit.taylor"}'), {}).structured_ids_present,
    true,
  );
});

test('evaluateQualitySignals 用 resolveExpectedCause 填入展示字段', () => {
  const c = {
    id: 'qm01', trap: false,
    expected_cause: '把乘积求导法则误记为 $(uv)\'=u\'v\'$',
    provisional_truth: '没有「错因：」前缀的真值文本',
    depth_target: 'L3',
  };
  const s = evaluateQualitySignals({ mode: 'diagnose', case_id: 'qm01', text: '', fields: { hasThree: true } }, c);
  assert.equal(s.expected_cause, '把乘积求导法则误记为 $(uv)\'=u\'v\'$');
  assert.equal(s.depth_target, 'L3');

  const trap = {
    id: 'qm11', trap: true, expected_cause: null,
    expected_cause_status: 'not_applicable_trap',
    provisional_truth: '错因：这句不该被抽出来',
  };
  const st = evaluateQualitySignals({ mode: 'diagnose', case_id: 'qm11', text: '', fields: { hasThree: true } }, trap);
  assert.equal(st.trap, true);
  assert.equal(st.expected_cause, null);
});

// ── 以下两条为词表校准任务（D）补充：仅断言「结构信号能否被检出」，非质量分 ──

test('expected_cause 三分支（经 evaluateQualitySignals 接线视角）', () => {
  const r = diag();
  // 显式字段优先：即使 provisional_truth 没有「错因：」前缀也能取到（修复 qm01 类缺口）
  assert.equal(
    evaluateQualitySignals(r, {
      expected_cause: '把乘积求导法则记反了，漏掉交叉项',
      provisional_truth: '没有「错因：」前缀的真值文本',
    }).expected_cause,
    '把乘积求导法则记反了，漏掉交叉项',
  );
  // 显式字段优先于 truth 里的「错因：」片段
  assert.equal(
    evaluateQualitySignals(r, {
      expected_cause: '显式声明的错因',
      provisional_truth: '错因：来自真值片段，不应被优先采用。',
    }).expected_cause,
    '显式声明的错因',
  );
  // 陷阱题 not_applicable_trap：直接 null，truth 含「错因：」也不得回退猜测
  assert.equal(
    evaluateQualitySignals(r, {
      expected_cause: null,
      expected_cause_status: 'not_applicable_trap',
      provisional_truth: '错因：陷阱题里这句绝不能被抽出来。',
    }).expected_cause,
    null,
  );
  // 回退：无显式字段、非陷阱 → extractExpectedCause(provisional_truth)
  assert.equal(
    evaluateQualitySignals(r, {
      provisional_truth: '正确答案为 1/2。错因：对相减的分子不能直接代换。应展开到足够阶。',
    }).expected_cause,
    '对相减的分子不能直接代换',
  );
  // 仍无则 null
  assert.equal(
    evaluateQualitySignals(r, { provisional_truth: '只有解答，没有错因前缀。' }).expected_cause,
    null,
  );
});

test('校准后 6 个词表类：代表性边界样本各 1 正 1 负（结构信号，非质量分）', () => {
  // essence 置空，使 actionNarrative 与 narrative 一致，隔离字段口径干扰；
  // 正/负样本取自 quality-proxy-calibration.mjs 的构造样本（承认循环论证，仅作回归护栏）
  const withCause = (cause, text) => ({
    ...diag(),
    text: text !== undefined ? text : `错因：${cause}\n知识点：x\n本质：y`,
    fields: { cause, knowledge_point: 'x', essence: '', hasThree: true },
  });
  const check = (key, pos, neg) => {
    assert.equal(evaluateQualitySignals(withCause(pos), {})[key], true, `${key} 正样本应命中：${pos}`);
    assert.equal(evaluateQualitySignals(withCause(neg), {})[key], false, `${key} 负样本不应命中：${neg}`);
  };
  // 负样本刻意选「近似但不含该信号」或专门哨兵，验证词表未放宽到恒真
  check('cause_has_empty_label', '疏忽大意', '误把 uv 撇 当成乘积求导法则');
  check('cause_has_mechanism', '把有序样本当无序组合计数', '基础不牢');
  check('actionable_hint', '应当保留换元产生的 1/2 系数', '正确答案为 1/6');
  check('explains_why', '其理由是变化率与当前值成正比', '先通分，再约分，得到 -1/6。');
  check('transfer_hint', '凡是含常数项的递推都可这样平移构造', '本题答案为 -1/6。');
  // structured_ids_present 看 result.text：camelCase 应命中、含 id 子串的普通词不得命中
  assert.equal(
    evaluateQualitySignals(withCause('正确', '{"kqId":"math.limit.taylor"}'), {}).structured_ids_present,
    true,
  );
  assert.equal(
    evaluateQualitySignals(withCause('正确', '{"valid": true, "guide": "review"}'), {}).structured_ids_present,
    false,
  );
});
