// 模型极限基准测试脚本（临时，跑完即删）
// 用法：
//   npx tsx src/services/attribution/_bench.ts            # 默认对接 8094 全量
//   BENCH_BASE_URL=http://localhost:8096 BENCH_MODEL=Qwen3-4B-Thinking \
//   BENCH_DISABLE_THINKING=false npx tsx .../_bench.ts    # 切到 8096 对比
//   BENCH_LIMIT=4 npx tsx .../_bench.ts                   # 仅跑前 4 题（快速验证对接/时延）
//
// 原理：直接改写 env 导出对象的 ANALYSIS_* 属性（运行时生效，零触碰 .env.local），
//       关闭 RAG 隔离纯模型表现；每题跑两种模式：
//         - 讲解模式（无作答）→ 自动判分：模型/数值校验给出的字母 == expectedLetter ?
//         - 诊断模式（故意错选）→ 看错因/知识点/本质是否到位（人工看文本，脚本只报 status+长度）
import path from 'node:path';
import os from 'node:os';
import { env } from '../../config/env';
import { generateAttribution } from './attributionService';
import { generateEnsembleAttribution } from './ensemble';
import { seedRagKnowledge } from './_seedRag';
import { getDb } from '../../db';
import { generateAttributionId } from '../../utils/id';
import { BENCH_QUESTIONS } from './benchmarkQuestions';

// ── 1) 对接目标端点（注入 env，不被 .env.local 的 override 覆盖，因为我用的是自定义键 BENCH_*）──
const targetBase = process.env.BENCH_BASE_URL || 'http://localhost:8094';
const targetModel = process.env.BENCH_MODEL || 'Qwen3.8-27B-IQ2XS';
const disableThinking = (process.env.BENCH_DISABLE_THINKING ?? 'true') === 'true';
env.ANALYSIS_BASE_URL = targetBase;
env.ANALYSIS_MODEL = targetModel;
env.DISABLE_THINKING = disableThinking;
env.RAG_ENABLED = false; // 隔离纯模型，不引入 RAG 参考/嵌入干扰
env.AUTO_FALLBACK_TO_MOCK = false; // 模型不可达就如实报 analyzing，不偷偷降级 Mock 掩盖真实表现
// ── 联网搜索实测（用户要求）：验证能否补小模型在英语/史实/政治概念的知识盲区 ──
// 数据主权提醒：本基准用的是我自造的题库（非用户真实内容），且用户显式要求开启；
// 生产环境 WEB_SEARCH_ENABLED 必须默认 false，仅数据主体逐次显式开启才外发检索词。
// BENCH_NOWEB=1 时关闭（作为对照实验，隔离"纯联网搜索"的增量效果）。
const webOn = !process.env.BENCH_NOWEB;
env.WEB_SEARCH_ENABLED = webOn; // 总闸
env.WEB_SEARCH_TIMEOUT_MS = 4000; // 收紧超时（bing 实测 ~2s），避免拖垮基准

// ── 2) 独立临时 DB，不污染生产库 ──
process.env.AICORRECTION_DB_PATH = path.join(os.tmpdir(), `aicorr_bench_${Date.now()}.db`);

const USER = `bench-${Date.now()}`;
const LIMIT = process.env.BENCH_LIMIT ? parseInt(process.env.BENCH_LIMIT, 10) : BENCH_QUESTIONS.length;
// 方案2 集成路径开关：设 BENCH_ENSEMBLE=1 时改用本地多模型编排（路由→专精小模型→汇总）
const BENCH_ENSEMBLE = !!process.env.BENCH_ENSEMBLE;
// 方案2·RAG specialist 开关：BENCH_RAG=1 时先灌本地题库知识点、再在集成合成阶段强制调用 RAG 作事实 grounding
const BENCH_RAG = !!process.env.BENCH_RAG;
const runAttr = (input: Parameters<typeof generateAttribution>[0]) =>
  BENCH_ENSEMBLE ? generateEnsembleAttribution(input) : generateAttribution(input);
// 定向复跑指定题（逗号分隔 id，如 BENCH_IDS=E1,E3,Z2,Z3,C3），不传则全量
const idsFilter = process.env.BENCH_IDS
  ? new Set(process.env.BENCH_IDS.split(',').map((s) => s.trim().toUpperCase()))
  : null;

