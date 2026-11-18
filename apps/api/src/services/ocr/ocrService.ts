/**
 * OCR 服务（INF-04）
 *
 * 图片入口策略链（OCR_MODE）：
 *   llm   → 只用视觉大模型（原逻辑保留）
 *   local → 只用本地 OCR；失败即 ocr_status='fail'
 *   auto  → 优先本地 OCR（RapidOCR ~2.4s），失败降级视觉大模型
 *
 * 文本入口（text/paste）无需 OCR，直接复用原文，ocr_status='success'。
 */
import fs from 'node:fs';
import { getRecognitionProvider } from '../llm';
import { ensureRecognitionReady } from './recognitionAutostart';
import { MockProvider } from '../llm/mockProvider';
import { env } from '../../config/env';
import { MOCK_ATTR_MODEL_VERSION } from '@aicorrection/shared';
import {
  runLocalOcr,
  type LocalOcrEngine,
} from './localOcrService';
import { validateLatex } from './latexGuard';
import { withTimeout } from '../../utils/promise';
import {
  OCR_PROMPT,
  isRejectedOcrText,
  decideAutoOcrResult,
  enforceAcademicSignal,
  localIsSufficient,
  type VisionOutcome,
  type OcrResult,
} from './ocrGuard';

// 兼容外部仍从 ocrService 引用该类型（OcrResult 定义已迁入 ocrGuard.ts，单一来源）。
export type { OcrResult } from './ocrGuard';

export interface RecognizeImageOpts {
  subject?: string;
  /** 仅用于日志定位：丢弃臆造 LaTeX 时打印，便于回溯是否误杀 */
  loopId?: string;
}

/** 本地 OCR 文本引擎名（受 OCR_TEXT_ENGINE 配置约束） */
const TEXT_ENGINE: LocalOcrEngine = env.OCR_TEXT_ENGINE;

/**
 * 公式识别独立时延预算（ms）：PP-FormulaNet-S 在重负载下推理会劣化到 13–16s，直接把整条
 * 生产链路拖过 V5 门禁。给公式识别设硬预算，超时即放弃 LaTeX、返回纯文本结果（文本识别
 * ~3.4s 不受影响），把本地 OCR 责任域墙钟稳定压在「文本 + 预算」之内。常态 4s 内完成则仍
 * 拼入 LaTeX（保 V2 字段级准确率）；重负载超时则牺牲 LaTeX 保时延。可通过 env.OCR_FORMULA_BUDGET_MS 覆盖。
 */
const FORMULA_BUDGET_MS = Number(env.OCR_FORMULA_BUDGET_MS ?? 5000);

/**
 * 文本识别耗时阈值（ms）：超过即判定机器 CPU 已被外部负载（如同机 8090 视觉模型）占满。
 * 此时公式识别几乎必然超预算，且会在后台继续吃 CPU 污染后续请求 → 直接跳过公式路、牺牲
 * LaTeX 保时延。常态文本 ~3.4s 远低于此，公式正常拼入。可通过 env.OCR_FORMULA_TEXT_SLOW_MS 覆盖。
 */
const FORMULA_TEXT_SLOW_MS = Number(env.OCR_FORMULA_TEXT_SLOW_MS ?? 6000);

/**
 * 公式识别超时后的冷却窗口（ms）：一次公式超预算即说明 paddle serve 正处于慢推理，
 * 其在后台仍会持续吃 CPU ~13–16s，若不冷却会拖慢接下来多次请求的文本识别。
 * 冷却期内所有公式请求直接跳过，让 paddle serve 跑完当前任务、释放 CPU。
 * 可通过 env.OCR_FORMULA_COOLDOWN_MS 覆盖。
 */
const FORMULA_COOLDOWN_MS = Number(env.OCR_FORMULA_COOLDOWN_MS ?? 20000);

/** 公式识别冷却截止时间戳（ms）；模块级启发式，避免 paddle 后台慢推理污染后续请求。 */
let formulaCooldownUntil = 0;

// ---- 公式触发判定（保守：避免每张图都多花 ~1.3s 还拿到垃圾 LaTeX）----

/** 命中即视为数学学科 */
const MATH_SUBJECT_KEYS = [
  'math',
  '数学',
  '高数',
  '高等数学',
  '线代',
  '线性代数',
  '概率',
  '概率论',
  '数理统计',
  '离散数学',
];

/** 公式符号（出现任一即触发，不必同时含数字）。注意：去掉 ^ —— 句中指数 e^(y+az) 也会命中，
 *  会误触发对整段题干跑 PP-FormulaNet-S（产出 exclamation_flood 垃圾 LaTeX，纯浪费时延）。 */
