/**
 * 归因链路耗时基准（G1 · p50 可观测性）
 *
 * 目的：把「离线 27B 归因 ~110s」拆成可归因的段，判断瓶颈在 prefill / decode /
 * 检索串行等待 / 模型跑飞，为 p50 优化提供可复现实证，而不是靠猜。
 *
 * 与生产一致性：直接 import 生产的 ATTR_SYSTEM / ATTR_SYSTEM_NOANSWER / attrUserPrompt，
 * 请求体参数（temperature / max_tokens / chat_template_kwargs）与 OllamaProvider 一致。
 *
 * 用法：
 *   npx tsx scripts/bench-attribution.ts                       # 讲解模式基线 1 次
 *   npx tsx scripts/bench-attribution.ts --mode diagnose --runs 2
 *   npx tsx scripts/bench-attribution.ts --max-tokens 512 --stream-stop
 *   BENCH_BASE_URL=http://localhost:8085/v1 npx tsx scripts/bench-attribution.ts
 *
 * 约束：只读上游模型，不写数据库、不启动 API、不依赖生产库。
 */
import { ATTR_SYSTEM, ATTR_SYSTEM_NOANSWER, attrUserPrompt } from '../apps/api/src/services/attribution/prompt';

const BASE = process.env.BENCH_BASE_URL ?? 'http://localhost:8085/v1';
const MODEL = process.env.BENCH_MODEL ?? 'Qwen3.8-27B-Uncensored';

/** 与 K1.2 真实模型探针同一道题（无作答 → 讲解模式）。 */
const QUESTION_TEACH =
  '设函数 $f(x)=x^3-3x$，求其在区间 $[-2,2]$ 上的单调区间与极值。';
const QUESTION_DIAGNOSE =
  '设函数 $f(x)=x^3-3x$，求其在区间 $[-2,2]$ 上的单调区间与极值。';
const USER_ANSWER = "由 $f'(x)=3x^2-3=0$ 得 $x=1$，故极大值为 $f(1)=-2$，函数在 $[-2,1]$ 递减。";

interface Args {
  mode: 'teach' | 'diagnose';
  runs: number;
  maxTokens: number | null;
  streamStop: boolean;
  temperature: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = get('--mode') === 'diagnose' ? 'diagnose' : 'teach';
  const runs = Math.max(1, Math.min(10, Number(get('--runs') ?? 1)));
  const mt = get('--max-tokens');
  return {
    mode,
    runs,
    maxTokens: mt ? Number(mt) : null,
    streamStop: argv.includes('--stream-stop'),
    temperature: Number(get('--temperature') ?? 0.3),
  };
}

const args = parseArgs();

/** 生产同款：讲解 1792 / 诊断 1536（见 attributionService.ts:183）。 */
const DEFAULT_MAX_TOKENS = args.mode === 'teach' ? 1792 : 1536;
const maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS;

const system = args.mode === 'teach' ? ATTR_SYSTEM_NOANSWER : ATTR_SYSTEM;
const question = args.mode === 'teach' ? QUESTION_TEACH : QUESTION_DIAGNOSE;
const user = attrUserPrompt(
  question,
  args.mode === 'diagnose' ? USER_ANSWER : undefined,
  '',
  { teach: args.mode === 'teach' }
);

/** 五段/三行标记是否全部出现（与 parseTeaching / parseAttrTriple 的判定精神一致）。
 *  注意：模型常在「本质：…」后直接 EOF、不再换行，故不能要求尾段后有 \n。 */
function coreComplete(text: string, mode: Args['mode']): boolean {
  const marks = mode === 'teach'
    ? ['正确答案：', '正确推导：', '常见陷阱：', '知识点：', '本质：']
    : ['错因：', '知识点：', '本质：'];
  const last = marks[marks.length - 1];
  if (!marks.every((m) => text.includes(m))) return false;
  const tail = text.slice(text.lastIndexOf(last) + last.length);
  return tail.trim().length >= 8;
}

/** 末段是否疑似被截断（没有句末标点 → 半句）。用于自动揭示早停副作用。 */
function likelyTruncated(text: string): boolean {
  const i = text.lastIndexOf('本质：');
  if (i < 0) return false;
  const tail = text.slice(i + '本质：'.length).trim();
  return tail.length > 0 && !/[。．.!?！？]$/.test(tail);
}

/**
 * 流式早停判据（**实验性，实测有害，禁止用于生产**）：
 * 2026-11-05 实测 27B：TTFT≈1.0s、decode≈3.5 tok/s，模型写完「本质」即自然 stop；
 * 提前 abort 只会把末段截成半句（如「…导数为零是」），且总耗时无收益（78.7s vs 75.8s）。
 * 保留此开关仅为复现该反例，勿据此改生产。
 */
