#!/usr/bin/env node
/**
 * auto-eval 数值一致性判据离线单测（node:test，纯离线、不调任何模型服务）。
 *
 * 运行：
 *   node --test apps/api/src/tests/auto-eval.numeric.test.mjs
 *
 * 覆盖：
 *   - 正确配对 → PASS；配对写反 → FAIL；驻点算错 → FAIL
 *   - 其余 3 道专项题（区间开闭 / 拐点符号翻转 / 数列配对）正确与错误输出
 *   - 旧 case 无 expected_facts → 评分结果与改动前完全一致（仍走 evalTeach / evalDiagnose）
 *   - 命中率过低（漏 --set）→ 非零退出并提示 --set
 *   - 现成 ext 报告的 10 条错误输出至少 9 条判 FAIL
 *
 * 所有 report 均在内存/临时目录构造，仅读取仓库内既有 reports/*.json 作回归证据，
 * 不联网、不访问 8085/8087 模型服务、不启动 3001 API、不碰生产库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  evalTeach,
  evalDiagnose,
  evalNumericFacts,
  scoreResult,
  computeTruthHitRate,
  extractNumbers,
  extractBindings,
  MIN_TRUTH_HIT_RATE,
} from './auto-eval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const AUTO_EVAL = path.join(HERE, 'auto-eval.mjs');
const SET_PATH = path.join(HERE, 'fixtures', 'prompt-ab-set-realexam.json');
const DEFAULT_SET_PATH = path.join(HERE, 'fixtures', 'prompt-ab-set.json');
const EXT_REPORT = path.join(REPO_ROOT, 'reports', 'prompt-ab-2026-11-05T16-24-06-4b-ext.json');

const setDoc = JSON.parse(fs.readFileSync(SET_PATH, 'utf8'));
const gold = (id) => {
  const c = setDoc.cases.find((x) => x.id === id);
  assert.ok(c, `题集应包含 ${id}`);
  assert.ok(c.expected_facts, `${id} 应声明 expected_facts`);
  return c.expected_facts;
};

/** 构造一条与 prompt-ab.mjs 产出结构一致的结果（fields + text 五段格式）。 */
function makeResult(caseId, correctAnswer, derivation = '') {
  const text = [
    `正确答案：${correctAnswer}`,
    '正确推导：',
    derivation,
    '常见陷阱：',
    '无',
    '知识点：',
    '导数与极值',
    '本质：',
    '利用导数判断单调性与极值',
  ].join('\n');
  return {
    case_id: caseId,
    mode: 'teach',
    difficulty: '中等',
    subject: 'math',
    trap: false,
    variant: 'offline-test',
    ok: true,
    err: null,
    fields: { correct_answer: correctAnswer, derivation, hasCore: true },
    text,
  };
}

/** 构造一份最小离线 report。 */
function makeReport(results) {
  return { generated_at: new Date().toISOString(), set: SET_PATH, set_version: setDoc.version, results };
}

// ── nx01：驻点 ↔ 极值类型 ↔ 函数值 三元配对 ────────────────────────────────────
const CORRECT_NX01 = '驻点 x=-1 与 x=1；增区间 [-2,-1] 和 [1,2]，减区间 [-1,1]；极大值 f(-1)=2，极小值 f(1)=-2。';
const DER_NX01 = "f'(x)=3x^2-3=0 解得 x=-1 或 x=1；f'(x)>0 当 x<-1 或 x>1，f'(x)<0 当 -1<x<1。";
const SWAPPED_NX01 = '驻点 x=-1 与 x=1；增区间 [-2,-1] 和 [1,2]，减区间 [-1,1]；极大值 f(1)=2，极小值 f(-1)=-2。';
const WRONG_STATIONARY_NX01 = '驻点 x=0 与 x=2；极大值 f(-1)=2，极小值 f(1)=-2。';

test('nx01 正确配对（极大值 f(-1)=2、极小值 f(1)=-2）→ PASS', () => {
  const res = evalNumericFacts(makeResult('nx01', CORRECT_NX01, DER_NX01), gold('nx01'));
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.reason, 'numeric_facts_match');
});

test('nx01 配对写反（数字全对但极大/极小互换）→ FAIL / numeric_pair_mismatch', () => {
  const res = evalNumericFacts(makeResult('nx01', SWAPPED_NX01, DER_NX01), gold('nx01'));
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, 'numeric_pair_mismatch');
  assert.match(res.detail, /极大值/);
  assert.match(res.detail, /极小值/);
  assert.match(res.detail, /f\(-1\)=2/);
});

test('nx01 驻点算错（0/2 代替 -1/1，配对本身正确）→ FAIL / numeric_set_mismatch', () => {
  const res = evalNumericFacts(makeResult('nx01', WRONG_STATIONARY_NX01, ''), gold('nx01'));
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, 'numeric_set_mismatch');
  assert.match(res.detail, /驻点/);
  assert.match(res.detail, /缺失=\[-1,1\]/);
});

