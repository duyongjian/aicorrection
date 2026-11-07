# 归因质量量尺 B 层：词表校准、字段口径修复与深度候选 A/B

> 日期：2026-11-07
> 前置：`docs/归因质量量尺A层落地.md`（提交 `ca2c5a8`）
> 触发：用户明确「归因质量和错题质量与深度完整度才是最关键的」，并要求「继续去优化，自己造错题也可以」。
> 本轮目标不是延迟，也不是答案行数值，而是把**深度完整度**变成可观测、可证伪的量，并试一个离线优化候选。
> **版本**：本文档经「第三轮真实语料误检复核」更新，量尺口径 `2026-11-07-wordlist-v2.1`。历史口径：`6358e12`（`essence-scope-fix`）、`8283f96`（`wordlist-v2`）。**三版 A/B 数字互不可直接比较**，差异来自量尺而非模型行为。
> **诚实性更正**：`8283f96` 的 commit message 及本文旧版把第二轮 84 条构造样本称为「非自证」，属不实措辞——该样本系照词表同义表达设计、修订又据漏检定向补充，仍有循环论证成分。本文与 `proxy_caveat`、A/B 脚本已统一更正。

---

## 0. 结论先行（诚实口径）

| 项 | 结论 |
|---|---|
| **G1 闸门** | **仍为 NO-GO / OPEN BLOCKER**；v0.2（`R04/R05/R06/G2`）继续冻结 |
| 本轮是否产出质量结论 | **否**。只产出结构代理量，本质分 / 可指导分 / 偏好 / Cohen's κ 恒为 `null` |
| 合成题集 | `synthetic: true`，**不是真实学生错题**；禁止用于 G1 判定、禁止推断 M1 认可率 / M6 盲评准确率、禁止写进对外材料 |
| 是否有效 | 离线 prompt 候选使**结构信号单方向改善且契约零代价**，但 `transfer_hint` 仅 4/30（v2 曾报 5/30，其中 1 条系实证误检、v2.1 已剔除）、`actionable_hint` 11/30 —— 深度完整度仍是主要缺口 |
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

## 2. 词表校准：三轮，拆自证陷阱 → 补词表（承认循环论证）→ 真实语料实证误检收窄（Task #8）

### 2.0 第一轮：84 条构造样本全 1.0，是循环论证

最初新建 `apps/api/src/tests/quality-proxy-calibration.mjs`：84 条构造样本覆盖 7 类代理量（含 `derivation_blocks` 计数型），灵敏度 / 特异度**全部 1.0**。但**正样本是照着词表正则写的**——全 1.0 只证明「词表能检出最直白的表达」，属循环论证，不能证明词表在自然表达上够用。当时已把该警示写进脚本头、报告与 `proxy_caveat`，没有拿 1.0 冒充「校准通过」。

### 2.0b 第二轮：补词表（`6358e12` 之后）—— 样本仍承认循环论证

失败 worker 复活后并发写入了一套 84 条构造样本（7 类 × 6 正 + 6 负），正样本是较自然的表达，例如「疏忽大意」「知识掌握得不扎实」「把有序样本当无序组合计数」「把 sinθ 与 cosθ 记反了」「应当保留换元产生的 1/2 系数」。用它测旧词表：

> ⚠️ **诚实性更正（针对 `8283f96` 及其 commit message）**：这套样本**并非「不照词表写的非自证样本」**。正样本是参照「词表应覆盖的同义表达」人工构造，修订词表时又据漏检明细定向补充，**仍有循环论证成分**；「补词表后 7 类全部 100%」只能证明**该样本上**无漏检/无误检，不能证明词表在真实模型输出上无误检。第三轮（§2.0d）才是由真实语料驱动的独立复核。

