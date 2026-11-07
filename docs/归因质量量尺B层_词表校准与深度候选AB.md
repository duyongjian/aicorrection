# 归因质量量尺 B 层：词表校准、字段口径修复与深度候选 A/B

> 日期：2026-11-07
> 前置：`docs/归因质量量尺A层落地.md`（提交 `ca2c5a8`）
> 触发：用户明确「归因质量和错题质量与深度完整度才是最关键的」，并要求「继续去优化，自己造错题也可以」。
> 本轮目标不是延迟，也不是答案行数值，而是把**深度完整度**变成可观测、可证伪的量，并试一个离线优化候选。

---

## 0. 结论先行（诚实口径）

| 项 | 结论 |
|---|---|
| **G1 闸门** | **仍为 NO-GO / OPEN BLOCKER**；v0.2（`R04/R05/R06/G2`）继续冻结 |
| 本轮是否产出质量结论 | **否**。只产出结构代理量，本质分 / 可指导分 / 偏好 / Cohen's κ 恒为 `null` |
| 合成题集 | `synthetic: true`，**不是真实学生错题**；禁止用于 G1 判定、禁止推断 M1 认可率 / M6 盲评准确率、禁止写进对外材料 |
| 是否有效 | 离线 prompt 候选使**结构信号单方向改善且契约零代价**，但 `transfer_hint` 仅 4/30、`actionable_hint` 11/30 —— 深度完整度仍是主要缺口 |
| 是否接生产 | **否**。`DEFAULT_VARIANT_ID` 仍是 `v0.2b-guard-trap`；`v0.5-depth` 为离线评测专用候选 |
| 数据主权 | 全程仅 `127.0.0.1:8093` + `NO_PROXY='*'`；未启 3001、未读写 `apps/api/data/aicorrection.db`、未启用联网检索、题干与输出零外发 |

---

## 1. 合成校准题集（Task #7）

`apps/api/src/tests/fixtures/quality-calibration-v1.json`，30 题：数学 12 / 物理 6 / 化学 5 / 英语 5 / 语文 2，陷阱题 4 道（13.3%，对齐 K1.3 种子集建议的 10–15%）；`diagnose` 22 / `teach` 8；`depth_target` L3×20 / L2×2 / L4×8。

元数据显式写死边界：

- `synthetic: true`、`source: synthetic`
- `NOT_formal_baseline`：引用 K1.3 §二「种子集不能当正式基线：题目是编的，难度分布与真实错题不一致」
- `depth_target_source: synthetic_author_defined`：L1–L4 由造题者定义，**不代表产品侧对真实错题的逐题标定**
- `kq_id_status: taxonomy_pending`：只给 `expected_kq` 文本，不擅自发明 KPI §6.3.1 的结构化 ID
- `trap_policy`：陷阱题 `expected_cause: null` + `expected_cause_status: not_applicable_trap`（如实标注，非占位）

---

## 2. 词表校准：先拆掉一个自证陷阱（Task #8）

新建 `apps/api/src/tests/quality-proxy-calibration.mjs`：84 条构造样本，覆盖 7 类代理量（含 `derivation_blocks` 计数型），算灵敏度 / 特异度，产物落在 `reports/`。

**首次结果全部 1.0 —— 但这是循环论证**：正样本是照着词表正则写的，全 1.0 只证明「词表能检出最直白的表达」，**不能证明词表在自然表达上够用**。脚本头、报告、`proxy_caveat` 三处都写明了这一点，没有拿 1.0 冒充「校准通过」。

真正的漏检证据来自**真实语料探测**：用 8093 深度思考档 34 题真题集输出跑同一批代理量，并把 `essence` 置空来模拟修复前口径。

| 代理量 | 修复前口径 | 当前口径 | 判读 |
|---|---|---|---|
| `actionable_hint` | 2/34 | **6/34** | 部分低命中来自**字段口径**，不是模型完全没写改错指令 |
| `transfer_hint` | 0/34 | 0/34 | **真实深度缺口**，与口径无关 |
| `explains_why` | 1/34 | 1/34 | 词表只认显式元话语词，不得读作「模型没讲为什么」 |
| `cause_has_mechanism` | 21/34 | 21/34 | — |
| `structured_ids_present` | 0/34 | 0/34 | KPI §6.3.1「`kq_id`/`cause_id` 上线即锁死」的实现缺口 |

