#!/usr/bin/env node
/**
 * auto-eval.mjs — 用 provisional_truth 做金标准，自动评分模型输出
 *
 * 设计理念：
 *   - provisional_truth 是"人工推导的正确答案/错误归因"，允许有偏差但不能作为事实；
 *     评分只看「方向是否一致」，不追求逐字匹配
 *   - 诊断模式：比较 model.cause 与 provisional_truth 中的错因描述
 *   - 陷阱题：provisional_truth 明确说"无错" → model 不得给错因
 *   - 讲解模式：比较 model.correct_answer 与 provisional_truth
 *
 * 用法：
 *   node apps/api/src/tests/auto-eval.mjs --json <path> --set <题集> [--cases c01,c02] [--verbose]
 *   （--set 建议始终显式传入：case_id 命中率过低会报错并非零退出，见 MIN_TRUTH_HIT_RATE）
 *
 * 评分维度：
 *   - trap_no_fabricate: 陷阱题是否没编错因
 *   - cause_direction:   错因方向是否与 truth 一致
 *   - answer_correct:    讲解题答案是否正确
 *   - self_contradict:   输出自身是否自相矛盾（筛查信号）
 *   - numeric_facts:     仅对声明 expected_facts 的 case 启用严格数值/配对判据（见下方专节）
 *                        支持 pair | set | interval | monotonic_direction | text 五类断言；
 *                        monotonic_direction 专门拦截「推导对、答案行把增/减方向写反」
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(process.cwd());
const DEFAULT_SET_PATH = path.join(REPO_ROOT, 'apps', 'api', 'src', 'tests', 'fixtures', 'prompt-ab-set.json');

// ── 评分规则 ─────────────────────────────────────────────────────────────────

/**
 * 检测字符串是否包含"正确/无错"语义
 */
function hasCorrectSemantics(text) {
  return /正确|无误|无错|未发现.*错|无误|没*有.*错|作答.*正确|解答.*正确|解法.*正确|逻辑.*正确/.test(text);
}

/**
 * 检测字符串是否包含"错误/错因"语义（排除否定语境如"未发现错误"）
 */
function hasErrorSemantics(text) {
  // 排除"未发现错误"、"无错误"、"未出现错误"等否定表达
  const negatedPatterns = /未发现.*错误|无.*错误|未出现.*错误|没有.*错误|未.*错|无误/;
  if (negatedPatterns.test(text)) return false;
  return /错因|计算错误|算错|概念.*错误|方法.*错误|思路.*错误/.test(text);
}

/**
 * 从 provisional_truth 判断是否为陷阱题
 */
function isTrapTruth(truth) {
  // 如果 truth 明确说学生"错误/不恰当/误用" → 不是陷阱，是学生真错了
  if (/错误|不恰当|误用|望文生义|不正确|有错/.test(truth)) return false;
  // 明确说"正确/无错"的
  if (/正确.*无需|解法.*正确|作答.*正确|解答.*正确|正确.*未发现|解法.*正确/.test(truth)) return true;
  // 明确说"不应给出错因"的
  if (/不应|不得|禁止|不能.*给|没有.*错因/.test(truth)) return true;
  // 明确说"陷阱题"且前面没否定
  if (/陷阱题/.test(truth)) return true;
  return false;
}

/**
 * 提取关键实体（实体名 / 数值 / 关系），用于匹配
 */
function extractEntities(text) {
  // 数字（含小数、负数、分数）
  const nums = (text.match(/-?\d+\.?\d*/g) || []).map(Number).filter(n => !isNaN(n));
  // 关键短语
  const keyPhrases = [];
  if (/正确|无错误|未发现/.test(text)) keyPhrases.push('correct');
  if (/错因|错误|漏掉|漏乘/.test(text)) keyPhrases.push('mistake');
  return { nums, keyPhrases };
}

/**
 * 计算两个字符串的关键词重叠率
 */
function keywordOverlap(a, b) {
  const toTokens = s => new Set((s.toLowerCase().match(/[a-z]+|\d+\.?\d*/g) || []));
  const ta = toTokens(a);
  const tb = toTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size, 1);
}

/**
 * 检查两个数值是否在容差内一致（相对误差 < 5% 或绝对误差 < 0.01）
 */
function numsMatchFunc(a, b, tol = 0.05) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (Math.abs(b) < 1e-9) return Math.abs(a) < 0.01;
  return Math.abs(a - b) / Math.abs(b) < tol;
}

/**
 * 从字符串中提取所有数值（支持科学计数法、分数）
 */
function extractNums(s) {
  // 先提取 LaTeX 公式内的数字
  const latexNums = [];
  const latexMatch = s.match(/\$+[^$]*?\$+/g) || [];
  for (const m of latexMatch) {
    const nums = m.match(/-?\d+\.?\d*/g) || [];
    latexNums.push(...nums.map(Number).filter(n => !isNaN(n) && Math.abs(n) > 1e-10));
  }
  // 再提取普通文本中的数字
  const text = s.replace(/\$+[^$]*?\$+/g, '');
  const textNums = text.match(/-?\d+\.?\d*/g) || [];
  return [...latexNums, ...textNums.map(Number).filter(n => !isNaN(n) && Math.abs(n) > 1e-10)];
}

/**
 * 提取文本中的关键词/短语（用于非数值类答案）
 */
function extractKeywords(text) {
  // 提取中文关键词（2个及以上中文字符）
  const cnKeywords = (text.match(/[\u4e00-\u9fa5]{2,}/g) || []);
  // 提取英文关键词（3个及以上字母）
  const enKeywords = (text.toLowerCase().match(/[a-z]{3,}/g) || []);
  return [...new Set([...cnKeywords, ...enKeywords])];
}