| 代理量 | 旧词表灵敏度 | 旧词表特异度 | 漏检 |
|---|---|---|---|
| `cause_has_empty_label` | 66.7% | 100% | 2 |
| `cause_has_mechanism` | 50% | 100% | 3 |
| `actionable_hint` | 50% | 100% | 3 |
| `explains_why` | 50% | 100% | 3 |
| `transfer_hint` | 50% | 100% | 3 |
| `structured_ids_present` | 50% | 100% | 3 |
| `derivation_blocks` | 100% | 100% | 0 |

合计 **17 条漏检、0 条误检、6 类全部未达标** —— 这才是「词表过窄」的实证。据此给 `quality-rubric.mjs` 的 6 组正则补了 17 行（同义空标签、描述「怎么错的」动词短语、常见改错动词、解释标志、迁移表达、结构化 ID 边界），**只改正则，不动判定逻辑、不改返回结构**。补词表后 `--baseline` 前后对照显示 7 类灵敏度与特异度**全部 100%、0 漏检 0 误检**；口径哨兵（「概念混淆」= 空标签词 + 机制词应为 false）与含 `id` 子串的普通词仍被正确拒绝。

> **并发事件如实记录**：该 worker 早前被报「上游流异常失败、零产出」，主理人已接手完成 #8 并提交 `6358e12`；它随后复活并继续原任务，在**提交之后**写入了词表正则与新版校准脚本。主理人核实改动内容、把证据保全到 `reports/concurrent-calibration-dev/`、补跑校准后验证确认达标、量化对 A/B 数字的影响后**决定纳入**，并按 v2 口径重算全部受影响数字，未静默覆盖也未丢弃成果。

### 2.0c 真实语料探测（`apps/api/src/tests/quality-proxy-corpus-probe.mjs`）

构造样本无论多自然仍是人造文本，故第二路证据用 8093 深度思考档 34 题真题集的**真实模型输出**，并把 `essence` 置空模拟修复前口径（v2 词表下）：

| 代理量 | 修复前口径 | 当前口径 | 判读 |
|---|---|---|---|
| `actionable_hint` | 3/34 | **7/34** | 部分低命中来自**字段口径**，不是模型完全没写改错指令 |
| `explains_why` | 1/34 | 1/34 | v2 曾报 2/34，其中 `rc05`「直接原因」是裸「原因」误检，v2.1 已剔除；不得读作「模型没讲为什么」 |
| `cause_has_mechanism` | 22/34 | 22/34 | — |
| `transfer_hint` | 0/34 | 0/34 | **真实深度缺口**，与口径无关 |
| `structured_ids_present` | 0/34 | 0/34 | KPI §6.3.1「`kq_id`/`cause_id` 上线即锁死」的实现缺口 |
| `contract_complete` | 33/34 | 33/34 | — |
| `pitfall_section` | 9/34 | 9/34 | — |

新增检出的 4 条 `essence` 原文确属可操作改错指令，例如「必须通过泰勒展开或通分保留足够高阶项才能正确求极限」「必须使用分部积分法 …」。当前口径仍未检出 `actionable_hint` 的条目 **27/34**（词表偏窄 + 模型确实少写，两者不可分开归因）。两路证据互补（**都不足以证明真实语料无误检**）：构造样本测「本样本检出能力」，真实语料测「字段口径与实际分布」；第三路见 §2.0d。

### 2.0d 第三轮：真实语料驱动的误检复核与最小收窄（v2.1）

`8283f96` 补的 29 条新增正则只在构造样本上验过特异度，缺真实语料证据。新增只读探针 `scripts/quality-proxy-false-positive-probe.mjs`：用 `git show 6358e12` 自取旧词表 → 与当前词表求差集 → 逐条列出新增正则在 **8093 真实语料 34 + A/B 合并件 60** 上的命中明细（含命中子串与全文）。

v2 词表下新增正则共 **26 处命中**，人工判读发现 **2 处实证误检**，且两处都是「唯一让该记录从 false 变 true」的命中：