新增检出的 4 条 `essence` 原文确属可操作改错指令，例如「必须通过泰勒展开或通分保留足够高阶项才能正确求极限」「必须使用分部积分法 …」。

### 2.1 字段口径修复（`quality-rubric.mjs`）

- `actionable_hint` / `transfer_hint` → 改用含 `essence` 的 `actionNarrative`。理由：这两个词表不含「本质/原理」等元话语词，纳入**不会恒真**；而「本质」段恰恰是模型写改错指令与迁移提示的主要位置。
- `explains_why` → **继续排除** `essence`。理由：它的词表含 `/本质(上|是|在于)/`、`/原理/`，而 `v0.5-depth` 明确要求模型在「本质」段写成立的依据，纳入会造恒真假指标。
- 这条修复直接决定 A/B 能不能测出效果：深度规则要求把「同类变式」写进「本质」段，旧口径会把真实提升误读成 0。

### 2.2 顺带修 `expected_cause`

新增 `resolveExpectedCause(caseDoc)`：优先取显式 `expected_cause`；陷阱题标 `not_applicable_trap` 时**直接返回 null、不回退猜测**；否则回退 `extractExpectedCause(provisional_truth)`。合成题集验证：30 题中 18 条拿到真值、4 道陷阱题仍为 null、另 8 道为 `teach` 题本就无错因。

> ⚠️ 口径变更后，**A/B 两侧同口径可比，但与 `ca2c5a8` 首次基线（旧口径）不可直接比较**。

---

## 3. 离线深度候选 `v0.5-depth`（Task #9）

注册于 `apps/api/src/services/attribution/promptVariants.ts`。**单变量设计**：

- 完全复用 `V02B_GUARD_TRAP` 的 system，仅在末尾追加一条 `DEPTH_RULE`；`tail`、`maxTokens`、题集、模型、温度全部一致。
- 规则要求：写机制而非贴标签、给一条可操作改错指令、在「本质」讲成立依据、篇幅允许时给同类变式；**不新增任何段落或标记行**，诊断仍恰好三行、讲解仍五段，保证 `parseAttrTriple` / `parseTeaching` 与 `hasThree` / `hasCore` 口径不变。
- **陷阱题例外（最高优先级）**：若独立核验后学生作答正确，「写机制 / 给改错指令」两条不适用，仍固定输出「错因：解法正确，未发现错误」，严禁为追求深度编造错误。
- `DEFAULT_VARIANT_ID` 未改；`attributionService.ts` / `env.ts` 未动；G1 未过前禁止接生产。

---

## 4. A/B 实测（合成校准集，30 题 × 2 变体 = 60 次调用）

环境：`NO_PROXY='*' no_proxy='*' DISABLE_THINKING=false ANALYSIS_BASE_URL=http://127.0.0.1:8093/v1 ANALYSIS_MODEL=Qwen3.8-9B-Distill LLM_BASE_URL=… LLM_MODEL=… LLM_PROVIDER=ollama`。按 5 个 chunk（每片 6 题 × 2 变体）前台分片落盘（历史教训：一次性长跑约 5 分钟被杀且无产物）。

**完整性**：60 条 / 30 个 `case_id` / 60 个唯一 `(case_id, variant)` 组合 / 两变体各 30 / `err=0` / `ok` 全 true / `fields.essence` 60/60 非空 / 无重试无超时。合并件 `reports/prompt-ab-depth-calibration-merged.json`，独立复核通过。

**基础统计**：`contract_complete` 诊断 22/22、讲解 8/8，两变体均 100%；契约破坏 0 条、`maxTokens` 疑似截断 0 条（`est_tokens` 峰值 477，占 teach 上限 1792 的 26.6%）；latency p50 12664.5 → 12362.5 ms，chars 均值 239.1 → 299.7。

