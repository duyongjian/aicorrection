import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWithEquation, verifyImplicitDifferentiation, normalizeMath, compileExpr } from './mathVerify';

test('normalizeMath: 偏导数 / e^ / 隐式乘法', () => {
  assert.equal(normalizeMath('∂z/∂x - ∂z/∂y'), 'dzdx-dzdy');
  assert.equal(normalizeMath('e^{y+az}'), 'exp(y+a*z)');
  assert.equal(normalizeMath('2x + a z'), '2*x+a*z');
  assert.equal(normalizeMath('x(2)'), 'x*(2)');
});

test('compileExpr: 基本运算', () => {
  const f = compileExpr('x - a*z - exp(y + a*z)');
  assert.ok(Math.abs(f({ x: 1, y: 0, z: 0, a: 1 }) - (1 - 0 - 1)) < 1e-9);
});

test('隐函数求导：仅 (A) ∂z/∂x−∂z/∂y=1/a 恒成立', () => {
  const eq = 'x - a*z = e^(y + a*z)';
  const opts = [
    { letter: 'A', relation: '∂z/∂x - ∂z/∂y = 1/a' },
    { letter: 'B', relation: '∂z/∂x + ∂z/∂y = 1/a' },
    { letter: 'C', relation: '∂z/∂x - ∂z/∂y = -1/a' },
    { letter: 'D', relation: '∂z/∂x + ∂z/∂y = -1/a' },
  ];
  const r = verifyWithEquation(eq, opts);
  assert.equal(r.kind, 'verified', `应为 verified，实际 ${r.kind}: ${r.reason}`);
  assert.equal(r.correctLetter, 'A', `正确应为 (A)，实际 ${r.correctLetter}`);
  // (D) 残差应明显非零（证明它"自洽但错"也能被抓住）
  assert.ok((r.residuals?.['D'] ?? 0) > 0.01, 'D 残差应明显非零');
});

test('verifyImplicitDifferentiation: 真实题干文本抽取 + 判定 (A)', () => {
  const q =
    '设 z=z(x,y) 是由方程 x - az = e^{y+az} 所确定的隐函数，则（ ）\n' +
    '(A) ∂z/∂x - ∂z/∂y = 1/a\n' +
    '(B) ∂z/∂x + ∂z/∂y = 1/a\n' +
    '(C) ∂z/∂x - ∂z/∂y = -1/a\n' +
    '(D) ∂z/∂x + ∂z/∂y = -1/a';
  const r = verifyImplicitDifferentiation(q);
  assert.equal(r.kind, 'verified', `应为 verified，实际 ${r.kind}: ${r.reason}`);
  assert.equal(r.correctLetter, 'A');
});

test('非隐函数题 → unknown（不干预）', () => {
  const r = verifyImplicitDifferentiation('下列关于函数的说法正确的是（ ）\n(A) f 连续\n(B) f 可导');
  assert.equal(r.kind, 'unknown');
});