/**
 * 去掉"而非 / 误作 / 错成 / 误为"之后的对比示例尾串。
 *
 * 诊断模式下，模型常在"错因"里引用学生写错的数值/矩阵（如"应为 [[4,-2],[-3,1]]
 * 而非 [[4,2],[3,1]]""应为 3Ω 而非 12Ω"）。这些被引用的错误数字若参与数值一致性
 * 校验（numsOk），会把"正确诊断"误判为数值不符。这里只剔除对比尾串，保留模型自身
 * 给出的结论数字，不影响文本重叠率（overlap）计算。
 */
function stripContrastTail(text) {
  return text.replace(/(而非|误作|错成|误为|错写为|误写为|误算成)[^\n]*/g, '');
}

// ── 结构化金标准（expected_facts）严格数值一致性判据 ────────────────────────────
// 背景：legacy evalTeach 用「三选一即 PASS」（首数字容差 / 特殊词 / 关键词重叠），
// 对「五段格式齐全但数值、符号、配对结论错误」的输出完全无能：极值题 truth 含
// -2,2,-1,1,3，模型把极大/极小配对写反仍会撞上数字交集而通过。
// 这里只对显式声明了 expected_facts 的 case 生效，校验的是「配对关系」而非数字集合交集：
//   pair 断言要求在「标签子句」内检到 f(at)=value 这类把位置与取值绑定的表达式。
// 无 expected_facts 的 case 评分逻辑一行不改（见 scoreResult 的分支顺序）。
// 字段 schema 与判据规则见 docs/回归门禁数值判据.md。

const DEFAULT_NUMERIC_TOLERANCE = 0.05;
/** 金标准命中率低于该阈值即视为「漏传 --set / 题集不匹配」，报错并非零退出。 */
const MIN_TRUTH_HIT_RATE = 0.6;

/**
 * 归一化数值文本，供数值抽取使用：
 *  - Unicode 负号、全角括号/等号/逗号统一；
 *  - Unicode 下标 ₀-₉ 转 ASCII（a₅ → a5）；
 *  - \frac{a}{b} 转十进制；
 *  - 去掉 ^2 / ^{3} 等指数，避免把指数当成独立数值；
 *  - \pm N / ±N 展开为 -N 与 N 两个数值；
 *  - \infty 家族不作为数值。
 */
function normalizeNumericText(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/[−–—]/g, '-').replace(/＋/g, '+').replace(/＝/g, '=').replace(/≈/g, '=');
  s = s.replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/；/g, ';');
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (ch) => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(ch)));
  s = s.replace(/\\frac\{\s*(-?\d+\.?\d*)\s*\}\{\s*(-?\d+\.?\d*)\s*\}/g, (_m, a, b) => String(Number(a) / Number(b)));
  s = s.replace(/\^\s*\{?\s*-?\d+\.?\d*\s*\}?/g, '');
  s = s.replace(/(?:\\pm|±)\s*(-?\d+\.?\d*)/g, (_m, n) => `-${n} ${n}`);
  s = s.replace(/[+-]?\\?infty/g, ' ');
  return s;
}

/** 抽取文本中的全部数值（已归一化，跳过 NaN / 非有限值）。 */
function extractNumbers(text) {
  const s = normalizeNumericText(text);
  return (s.match(/-?\d+\.?\d*/g) || []).map(Number).filter((n) => Number.isFinite(n));
}

/** 数值一致：复用既有 numsMatchFunc（相对误差 < tol，期望值 0 时绝对误差 < 0.01），仅补 Infinity 相等。 */
function numEq(a, b, tol = DEFAULT_NUMERIC_TOLERANCE) {
  if (a === b) return true;
  return numsMatchFunc(Number(a), Number(b), tol);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 抽取「配对绑定」：把「位置 / 自变量」与「取值」写在同一个表达式里的片段。
 * 支持：
 *   1) 函数/数列型  f(-1)=2、a_3=7、a(5)=31、S(2)=3
 *   2) 坐标型      (1,-2)、(-1, 2)（拐点 / 极值点坐标）
 * 这些片段才承载配对语义；单纯罗列数字不构成绑定。
 */
function extractBindings(clause) {
  const out = [];
  const push = (at, value, raw) => {
    const a = Number(at);
    const v = Number(value);
    if (Number.isFinite(a) && Number.isFinite(v)) out.push({ at: a, value: v, raw: String(raw).trim() });
  };
  const fnRe = /(?:^|[^A-Za-z0-9])([fFaAgS])\s*[(_^{]*\s*(-?\d+\.?\d*)\s*[)}_]*\s*=\s*(-?\d+\.?\d*)/g;
  let m = null;
  while ((m = fnRe.exec(clause)) !== null) push(m[2], m[3], m[0]);
  const ptRe = /\(\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\)/g;
  while ((m = ptRe.exec(clause)) !== null) push(m[1], m[2], m[0]);
  return out;
}

/**
 * 按锚点定位「子句」：从锚点向左回退到最近句读、向右推进到最近句读（或上限长度），
 * 多个锚点的子句拼接。用于把断言限定在「标签所在的那一小段」，避免跨题/跨标签串味。
 */