function readyToStop(text: string, mode: Args['mode']): boolean {
  if (!coreComplete(text, mode)) return false;
  const last = mode === 'teach' ? '本质：' : '本质：';
  const tail = text.slice(text.lastIndexOf(last) + last.length).trim();
  return tail.length >= 24;
}

interface BenchResult {
  run: number;
  mode: string;
  maxTokens: number;
  streamStop: boolean;
  totalMs: number;
  ttftMs: number | null;
  promptChars: number;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  finishReason: string | null;
  outputChars: number;
  outputTail: string;
  coreComplete: boolean;
  likelyTruncated: boolean;
  stoppedEarly: boolean;
  error: string | null;
}

async function nonStream(run: number): Promise<BenchResult> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: args.temperature,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const json: any = await res.json();
  const text: string = json?.choices?.[0]?.message?.content
    ?? json?.choices?.[0]?.message?.reasoning_content
    ?? '';
  return {
    run,
    mode: args.mode,
    maxTokens,
    streamStop: false,
    totalMs: Date.now() - t0,
    ttftMs: null,
    promptChars: system.length + user.length,
    usage: json?.usage ?? null,
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
    outputChars: text.length,
    outputTail: text.slice(-220),
    coreComplete: coreComplete(text, args.mode),
    likelyTruncated: likelyTruncated(text),
    stoppedEarly: false,
    error: res.ok ? null : `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
  };
}

/** 流式 + 核心段齐备即 abort：验证「结论后冗余」是否可被早停砍掉。 */
async function streamWithEarlyStop(run: number): Promise<BenchResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  let ttft: number | null = null;
  let text = '';
  let finishReason: string | null = null;
  let usage: BenchResult['usage'] = null;
  let stoppedEarly = false;
  let err: string | null = null;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: args.temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) {
      err = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    } else if (!res.body) {
      err = 'no response body';
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk: any;
          try { chunk = JSON.parse(payload); } catch { continue; }
          if (chunk.usage) usage = chunk.usage;
          const delta: string = chunk?.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            if (ttft === null) ttft = Date.now() - t0;
            text += delta;
          }
          const fr = chunk?.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (!stoppedEarly && readyToStop(text, args.mode)) {
            stoppedEarly = true;
            controller.abort();
          }
        }
      }
    }
  } catch (e) {
    // AbortError 是预期内的主动早停，不算失败。
    if (!(e instanceof Error && /abort/i.test(e.name + e.message))) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    run,
    mode: args.mode,
    maxTokens,
    streamStop: true,
    totalMs: Date.now() - t0,
    ttftMs: ttft,
    promptChars: system.length + user.length,
    usage,
    finishReason,
    outputChars: text.length,
    outputTail: text.slice(-220),
    coreComplete: coreComplete(text, args.mode),
    likelyTruncated: likelyTruncated(text),
    stoppedEarly,
    error: err,
  };
}

function fmt(r: BenchResult): string {
  const u = r.usage;
  return [
    `run=${r.run} mode=${r.mode} max_tokens=${r.maxTokens} streamStop=${r.streamStop}`,
    `  total=${r.totalMs}ms  ttft=${r.ttftMs ?? 'n/a'}ms  promptChars=${r.promptChars}`,
    `  usage: prompt=${u?.prompt_tokens ?? 'n/a'} completion=${u?.completion_tokens ?? 'n/a'} total=${u?.total_tokens ?? 'n/a'}`,
    `  finish=${r.finishReason ?? 'n/a'}  outputChars=${r.outputChars}  coreComplete=${r.coreComplete}  likelyTruncated=${r.likelyTruncated}  earlyStop=${r.stoppedEarly}`,
    `  error=${r.error ?? 'none'}`,
    `  tail: ${JSON.stringify(r.outputTail)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  console.log(`[bench] base=${BASE} model=${MODEL} runs=${args.runs} mode=${args.mode} maxTokens=${maxTokens} streamStop=${args.streamStop}`);
  const results: BenchResult[] = [];
  for (let i = 1; i <= args.runs; i++) {
    const r = args.streamStop ? await streamWithEarlyStop(i) : await nonStream(i);
    results.push(r);
    console.log(fmt(r));
  }
  const ok = results.filter((r) => !r.error && r.coreComplete);
  const times = results.map((r) => r.totalMs);
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    runs: results.length,
    complete: ok.length,
    p50Ms: times.length ? [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] : null,
    minMs: times.length ? Math.min(...times) : null,
    maxMs: times.length ? Math.max(...times) : null,
    avgCompletionTokens: ok.length && ok[0]?.usage?.completion_tokens
      ? Math.round(ok.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0) / ok.length)
      : null,
    earlyStopped: results.filter((r) => r.stoppedEarly).length,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