| 记录 | 代理量 | 命中子串 | 为什么是误检 |
|---|---|---|---|
| `rc05` / 8093 真实语料 | `explains_why` | 「直接**原因**」 | 裸「原因」是名词，不是解释性元话语；旧词表不命中 |
| `qy01` / `v0.5-depth` | `transfer_hint` | 「"让"字**同样**不能充当主语」 | 句内类比，不是跨题迁移；而它正是 A/B「transfer 0→5」的支撑之一 |

另有 `qm09`、`qp05` 也命中裸「同样」，但正文另有「**推广到**…」（旧词表已命中），收窄不改变其记录级结论；`tm04`「误用 was 代替 were」、`qm02/v0.5`「用于…替换」被 `ACTIONABLE` 的「用…代替/替换」类正则命中，属**命中依据不严谨**（描述错误做法而非改错指令），见下方残留局限。

**最小收窄**（只动 2 条正则，不动判定逻辑与返回结构）：

- `EXPLAIN_WHY_PATTERNS`：`/(其)?(理由|原因)(是|在于|很简单)?/` → 去掉末尾 `?`，要求后接「是 / 在于 / 很简单」。
- `TRANSFER_PATTERNS`：`/(同理|同样)(可|适用|地)?/` → `/(同理|同样)(可|适用)/`。

收窄后复验：新增命中 **26 → 23**（`EXPLAIN_WHY` 1→0、`TRANSFER` 3→1），两条实证误检消失；84 条构造样本仍 **7 类灵敏度/特异度 100%、0 漏检 0 误检**（正样本靠「理由是」「同理可」等写法，不受影响）；质量量尺单测 **18/18**、api 全量单测 **75/75**、typecheck 通过。量尺口径升 `2026-11-07-wordlist-v2.1`。

> **已知残留局限（如实登记，不掩饰）**：`ACTIONABLE_PATTERNS` 的 `/(用|改用|采用)…(代替|替换|…)/` 仍会把「误用 was 代替 were」「不能用于…替换」这类**错误做法描述**算成可操作改错指令。之所以不收窄：收窄会使 `tm04` 中真实存在的改错指令「应统一用 were」连带漏检，得不偿失。因此 `actionable_hint` 的相关条目须人工复核，**不得据其命中率宣称改错指令达标**。`需|得` 单字前缀在 94 条真实/合成记录上未发现 `得` 的实证误检，保留观察。

### 2.1 字段口径修复（`quality-rubric.mjs`）

- `actionable_hint` / `transfer_hint` → 改用含 `essence` 的 `actionNarrative`。理由：这两个词表不含「本质/原理」等元话语词，纳入**不会恒真**；而「本质」段恰恰是模型写改错指令与迁移提示的主要位置。
- `explains_why` → **继续排除** `essence`。理由：它的词表含 `/本质(上|是|在于)/`、`/原理/`，而 `v0.5-depth` 明确要求模型在「本质」段写成立的依据，纳入会造恒真假指标。
- 这条修复直接决定 A/B 能不能测出效果：深度规则要求把「同类变式」写进「本质」段，旧口径会把真实提升误读成 0。

### 2.2 顺带修 `expected_cause`

新增 `resolveExpectedCause(caseDoc)`：优先取显式 `expected_cause`；陷阱题标 `not_applicable_trap` 时**直接返回 null、不回退猜测**；否则回退 `extractExpectedCause(provisional_truth)`。合成题集验证：30 题中 18 条拿到真值、4 道陷阱题仍为 null、另 8 道为 `teach` 题本就无错因。

> ⚠️ 三次口径变更后，**A/B 两侧同口径可比，但与 `ca2c5a8` 首次基线、`6358e12` 第一轮（`essence-scope-fix`）、`8283f96` 第二轮（`wordlist-v2`）均不可直接比较** —— 跨版本数字差异来自量尺，不是模型行为变化。

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

**结构代理量对比**（`scripts/quality-ab-compare.mjs`，口径 **`2026-11-07-wordlist-v2.1`**）：