function clauseFor(text, anchors, opts = {}) {
  const src = String(text || '');
  const leftPad = opts.leftPad ?? 60;
  const rightPad = opts.rightPad ?? 140;
  const rightStops = opts.rightStops ?? /[\n。;；]/;
  const leftStops = /[\n。;；,，]/;
  const list = (Array.isArray(anchors) ? anchors : [anchors]).filter((a) => typeof a === 'string' && a.length > 0);
  const segments = [];
  for (const anchor of list) {
    let from = 0;
    for (;;) {
      const idx = src.indexOf(anchor, from);
      if (idx < 0) break;
      from = idx + anchor.length;
      let start = Math.max(0, idx - leftPad);
      for (let i = start; i < idx; i++) if (leftStops.test(src[i])) start = i + 1;
      let end = Math.min(src.length, idx + anchor.length + rightPad);
      // 逗号只有在括号外才算子句结束：(1,-2) 这样的坐标/区间内部逗号不能截断子句。
      let depth = 0;
      for (let i = idx + anchor.length; i < end; i++) {
        const ch = src[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        if (depth === 0 && rightStops.test(ch)) { end = i; break; }
      }
      segments.push(src.slice(start, end));
    }
  }
  return segments.join('\n');
}

/**
 * 消费报告结果：优先 fields.correct_answer + fields.derivation，回落 r.text。
 * 同时保留 raw 版本供 text 断言做子串匹配（避免归一化改写掉 2^{n} 等写法）。
 */
function resolveSources(r) {
  const fields = r && r.fields && typeof r.fields === 'object' ? r.fields : {};
  const rawText = r && typeof r.text === 'string' ? r.text : '';
  const fieldAnswer = typeof fields.correct_answer === 'string' ? fields.correct_answer.trim() : '';
  const answerLine = rawText.match(/正确答案[：:]\s*([^\n]*)/);
  const rawAnswer = fieldAnswer || (answerLine ? answerLine[1].trim() : '');
  const rawDerivation = typeof fields.derivation === 'string' ? fields.derivation.trim() : '';
  const rawAny = [rawAnswer, rawDerivation, rawText].filter(Boolean).join('\n');
  return {
    answer: normalizeNumericText(rawAnswer),
    derivation: normalizeNumericText(rawDerivation),
    any: normalizeNumericText(rawAny),
    fullText: normalizeNumericText(rawText),
    raw: { answer: rawAnswer, derivation: rawDerivation, any: rawAny, fullText: rawText },
  };
}

/** 按断言声明的 source 取文本；answer 缺省时回落 r.text（fullText）。 */
function pickSource(sources, name, raw = false) {
  const key = name === 'answer' || name === 'derivation' ? name : 'any';
  const bucket = raw ? sources.raw : sources;
  if (key === 'answer' && !bucket.answer) return bucket.fullText || '';
  return bucket[key] || '';
}

/** pair 断言：标签子句内必须存在 (at, value) 正确的配对绑定。 */
function evalPairAssertion(a, sources, tol) {
  const label = String(a.label ?? '');
  const at = Number(a.at);
  const value = Number(a.value);
  const anchors = Array.isArray(a.match_any) && a.match_any.length ? a.match_any : [label];
  const clause = clauseFor(pickSource(sources, a.source), anchors, {
    rightStops: /[\n。;；,，]/,
    rightPad: 140,
    leftPad: 60,
  });
  const expected = `标签「${label}」处须出现配对 f(${at})=${value}`;
  if (!clause.trim()) {
    return { ok: false, kind: 'pair', label, expected, detected: `未找到标签/锚点 [${anchors.join(' | ')}]` };
  }
  const bindings = extractBindings(clause);
  let ok = false;
  let detected = '';
  if (bindings.length > 0) {
    ok = bindings.some((b) => numEq(b.at, at, tol) && numEq(b.value, value, tol));
    detected = `检到配对 [${bindings.map((b) => `f(${b.at})=${b.value}`).join(', ')}]`;
  } else {
    // 保守回落：无显式绑定时，要求 x=<at> 与 <value> 同时出现在同一子句内。
    const atRe = new RegExp(`x\\s*=\\s*${escapeRegExp(String(at))}(?!\\d)`);
    const hasAt = atRe.test(clause);
    const nums = extractNumbers(clause);
    const hasValue = nums.some((n) => numEq(n, value, tol));
    ok = hasAt && hasValue;
    detected = `无显式配对绑定；x=${at} 出现=${hasAt}，值 ${value} 出现=${hasValue}，子句数值=[${nums.join(', ')}]`;
  }
  return { ok, kind: 'pair', label, expected, detected };
}

/** set 断言：标签子句内必须「全部」出现 values（可选 exclude 禁止出现的值）。不是交集。 */
function evalSetAssertion(a, sources, tol) {
  const label = String(a.label ?? '');
  const values = (Array.isArray(a.values) ? a.values : []).map(Number).filter(Number.isFinite);
  const exclude = (Array.isArray(a.exclude) ? a.exclude : []).map(Number).filter(Number.isFinite);
  const anchors = Array.isArray(a.match_any) && a.match_any.length ? a.match_any : [label];
  const clause = clauseFor(pickSource(sources, a.source), anchors, { rightPad: 140, leftPad: 40 });
  const expected = `「${label}」子句内必须全部出现 ${JSON.stringify(values)}${exclude.length ? `，且不得出现 ${JSON.stringify(exclude)}` : ''}`;
  if (!clause.trim()) {
    return { ok: false, kind: 'set', label, expected, detected: `未找到定位锚点 [${anchors.join(' | ')}]` };
  }
  const nums = extractNumbers(clause);
  const missing = values.filter((v) => !nums.some((n) => numEq(n, v, tol)));
  const forbidden = exclude.filter((v) => nums.some((n) => numEq(n, v, tol)));
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    kind: 'set',
    label,
    expected,
    detected: `子句数值=[${nums.join(', ')}]；缺失=${JSON.stringify(missing)}；命中禁用值=${JSON.stringify(forbidden)}`,
  };
}

