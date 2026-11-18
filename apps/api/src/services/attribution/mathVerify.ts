/**
 * 符号 / 数值独立校验模块（治本、模型无关）
 * ----------------------------------------------------------------------------
 * 痛点：本地小模型（9B@Q5_K 乃至 27B@IQ2XS）在隐函数求导等微积分选择题上，
 *       会"推导自洽但结论数学上错"（例如自己证明 D 公式 ≠ −1/a，却硬给 (D)）。
 *       纯文本比对（verifyAnswerLetter）抓不住"公式本身不成立"这类错误。
 *
 * 本模块的做法：不依赖模型，用数值法在隐函数曲面上取点 → 隐函数定理求偏导
 *       → 逐项验证 A~D 哪个选项恒成立 → 直接判定正确选项字母。
 *       —— 这是"可证明正确"的硬校验，模型答错也能纠正。
 *
 * 适用范围：含隐式方程 F(x,y,z,...)=0 且选项为 ∂z/∂x、∂z/∂y 线性/分式关系
 *       的微积分选择题（当前最高频的失败类别）。非此类题 → 返回 unknown，不干预。
 *
 * 设计要点：零外部依赖（自写递归下降求值器，不用 new Function，杜绝代码注入）。
 */
import type { ParsedOption } from './prompt';

// ───────────────────────────── 表达式求值器 ─────────────────────────────

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

const NUM_RE = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const ID_RE = /^[a-zA-Z]+/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const m = src.slice(i).match(NUM_RE)!;
      toks.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const m = src.slice(i).match(ID_RE)!;
      toks.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '(') {
      toks.push({ t: 'lp' });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: 'rp' });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ t: 'comma' });
      i++;
      continue;
    }
    if ('+-*/^'.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    // 未知字符（如 = 不应出现，已在调用方拆好）→ 跳过，避免卡死
    i++;
  }
  return toks;
}

// 已知函数名（小写）。log / ln 均取自然对数。
const FUNCS: Record<string, (...a: number[]) => number> = {
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (x) => 1 / Math.tan(x),
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  sqrt: Math.sqrt,
  log: Math.log,
  ln: Math.log,
  abs: Math.abs,
};

type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'unary'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

class Parser {
  private toks: Tok[];
  private pos = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }
  parse(): Node {
    const n = this.parseExpr();
    if (this.pos !== this.toks.length) {
      throw new Error(`表达式解析残留，位置 ${this.pos}`);
    }
    return n;
  }
  private parseExpr(): Node {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        left = { k: 'bin', op: t.v, a: left, b: this.parseTerm() };
      } else break;
    }
    return left;
  }
  private parseTerm(): Node {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
        this.next();
        left = { k: 'bin', op: t.v, a: left, b: this.parseFactor() };
      } else break;
    }
    return left;
  }
  private parseFactor(): Node {
    const base = this.parseUnary();
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '^') {
      this.next();
      // 右结合
      return { k: 'bin', op: '^', a: base, b: this.parseFactor() };
    }
    return base;
  }
  private parseUnary(): Node {
    const t = this.peek();
    if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
      this.next();
      return { k: 'unary', op: t.v, a: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new Error('表达式意外结束');
    if (t.t === 'num') {
      this.next();
      return { k: 'num', v: t.v };
    }
    if (t.t === 'lp') {
      this.next();
      const n = this.parseExpr();
      const close = this.next();
      if (!close || close.t !== 'rp') throw new Error('缺少右括号');
      return n;
    }
    if (t.t === 'id') {
      this.next();
      const nxt = this.peek();
      if (nxt && nxt.t === 'lp') {
        this.next(); // 吃掉 '('
        const args: Node[] = [];
        if (this.peek() && this.peek()!.t !== 'rp') {
          args.push(this.parseExpr());
          while (this.peek() && this.peek()!.t === 'comma') {
            this.next();
            args.push(this.parseExpr());
          }
        }
        const close = this.next();
        if (!close || close.t !== 'rp') throw new Error('函数缺少右括号');
        return { k: 'call', name: t.v.toLowerCase(), args };
      }
      return { k: 'var', name: t.v.toLowerCase() };
    }
    throw new Error(`无法解析的 token: ${JSON.stringify(t)}`);
  }
}