const MATH_SYMBOL_RE = /[∫√∑π±×÷≤≥≠≈∇∂]/;
/** 强数学结构符号（localIsSufficient 用，含义同 MATH_SYMBOL_RE 这里取不含 ^ 的口径）。 */
const MATH_STRUCT_RE = /[∫√∑π±×÷≤≥≠≈∇∂]/;
/** 中文数学词 */
const MATH_WORD_RE =
  /(求|解|证明|函数|方程|导数|积分|极限|矩阵|概率|极值|单调|数列|向量|微分|不等式)/;

/**
 * 判定是否值得再跑一次 Paddle 公式识别（PP-FormulaNet-S）。
 * 命中条件（保守，避免对整段题干误跑公式模型产出垃圾且浪费时延）：
 *  - 学科是数学类；或
 *  - 文本含"= 且有数字"，或含强结构公式符号（∫√∑∂∇π 等）。
 * 不再用中文数学词（方程/函数/证明…）触发：这类词出现在「整段题干」里，题干已由 rapid
 * 完整捕获，再跑 standalone 公式模型只会产出 exclamation_flood 垃圾 LaTeX（实测 implicit-partial-choice
 * 每次都命中且被丢弃），徒增 4–12s 时延。
 */
export function shouldTryFormula(subject?: string, text?: string): boolean {
  const s = (subject ?? '').toLowerCase();
  if (MATH_SUBJECT_KEYS.some((k) => s.includes(k))) return true;

  const t = text ?? '';
  if (!t) return false;
  const hasEqAndDigit = t.includes('=') && /\d/.test(t);
  return hasEqAndDigit || MATH_STRUCT_RE.test(t);
}

/** 文本入口：原文即为题干，无需 OCR。 */
export function recognizeText(rawText?: string): OcrResult {
  const question = (rawText ?? '').trim();
  return {
    ocr_status: question ? 'success' : 'fail',
    question,
    latex: null,
  };
}

/** 图片入口：本地 OCR 优先，按 OCR_MODE 决定是否叠加/降级视觉大模型。 */
export async function recognizeImage(
  imagePath: string,
  opts: RecognizeImageOpts = {}
): Promise<OcrResult> {
  if (env.OCR_MODE === 'llm') {
    // 纯视觉大模型模式（含探活 + 可选 mock 兜底）
    return recognizeImageByLlm(imagePath);
  }
  if (env.OCR_MODE === 'local') {
    // 纯本地 OCR，不让步：本地失败（含未识别到文本）如实返回 fail，绝不抛 500。
    try {
      return await recognizeImageLocal(imagePath, opts);
    } catch {
      return { ocr_status: 'fail', question: '', latex: null };
    }
  }

  // auto（默认）：本地 OCR 优先；成功后再叠加视觉大模型描述（OCR_COMBO）做交叉核对。
  const local = await recognizeImageLocalSafe(imagePath, opts);
  if (!local) {
    // 本地完全失败（未识别到任何文本）→ 降级视觉大模型（内部含探活 + 可选 mock 兜底）
    const ready = await ensureRecognitionReady();
    if (!ready) return { ocr_status: 'fail', question: '', latex: null };
    return recognizeImageByLlm(imagePath);
  }
  if (env.OCR_COMBO) {
    // P1 时延优化：本地 OCR 已充分捕捉题目信号（选择题抓全 4 选项 / 含强数学结构），
    // 视觉第二路是冗余且额外 +~24s，确定性跳过，直接返回本地结果（仍过学术闸门）。
    if (localIsSufficient(local)) {
      return enforceAcademicSignal(local);
    }
    const vision = await recognizeVisionSafe(imagePath).catch(
      (): VisionOutcome => ({ kind: 'unavailable' })
    );
    return enforceAcademicSignal(decideAutoOcrResult(local, vision));
  }
  return local;
}

/** 本地 OCR 安全包装：任何异常（含未识别到文本）都返回 null，由上层决定降级策略。 */
async function recognizeImageLocalSafe(
  imagePath: string,
  opts: RecognizeImageOpts
): Promise<OcrResult | null> {
  try {
    return await recognizeImageLocal(imagePath, opts);
  } catch {
    return null;
  }
}

/**
 * 视觉大模型语义描述（MiniCPM-V 等），识别双通道的第二路证据。
 * 返回三态 VisionOutcome：
 *   - 探活失败 / 异常 / 超时 / mock / 空文本 → unavailable（上层静默保留本地结果）
 *   - 模型明确输出拒识标记 → rejected（上层必须覆盖本地结果为 fail，绝不 mock）
 *   - 拿到题目文本 → ok
 * 绝不 mock：占位题干不得冒充视觉证据。
 */