| 代理量 | `v0.2b-guard-trap` | `v0.5-depth` | Δ | 逐题新增/丢失 |
|---|---|---|---|---|
| `contract_complete` | 30/30 | 30/30 | 0 | 0/0 |
| `cause_has_empty_label` | 0/22 | 0/22 | 0 | 0/0 |
| `cause_has_mechanism` | 15/22 | 18/22 | **+3** | 3/0 |
| `actionable_hint` | 6/30 | 11/30 | **+5** | 7/2 |
| `explains_why` | 0/30 | 0/30 | 0 | 0/0 |
| `pitfall_section` | 8/30 | 8/30 | 0 | 0/0 |
| `transfer_hint` | 0/30 | **4/30** | **+4** | 4/0 |
| `structured_ids_present` | 0/30 | 0/30 | 0 | 0/0 |

`depth_signal_level` 分布：v0.2b `{L1:6, L2:19, L3:5, L4:0}` → v0.5 `{L1:4, L2:15, L3:10, L4:1}`。

> **版本变更溯源**：
> - v1（`6358e12`）→ v2（`8283f96`）：3 处变化来自补词表 —— `cause_has_mechanism` 基线 14/22→15/22（Δ +4→+3）、`transfer_hint` v0.5 4/30→5/30（Δ +4→+5）、v0.2b 的 L1/L2 `7/18`→`6/19`。
> - v2 → v2.1（本次）：`transfer_hint` v0.5 **5/30→4/30（Δ +5→+4、逐题新增 5/0→4/0）**，来自剔除 `qy01` 的实证误检；真实语料 `explains_why` **2/34→1/34**（剔除 `rc05`）。其余代理量数字不变。
> - **全部来自量尺改动，不是模型重跑或行为变化**（60 次调用结果一份未动）；两侧始终用同一份词表评分，A/B 内部可比，跨版本不可比。

**陷阱题回归**：4 道 × 2 变体共 8 条错因行，全部为「解法正确，未发现错误」，未出现为追求深度而强行编造错因；两变体一致。

### 4.1 判读纪律（不可放宽）

- 上表是**结构代理量**，不是质量分。命中率上升只说明「出现了更多该结构信号」，**不等于**归因更触及本质、更能指导改错。
- `transfer_hint` 从 0 → 4 是本轮最值得注意的信号，但 4/30（13.3%）说明**深度完整度仍是主要缺口**；`actionable_hint` 11/30 且有 2 题丢失，不是纯单向改善。v2 口径曾报 0→5，其中 1 条为实证误检，已在 v2.1 剔除。
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
| 质量量尺单测 `node --test apps/api/src/tests/quality-rubric.test.mjs` | **18/18 pass**（含 worker 追加的 2 条边界测试 + 诚实性措辞回归护栏） |
| api 全量单测 `npm run test -w @aicorrection/api` | **75/75 pass** |
| `npm run typecheck -w @aicorrection/api` | 通过 |
| 历史门禁回放 `JSON=reports/prompt-ab-8093-think-real-merged.json npm run attrib:regress:real` | `34 \| PASS 27 \| PARTIAL 1 \| FAIL 6 \| 陷阱未瞎编 0/1`，退出码 1 —— **代理量不参与 PASS/FAIL 判定**，词表改动不改变门禁结果；本次未重跑回放，该结论依据 A 层架构约束而非本轮实测 |
| 构造样本校准 `quality-proxy-calibration.mjs` | 84 条**承认循环论证**的构造样本：6 类灵敏度 50–66.7% → **7 类全部 100%**、特异度 100%、0 漏检 0 误检；**只证明本样本，不证明真实语料无误检** |
| 真实语料探测 `quality-proxy-corpus-probe.mjs` | 8093 34 题真实输出；`actionable_hint` 3/34→7/34、`explains_why` 1/34→1/34、`transfer_hint` 0/34→0/34 |
| 新增正则误检探针 `scripts/quality-proxy-false-positive-probe.mjs` | 真实语料 34 + A/B 60 逐条列命中明细；v2 共 26 处、实证 2 处误检 → 收窄后 23 处、误检消失 |
| A/B 评分脚本输入校验 | 条数 / 30 题 / 唯一组合 / 变体齐全 / ok / synthetic 六项，失败即 `exit 2` |
| 独立复核（第二层 QA，**仅第一轮口径**） | 复现 9 项数字逐条一致；故意删 1 条 / 改 `ok=false` 两种破坏副本均 `exit 2` 且未静默出表；口径措辞审查未发现越界。**时效性说明：该复核只对当时口径成立，v2 / v2.1 两轮量尺改动后未重跑，不得据以声称最终版仍已独立复核** |