function parseEndpoint(s) {
  const raw = String(s).trim();
  if (/infty|∞/.test(raw)) return /-/.test(raw) ? -Infinity : Infinity;
  const nums = extractNumbers(raw);
  return nums.length ? nums[0] : null;
}

/** 解析子句中的区间表达式，保留端点开闭括号。 */
function parseIntervals(clause) {
  const out = [];
  const re = /([\[(])\s*([^,)\]\n]{1,24}?)\s*,\s*([^,)\]\n]{1,24}?)\s*([\])])/g;
  let m = null;
  while ((m = re.exec(clause)) !== null) {
    const left = parseEndpoint(m[2]);
    const right = parseEndpoint(m[3]);
    if (left === null || right === null) continue;
    out.push({ left, right, left_bracket: m[1], right_bracket: m[4] });
  }
  return out;
}

function bracketMatch(actual, expected) {
  const allow = expected === undefined ? ['[', '('] : (Array.isArray(expected) ? expected : [expected]);
  return allow.includes(actual);
}

/** interval 断言：逐段校验端点数值 + 开闭括号（用于单调区间开闭与定义域约束）。 */
function evalIntervalAssertion(a, sources, tol) {
  const label = String(a.label ?? '');
  const segments = Array.isArray(a.segments) ? a.segments : [];
  const clause = clauseFor(pickSource(sources, a.source), [label], { rightPad: 160, leftPad: 30 });
  const parsed = parseIntervals(clause);
  const unmatched = segments.filter((seg) => !parsed.some((p) =>
    numEq(p.left, Number(seg.left), tol) &&
    numEq(p.right, Number(seg.right), tol) &&
    bracketMatch(p.left_bracket, seg.left_bracket) &&
    bracketMatch(p.right_bracket, seg.right_bracket)
  ));
  const expected = segments.map((s) => `${s.left_bracket ?? '['}${s.left},${s.right}${s.right_bracket ?? ']'}`).join(' ');
  const detected = parsed.map((p) => `${p.left_bracket}${p.left},${p.right}${p.right_bracket}`).join(' ');
  return {
    ok: clause.trim().length > 0 && segments.length > 0 && unmatched.length === 0,
    kind: 'interval',
    label,
    expected: `「${label}」须包含 ${expected}`,
    detected: `检到区间 [${detected}]；未满足段数=${unmatched.length}`,
  };
}

// ── 单调方向绑定判据（2026-11-06） ─────────────────────────────────────────────
// 背景：Qwen3.5-9B 离线评测里 v0.2b-guard-trap 的「正确推导」写对了 f'(x)>0 ⇒ 递增，
// 但「正确答案」行把增/减区间整体写反（10/10）。原有判据都拦不住：
//   - interval 只要求「期望段出现」，且标签字面必须命中「增区间/减区间」，
//     遇到「单调递增区间」等别名会直接找不到锚点而误杀；
//   - text 只是子串存在性，不绑定「哪个符号对应哪个方向」；
//   - evalTeach 三选一即 PASS，数字集合一致就算过。
// 这里把「方向标签 ↔ 区间集合」做成双向绑定：
//   1) 每个方向的期望段必须全部出现在该方向的子句内；
//   2) 每个方向的子句内不得出现另一方向的期望段（增/减写反的直接信号）；
//   3) 两个方向都必须给出区间。
// strict_brackets 默认 false：教材对单调区间端点开闭写法不统一（[-2,-1] vs [-2,-1)），
// 这里只校验端点数值；严格开闭由同 case 的 interval 断言负责（如 nx02）。

const MONOTONIC_ALIASES = {
  increasing: ['单调递增区间', '单调增区间', '递增区间', '增区间', '上升区间'],
  decreasing: ['单调递减区间', '单调减区间', '递减区间', '减区间', '下降区间'],
};

function fmtSegment(s) {
  return `${s.left_bracket ?? '['}${s.left},${s.right}${s.right_bracket ?? ']'}`;
}

function fmtParsedIntervals(list) {
  return list.map((p) => `${p.left_bracket}${p.left},${p.right}${p.right_bracket}`).join(' ');
}