async function recognizeVisionSafe(imagePath: string): Promise<VisionOutcome> {
  try {
    const ready = await ensureRecognitionReady();
    if (!ready) return { kind: 'unavailable' };
    const provider = getRecognitionProvider();
    // 绝不 mock：真实模型缺失时不得把 MockProvider 占位题干当视觉证据。
    if (provider.name === 'mock' || provider.name === MOCK_ATTR_MODEL_VERSION) {
      return { kind: 'unavailable' };
    }
    const base64 = fs.readFileSync(imagePath).toString('base64');
    const res = await withTimeout(
      provider.chatWithImage(base64, OCR_PROMPT),
      env.OCR_LOCAL_TIMEOUT_MS
    );
    const text = (res.text ?? '').trim();
    // 拒识判定必须早于空串 / 成功返回：token 是非空文本。
    if (isRejectedOcrText(text)) return { kind: 'rejected' };
    if (!text) return { kind: 'unavailable' };
    return {
      kind: 'ok',
      result: { ocr_status: 'success', question: text, latex: null },
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * 本地 OCR：① 文本引擎抽题干 → ②（可选）公式引擎抽 LaTeX → ③ 拼接。
 * 任一步失败都 throw，由 recognizeImage 统一处理降级。
 */
async function recognizeImageLocal(
  imagePath: string,
  opts: RecognizeImageOpts
): Promise<OcrResult> {
  // 串行-条件式本地 OCR（P1-b 时延优化 · 修订版）：
  // 先跑轻量 text serve（rapid，安静 ~1.8s），再「仅当文本提示需要公式」时跑重型
  // formula serve（paddle + PP-FormulaNet-S）。
  //
  // 原先双 serve 并行让两个重型 Python 进程同机抢 CPU/RAM，使本地 OCR 由 ~1.8s
  // 放大到 5–10×（实测冷 p95 22s、热偶发 24.8s 公式 serve 冷重载尖刺）。改为串行后
  // 二者错峰，墙钟由「并行和之争用」降为「文本 +（可选）公式」，且公式 serve 不再与
  // 文本 serve 同时占满 CPU，冷重载尖刺概率大幅下降。
  //
  // 公式路触发（保守，避免每张图都多跑一轮重型引擎还拿到垃圾 LaTeX）：
  //   OCR_FORMULA_AUTO 且（学科/符号/中文数学词 命中，或文本为空＝疑似纯公式图）。
  //   已知非数学学科或纯选择题（无 =/符号/数学词）跳过公式路，省 CPU；公式结果是否
  //   采用仍过 validateLatex 护栏，避免臆造 LaTeX 污染题干。
  const t0Text = Date.now();
  const textRes = await runLocalOcr(imagePath, { engine: TEXT_ENGINE });
  const texts = textRes.texts
    .map((t) => (t.text ?? '').trim())
    .filter((t) => t.length > 0);
  const question = texts.join('\n');
  const textMs = Date.now() - t0Text;

  // 公式路触发（保守，避免对整段题干误跑公式模型产出垃圾且浪费时延）
  const triggerFormula =
    env.OCR_FORMULA_AUTO === true &&
    (shouldTryFormula(opts.subject, question) || question === '');

  // 重负载自适应（P1-b 时延兜底）：出现以下任一即跳过公式路、牺牲 LaTeX 保时延——
  //  ① 文本识别已超阈值：机器 CPU 被外部负载（如同机 8090 视觉模型）占满，公式几乎必超预算；
  //  ② 公式刚超时冷却中：paddle serve 慢推理在后台仍持续吃 CPU ~13–16s，若不冷却会拖慢
  //     后续多次请求的文本识别。冷却期内直接跳过，让其跑完释放 CPU。
  // 轻载（文本 ~3.4s、公式 ~4s）时二者都不命中，公式正常拼入 LaTeX（保 V2 字段级准确率）。
  const now = Date.now();
  const skipFormula =
    !triggerFormula || textMs > FORMULA_TEXT_SLOW_MS || now < formulaCooldownUntil;

  let latex: string | null = null;
  if (!skipFormula) {
    // 公式识别硬时延预算：PP-FormulaNet-S 在重负载下推理会劣化到 13–16s，直接把整条本地
    // OCR 责任域拖过 V5 门禁。超预算即放弃 LaTeX、返回纯文本（文本 ~3.4s 不受影响），把墙钟
    // 稳定压在「文本 + 预算」之内；并进入冷却，避免 paddle 后台慢推理污染后续请求。
    const fRes = await withTimeout(
      runLocalOcr(imagePath, { engine: 'paddle', formula: true }),
      FORMULA_BUDGET_MS,
      `formula OCR 超过预算 ${FORMULA_BUDGET_MS}ms，放弃 LaTeX 保时延`
    ).catch((err) => {
      console.warn(
        `[ocr] ${err instanceof Error ? err.message : String(err)} loop_id=${
          opts.loopId ?? '-'
        }（进入公式冷却 ${FORMULA_COOLDOWN_MS}ms）`
      );
      // 关键：超时说明 paddle serve 正处于慢推理，其在后台仍会持续吃 CPU，
      // 若不冷却会拖慢接下来多次请求的文本识别 → 设冷却窗口跳过后续公式路。
      formulaCooldownUntil = Date.now() + FORMULA_COOLDOWN_MS;
      return null;
    });
    // 仅当「学科/符号/中文数学词」命中或纯公式空文本时才采用，避免臆造 LaTeX 污染题干
    if (fRes && (shouldTryFormula(opts.subject, question) || question === '')) {
      const candidate = (fRes.texts[0]?.text ?? '').trim();
      if (candidate) {
        // PP-FormulaNet-S 对不含公式的图也会强行吐一段臆造 LaTeX（score 恒 1.0），
        // 故"拿到 LaTeX"不等于"该用"，必须过校验才允许拼进 question。
        const guard = validateLatex(candidate, question);
        if (guard.ok) {
          latex = guard.latex;
        } else {
          const m = guard.metrics;
          console.warn(
            `[ocr] 丢弃疑似臆造 LaTeX（不拼入 question）loop_id=${
              opts.loopId ?? '-'
            } reason=${guard.reason} len=${m.len} strong=${m.strong}` +
              ` mathrm=${m.mathrm} malformed=${m.malformed}` +
              ` malformedDensity=${m.malformedDensity.toFixed(2)}` +
              ` snippet=${JSON.stringify(candidate.slice(0, 80))}`
          );
        }
      }
    }
  } else if (triggerFormula && textMs > FORMULA_TEXT_SLOW_MS) {
    console.warn(
      `[ocr] 文本识别 ${textMs}ms 已超阈值 ${FORMULA_TEXT_SLOW_MS}ms，跳过公式路保时延 loop_id=${
        opts.loopId ?? '-'
      }`
    );
  }

  // 纯公式图：文本引擎（rapid）往往识别不到文字，但公式分支已拿到有效 LaTeX。
  // 此时本地已充分捕捉题目信号，直接以「【公式】{latex}」成题并让上层 localIsSufficient
  // 命中 MATH_STRUCT_RE 确定性跳过视觉第二路，不再因文本为空而误降级到 5GB 视觉模型
  // （既修正了公式识别白做，又消除了视觉第二路与 OCR 同跑的机器争用）。
  if (!question && latex) {
    return enforceAcademicSignal({
      ocr_status: 'success',
      question: `【公式】${latex}`,
      latex,
    });
  }

  // 文本与公式均未识别到任何内容 → 如实抛错，交由上层降级（auto 走视觉 / local 走 fail）
  if (!question) {
    throw new Error(`本地 OCR（${TEXT_ENGINE}）未识别到任何文本`);
  }

  return enforceAcademicSignal({
    ocr_status: 'success',
    // 让下游归因 prompt 能看到公式，否则公式识别白做
    question: latex ? `${question}\n【公式】${latex}` : question,
    latex,
  });
}

/** 视觉大模型图片识别（LLM 模式 / auto 降级路径，逻辑与改造前一致）。 */
async function recognizeImageByLlm(imagePath: string): Promise<OcrResult> {
  // 图片识别走识别 provider（LLM_* / VISION_*，仍指向 MiniCPM 等视觉模型）
  const provider = getRecognitionProvider();
  const base64 = fs.readFileSync(imagePath).toString('base64');
  try {
    const res = await provider.chatWithImage(base64, OCR_PROMPT);
    const isMock = provider.name === 'mock' || provider.name === MOCK_ATTR_MODEL_VERSION;
    const text = (res.text ?? '').trim();
    if (isMock) {
      // Mock 视觉模型：占位题干，标记 partial，闭环仍可继续演示
      return { ocr_status: 'partial', question: text, latex: null };
    }
    if (!text || isRejectedOcrText(text)) {
      return { ocr_status: 'fail', question: '', latex: null };
    }
    return enforceAcademicSignal({ ocr_status: 'success', question: text, latex: null });
  } catch {
    // 视觉模型不可用（如 VISION_MODEL 未拉取）→ Mock 占位题干兜底，保证图片入口仍可演示
    if (env.AUTO_FALLBACK_TO_MOCK) {
      const mock = new MockProvider();
      const r = await mock.chatWithImage(base64, OCR_PROMPT);
      return { ocr_status: 'partial', question: r.text, latex: null };
    }
    return { ocr_status: 'fail', question: '', latex: null };
  }
}
