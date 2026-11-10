/**
 * OCR 校验层回归测试（node:test）。
 * 8090 视觉端 P0 修复：拒识哨兵 + 全部选项 prompt + auto 分支三态传播 + 合并唯一来源。
 * 纯函数测试：不连 DB / 网络 / 3001，不 import provider 单例。
 *
 * 运行：npm -w @aicorrection/api run test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OCR_REJECT_TOKEN,
  OCR_PROMPT,
  OCR_LOCAL_PREFIX,
  OCR_VISION_PREFIX,
  isRejectedOcrText,
  mergeOcr,
  decideAutoOcrResult,
  type VisionOutcome,
  type OcrResult,
} from './ocrGuard';
// 占位题干唯一来源：mockProvider.ts 导出的常量（模块顶层无副作用，import 安全）。
import { MOCK_PLACEHOLDER_QUESTION } from '../llm/mockProvider';

const fixture = (name: string): string =>
  fs.readFileSync(
    fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
    'utf8'
  );

// ---------------- isRejectedOcrText ----------------

test('精确拒识 token → true', () => {
  assert.equal(isRejectedOcrText(OCR_REJECT_TOKEN), true);
});

test('token 带首尾空白 / 大小写混杂 → true', () => {
  assert.equal(isRejectedOcrText('  [[not_a_question]]  '), true);
  assert.equal(isRejectedOcrText('\n[[Not_A_Question]]\n'), true);
  assert.equal(isRejectedOcrText('[[ NOT_A_QUESTION ]]'), true); // 内部空白归一化
});

test('裸「非题目」+ 中英文标点 / 引号包裹 → true', () => {
  assert.equal(isRejectedOcrText('非题目'), true);
  assert.equal(isRejectedOcrText('非题目。'), true);
  assert.equal(isRejectedOcrText('非题目!'), true);
  assert.equal(isRejectedOcrText('"非题目"'), true);
  assert.equal(isRejectedOcrText('“非题目。！”'), true);
});

test('token 后跟短说明（半句）→ true', () => {
  assert.equal(isRejectedOcrText(`${OCR_REJECT_TOKEN} 这是一张海报`), true);
  assert.equal(isRejectedOcrText(`${OCR_REJECT_TOKEN}，图中无题目`), true);
});

test('真实选择题全文（含 A–D 选项）→ 不误杀', () => {
  const q =
    '下列关于函数 f(x)=x^2 的说法正确的是（  ）\n' +
    'A. 在 R 上单调递增\n' +
    'B. 是偶函数\n' +
    'C. 最小值为 -1\n' +
    'D. 图像关于 y 轴对称，请选出所有正确选项';
  assert.equal(isRejectedOcrText(q), false);
});

test('MOCK_PLACEHOLDER_QUESTION（mock 占位题干）→ 不误杀', () => {
  assert.equal(isRejectedOcrText(MOCK_PLACEHOLDER_QUESTION), false);
});

test('带 mergeOcr 前缀的合并文本 → 不误杀', () => {
  const merged =
    `${OCR_LOCAL_PREFIX}\n下列关于光合作用的叙述正确的是 A. ... B. ... C. ... D. ...\n\n` +
    `${OCR_VISION_PREFIX}\n题干与四个选项如下：A ... B ... C ... D ...`;
  assert.equal(isRejectedOcrText(merged), false);
});

test('空串 / 纯空白 → 不判拒识（交上层 !text 处理）', () => {
  assert.equal(isRejectedOcrText(''), false);
  assert.equal(isRejectedOcrText('   \n\t  '), false);
});

test('长文本（>200）一律不判拒识，即使内含「非题目」三字', () => {
  const long = '本试卷说明：非题目区域请勿作答。' + '本题要求逐项判断下列命题真伪。'.repeat(20);
  assert.ok(long.length > 200);
  assert.equal(isRejectedOcrText(long), false);
});

test('含「非题目」三字但确有题干（非以「非题目」开头）→ 不误杀', () => {
  const q = '请辨析以下说法是否属于非题目：下列说法正确的是 A. 1 B. 2 C. 3 D. 4';
  assert.equal(isRejectedOcrText(q), false);
});

test('臆造 LaTeX（garbage_*.txt）→ 不误杀', () => {
  for (const name of ['garbage_textonly.txt', 'garbage_ch_en_num.txt']) {
    assert.equal(isRejectedOcrText(fixture(name)), false, name);
  }
});

// ---------------- mergeOcr 唯一来源 ----------------

test('前缀常量值与原实现一致', () => {
  assert.equal(OCR_LOCAL_PREFIX, '【本地OCR识别】');
  assert.equal(OCR_VISION_PREFIX, '【视觉模型描述(MiniCPM-V)】');
});

test('mergeOcr 拼接两段前缀 / status / latex（行为一字不改）', () => {
  const local: OcrResult = {
    ocr_status: 'success',
    question: '本地题干 A. 1 B. 2',
    latex: '\\frac{1}{2}',
  };
  const vision: OcrResult = {
    ocr_status: 'success',
    question: '  视觉题干 C. 3 D. 4  ',
    latex: null,
  };
  const r = mergeOcr(local, vision);
  assert.equal(r.ocr_status, 'success');
  assert.equal(r.latex, '\\frac{1}{2}');
  assert.equal(r.question.split('\n\n').length, 2);
  assert.ok(r.question.startsWith(`${OCR_LOCAL_PREFIX}\n本地题干`));
  // 视觉段 trim 后拼接，末尾恰为前缀 + 去空白文本
  assert.ok(r.question.endsWith(`${OCR_VISION_PREFIX}\n视觉题干 C. 3 D. 4`));
});

test('mergeOcr 本地 partial → partial；视觉空题干则不拼第二段', () => {
  const local: OcrResult = { ocr_status: 'partial', question: '片段', latex: null };
  const emptyVision: OcrResult = { ocr_status: 'success', question: '   ', latex: null };
  const r = mergeOcr(local, emptyVision);
  assert.equal(r.ocr_status, 'partial');
  assert.equal(r.question, `${OCR_LOCAL_PREFIX}\n片段`);
  assert.ok(!r.question.includes(OCR_VISION_PREFIX));
});

test('合并后 question 形态（用前缀常量 + mergeOcr 构造）→ 不误杀', () => {
  const local: OcrResult = { ocr_status: 'success', question: '促销海报 全场五折', latex: null };
  const vision: OcrResult = { ocr_status: 'success', question: '一张商品促销海报', latex: null };
  const merged = mergeOcr(local, vision);
  assert.equal(isRejectedOcrText(merged.question), false);
});

// ---------------- decideAutoOcrResult 三态 ----------------

const localPoster: OcrResult = {
  ocr_status: 'success',
  question: '双十一特惠 促销海报 全场五折 满300减50 限时抢购',
  latex: null,
};

test('rejected → 覆盖本地，返回 fail + 空题干（V4 核心）', () => {
  const r = decideAutoOcrResult(localPoster, { kind: 'rejected' });
  assert.equal(r.ocr_status, 'fail');
  assert.equal(r.question, '');
  assert.equal(r.latex, null);
  // 绝不能夹带本地海报的任何内容
  for (const seg of ['双十一', '促销海报', '五折', '满300减50']) {
    assert.equal(r.question.includes(seg), false);
  }
});

test('unavailable → 静默保留本地结果（遗留语义）', () => {
  const r = decideAutoOcrResult(localPoster, { kind: 'unavailable' });
  assert.equal(r, localPoster); // 同一结果
  assert.equal(r.ocr_status, 'success');
  assert.equal(r.question, localPoster.question);
});

test('ok → 调用唯一来源 mergeOcr 拼接本地 + 视觉两路文本', () => {
  const ok: VisionOutcome = {
    kind: 'ok',
    result: {
      ocr_status: 'success',
      question: '已知函数 f(x)=x^2，判断奇偶性。A. 奇 B. 偶 C. 非奇非偶 D. 既奇又偶',
      latex: null,
    },
  };
  const r = decideAutoOcrResult(localPoster, ok);
  assert.equal(r.ocr_status, 'success');
  assert.ok(r.question.includes(OCR_LOCAL_PREFIX));
  assert.ok(r.question.includes(localPoster.question));
  assert.ok(r.question.includes(OCR_VISION_PREFIX));
  assert.ok(r.question.includes('判断奇偶性'));
  assert.equal(r.latex, null);
  // 与直接调 mergeOcr 完全一致，证明 decide 复用同一函数、无第二份实现
  assert.equal(r.question, mergeOcr(localPoster, ok.result).question);
});

test('ok + 本地 partial → 合并后 partial 且保留 latex', () => {
  const partialLocal: OcrResult = {
    ocr_status: 'partial',
    question: '（占位）题目片段',
    latex: '\\frac{1}{2}',
  };
  const ok: VisionOutcome = {
    kind: 'ok',
    result: { ocr_status: 'success', question: '完整题干 A. 1 B. 2', latex: null },
  };
  const r = decideAutoOcrResult(partialLocal, ok);
  assert.equal(r.ocr_status, 'partial');
  assert.equal(r.latex, '\\frac{1}{2}');
});

// ---------------- prompt 防回归 ----------------

test('OCR_PROMPT 含「所有选项」指令与拒识哨兵', () => {
  assert.ok(OCR_PROMPT.includes('所有选项'));
  assert.ok(OCR_PROMPT.includes(OCR_REJECT_TOKEN));
  assert.ok(OCR_PROMPT.includes('不得省略'));
});