**结构代理量对比**（`scripts/quality-ab-compare.mjs`，口径 `2026-11-07-essence-scope-fix`）：

| 代理量 | `v0.2b-guard-trap` | `v0.5-depth` | Δ | 逐题新增/丢失 |
|---|---|---|---|---|
| `contract_complete` | 30/30 | 30/30 | 0 | 0/0 |
| `cause_has_empty_label` | 0/22 | 0/22 | 0 | 0/0 |
| `cause_has_mechanism` | 14/22 | 18/22 | **+4** | 4/0 |
| `actionable_hint` | 6/30 | 11/30 | **+5** | 7/2 |
| `explains_why` | 0/30 | 0/30 | 0 | 0/0 |
| `pitfall_section` | 8/30 | 8/30 | 0 | 0/0 |
| `transfer_hint` | 0/30 | **4/30** | **+4** | 4/0 |
| `structured_ids_present` | 0/30 | 0/30 | 0 | 0/0 |

`depth_signal_level` 分布：v0.2b `{L1:7, L2:18, L3:5, L4:0}` → v0.5 `{L1:4, L2:15, L3:10, L4:1}`。

**陷阱题回归**：4 道 × 2 变体共 8 条错因行，全部为「解法正确，未发现错误」，未出现为追求深度而强行编造错因；两变体一致。

### 4.1 判读纪律（不可放宽）

- 上表是**结构代理量**，不是质量分。命中率上升只说明「出现了更多该结构信号」，**不等于**归因更触及本质、更能指导改错。
- `transfer_hint` 从 0 → 4 是本轮最值得注意的信号，但 4/30（13.3%）说明**深度完整度仍是主要缺口**；`actionable_hint` 11/30 且有 2 题丢失，不是纯单向改善。
- `explains_why` 对 v0.5 存在**系统性低估**（规则要求把依据写进「本质」段，而该代理量刻意排除 essence 防恒真），0/30 不得读作「v0.5 没讲为什么」。
- `structured_ids_present` 0/30 是 KPI §6.3.1 的实现缺口，prompt 层解决不了，需产品侧拍板 taxonomy。
- **不得据本表推断 M1 认可率或 M6 盲评准确率，不构成 G1 闸门证据。**

---

## 5. 盲评链路演练（不是正式基线）

`npm run blind:export -- --from-json reports/prompt-ab-depth-calibration-merged.json --set apps/api/src/tests/fixtures/quality-calibration-v1.json --raters 2 --seed 20261107 --out reports/blind-drill-depth-calib`

产出：30 题 × 2 版、2 份独立评分表（每题 A/B 归属共享、题序各自打乱）、7 列 CSV（错因或答案是否正确 / 是否触及本质 1–5 / 能否指导改错 1–5 / 更愿意相信哪一版 / 备注），以及**不可给评分人**的 `key.json` 与内部对照。

用途仅限**验证 2 人独立评分链路可跑通**。K1.3 §二要求正式盲评为 **50–100 条真实学生错题 + 2 人独立评分、Cohen's κ >0.6**；本演练是 30 道自造题，**不构成正式本质分基线**，历史正式基线仍为 `PENDING_FORMAL_BLIND_REVIEW`。

---

## 6. 验证结果

| 验证 | 结果 |
|---|---|
| 质量量尺单测 `node --test apps/api/src/tests/quality-rubric.test.mjs` | **15/15 pass** |
| api 全量单测 `npm run test -w @aicorrection/api` | **75/75 pass** |
| `npm run typecheck -w @aicorrection/api` | 通过 |
| 历史门禁回放 `JSON=reports/prompt-ab-8093-think-real-merged.json npm run attrib:regress:real` | `34 \| PASS 27 \| PARTIAL 1 \| FAIL 6 \| 陷阱未瞎编 0/1`，退出码 1 —— **与历史完全一致，代理量改动未渗入 PASS/FAIL 判定** |
| 校准脚本（含真实语料探测） | 84 样本、人工维度恒 null，产物落于 `reports/` |
| A/B 评分脚本输入校验 | 条数 / 30 题 / 唯一组合 / 变体齐全 / ok / synthetic 六项，失败即 `exit 2` |
| 独立复核（第二层 QA） | 复现 9 项数字逐条一致；故意删 1 条 / 改 `ok=false` 两种破坏副本均 `exit 2` 且未静默出表；口径措辞审查未发现越界 |