function evalNode(n: Node, scope: Record<string, number>): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'var': {
      if (n.name === 'pi') return Math.PI;
      if (n.name === 'e') return Math.E;
      if (n.name === 'inf') return Infinity;
      const v = scope[n.name];
      if (v === undefined) throw new Error(`未提供变量 ${n.name}`);
      return v;
    }
    case 'unary':
      return n.op === '-' ? -evalNode(n.a, scope) : evalNode(n.a, scope);
    case 'bin': {
      const a = evalNode(n.a, scope);
      const b = evalNode(n.b, scope);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return Math.pow(a, b);
      }
      throw new Error(`未知运算符 ${n.op}`);
    }
    case 'call': {
      const fn = FUNCS[n.name];
      if (!fn) throw new Error(`未知函数 ${n.name}`);
      return fn(...n.args.map((a) => evalNode(a, scope)));
    }
  }
}

/**
 * 把"数学记号文本"规整为求值器可解析的字符串：
 *  - LaTeX \frac / 花括号 / 偏导数符号 / e^ / 全角减号 → 标准记号
 *  - 隐式乘法（az、2x、x(、)x）→ 显式 *
 * 做法：先做记号层替换，再分词（tokenize），按 token 邻接规则插乘——
 *       函数名（exp/sin/...）后接 ( 视为函数调用、不插乘；变量后接 ( 才插乘。
 */
export function normalizeMath(s: string): string {
  let t = (s ?? '').trim();
  t = t.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
  // LaTeX 花括号 → 圆括号（\frac 已先行处理；e^{...} / 指数分组等转为可解析形式）
  t = t.replace(/\{/g, '(');
  t = t.replace(/\}/g, ')');
  // 偏导数 ∂z/∂x 与 \partial z / \partial x 两种写法
  t = t.replace(/∂\s*z\s*\/\s*∂\s*x/g, 'dzdx');
  t = t.replace(/∂\s*z\s*\/\s*∂\s*y/g, 'dzdy');
  t = t.replace(/\\partial\s+z\s*\/\s*\\partial\s+x/g, 'dzdx');
  t = t.replace(/\\partial\s+z\s*\/\s*\\partial\s+y/g, 'dzdy');
  // e^ → exp（含 e^(...) 与 e^x）
  t = t.replace(/e\^\(/g, 'exp(');
  t = t.replace(/e\^([a-zA-Z0-9_.]+)/g, 'exp($1)');
  t = t.replace(/[−–—]/g, '-'); // 各种 dash → ASCII 减号
  t = t.replace(/\s+/g, '');
  // 函数名后紧跟变量/数字（无括号）时补全为函数调用 cos x → cos(x)，
  // 否则 "cos*x" 会被当乘法、cos 被当未定义变量导致编译失败。
  // 负向回顾排除被包在其它单词里的同名片段（如 arcsin 中的 sin）。
  t = t.replace(/(?<![a-zA-Z])(sin|cos|tan|cot|sec|csc|exp|ln|log|sqrt|abs)\s*([a-zA-Z]|[0-9.]+)/gi, '$1($2)');
  t = t.replace(/\\pi/gi, 'pi'); // LaTeX \pi → pi（与 π 字符统一）
  t = t.replace(/π/g, 'pi');
  t = t.replace(/\\infty/gi, 'inf'); // 无穷 ∞ → inf 常量（避免选项含 ∞ 时编译失败）
  t = t.replace(/∞/g, 'inf');
  // 分词后：先把"非函数名 / 非特殊 token"的多字母标识符拆成单字母
  // （如 az → a,z；否则 [a-zA-Z]+ 会把它当成单个变量），再按邻接规则插入显式 *
  const toks = expandTokens(tokenize(t));
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const cur = toks[i];
    const nxt = toks[i + 1];
    out.push(tokenToStr(cur));
    if (nxt && needsStar(cur, nxt)) out.push('*');
  }
  return out.join('');
}

/** 保留为整体、不拆字母的标识符（函数名 + 特殊 token + 常数）。 */
const KEEP_ID: Set<string> = new Set([...Object.keys(FUNCS), 'dzdx', 'dzdy', 'pi']);