/** 方向别名可能在同一处命中多次（如「单调递增区间」同时含「递增区间」「增区间」），去重后再判定与展示。 */
function dedupeIntervals(list) {
  const seen = new Set();
  return list.filter((p) => {
    const key = `${p.left_bracket}${p.left},${p.right}${p.right_bracket}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function segmentHit(parsed, seg, tol, strictBrackets) {
  return parsed.some((p) =>
    numEq(p.left, Number(seg.left), tol) &&
    numEq(p.right, Number(seg.right), tol) &&
    (!strictBrackets || (
      bracketMatch(p.left_bracket, seg.left_bracket) &&
      bracketMatch(p.right_bracket, seg.right_bracket)
    ))
  );
}

/** monotonic_direction 断言：方向标签与区间集合的双向绑定（写反即 FAIL）。 */
function evalMonotonicDirectionAssertion(a, sources, tol) {
  const label = String(a.label ?? '单调方向');
  const strictBrackets = !!a.strict_brackets;
  const sourceText = pickSource(sources, a.source);
  const dirs = ['increasing', 'decreasing'];
  const cn = { increasing: '增', decreasing: '减' };
  const cfg = {};
  const parsed = {};
  const problems = [];

  for (const dir of dirs) {
    const d = a[dir] && typeof a[dir] === 'object' ? a[dir] : {};
    cfg[dir] = (Array.isArray(d.segments) ? d.segments : []).filter(
      (s) => Number.isFinite(Number(s.left)) && Number.isFinite(Number(s.right))
    );
  }

  for (const dir of dirs) {
    const d = a[dir] && typeof a[dir] === 'object' ? a[dir] : {};
    const anchors = Array.isArray(d.match_any) && d.match_any.length ? d.match_any : MONOTONIC_ALIASES[dir];
    const clause = clauseFor(sourceText, anchors, { rightPad: 180, leftPad: 40, rightStops: /[\n。;；,，]/ });
    parsed[dir] = dedupeIntervals(parseIntervals(clause));
    if (!clause.trim()) {
      problems.push(`「${cn[dir]}」方向标签未命中（锚点 [${anchors.join(' | ')}]）`);
      continue;
    }
    if (cfg[dir].length === 0) {
      problems.push(`「${cn[dir]}」未声明期望段`);
      continue;
    }
    if (parsed[dir].length === 0) {
      problems.push(`「${cn[dir]}」子句内未检到区间表达式`);
      continue;
    }
    const missing = cfg[dir].filter((s) => !segmentHit(parsed[dir], s, tol, strictBrackets));
    if (missing.length) problems.push(`「${cn[dir]}」缺少期望段 [${missing.map(fmtSegment).join(' ')}]`);
    // 方向互斥：反向期望段出现在本方向子句内 ⇒ 增/减被交换。
    const other = dir === 'increasing' ? 'decreasing' : 'increasing';
    const conflict = cfg[other].filter((s) => segmentHit(parsed[dir], s, tol, false));
    if (conflict.length) {
      problems.push(`「${cn[dir]}」子句内出现反向区间 [${conflict.map(fmtSegment).join(' ')}] ⇒ 方向写反`);
    }
  }

  const expected = dirs.map((d) => `${cn[d]}须含 ${(cfg[d] || []).map(fmtSegment).join(' ') || '(未声明)'}`).join('；')
    + `；两方向互斥${strictBrackets ? '（校验开闭）' : '（不校验开闭）'}`;
  const detected = dirs.map((d) => `${cn[d]}=[${fmtParsedIntervals(parsed[d] || [])}]`).join(' ')
    + (problems.length ? `；问题：${problems.join(' | ')}` : '；两方向绑定一致');
  return { ok: problems.length === 0, kind: 'monotonic_direction', label, expected, detected };
}

/** text 断言：子串级 all_of / any_of / none_of，用于导数符号、通项写法等结构性描述。 */
function evalTextAssertion(a, sources) {
  const label = String(a.label ?? '');
  const sourceText = pickSource(sources, a.source, true);
  const contains = (item) => {
    if (Array.isArray(item)) return item.some((x) => sourceText.includes(String(x)));
    return sourceText.includes(String(item));
  };
  const allOf = Array.isArray(a.all_of) ? a.all_of : [];
  const anyOf = Array.isArray(a.any_of) ? a.any_of : [];
  const noneOf = Array.isArray(a.none_of) ? a.none_of : [];
  const missing = allOf.filter((x) => !contains(x));
  const anyOk = anyOf.length === 0 || anyOf.some((x) => contains(x));
  const forbidden = noneOf.filter((x) => contains(x));
  return {
    ok: missing.length === 0 && anyOk && forbidden.length === 0,
    kind: 'text',
    label,
    expected: `all_of=${JSON.stringify(allOf)} any_of=${JSON.stringify(anyOf)} none_of=${JSON.stringify(noneOf)}`,
    detected: `缺失=${JSON.stringify(missing)}；any_of 命中=${anyOk}；命中禁用=${JSON.stringify(forbidden)}`,
  };
}

/**
 * 严格数值一致性判据（仅用于声明了 expected_facts 的 case）。
 * 所有断言必须全部满足；任一不满足即 FAIL，并给出可读 reason + 逐条 detail。
 */
function evalNumericFacts(r, expectedFacts) {
  const facts = expectedFacts && typeof expectedFacts === 'object' ? expectedFacts : null;
  const assertions = facts && Array.isArray(facts.assertions) ? facts.assertions : [];
  const tol = facts && Number.isFinite(Number(facts.tolerance)) ? Number(facts.tolerance) : DEFAULT_NUMERIC_TOLERANCE;
  if (!facts || assertions.length === 0) {
    return { verdict: 'FAIL', reason: 'numeric_facts_empty', detail: '声明了 expected_facts 但没有任何断言，拒绝静默通过' };
  }
  const sources = resolveSources(r);
  if (!sources.any.trim()) {
    return { verdict: 'FAIL', reason: 'numeric_missing_answer', detail: '结果中无可消费的 fields.correct_answer / fields.derivation / text' };
  }
  const failures = [];
  for (const a of assertions) {
    let res;
    switch (a && a.kind) {
      case 'pair': res = evalPairAssertion(a, sources, tol); break;
      case 'set': res = evalSetAssertion(a, sources, tol); break;
      case 'interval': res = evalIntervalAssertion(a, sources, tol); break;
      case 'monotonic_direction': res = evalMonotonicDirectionAssertion(a, sources, tol); break;
      case 'text': res = evalTextAssertion(a, sources); break;
      default:
        res = {
          ok: false,
          kind: String((a && a.kind) || 'unknown'),
          label: String((a && a.label) || ''),
          expected: '受支持的断言类型：pair | set | interval | monotonic_direction | text',
          detected: `未知 kind=${String((a && a.kind) || 'undefined')}`,
        };
    }
    if (!res.ok) failures.push(res);
  }
  if (failures.length > 0) {
    const reason = failures.some((f) => f.kind === 'monotonic_direction') ? 'numeric_direction_mismatch'
      : failures.some((f) => f.kind === 'pair') ? 'numeric_pair_mismatch'
        : failures.some((f) => f.kind === 'interval') ? 'numeric_interval_mismatch'
          : failures.some((f) => f.kind === 'set') ? 'numeric_set_mismatch'
            : 'numeric_fact_mismatch';
    const detail = failures.map((f) => `[${f.kind}/${f.label}] 期望 ${f.expected}；实际 ${f.detected}`).join(' | ');
    return { verdict: 'FAIL', reason, detail };
  }
  return { verdict: 'PASS', reason: 'numeric_facts_match', detail: `${assertions.length} 条结构化数值断言全部满足（容差 ${tol}）` };
}

/** 统计 report 的 case_id 在题集中命中到非空 provisional_truth 的比例。 */
function computeTruthHitRate(results, truthMap) {
  const list = Array.isArray(results) ? results : [];
  let hits = 0;
  for (const r of list) {
    const t = truthMap.get(r && r.case_id);
    if (typeof t === 'string' && t.trim().length > 0) hits++;
  }
  return { hits, total: list.length, rate: list.length === 0 ? 0 : hits / list.length };
}

/**
 * 单条结果评分入口。
 * 硬约束：只在其之前加 expected_facts 分支；无该字段的 case 仍走原 evalDiagnose / evalTeach，
 * 判定式一行不改，历史报告重跑结论完全相同。
 */
function scoreResult(r, ctx = {}) {
  if (ctx.expectedFacts) return evalNumericFacts(r, ctx.expectedFacts);
  if (r.mode === 'diagnose') return evalDiagnose(r.text || '', ctx.truth || '', ctx.isTrap);
  return evalTeach(r.text || '', ctx.truth || '');
}

// ── 诊断模式评分 ──────────────────────────────────────────────────────────────

function evalDiagnose(modelText, truth, isTrap) {
  // 1) 陷阱题检查：truth 说正确，model 不能给错因
  if (isTrap) {
    // 模型必须明确说"正确"且不给错因
    const hasCorrect = hasCorrectSemantics(modelText);
    const hasError = hasErrorSemantics(modelText);
    // 如果模型既说了"正确"，又没有给出具体错因 → PASS
    // 注意：知识点/本质部分可以讨论正确解法，只要错因行明确说"无错"
    const causeLine = modelText.split('\n').find(l => l.includes('错因'));
    if (hasCorrect && (!causeLine || !hasErrorSemantics(causeLine))) {
      return { verdict: 'PASS', reason: 'trap_ok', detail: '陷阱题：明确判定为正确' };
    }
    return { verdict: 'FAIL', reason: 'trap_fabricate', detail: '陷阱题：编造了错因' };
  }

  const m = extractEntities(modelText);
  const t = extractEntities(truth);

  // 2) 检查自相矛盾（区分"应为 X 而非 Y"的正确纠正 vs 自相矛盾）
  // "应为 X 而非 X"（同一值）才是自相矛盾；"应为 X 而非 Y"是正常纠正
  // 修复：原正则 /应为\s*([^非]+)\s*而非\s*\1/ 中 [^非]+ 贪婪，会把 "NO₂" 里的 "NO"
  // 当成 group1、再匹配 "而非\1" 命中 "NO₂" 中的 "NO"，误判 NO vs NO₂ 这种正确纠正为自相矛盾。
  // 改为分别捕获 X、Y 两个独立非空白 token，仅在 X===Y（如 "应为 36g 而非 36g"）才判自相矛盾。
  const scMatch = modelText.match(/应为\s*(\S+)\s*而非\s*(\S+)/);
  let selfContradict = /从正确的.*误/.test(modelText);
  if (scMatch) {
    const scX = scMatch[1];
    const scY = scMatch[2].replace(/[，。；,;：:、.（）()\[\]]$/, '');
    selfContradict = selfContradict || scX === scY;
  }
  if (selfContradict) {
    return { verdict: 'FAIL', reason: 'self_contradict', detail: '输出自相矛盾（同一值前后矛盾）' };
  }

  // 3) 错因方向是否一致
  // 说明：诊断模式只校验"错因"方向（关键词重叠）。数值一致性校验（numsOk）已移除：
  // 本批题上 v0.2-guard 的诊断错因方向全部正确，而模型在"错因"中额外写的正确上下文数字
  // （如 R/2、22.4、对比中的错误示例值）会被 numsOk 误判为数值不符，纯属噪声。讲解模式
  // （evalTeach）仍保留严格数值校验，因为那里错的是"正确答案"本身（如 m05 差值、m11 极值）。
  const overlap = keywordOverlap(modelText, truth);

  if (overlap >= 0.3) {
    return { verdict: 'PASS', reason: 'direction_match', detail: `关键词重叠 ${overlap.toFixed(2)}，错因方向一致` };
  }
  if (overlap >= 0.2) {
    return { verdict: 'PARTIAL', reason: 'partial_match', detail: `关键词重叠 ${overlap.toFixed(2)}` };
  }
  return { verdict: 'FAIL', reason: 'direction_miss', detail: `关键词重叠 ${overlap.toFixed(2)}` };
}

// ── 讲解模式评分 ──────────────────────────────────────────────────────────────

function evalTeach(modelText, truth) {
  const m = extractEntities(modelText);
  const t = extractEntities(truth);

  // 提取模型答案行
  const answerMatch = modelText.match(/正确答案[：:]\s*(.+)$/m);
  const modelAnswer = answerMatch ? answerMatch[1].trim() : modelText.slice(0, 200);

  // 1) 检查自相矛盾
  // 修复：同诊断模式，原正则贪婪匹配会把 "NO₂" 误判为与 "NO" 自相矛盾。
  const scMatch = modelText.match(/应为\s*(\S+)\s*而非\s*(\S+)/);
  let selfContradict = /从正确的.*误/.test(modelText);
  if (scMatch) {
    const scX = scMatch[1];
    const scY = scMatch[2].replace(/[，。；,;：:、.（）()\[\]]$/, '');
    selfContradict = selfContradict || scX === scY;
  }
  if (selfContradict) {
    return { verdict: 'FAIL', reason: 'self_contradict', detail: '输出自相矛盾' };
  }

  // 2) 关键数值匹配（提取答案值和真理值）
  const modelNums = extractNums(modelAnswer);
  const truthNums = extractNums(truth);

  // 找主要答案值（通常是最后一个或特定的关键值）
  let modelKeyNum = null;
  let truthKeyNum = null;

  // 尝试从答案行提取关键数值
  const modelAnswerNumMatch = modelAnswer.match(/(\d+\.?\d*)/);
  if (modelAnswerNumMatch) modelKeyNum = parseFloat(modelAnswerNumMatch[1]);

  // 从真理中提取 pH 值或最终答案
  const truthPHEq = truth.match(/pH[=≈]=\s*(\d+\.?\d*)/i);
  if (truthPHEq) truthKeyNum = parseFloat(truthPHEq[1]);
  else if (truthNums.length > 0) truthKeyNum = truthNums[truthNums.length - 1];

  // 比较关键数值
  let numsMatchFlag = false;
  if (modelKeyNum !== null && truthKeyNum !== null) {
    numsMatchFlag = numsMatchFunc(modelKeyNum, truthKeyNum);
  } else {
    // 如果没有明确的关键值，检查是否有数值重叠
    numsMatchFlag = modelNums.some(mn => truthNums.some(tn => numsMatchFunc(mn, tn)));
  }

  // 3) 关键词重叠检查
  const overlap = keywordOverlap(modelAnswer, truth);

  // 4) 特殊关键词检查（适用于非数值类答案）
  const mKeywords = extractKeywords(modelAnswer);
  const tKeywords = extractKeywords(truth);
  let keywordMatch = false;
  for (const kw of tKeywords) {
    if (modelAnswer.toLowerCase().includes(kw.toLowerCase())) {
      keywordMatch = true;
      break;
    }
  }

  // 综合判定：数值正确 或 关键词匹配 或 特殊词匹配 都算通过
  const specialKeywords = ['条件收敛', '绝对收敛', '发散', '收敛', '正确', '错误'];
  let specialMatch = specialKeywords.some(kw => modelAnswer.includes(kw) && truth.includes(kw));
  if (numsMatchFlag || specialMatch || (keywordMatch && overlap >= 0.1)) {
    return { verdict: 'PASS', reason: 'answer_match', detail: `答案匹配 (数值=${numsMatchFlag}, 特殊词=${specialMatch})` };
  }
  if (overlap >= 0.1) {
    return { verdict: 'PARTIAL', reason: 'partial_answer', detail: `答案部分匹配 (重叠=${overlap.toFixed(2)})` };
  }
  return { verdict: 'FAIL', reason: 'answer_miss', detail: `答案不匹配 (重叠=${overlap.toFixed(2)}, 数值:${modelKeyNum||'N/A'} vs ${truthKeyNum||'N/A'})` };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let jsonPath = null;
  let setPath = null;
  let casesFilter = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && i + 1 < args.length) {
      jsonPath = args[++i];
    } else if (args[i] === '--set' && i + 1 < args.length) {
      setPath = path.resolve(args[++i]);
    } else if (args[i] === '--cases' && i + 1 < args.length) {
      casesFilter = new Set(args[++i].split(','));
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  if (!jsonPath) {
    console.error('用法: npm run auto-eval -- --json <path> --set <题集> [--cases c01,c02] [--verbose]');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const setDoc = JSON.parse(fs.readFileSync(setPath || DEFAULT_SET_PATH, 'utf8'));
  const truthMap = new Map(setDoc.cases.map(c => [c.id, c.provisional_truth]));
  // 用 fixtures 中权威的 trap 布尔值作为陷阱判定金标准，避免 isTrapTruth 的正则
  // 在 truth 含"错误/误判"等词时提前 return false、漏掉真正的陷阱题（e04/c02 曾因此被误判）。
  const trapMap = new Map(setDoc.cases.map(c => [c.id, !!c.trap]));
  // 仅声明了 expected_facts 的 case 启用严格数值判据；历史 case 无此字段 → 走原判定式。
  const factsMap = new Map(
    setDoc.cases.filter(c => c.expected_facts && typeof c.expected_facts === 'object').map(c => [c.id, c.expected_facts])
  );

  // 过滤
  let results = report.results;
  if (casesFilter) {
    results = results.filter(r => casesFilter.has(r.case_id));
  }

  // 防「漏 --set 静默假结论」：金标准大面积为空时报错并非零退出。
  // attrib-regress.mjs 正常传 --set，且题集 case_id 与报告完全一致 → 命中率 100%，不受影响。
  const hit = computeTruthHitRate(results, truthMap);
  if (hit.total === 0) {
    console.error('[auto-eval] 报告 results 为空，无法评分。');
    process.exit(2);
  }
  if (hit.rate < MIN_TRUTH_HIT_RATE) {
    console.error(`[auto-eval] 金标准命中率过低：${hit.hits}/${hit.total} (${(hit.rate * 100).toFixed(0)}%)，低于阈值 ${(MIN_TRUTH_HIT_RATE * 100).toFixed(0)}%。`);
    console.error('[auto-eval] 这通常意味着漏传 --set，或指定的题集与报告 case_id 不匹配（truth 全空会得出无意义的 PASS/FAIL）。');
    console.error('[auto-eval] 请显式传 --set <题集路径>，例：--set apps/api/src/tests/fixtures/prompt-ab-set-realexam.json');
    process.exit(2);
  }

  // 评分：scoreResult 内部「先加 expected_facts 严格分支，再原样走 evalDiagnose / evalTeach」。
  // 无 expected_facts 的历史 case 判定式与改动前完全一致（已由 3 份历史报告回放核对）。
  const scored = results.map(r => {
    const truth = truthMap.get(r.case_id) || '';
    const isTrap = trapMap.get(r.case_id) ?? isTrapTruth(truth);
    const evalResult = scoreResult(r, { truth, isTrap, expectedFacts: factsMap.get(r.case_id) });
    return {
      ...r,
      eval: evalResult,
      truth: truth.slice(0, 120),
      isTrap,
    };
  });

  // 汇总
  const byVariant = new Map();
  for (const s of scored) {
    const v = byVariant.get(s.variant) ?? { variant: s.variant, n: 0, pass: 0, fail: 0, partial: 0, reasons: {} };
    v.n++;
    v[s.eval.verdict.toLowerCase()]++;
    v.reasons[s.eval.reason] = (v.reasons[s.eval.reason] || 0) + 1;
    byVariant.set(s.variant, v);
  }

  // 陷阱题专项
  const traps = scored.filter(s => s.isTrap);
  const trapPass = traps.filter(s => s.eval.verdict === 'PASS').length;

  // 输出
  console.log('\n=== AUTO-EVAL 汇总 ===');
  console.log(`总题数: ${scored.length}（含 ${traps.length} 道陷阱题）`);
  console.log(`JSON: ${path.relative(REPO_ROOT, jsonPath)}`);

  for (const v of byVariant.values()) {
    console.log(`\n--- ${v.variant} ---`);
    console.log(`  总: ${v.n} | PASS: ${v.pass} | PARTIAL: ${v.partial} | FAIL: ${v.fail}`);
    console.log(`  失败原因: ${JSON.stringify(v.reasons)}`);
  }

  const numericScored = scored.filter(s => factsMap.has(s.case_id));
  if (numericScored.length > 0) {
    const numericFail = numericScored.filter(s => s.eval.verdict === 'FAIL').length;
    console.log(`\n--- 严格数值判据（expected_facts） ---`);
    console.log(`  启用题数: ${numericScored.length} | 判 FAIL: ${numericFail}`);
  }

  console.log(`\n--- 陷阱题专项 ---`);
  // 无陷阱题的专项报告（如 10 条极值题回放）避免 0/0 产生 NaN%；
  // 保留 "x/y" 前缀不变，attrib-regress.mjs 的 gateFromAutoEval 正则仍可解析；有陷阱题时输出逐字不变。
  const trapRateText = traps.length ? `${(trapPass/traps.length*100).toFixed(0)}%` : 'n/a (无陷阱题)';
  console.log(`  未瞎编率: ${trapPass}/${traps.length} (${trapRateText})`);

  if (verbose) {
    console.log('\n=== 逐题详情 ===');
    for (const s of scored) {
      const mark = s.eval.verdict === 'PASS' ? '✓' : s.eval.verdict === 'FAIL' ? '✗' : '~';
      console.log(`[${mark}] ${s.case_id} | ${s.variant} | ${s.eval.reason}: ${s.eval.detail}`);
      if (s.eval.verdict === 'FAIL') {
        console.log(`    模型: ${(s.text||'').slice(0,100)}`);
        console.log(`    Truth: ${s.truth}`);
      }
    }
  }

  // 写报告
  const outDir = path.join(path.dirname(jsonPath), 'auto-eval');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outJson = path.join(outDir, `eval-${ts}.json`);
  const outMd = path.join(outDir, `eval-${ts}.md`);
  fs.writeFileSync(outJson, JSON.stringify({ generated_at: new Date().toISOString(), report_source: jsonPath, scored }, null, 2), 'utf8');

  const md = [`# Auto-Eval 报告`, `\n生成时间: ${new Date().toISOString()}`, `\n源报告: ${jsonPath}`, `\n\n## 汇总`];
  for (const v of byVariant.values()) {
    md.push(`\n### ${v.variant}`, `- PASS: ${v.pass}/${v.n} (${(v.pass/v.n*100).toFixed(0)}%)`, `- FAIL: ${v.fail}/${v.n}`, `- 原因: ${JSON.stringify(v.reasons)}`);
  }
  md.push(`\n## 陷阱题`, `- 未瞎编: ${trapPass}/${traps.length}`);
  if (verbose) {
    md.push('\n## 逐题', '| 题 | 变体 | 判定 | 原因 | 模型输出 |', '|---|---|---|---|---|');
    for (const s of scored) {
      const mark = s.eval.verdict === 'PASS' ? '✓' : s.eval.verdict === 'FAIL' ? '✗' : '~';
      const out = (s.text || '').replace(/\n/g, ' ').slice(0, 80);
      md.push(`| ${s.case_id} | ${s.variant} | ${mark} ${s.eval.reason} | ${s.eval.detail} | ${out} |`);
    }
  }
  fs.writeFileSync(outMd, md.join('\n'), 'utf8');
  console.log(`\n报告: ${outMd}`);
}

// 供离线单测直接 import（node --test）而不触发 CLI 主流程。
// 注意：evalTeach / evalDiagnose 的判定式保持原样，未作任何改动。
export {
  evalTeach,
  evalDiagnose,
  evalNumericFacts,
  evalMonotonicDirectionAssertion,
  scoreResult,
  computeTruthHitRate,
  resolveSources,
  extractNumbers,
  extractBindings,
  MIN_TRUTH_HIT_RATE,
  DEFAULT_NUMERIC_TOLERANCE,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath === modulePath) {
  main();
}