function ensureParents(loopId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO users (anon_user_id, segment, register_ts) VALUES (?, 'kaoyan', datetime('now'))`
  ).run(USER);
  db.prepare(
    `INSERT OR IGNORE INTO loop_sessions (loop_id, anon_user_id, start_ts, loop_complete, followup_rounds)
     VALUES (?, ?, datetime('now'), 0, 0)`
  ).run(loopId, USER);
}

// 从题干抽取指定字母选项文本（诊断模式用作"学生作答"）
function optionText(question: string, letter: string): string {
  const re = /[\(（]\s*([A-Ea-e])\s*[\)）]\s*([^\(（]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(question)) !== null) {
    if (m[1].toUpperCase() === letter.toUpperCase()) {
      return `(${m[1].toUpperCase()}) ${m[2].trim()}`;
    }
  }
  return `(${letter})`;
}

// 从模型返回的正确答案文本里抽选项字母（"(B) 1" → B；"∅"/无 → null）
function claimedLetter(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/[\(（]\s*([A-Ea-e])\s*[\)）]/);
  if (m) return m[1].toUpperCase();
  const sm = text.match(/\b([A-Ea-e])\b/);
  return sm ? sm[1].toUpperCase() : null;
}

const verdict = (got: string | null, exp: string): string =>
  got === exp ? `✓PASS` : `✗FAIL(得${got ?? '-'}/应${exp})`;

(async () => {
  const items = (idsFilter
    ? BENCH_QUESTIONS.filter((q) => idsFilter.has(q.id.toUpperCase()))
    : BENCH_QUESTIONS
  ).slice(0, LIMIT);
  let teachPass = 0;
  const rows: string[] = [];
  console.log(
    `端点: ${targetBase} | 模型: ${targetModel} | thinking=${!disableThinking} | 策略=${BENCH_ENSEMBLE ? `ensemble${BENCH_RAG ? '+RAG' : ''}` : 'single'} | RAG种子库=${BENCH_ENSEMBLE && BENCH_RAG ? 'on' : 'off'} | 题数=${items.length}\n`
  );

  // 方案2·RAG specialist：集成+本地题库 grounding 时，先灌 5 道知识盲区题的正确知识点进临时 DB
  if (BENCH_ENSEMBLE && BENCH_RAG) {
    const n = await seedRagKnowledge();
    console.log(`已灌入本地题库知识点 ${n} 条（仅本临时 DB，不污染生产库）\n`);
  }

  for (const it of items) {
    const tLoop = `t-${generateAttributionId()}`;
    const dLoop = `d-${generateAttributionId()}`;
    ensureParents(tLoop);
    ensureParents(dLoop);

    // 讲解模式（无作答）：看模型能否给出正确选项（mathVerify 会兜底纠正数学题）
    let tRes: any;
    const t0 = Date.now();
    try {
      tRes = await runAttr({
        loop_id: tLoop,
        anon_user_id: USER,
        question: it.question,
        user_answer: undefined,
        subject: it.subject,
        mistake_id: null,
        is_internal: true,
        enableWebSearch: webOn,
        enableRagSpecialist: BENCH_RAG,
      });
    } catch (e) {
      tRes = { status: 'exception', err: (e as Error).message };
    }
    const tDt = Date.now() - t0;
    const tLetter = claimedLetter(tRes?.correct_answer);
    const tOk = tRes?.status === 'ok' && tLetter === it.expectedLetter;
    if (tOk) teachPass++;

    // 诊断模式（故意错选）：看错因诊断质量
    let dRes: any;
    const d0 = Date.now();
    try {
      dRes = await runAttr({
        loop_id: dLoop,
        anon_user_id: USER,
        question: it.question,
        user_answer: optionText(it.question, it.wrongLetter),
        subject: it.subject,
        mistake_id: null,
        is_internal: true,
        enableWebSearch: webOn,
        enableRagSpecialist: BENCH_RAG,
      });
    } catch (e) {
      dRes = { status: 'exception', err: (e as Error).message };
    }
    const dDt = Date.now() - d0;
    const dOk = dRes?.status === 'ok';
    const dLen = dOk ? `${(dRes.cause || '').length + (dRes.knowledge_point || '').length}` : '-';

    rows.push(
      `${it.id} D${it.difficulty} ${it.subject.padEnd(22)} | 讲解 ${tRes?.status === 'ok' ? 'ok' : tRes?.status} ${tDt}ms ${verdict(tLetter, it.expectedLetter)} | 诊断 ${dRes?.status === 'ok' ? 'ok' : dRes?.status} ${dDt}ms ${dOk ? `诊断文本${dLen}字` : ''}`
    );
    console.log(rows[rows.length - 1]);
    if (dOk) {
      console.log(`     错因: ${(dRes.cause || '').slice(0, 80)}`);
      console.log(`     讲解正确选项回填: ${tRes?.correct_answer ?? '∅'}`);
    }
  }

  console.log(
    `\n===== 讲解模式自动判分：${teachPass}/${items.length} 通过 | 诊断模式：${rows.filter((r) => r.includes('诊断 ok')).length}/${items.length} 成功 =====`
  );
  process.exit(0);
})();