/** 把多字母且非保留的标识符拆成单字母 token（az → a, z）。 */
function expandTokens(toks: Tok[]): Tok[] {
  const res: Tok[] = [];
  for (const tk of toks) {
    if (tk.t === 'id' && tk.v.length > 1 && !KEEP_ID.has(tk.v.toLowerCase())) {
      for (const ch of tk.v) res.push({ t: 'id', v: ch });
    } else {
      res.push(tk);
    }
  }
  return res;
}

function tokenToStr(t: Tok): string {
  switch (t.t) {
    case 'num':
      return String(t.v);
    case 'id':
      return t.v;
    case 'op':
      return t.v;
    case 'lp':
      return '(';
    case 'rp':
      return ')';
    case 'comma':
      return ',';
  }
}

/** 是否在 cur、nxt 两个相邻 token 之间插入隐式乘法 *（函数调用除外）。 */
function needsStar(cur: Tok, nxt: Tok): boolean {
  if (cur.t === 'num' && nxt.t === 'id') return true; // 2x → 2*x
  if (cur.t === 'id' && nxt.t === 'num') return true; // x2 → x*2
  if (cur.t === 'id' && nxt.t === 'id') return true; // az → a*z（多字母 id 已是单 token）
  if (cur.t === 'num' && nxt.t === 'lp') return true; // 2( → 2*(
  if (cur.t === 'rp' && (nxt.t === 'id' || nxt.t === 'num' || nxt.t === 'lp')) return true; // )x / )( 
  if (cur.t === 'id' && nxt.t === 'lp') {
    // 函数名后接 ( → 函数调用，不插乘；其余变量后接 ( → 插乘
    return !(nxt && FUNCS[cur.v.toLowerCase()]);
  }
  return false;
}

export interface CompiledExpr {
  (scope: Record<string, number>): number;
}

/** 编译一个表达式字符串为可重复求值的函数（失败抛错）。 */
export function compileExpr(expr: string): CompiledExpr {
  const norm = normalizeMath(expr);
  const ast = new Parser(tokenize(norm)).parse();
  return (scope: Record<string, number>) => evalNode(ast, scope);
}

// ───────────────────────────── 隐函数偏导数值验证 ─────────────────────────────

const H = 1e-6; // 有限差分步长

function partial(fn: CompiledExpr, scope: Record<string, number>, varName: string): number {
  const x0 = scope[varName];
  const sp = { ...scope, [varName]: x0 + H };
  const sm = { ...scope, [varName]: x0 - H };
  return (fn(sp) - fn(sm)) / (2 * H);
}

/**
 * 在隐式方程 F(x,y,z,...) = 0 上，用牛顿法解 z（多起点兜底）。
 * 返回命中的 z，或 null（该采样点无根）。
 */
function solveZ(F: CompiledExpr, x: number, y: number, a: number): number | null {
  const vars = { x, y, z: 0, a };
  const guesses = [-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4, 8];
  for (const g of guesses) {
    let z = g;
    let ok = false;
    for (let it = 0; it < 60; it++) {
      const fz = F({ x, y, z, a });
      const fzp = partial(F, { x, y, z, a }, 'z');
      if (!isFinite(fz) || !isFinite(fzp) || Math.abs(fzp) < 1e-12) break;
      const step = fz / fzp;
      z = z - step;
      if (!isFinite(z)) break;
      if (Math.abs(step) < 1e-12) {
        ok = true;
        break;
      }
    }
    if (ok && Math.abs(F({ x, y, z, a })) < 1e-7) return z;
  }
  return null;
}

export interface VerifyOutput {
  kind: 'verified' | 'unknown';
  /** 判定为恒等式的正确选项字母 */
  correctLetter?: string;
  /** 正确选项的原文（含标号，如 "(A) ∂z/∂x − ∂z/∂y = 1/a"），用于覆盖时直接采用 */
  correctOptionText?: string;
  /** 各选项在采样点上的最大 |残差|（调试 / 解释用） */
  residuals?: Record<string, number>;
  reason?: string;
}

/**
 * 给定隐式方程字符串与若干"选项关系"字符串（如 "dzdx - dzdy = 1/a"），
 * 在曲面上随机采样，判定哪个选项恒成立。
 */