**独立复核提出的 2 个「不自证」弱点已修复**（当前数据下与事实一致、不影响本次数字，但换输入会失真）：

1. `validation` 的 `err_n` / `ok_false_n` / `synthetic` 原为字面量 → 改为从 `results` / `setDoc` 实算，并补 `per_variant` 计数。
2. md 的陷阱题题号与「零回归」结论原为硬编码 → 改为从 `trapCauseRows` 逐条实算，新增 `trap_cause_audit`；**只要有一条偏离「解法正确，未发现错误」就列出告警并禁止宣称零回归**。本轮实算 8 条全 clean、deviations 0。

另统一 `latency_p50_ms` 末步舍入为 1 位小数（与合并脚本 `percentile()` 一致），消除 `Math.round` 对 `.5` 向上取整造成的 `12665` vs `12664.5` 跨产物表观差异；分位数算法本身两处相同，均为线性插值 `(n-1)*p`。**该加固本身不改变任何代理量数字**；其后第二轮补词表、第三轮按真实语料实证误检收窄分别使数字变化，已按 v2.1 口径全表重算（见 §4）。

---

## 7. 仍未解决 / 下一步

1. **正式人工盲评基线**：50–100 条真实学生错题 + 2 人独立评分，κ >0.6。当前仍空白。
2. **代理量与质量的相关性未校准**：本轮只校准了「词表能否检出结构信号」，未校准「该结构能否预测本质分 / 可指导分」——这需要第 1 项的真实盲评样本才能做。
3. `kq_id` / `cause_id` taxonomy 拍板（KPI §6.3.1「MVP 期上线即锁死」）；`depth_target` 产品侧逐题标定。
4. 深度完整度绝对值仍低：可继续试生成层结构修复（JSON schema 输出、诊断/讲解分离）、本地题库 RAG grounding、级联复核模型，但每一步都必须用同一口径重跑 A/B，且不得跳过人工盲评。
5. 产品侧待拍板：M4 口径是否改为「首屏 + 异步深度」、G1 认可率是否拆出质量分量。
6. G1 真实样本 n≥250、生产配置 p50 复测等门槛均未解除。
7. **词表残留误检未量化**（见 §2.0d）：`ACTIONABLE` 的「用…代替/替换」类正则仍会在错误做法描述上命中；`transfer_hint` / `explains_why` 的 2 处实证误检已剔除，但真实语料上的系统性误检率仍缺人工标注集，无法给出置信区间。

---

## 8. 复现命令

```bash
# 词表校准（构造样本，承认循环论证；--baseline 传旧词表报告可生成前后对照）
node apps/api/src/tests/quality-proxy-calibration.mjs \
  --baseline reports/quality-proxy-calibration-2026-11-07T08-38-28-809Z.json

# 真实模型输出上的代理量 / 字段口径探测
node apps/api/src/tests/quality-proxy-corpus-probe.mjs

# 新增正则误检探针（只读；git show 6358e12 自取旧词表，逐条列命中明细）
node scripts/quality-proxy-false-positive-probe.mjs

# 首次基线汇总（会重新调用 evaluateQualitySignals，产物带 rubric_scope）
node scripts/quality-baseline.mjs

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
