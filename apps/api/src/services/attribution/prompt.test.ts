/**
 * 讲解/诊断字段解析器单测（node:test + tsx，纯离线）。
 *
 * 背景：Qwen3.5-9B 在生产的 v0.1 prompt 下高频把「正确推导」写成单独成行、
 * 冒号省略，随后直接换行接 $$公式$$。旧 findLastField 严格要求 `标记\s*[:：]`，
 * 导致 derivation 取不到、correct_answer 被推导内容污染、hasCore=false → 生产返回 incomplete。
 * 本测试锁死「容忍无冒号行标题」的收益与边界：修好 9B，且不把正文里的同名词误判成标题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeaching, parseAttrTriple } from './prompt';

/** 取自 reports/prompt-ab-2026-11-06T02-20-00-9b-ext.json 的 9B v0.1 真实输出（精简保留形态）。 */
const NO_COLON_9B = [
  '正确答案：单调递增区间为 $[-2,-1)$ 和 $(1,2]$；极大值为 $f(-1)=2$，极小值为 $f(1)=-2$',
  '正确推导',
  "$$f'(x) = 3x^2 - 3$$",
  '$$令 f\'(x) = 0 得 x = \\pm 1$$',
  '$$计算极值：f(-1)=2（极大值），f(1)=-2（极小值）$$',
  '常见陷阱：求导后解方程漏掉负根 x=-1',
  '知识点：利用导数符号判断函数单调性及求极值',
  '本质：单调性与极值由导函数的正负号及零点决定',
].join('\n');

const ALL_COLON = [
  '正确答案：f(-1)=2 为极大值',
  '正确推导：',
  '$$f\'(x)=3x^2-3$$',
  '常见陷阱：把极值写反',
  '知识点：导数应用',
  '本质：符号决定单调性',
].join('\n');

test('旧格式（全部带冒号）解析结果逐字段不变 —— 向后兼容', () => {
  const p = parseTeaching(ALL_COLON);
  assert.equal(p.hasCore, true);
  assert.equal(p.correct_answer, 'f(-1)=2 为极大值');
  assert.ok(p.derivation?.includes("3x^2-3"));
  assert.equal(p.pitfalls, '把极值写反');
  assert.equal(p.knowledge_point, '导数应用');
  assert.equal(p.essence, '符号决定单调性');
});

test('9B 无冒号行标题：核心三段齐全，且字段互不污染', () => {
  const p = parseTeaching(NO_COLON_9B);
  assert.equal(p.hasCore, true, '9B 这条输出内容完整，不应判 incomplete');
  assert.ok(p.correct_answer?.includes('f(-1)=2'));
  assert.ok(!p.correct_answer?.includes('$$'), 'correct_answer 不得吞进推导公式');
  assert.ok(p.derivation?.includes('3x^2'), 'derivation 应取到公式');
  assert.ok(!p.derivation?.includes('常见陷阱'), 'derivation 不得吞进常见陷阱');
  assert.equal(p.pitfalls, '求导后解方程漏掉负根 x=-1');
  assert.equal(p.knowledge_point, '利用导数符号判断函数单调性及求极值');
});

test('三个标题都无冒号、单独成行时仍能正确切分', () => {
  const text = ['正确答案', 'A', '正确推导', 'B', '常见陷阱', 'C'].join('\n');
  const p = parseTeaching(text);
  assert.equal(p.hasCore, true);
  assert.equal(p.correct_answer, 'A');
  assert.equal(p.derivation, 'B');
  assert.equal(p.pitfalls, 'C');
});

test('markdown 强调 / 序号装饰的无冒号标题可识别', () => {
  const text = [
    '**正确答案**', 'A',
    '2. 正确推导', 'B',
    '- 常见陷阱', 'C',
  ].join('\n');
  const p = parseTeaching(text);
  assert.equal(p.hasCore, true);
  assert.equal(p.correct_answer, 'A');
  assert.equal(p.derivation, 'B');
  assert.equal(p.pitfalls, 'C');
});

test('正文里顺带提到「正确推导」且有其它文字：不误判为标题', () => {
  const text = [
    '正确答案：详见正确推导部分的结论',
    '常见陷阱：把极值写反',
    '知识点：导数应用',
  ].join('\n');
  const p = parseTeaching(text);
  assert.equal(p.derivation, undefined, '不得把正文中的同名词当成字段标题');
  assert.equal(p.correct_answer, '详见正确推导部分的结论');
  assert.equal(p.hasCore, false, '确实缺少推导段，应诚实判 incomplete');
});

test('「正确推导 如下」这类非整行标题：不误判', () => {
  const text = [
    '正确答案：A',
    '正确推导 如下：先求导再代入',
    '常见陷阱：C',
  ].join('\n');
  const p = parseTeaching(text);
  assert.equal(p.derivation, undefined);
  assert.equal(p.hasCore, false);
});

test('真缺一段时仍 hasCore=false —— 容忍不等于放宽完整性要求', () => {
  const text = ['正确答案：A', '正确推导', 'B'].join('\n');
  assert.equal(parseTeaching(text).hasCore, false, '缺常见陷阱');
  assert.equal(parseTeaching('正确答案：A').hasCore, false, '只写一段');
  assert.equal(parseTeaching('').hasCore, false, '空文本');
});

test('解析结果取最后一个结论块：思考噪音不污染', () => {
  const text = [
    '正确答案：草稿（错）',
    '正确推导',
    '草稿推导',
    '常见陷阱：草稿陷阱',
    '……重新整理如下……',
    '正确答案：正式答案',
    '正确推导',
    '正式推导',
    '常见陷阱：正式陷阱',
  ].join('\n');
  const p = parseTeaching(text);
  assert.equal(p.hasCore, true);
  assert.equal(p.correct_answer, '正式答案');
  assert.equal(p.derivation, '正式推导');
  assert.equal(p.pitfalls, '正式陷阱');
});

test('parseAttrTriple 旧行为保持：三行带冒号 + 前置噪音回溯', () => {
  const text = [
    '前置锚点文本',
    '错因：把 were 写成 was',
    '知识点：虚拟语气',
    '本质：语法形式强制规定',
  ].join('\n');
  const p = parseAttrTriple(text);
  assert.equal(p.hasThree, true);
  assert.equal(p.cause, '把 were 写成 was');
  assert.equal(p.knowledge_point, '虚拟语气');
  assert.equal(p.essence, '语法形式强制规定');
});

test('parseAttrTriple 也兼容无冒号行标题（同一解析器扩展）', () => {
  const text = ['错因', '把 were 写成 was', '知识点', '虚拟语气', '本质', '语法形式强制规定'].join('\n');
  assert.equal(parseAttrTriple(text).hasThree, true);
});
