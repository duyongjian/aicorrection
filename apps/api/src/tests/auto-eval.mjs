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
 *   npm run auto-eval -- --json <path> [--cases c01,c02] [--verbose]
 *
 * 评分维度：
 *   - trap_no_fabricate: 陷阱题是否没编错因
 *   - cause_direction:   错因方向是否与 truth 一致
 *   - answer_correct:    讲解题答案是否正确
 *   - self_contradict:   输出自身是否自相矛盾（筛查信号）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(process.cwd());
const SET_PATH = path.join(REPO_ROOT, 'apps', 'api', 'src', 'tests', 'fixtures', 'prompt-ab-set.json');

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
  const selfContradict = /应为\s*([^非]+)\s*而非\s*\1/.test(modelText) || /从正确的.*误/.test(modelText);
  if (selfContradict) {
    return { verdict: 'FAIL', reason: 'self_contradict', detail: '输出自相矛盾（同一值前后矛盾）' };
  }

  // 3) 错因方向是否一致
  const overlap = keywordOverlap(modelText, truth);

  // 4) 检查数值一致性
  const mNums = extractNums(modelText);
  const tNums = extractNums(truth);
  let numsOk = true;
  if (mNums.length > 0 && tNums.length > 0) {
    numsOk = mNums.every(mn => tNums.some(tn => numsMatchFunc(mn, tn)));
  }

  if (overlap >= 0.3 && numsOk) {
    return { verdict: 'PASS', reason: 'direction_match', detail: `关键词重叠 ${overlap.toFixed(2)}，数值一致` };
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
  const selfContradict = /应为\s*([^非]+)\s*而非\s*\1/.test(modelText) || /从正确的.*误/.test(modelText);
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
  let casesFilter = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && i + 1 < args.length) {
      jsonPath = args[++i];
    } else if (args[i] === '--cases' && i + 1 < args.length) {
      casesFilter = new Set(args[++i].split(','));
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  if (!jsonPath) {
    console.error('用法: npm run auto-eval -- --json <path>');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const setDoc = JSON.parse(fs.readFileSync(SET_PATH, 'utf8'));
  const truthMap = new Map(setDoc.cases.map(c => [c.id, c.provisional_truth]));

  // 过滤
  let results = report.results;
  if (casesFilter) {
    results = results.filter(r => casesFilter.has(r.case_id));
  }

  // 评分
  const scored = results.map(r => {
    const truth = truthMap.get(r.case_id) || '';
    const isTrap = isTrapTruth(truth);
    let evalResult;
    if (r.mode === 'diagnose') {
      evalResult = evalDiagnose(r.text || '', truth, isTrap);
    } else {
      evalResult = evalTeach(r.text || '', truth);
    }
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

  console.log(`\n--- 陷阱题专项 ---`);
  console.log(`  未瞎编率: ${trapPass}/${traps.length} (${(trapPass/traps.length*100).toFixed(0)}%)`);

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

main();