test('nx01 只做数字集合交集不能蒙混：数字全对但配对为别处数值 → FAIL', () => {
  // 答案里出现 -2 -1 1 2 全部数字，但极值处绑定的是 f(0)=0 / f(2)=-4
  const wrong = '增区间 [-2,0] 和 [2,2]，减区间 [0,2]；极大值 f(0)=0，极小值 f(2)=-4。';
  const res = evalNumericFacts(makeResult('nx01', wrong, ''), gold('nx01'));
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, 'numeric_pair_mismatch');
});

// ── 其余 3 道专项题 ────────────────────────────────────────────────────────────
test('nx02 单调区间开闭 + 导数符号 + 极值配对：正确 → PASS，开区间写错 → FAIL', () => {
  const right = '增区间 [-2,-1] 和 [1,2]，减区间 [-1,1]；极大值 f(-1)=2，极小值 f(1)=-2。';
  const der = "f'(x)=3x^2-3；f'(x)>0 当 x<-1 或 x>1，f'(x)<0 当 -1<x<1。";
  assert.equal(evalNumericFacts(makeResult('nx02', right, der), gold('nx02')).verdict, 'PASS');

  const openWrong = '增区间 (-2,-1) 和 (1,2)，减区间 (-1,1)；极大值 f(-1)=2，极小值 f(1)=-2。';
  const res = evalNumericFacts(makeResult('nx02', openWrong, der), gold('nx02'));
  assert.equal(res.verdict, 'FAIL');
  assert.match(res.reason, /numeric_(interval|pair)_mismatch/);
  assert.match(res.detail, /增区间|减区间/);
});

test('nx03 二阶导拐点与符号翻转：正确 → PASS，拐点坐标写反 → FAIL', () => {
  const right = "f''(x)=6x-6；拐点 (1,-2)。";
  const der = "f'(x)=3x^2-6x，f''(x)=6x-6。f''(x)=0 得 x=1；x<1 时 f''(x)<0，x>1 时 f''(x)>0，符号由负变正。";
  assert.equal(evalNumericFacts(makeResult('nx03', right, der), gold('nx03')).verdict, 'PASS');

  const swapped = "f''(x)=6x-6；拐点 (-2,1)。";
  const res = evalNumericFacts(makeResult('nx03', swapped, der), gold('nx03'));
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, 'numeric_pair_mismatch');
  assert.match(res.detail, /拐点/);
});

test('nx04 数列/方程多步求解：正确 → PASS，a_5 配对写错 → FAIL', () => {
  const right = '通项 a_n=2^{n}-1；a_3=7，a_5=31；方程 x^2-5x+6=0 的两根为 2 与 3。';
  assert.equal(evalNumericFacts(makeResult('nx04', right), gold('nx04')).verdict, 'PASS');

  const wrong = '通项 a_n=2^{n}-1；a_3=7，a_5=15；方程 x^2-5x+6=0 的两根为 2 与 3。';
  const res = evalNumericFacts(makeResult('nx04', wrong), gold('nx04'));
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, 'numeric_pair_mismatch');
  assert.match(res.detail, /a_5/);
});

// ── 判据基本能力 ────────────────────────────────────────────────────────────────
test('数值归一化：±1 展开为 -1/1、Unicode 下标、分数、指数不污染数值', () => {
  assert.deepEqual(extractNumbers('解得 x=±1'), [-1, 1]);
  assert.deepEqual(extractNumbers('a₅=31'), [5, 31]);
  assert.ok(extractNumbers('\\frac{1}{2}').includes(0.5));
  assert.ok(!extractNumbers('f(x)=x^{3}-3x').includes(3 + 0)); // 指数 3 被剔除
});

test('配对绑定抽取：函数式 / 坐标式 / 数列式', () => {
  const pairs = (s) => extractBindings(s).map((b) => [b.at, b.value]);
  assert.deepEqual(pairs('极大值 f(-1)=2'), [[-1, 2]]);
  assert.deepEqual(pairs('拐点 (1,-2)'), [[1, -2]]);
  assert.deepEqual(pairs('a_5=31'), [[5, 31]]);
  assert.deepEqual(pairs('极大值 f(1)=2，极小值 f(-1)=-2'), [[1, 2], [-1, -2]]);
});

test('expected_facts 为空 / 无可用答案 → FAIL，绝不静默通过', () => {
  assert.equal(evalNumericFacts(makeResult('nx01', CORRECT_NX01), { assertions: [] }).reason, 'numeric_facts_empty');
  const empty = { case_id: 'nx01', mode: 'teach', fields: {}, text: '' };
  assert.equal(evalNumericFacts(empty, gold('nx01')).reason, 'numeric_missing_answer');
});

test('回落 r.text：无 fields 时从「正确答案：」行消费', () => {
  const r = {
    case_id: 'nx01',
    mode: 'teach',
    text: `正确答案：${CORRECT_NX01}\n正确推导：\n${DER_NX01}`,
  };
  assert.equal(evalNumericFacts(r, gold('nx01')).verdict, 'PASS');
});