export function verifyWithEquation(
  equation: string,
  options: { letter: string; relation: string }[],
  targetDeriv?: 'dzdx' | 'dzdy' | null
): VerifyOutput {
  let F: CompiledExpr;
  try {
    // F = LHS - RHS
    const eqIdx = equation.indexOf('=');
    if (eqIdx < 0) return { kind: 'unknown', reason: '方程无 =' };
    const lhs = equation.slice(0, eqIdx);
    const rhs = equation.slice(eqIdx + 1);
    const Flhs = compileExpr(lhs);
    const Frhs = compileExpr(rhs);
    F = (s) => Flhs(s) - Frhs(s);
  } catch (e) {
    return { kind: 'unknown', reason: `方程编译失败: ${(e as Error).message}` };
  }

  // 编译各选项：两类题型统一处理
  //  - 等式型选项（如 "dzdx - dzdy = 1/a"）：检验恒等式 LHS - RHS ≈ 0 是否恒成立；
  //  - 表达式型选项（如 "-x/z"，即所求偏导本身）：其数值应等于数值求得的 dzdx / dzdy。
  const comps: { letter: string; fn: CompiledExpr; kind: 'eq' | 'expr' }[] = [];
  for (const o of options) {
    try {
      const idx = o.relation.indexOf('=');
      if (idx >= 0) {
        const L = compileExpr(o.relation.slice(0, idx));
        const R = compileExpr(o.relation.slice(idx + 1));
        comps.push({ letter: o.letter, fn: (s) => L(s) - R(s), kind: 'eq' });
      } else if (targetDeriv) {
        const E = compileExpr(o.relation);
        comps.push({
          letter: o.letter,
          fn: (s) => E(s) - (s[targetDeriv] ?? NaN),
          kind: 'expr',
        });
      }
    } catch {
      // 该选项无法解析 → 跳过（不参与判定）
    }
  }
  if (comps.length < 2) return { kind: 'unknown', reason: '可解析选项不足' };

  const N = 60;
  const residuals: Record<string, number> = {};
  for (const c of comps) residuals[c.letter] = 0;
  let valid = 0;
  for (let s = 0; s < N; s++) {
    // 随机采样 x,y,a（避免退化），a 远离 0 以保隐函数定理分母非零
    const x = rand(-2, 2);
    const y = rand(-2, 2);
    const a = rand(0.4, 2.4) * (Math.random() < 0.5 ? 1 : -1) || 1;
    const z = solveZ(F, x, y, a);
    if (z === null) continue;
    const scope: Record<string, number> = { x, y, z, a };
    // 隐函数定理：∂z/∂x = -F_x/F_z, ∂z/∂y = -F_y/F_z
    const Fx = partial(F, scope, 'x');
    const Fy = partial(F, scope, 'y');
    const Fz = partial(F, scope, 'z');
    if (!isFinite(Fz) || Math.abs(Fz) < 1e-9) continue;
    scope.dzdx = -Fx / Fz;
    scope.dzdy = -Fy / Fz;
    let allFinite = true;
    const res: Record<string, number> = {};
    for (const c of comps) {
      let v: number;
      try {
        v = c.fn(scope);
      } catch {
        allFinite = false;
        break;
      }
      if (!isFinite(v)) {
        allFinite = false;
        break;
      }
      res[c.letter] = v;
    }
    if (!allFinite) continue;
    for (const c of comps) {
      residuals[c.letter] = Math.max(residuals[c.letter], Math.abs(res[c.letter]));
    }
    valid++;
  }
  if (valid < 10) return { kind: 'unknown', reason: `有效采样点不足 (${valid})` };

  // 判定：残差最小的选项需"几乎为 0"，且与次小选项明显分离
  const ranked = comps
    .map((c) => ({ letter: c.letter, r: residuals[c.letter] }))
    .sort((p, q) => p.r - q.r);
  const best = ranked[0];
  const second = ranked[1];
  const sep = second.r - best.r;
  // 相对/绝对双判据：最优残差 < 1e-3 且与次优差 > 0.05（量纲无关）
  if (best.r < 1e-3 && sep > 0.05) {
    return { kind: 'verified', correctLetter: best.letter, residuals, reason: `采样 ${valid} 点，最优残差 ${best.r.toExponential(2)}` };
  }
  return { kind: 'unknown', reason: `选项残差区分度不足 (best=${best.r.toExponential(2)}, sep=${sep.toExponential(2)})`, residuals };
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

/**
 * 从题干自动抽取隐式方程 + A~D 选项，再调用 verifyWithEquation。
 * 仅对"题干部位（首个选项字母之前）含 = 且含 z"的题目生效；否则 unknown。
 */
export function verifyImplicitDifferentiation(question: string): VerifyOutput {
  // 题干部位：首个 (A)/(a)/（A） 之前
  const m = question.match(/[\(（]\s*[Aa]\s*[\)）]/);
  const prefix = m ? question.slice(0, m.index!) : question;
  const clause = extractEquationClause(prefix);
  if (!clause) return { kind: 'unknown', reason: '题干未找到隐式方程' };
  if (!/[zZ]/.test(clause)) return { kind: 'unknown', reason: '方程未含因变量 z' };
  const equation = clause;

  // 选项：复用 prompt 的解析
  const opts: ParsedOption[] = parseOptionsLocal(question);
  if (opts.length < 2) return { kind: 'unknown', reason: '选项不足' };
  const optInputs = opts.map((o) => ({ letter: o.letter, relation: stripMarker(o.body) }));
  // 判定题干所求：∂z/∂x 还是 ∂z/∂y（用于"表达式型"选项比对其数值是否等于所求导数值）。
  // 等式型选项（如 dzdx-dzdy=1/a）无需此信息。选项若不含 ∂z/∂x 这类记号（如 -x/z），
  // 仅在题干明确出现时才设定 target，避免误判。
  const targetDeriv: 'dzdx' | 'dzdy' | null = (() => {
    if (
      /\\?partial\s+z\s*\}\s*\{\s*\\?partial\s+x|\\?partial\s+z\s*\/\s*\\?partial\s+x|∂\s*z\s*\/\s*∂\s*x/.test(
        question
      )
    )
      return 'dzdx';
    if (
      /\\?partial\s+z\s*\}\s*\{\s*\\?partial\s+y|\\?partial\s+z\s*\/\s*\\?partial\s+y|∂\s*z\s*\/\s*∂\s*y/.test(
        question
      )
    )
      return 'dzdy';
    return null;
  })();
  const result = verifyWithEquation(equation, optInputs, targetDeriv);
  if (result.kind === 'verified' && result.correctLetter) {
    const hit = opts.find((o) => o.letter === result.correctLetter);
    if (hit) result.correctOptionText = hit.body;
  }
  return result;
}

// 本地轻量选项解析（避免改动 prompt.ts）
function parseOptionsLocal(question: string): ParsedOption[] {
  const markerRe = /[\(（]\s*([A-Ea-e])\s*[\)）]/g;
  const markers: { letter: string; idx: number }[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = markerRe.exec(question)) !== null) {
    markers.push({ letter: mm[1].toUpperCase(), idx: mm.index });
  }
  if (markers.length === 0) return [];
  const opts: ParsedOption[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].idx;
    const end = i + 1 < markers.length ? markers[i + 1].idx : question.length;
    opts.push({ letter: markers[i].letter, body: question.slice(start, end).trim() });
  }
  return opts;
}

