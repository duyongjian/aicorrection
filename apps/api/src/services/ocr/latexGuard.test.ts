/**
 * latexGuard 回归测试（node:test）。
 * 覆盖第四道防线「感叹号洪流」：裸阶乘 `!` 与负间距 `\!` 分开计数，避免误杀合法 LaTeX。
 *
 * 运行：npx tsx --test src/services/ocr/latexGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLatex } from './latexGuard';

// ocrText 仅用于去重判据，这里给无关文本避免 duplicate_of_text 提前拦截。
const OCR = '这是一段和公式无关的纯文本题干，用于去重对照';

test('exclamation_flood：裸 ! 成百上千 → 拒绝', () => {
  // 混一个 \frac 信号使其通过 no_math_signal 前序判据，方能触达第四道防线。
  const latex = '\\frac{1}{2}' + '!'.repeat(200);
  const r = validateLatex(latex, OCR);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exclamation_flood');
});

test('exclamation_flood：\\! 成百上千 → 拒绝', () => {
  const latex = '\\frac{1}{2}' + '\\!'.repeat(200);
  const r = validateLatex(latex, OCR);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exclamation_flood');
});

test('合法公式：含若干 \\! 对齐间距 → 通过', () => {
  const latex = '\\begin{aligned} a&\\!=\\!b\\\\ c&\\!=\\!d\\end{aligned}';
  const r = validateLatex(latex, OCR);
  assert.equal(r.ok, true);
});

test('合法公式：含若干阶乘 ! → 通过', () => {
  const latex = 'x^{n!} + y^{m!}';
  const r = validateLatex(latex, OCR);
  assert.equal(r.ok, true);
});

test('边界：恰好 20 个裸 ! → 不拒绝', () => {
  const latex = '\\frac{1}{2}' + '!'.repeat(20);
  const r = validateLatex(latex, OCR);
  assert.equal(r.ok, true);
});