**独立复核提出的 2 个「不自证」弱点已修复**（当前数据下与事实一致、不影响本次数字，但换输入会失真）：

1. `validation` 的 `err_n` / `ok_false_n` / `synthetic` 原为字面量 → 改为从 `results` / `setDoc` 实算，并补 `per_variant` 计数。
2. md 的陷阱题题号与「零回归」结论原为硬编码 → 改为从 `trapCauseRows` 逐条实算，新增 `trap_cause_audit`；**只要有一条偏离「解法正确，未发现错误」就列出告警并禁止宣称零回归**。本轮实算 8 条全 clean、deviations 0。

另统一 `latency_p50_ms` 末步舍入为 1 位小数（与合并脚本 `percentile()` 一致），消除 `Math.round` 对 `.5` 向上取整造成的 `12665` vs `12664.5` 跨产物表观差异；分位数算法本身两处相同，均为线性插值 `(n-1)*p`。加固后重跑 9 项代理量数字**逐字未变**。

---

## 7. 仍未解决 / 下一步

1. **正式人工盲评基线**：50–100 条真实学生错题 + 2 人独立评分，κ >0.6。当前仍空白。
2. **代理量与质量的相关性未校准**：本轮只校准了「词表能否检出结构信号」，未校准「该结构能否预测本质分 / 可指导分」——这需要第 1 项的真实盲评样本才能做。
3. `kq_id` / `cause_id` taxonomy 拍板（KPI §6.3.1「MVP 期上线即锁死」）；`depth_target` 产品侧逐题标定。
4. 深度完整度绝对值仍低：可继续试生成层结构修复（JSON schema 输出、诊断/讲解分离）、本地题库 RAG grounding、级联复核模型，但每一步都必须用同一口径重跑 A/B，且不得跳过人工盲评。
5. 产品侧待拍板：M4 口径是否改为「首屏 + 异步深度」、G1 认可率是否拆出质量分量。
6. G1 真实样本 n≥250、生产配置 p50 复测等门槛均未解除。

---

## 8. 复现命令

```bash
# 词表校准（含真实语料探测）
node apps/api/src/tests/quality-proxy-calibration.mjs

# 离线变体 A/B（分片，勿一把梭）
NO_PROXY='*' no_proxy='*' DISABLE_THINKING=false \
ANALYSIS_BASE_URL=http://127.0.0.1:8093/v1 ANALYSIS_MODEL=Qwen3.8-9B-Distill \
LLM_BASE_URL=http://127.0.0.1:8093/v1 LLM_MODEL=Qwen3.8-9B-Distill \
LLM_PROVIDER=ollama npm run prompt:ab -- \
  --set apps/api/src/tests/fixtures/quality-calibration-v1.json \
  --provider real --variants v0.2b-guard-trap,v0.5-depth \
  --ids qm01,qm02,qm03,qm04,qm05,qm06 --tag depth-calib-c1

# 5 分片合并 + 校验 + 基础统计（脚本在 reports/ 下、随 gitignore 本地保留）
node reports/depth-ab-merge.mjs   # 自动发现每个 c1–c5 最新一份

# 统一口径评分对比
node scripts/quality-ab-compare.mjs \
  --report reports/prompt-ab-depth-calibration-merged.json \
  --set apps/api/src/tests/fixtures/quality-calibration-v1.json
```

> `reports/depth-ab-merge.mjs` 以自身所在目录作为产物目录，**不要移到 `scripts/`**（路径会失效）。它只在本机保留，不随仓库提交；5 分片与合并件同样在 gitignore 内。

> ⚠️ `DISABLE_THINKING=false` 不可漏：项目 `env.ts` 默认 `DISABLE_THINKING=true`，漏传会静默关掉思考档，测出错误结论（见 `docs/8093-Qwen3.8-9B-Distill深度思考档复测.md` §1.2）。