function stripMarker(body: string): string {
  return body.replace(/^[\(（]\s*[A-Ea-e]\s*[\)）]\s*/, '').replace(/^选项?[A-Ea-e]\s*[:：]?/i, '').trim();
}

/**
 * 从题干部位抽取隐式方程子句：
 *  - 优先锚定"方程 … 所确定 / 确定"结构（中文隐函数题最稳定，自动排除 z=z(x,y) 定义）。
 *  - 兜底：取最后一个含 z 的 = 子句，左右以标点 / 前一个 = 界定。
 */
function extractEquationClause(prefix: string): string | null {
  const anchor = prefix.match(/方程\s*([^。；！？\n]+?)\s*所?确定/);
  if (anchor && anchor[1] && /[zZ]/.test(anchor[1])) {
    return anchor[1].trim();
  }
  const eqs = [...prefix.matchAll(/=/g)].map((x) => x.index!);
  if (eqs.length === 0) return null;
  const idx = eqs[eqs.length - 1];
  let left = 0;
  for (let j = idx - 1; j >= 0; j--) {
    if ('=，。；：（）(、\n'.includes(prefix[j])) {
      left = j + 1;
      break;
    }
  }
  let right = prefix.length;
  for (let j = idx + 1; j < prefix.length; j++) {
    if ('，。；：（）)\n'.includes(prefix[j])) {
      right = j;
      break;
    }
  }
  return prefix.slice(left, right).trim();
}