// ── 向后兼容：无 expected_facts 的 case 一行不改 ───────────────────────────────
test('旧 teach case（无 expected_facts）→ 与 evalTeach 原判定完全一致', () => {
  const old = setDoc.cases.find((c) => c.id === 'tm01');
  assert.equal(old.expected_facts, undefined);
  const r = makeResult('tm01', '2', '[-cos x] = 2');
  const expected = evalTeach(r.text, old.provisional_truth);
  const actual = scoreResult(r, { truth: old.provisional_truth, isTrap: false, expectedFacts: undefined });
  assert.deepEqual(actual, expected);
  assert.notEqual(actual.reason, 'numeric_facts_match');
});

test('旧 diagnose case（无 expected_facts）→ 与 evalDiagnose 原判定完全一致', () => {
  const old = setDoc.cases.find((c) => c.id === 'rm02');
  assert.equal(old.expected_facts, undefined);
  const r = {
    case_id: 'rm02',
    mode: 'diagnose',
    text: '错因：把乘积的积分拆成积分的乘积，属于运算律误用，应使用分部积分法。',
  };
  const expected = evalDiagnose(r.text, old.provisional_truth, false);
  const actual = scoreResult(r, { truth: old.provisional_truth, isTrap: false, expectedFacts: undefined });
  assert.deepEqual(actual, expected);
});

test('题集 29 道历史 case 逐字未改（无 expected_facts），新增 4 道均带金标准', () => {
  assert.equal(setDoc.version, 'real-exam-v2');
  assert.equal(setDoc.cases.length, 33);
  assert.equal(setDoc.cases.slice(0, 29).filter((c) => c.expected_facts).length, 0);
  assert.deepEqual(setDoc.cases.slice(29).map((c) => c.id), ['nx01', 'nx02', 'nx03', 'nx04']);
  assert.ok(setDoc.cases.slice(29).every((c) => c.mode === 'teach' && c.expected_facts.schema === 1));
});

test('computeTruthHitRate：命中/漏传 --set 的量化', () => {
  const truthMap = new Map(setDoc.cases.map((c) => [c.id, c.provisional_truth]));
  assert.deepEqual(computeTruthHitRate(makeReport([makeResult('nx01', CORRECT_NX01)]).results, truthMap),
    { hits: 1, total: 1, rate: 1 });
  const miss = computeTruthHitRate([{ case_id: 'zz_unknown' }], truthMap);
  assert.equal(miss.rate, 0);
  assert.ok(miss.rate < MIN_TRUTH_HIT_RATE);
});

// ── CLI：漏 --set 的静默假结论必须报错并非零退出 ───────────────────────────────
function withTempReport(report, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicorrection-numeric-'));
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI 漏 --set（金标准大面积为空）→ 非零退出 + 提示 --set', () => {
  const report = makeReport([
    { ...makeResult('zz_unknown_1', '任意答案'), case_id: 'zz_unknown_1' },
    { ...makeResult('zz_unknown_2', '任意答案'), case_id: 'zz_unknown_2' },
  ]);
  withTempReport(report, (file) => {
    const r = spawnSync(process.execPath, [AUTO_EVAL, '--json', file], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, '漏 --set 必须非零退出');
    assert.match(`${r.stderr}${r.stdout}`, /--set/);
    assert.match(`${r.stderr}${r.stdout}`, /命中率过低/);
  });
});

test('CLI 显式 --set 且 case_id 命中 → 退出 0，不误伤 attrib-regress 的正常路径', () => {
  const report = makeReport([makeResult('nx01', CORRECT_NX01, DER_NX01)]);
  withTempReport(report, (file) => {
    const r = spawnSync(process.execPath, [AUTO_EVAL, '--json', file, '--set', SET_PATH], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /PASS: 1/);
  });
  // 默认题集（prompt-ab-set.json）与 real-exam-v2 报告 case_id 完全不重叠 → 必须报错
  assert.ok(fs.existsSync(DEFAULT_SET_PATH));
  withTempReport(report, (file) => {
    const r = spawnSync(process.execPath, [AUTO_EVAL, '--json', file, '--set', DEFAULT_SET_PATH], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, '题集与报告不匹配时必须非零退出');
  });
});

// ── 现成验收证据：10 条极值错误输出 ────────────────────────────────────────────
test('reports/*-4b-ext.json 的 10 条错误输出按 nx01 金标准回放 ≥9 条 FAIL', {
  skip: !fs.existsSync(EXT_REPORT) ? '现成验收报告不存在（reports/ 已 gitignore）' : false,
}, () => {
  const report = JSON.parse(fs.readFileSync(EXT_REPORT, 'utf8'));
  assert.equal(report.results.length, 10);
  const verdicts = report.results.map((r) => evalNumericFacts(r, gold('nx01')));
  const failCount = verdicts.filter((v) => v.verdict === 'FAIL').length;
  assert.ok(failCount >= 9, `期望 ≥9 条 FAIL，实测 ${failCount}`);
  assert.ok(verdicts.every((v) => v.reason.startsWith('numeric_')));
});