// ───────────────────────────── 通用数值匹配辅助 ─────────────────────────────

/** 安全求值：抛错或非有限返回 NaN（不污染匹配）。 */
function safeEval(fn: CompiledExpr, scope: Record<string, number>): number {
  try {
    const v = fn(scope);
    return typeof v === 'number' && isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

/** π → pi（与 normalizeMath 的 π 替换保持一致，供独立编译选项/上下限用）。 */
function replacePi(s: string): string {
  return (s ?? '').replace(/\\pi/gi, 'pi').replace(/π/g, 'pi');
}

/** 复合辛普森积分（定步长）。任一采样点非有限即返回 NaN。 */
function simpson(fn: CompiledExpr, a: number, b: number, n: number): number {
  const nn = n % 2 === 0 ? n : n + 1;
  const h = (b - a) / nn;
  let s = safeEval(fn, { x: a }) + safeEval(fn, { x: b });
  if (!isFinite(s)) return NaN;
  for (let i = 1; i < nn; i++) {
    const y = safeEval(fn, { x: a + i * h });
    if (!isFinite(y)) return NaN;
    s += (i % 2 === 0 ? 2 : 4) * y;
  }
  return (h / 3) * s;
}

/**
 * 把题干选项编译为数值，与真值 V 比对，挑出残差最小且与次小明显分离的选项。
 * 适用于极限 / 定积分（选项为数值或含 π/ln 等常量）。
 */
function matchNumericOptions(question: string, V: number): VerifyOutput {
  const opts = parseOptionsLocal(question);
  if (opts.length < 2) return { kind: 'unknown', reason: '选项不足' };
  const residuals: Record<string, number> = {};
  const comps: { letter: string; r: number }[] = [];
  for (const o of opts) {
    const body = stripMarker(o.body);
    let val: number | null = null;
    try {
      val = compileExpr(body.replace(/π/g, 'pi'))({});
    } catch {
      val = null;
    }
    const r = val === null ? Infinity : Math.abs(val - V);
    residuals[o.letter] = r;
    if (val !== null) comps.push({ letter: o.letter, r });
  }
  if (comps.length < 2) return { kind: 'unknown', reason: '可解析数值选项不足' };
  comps.sort((p, q) => p.r - q.r);
  const best = comps[0];
  const second = comps[1];
  const sep = second.r - best.r;
  if (best.r < 1e-2 && sep > 0.05) {
    const hit = opts.find((o) => o.letter === best.letter);
    return {
      kind: 'verified',
      correctLetter: best.letter,
      correctOptionText: hit?.body,
      residuals,
      reason: `数值真值 ${V.toFixed(4)}，最优残差 ${best.r.toExponential(2)}`,
    };
  }
  return {
    kind: 'unknown',
    reason: `数值选项区分度不足 (best=${best.r.toExponential(2)}, sep=${sep.toExponential(2)})`,
    residuals,
  };
}

/** 级数选项匹配：先按"收敛/发散"文本判定，否则按数值和匹配。 */
function matchSeriesOptions(
  question: string,
  converges: boolean,
  V: number
): VerifyOutput {
  const opts = parseOptionsLocal(question);
  if (opts.length < 2) return { kind: 'unknown', reason: '选项不足' };
  const residuals: Record<string, number> = {};
  for (const o of opts) {
    const b = o.body.replace(/^[\(（]\s*[A-Ea-e]\s*[\)）]\s*/, '');
    const isConv = /收敛/.test(b);
    const isDiv = /发散/.test(b);
    if ((converges && isConv) || (!converges && isDiv)) {
      return { kind: 'verified', correctLetter: o.letter, correctOptionText: o.body, residuals };
    }
    try {
      const val = compileExpr(b.replace(/π/g, 'pi'))({});
      residuals[o.letter] = isFinite(val) ? Math.abs(val - V) : Infinity;
    } catch {
      residuals[o.letter] = Infinity;
    }
  }
  const comps = opts
    .map((o) => ({ letter: o.letter, r: residuals[o.letter] }))
    .filter((c) => isFinite(c.r));
  if (comps.length >= 2) {
    comps.sort((p, q) => p.r - q.r);
    if (comps[0].r < 1e-2 && comps[1].r - comps[0].r > 0.05) {
      const hit = opts.find((o) => o.letter === comps[0].letter);
      return {
        kind: 'verified',
        correctLetter: comps[0].letter,
        correctOptionText: hit?.body,
        residuals,
      };
    }
  }
  return { kind: 'unknown', reason: '级数选项未匹配（收敛性或数值不符）', residuals };
}

/**
 * 极限数值验证：解析 lim 表达式与趋向点，双侧/无穷采样求极限值，再与数值选项比对。
 * 仅在能稳定求出有限极限时返回 verified；否则 unknown 不干预。
 */
export function verifyLimit(question: string): VerifyOutput {
  const limMatch = question.match(/\\?lim(?:_\s*\{?([^}]*)\}?)?/i);
  if (!limMatch) return { kind: 'unknown', reason: '未找到极限表达式' };
  const subscript = limMatch[1] ?? '';
  const varMatch = subscript.match(/([a-zA-Z])/);
  const vname = varMatch ? varMatch[1].toLowerCase() : 'x';
  const isInfinite = /∞|\\infty/i.test(subscript);
  let point: number | null = null;
  if (!isInfinite) {
    const pm = subscript.match(/[-+]?\d*\.?\d+/);
    if (pm) point = parseFloat(pm[0]);
  }
  const after = question.slice(limMatch.index! + limMatch[0].length);
  const exprEnd = after.search(/[。！？；\n]/);
  let exprRaw = exprEnd >= 0 ? after.slice(0, exprEnd) : after;
  exprRaw = exprRaw.replace(/\\?lim/gi, '');
  // 截掉"答案空 / 选项"等尾部噪声：遇到答案空 "( )"、选项字母 "(A)" 或等号填空 "= (" 即止，
  // 避免把选项文当表达式编译（compileExpr 内部 normalizeMath 负责处理 \frac / \pi）。
  const cutIdx = exprRaw.search(/[=＝]\s*\(|\(?\s*[A-Ea-e]\s*[\)）]|（\s*[A-Ea-e]\s*）|\(\s*\)/);
  if (cutIdx >= 0) exprRaw = exprRaw.slice(0, cutIdx);
  exprRaw = exprRaw.trim();
  let compiled: CompiledExpr;
  try {
    compiled = compileExpr(exprRaw);
  } catch {
    return { kind: 'unknown', reason: '极限表达式编译失败' };
  }
  let V: number | null = null;
  if (isInfinite) {
    const vals = [1e4, 1e5, 1e6].map((n) => safeEval(compiled, { [vname]: n }));
    if (vals.some((v) => !isFinite(v))) return { kind: 'unknown', reason: '无穷极限采样非有限' };
    if (Math.abs(vals[2] - vals[1]) < 1e-3 && Math.abs(vals[1] - vals[0]) < 1e-2) V = vals[2];
    else return { kind: 'unknown', reason: '无穷极限未收敛' };
  } else if (point !== null) {
    const d = 1e-4;
    const vp = safeEval(compiled, { [vname]: point + d });
    const vm = safeEval(compiled, { [vname]: point - d });
    if (!isFinite(vp) || !isFinite(vm)) return { kind: 'unknown', reason: '极限采样非有限' };
    if (Math.abs(vp - vm) < 1e-6) V = (vp + vm) / 2;
    else return { kind: 'unknown', reason: '双侧极限不一致（极限不存在）' };
  } else {
    return { kind: 'unknown', reason: '未能解析趋向点' };
  }
  return matchNumericOptions(question, V as number);
}

/**
 * 定积分数值验证：解析上下限与被积表达式，复合辛普森求积，再与数值选项比对。
 */
export function verifyIntegral(question: string): VerifyOutput {
  const bnd = question.match(
    /\\int\s*_\s*\{?(\\?pi|[0-9e\.\-]+)\}?\s*\^\s*\{?(\\?pi|[0-9e\.\-]+)\}?/i
  );
  if (!bnd) return { kind: 'unknown', reason: '未解析积分上下限' };
  let a: number, b: number;
  try {
    a = compileExpr(replacePi(bnd[1]))({});
    b = compileExpr(replacePi(bnd[2]))({});
  } catch {
    return { kind: 'unknown', reason: '积分上下限编译失败' };
  }
  if (!isFinite(a) || !isFinite(b)) return { kind: 'unknown', reason: '积分上下限非有限' };
  const after = question.slice(bnd.index! + bnd[0].length);
  const dxMatch = after.match(/([\s\S]*?)\\?,?\s*d\s*x/i);
  if (!dxMatch) return { kind: 'unknown', reason: '未找到被积表达式或 dx' };
  let integrandRaw = dxMatch[1].trim();
  let compiled: CompiledExpr;
  try {
    compiled = compileExpr(integrandRaw);
  } catch {
    return { kind: 'unknown', reason: '被积表达式编译失败' };
  }
  const V = simpson(compiled, a, b, 2000);
  if (!isFinite(V)) return { kind: 'unknown', reason: '积分数值非有限' };
  return matchNumericOptions(question, V);
}

/**
 * 级数敛散性验证：解析通项，数值累加部分和判定收敛/发散，再与选项（收敛/发散 或 和值）比对。
 * 启发式：比较 S_N 与 S_{N/2} 的增量——增量不趋于 0 即判定发散；否则收敛，和值取 S_N。
 */
export function verifySeries(question: string): VerifyOutput {
  const sm = question.match(/\\sum\s*_\s*\{?([^}]*)\}?\s*\^\s*\{?([^}]*)\}?/i);
  if (!sm) return { kind: 'unknown', reason: '未解析级数下标' };
  const lowerM = (sm[1] ?? '').match(/=\s*(\d+)/);
  const startN = lowerM ? parseInt(lowerM[1], 10) : 1;
  const after = question.slice(sm.index! + sm[0].length);
  const exprEnd = after.search(/[。！？；\n]/);
  let termRaw = exprEnd >= 0 ? after.slice(0, exprEnd) : after;
  termRaw = termRaw.replace(/\\sum/gi, '');
  // 截掉"答案空 / 选项"等尾部噪声（同极限处理），避免把选项文当通项编译
  const cutS = termRaw.search(/[=＝]\s*\(|\(?\s*[A-Ea-e]\s*[\)）]|（\s*[A-Ea-e]\s*）/);
  if (cutS >= 0) termRaw = termRaw.slice(0, cutS);
  termRaw = termRaw.trim();
  let compiled: CompiledExpr;
  try {
    compiled = compileExpr(termRaw);
  } catch {
    return { kind: 'unknown', reason: '级数通项编译失败' };
  }
  const N = 200000;
  const partial = (upto: number): { S: number; last: number } => {
    let S = 0;
    let last = 0;
    for (let n = startN; n <= upto; n++) {
      const a = safeEval(compiled, { n });
      if (!isFinite(a)) return { S: NaN, last: NaN };
      S += a;
      last = a;
    }
    return { S, last };
  };
  const full = partial(N);
  if (!isFinite(full.S)) return { kind: 'unknown', reason: '通项非有限' };
  if (Math.abs(full.last) > 1e-2) {
    return matchSeriesOptions(question, false, NaN); // 第 N 项不趋于 0 → 发散（必要条件）
  }
  const half = partial(Math.floor(N / 2));
  if (!isFinite(half.S)) return { kind: 'unknown', reason: '部分和半段非有限' };
  if (Math.abs(full.S - half.S) < 1e-2) {
    return matchSeriesOptions(question, true, full.S);
  }
  return matchSeriesOptions(question, false, NaN);
}

/**
 * 统一分发：隐函数求导（含 z 的等式，最高特异度，优先）→ 极限 → 定积分 → 级数。
 * 仅在能稳定验证时返回 verified；否则 unknown（不干预、不误杀）。
 * 供诊断 / 讲解两种模式共用，作为"模型无关正确选项"的硬校验。
 */
export function verifyAnswer(question: string): VerifyOutput {
  const imp = verifyImplicitDifferentiation(question);
  if (imp.kind === 'verified') return imp;
  if (/\\?lim|极限|趋向|趋于/i.test(question)) {
    const r = verifyLimit(question);
    if (r.kind === 'verified') return r;
  }
  if (/\\int|积分|定积分/i.test(question)) {
    const r = verifyIntegral(question);
    if (r.kind === 'verified') return r;
  }
  if (/\\sum|级数|敛散|收敛|发散|求和/i.test(question)) {
    const r = verifySeries(question);
    if (r.kind === 'verified') return r;
  }
  return { kind: 'unknown', reason: '非可验证题型或解析失败' };
}
