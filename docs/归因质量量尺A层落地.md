# 归因质量量尺 A 层落地与首次基线

> 日期：2026-11-07 · 范围：**只换量尺，不改生成与模型**
> 关联：`docs/K1.3_盲评作业指引.md`、`docs/k1.5-G1闸门报告框架.md` §491、
> `错题强化闭环_PRD_详细需求文档.md` §1.2 / R02、`错题强化闭环_全生命周期KPI与商业化指标模型.md` §0.3 / §6.3.1
> 基线产物：`reports/quality-baseline-2026-11-07T07-03-13.json` / `.md`（`reports/` 在 gitignore，不随仓库提交）

---

## 0. 一句话

**「归因是否触及本质、讲解有没有深度」目前没有正式基线数据**；本轮把量尺接通，并用 5 份历史报告量化出**可观测的结构缺口**。机器只出结构代理量，本质分 / 可指导分 / 偏好 / κ 一律留给人工盲评。

---

## 1. 为什么不是「自动本质分」

PRD §1.2 定义产品壁垒 =「**归因深度 × 验收严格度**」，MVP 假设链是「AI 归因可信 → 用户愿练 → 能复述本质」。但此前 `auto-eval.mjs` / `attrib-regress.mjs` 只测「契约格式 + 数值断言 + 错因方向关键词重叠 + 延迟」；`docs/k1.5-G1闸门报告框架.md` §491 早已写明：

> `FAIL=0` 只证明「契约格式 + 错因方向」合规，**不等于 M1 认可率 / M6 盲评准确率达标**。

探查发现 **K1.3 的人工量尺早已实现**：`apps/api/src/tests/blind-review.mjs` 已产出 7 列评分 CSV（`A/B_是否触及本质(1-5)`、`A/B_能否指导改错(1-5)`、方向对错、`更愿意相信哪一版`），`npm run blind:score` 已算本质均值、可指导均值、Cohen's κ、陷阱未瞎编率。缺口不在「没有尺」，而在**门禁链与人工尺是两条断开的链**，且正式盲评从未跑过。

因此本轮**不新造自动打分器**——用关键词启发式给 1–5 分会造出 KPI §0.3 R-Gate1 定义的「**假闸门**」，比没有指标更危险。落地方式是「接链 + 暴露缺口」：

| 维度 | 谁给分 | 本轮处理 |
|---|---|---|
| 契约齐全、错因是否空标签、是否含因果机制、推导块数、可操作改错指令、解释「为什么」、迁移/变式、结构化 ID、L1–L4 结构信号 | **机器**（布尔/计数代理量） | 新增 `quality-rubric.mjs`，接进 `auto-eval` 只读输出 |
| 是否触及本质 1–5、能否指导改错 1–5、更愿意相信哪版、Cohen's κ | **2 名评分人独立盲评** | `HUMAN_ONLY_DIMENSIONS` 恒返回 `null`，输出待评队列，走既有 `blind:export` / `blind:score` |
| `depth_target`（逐题目标深度 L1–L4） | **产品侧逐题标定** | 题集未提供时如实计 `unspecified`，不猜测、不填占位 |

---

## 2. 交付清单

| 文件 | 作用 |
|---|---|
| `apps/api/src/tests/quality-rubric.mjs`（新建） | `DEPTH_LEVELS` / `HUMAN_ONLY_DIMENSIONS` / `MACHINE_PROXY_KEYS`；`evaluateQualitySignals` / `summarizeQuality` / `buildReviewQueue` / `extractExpectedCause` / `deriveDepthSignalLevel` |
| `apps/api/src/tests/auto-eval.mjs`（改） | 顶部 import；`main()` 给每条 `scored` 追加 `quality_signals`；控制台、JSON（顶层 `quality_rubric`）、Markdown 各加一节只读汇总；导出转出新符号。**`scoreResult` / `evalTeach` / `evalDiagnose` / `computeTruthHitRate` / 陷阱判定 / 门禁正则解析全部逐字未动** |
| `apps/api/src/tests/quality-rubric.test.mjs`（新建） | 11 条离线单测，含「人工维度恒 null」「接线不破坏原有判定导出」 |
| `scripts/quality-baseline.mjs`（新建） | 5 份报告批量汇总，产出 `reports/quality-baseline-<ts>.json/.md`（含人工盲评历史状态、待评队列、异常记录） |
| `docs/归因质量量尺A层落地.md`（本文） | 口径纪律、基线、缺口、下一步 |

未改动：任何题集 `*.json`、任何生产代码（`promptVariants.ts` / `env.ts` / `attributionService.ts`）、`DEFAULT_VARIANT_ID`、`attrib-regress.mjs`。

---

## 3. 口径纪律（DSR，不可放宽）

1. **代理量 ≠ 质量**。固定词表命中得出，灵敏度与特异度**均未校准**：命中 ≠ 达标，未命中 ≠ 差。`explains_why` 刻意排除 `essence` 字段以免恒真，故 1/34 的低命中首先应怀疑词表过窄。
2. **跨题集不可比**。不同题集题型/重复采样结构不同；只能在同题集、同题量下做改动前后对照。典型反例：8092 `v0.2d` 的「可操作改错」6/12 高于 8093 门禁的 2/34，反映的是题型差异，不是质量差异。
3. **机器恒不给 1–5 分**。`human_only` 四项恒 `null`，`human_only.status = PENDING_HUMAN_BLIND_REVIEW`。
4. **不进闸门**。新维度不参与 PASS/PARTIAL/FAIL/INCOMPLETE，不改变 `attrib:regress` 结果，不得用于推断 M1 认可率 / M6 盲评准确率。
5. **深度目标不猜测**。题集未标 `depth_target` 就计 `unspecified`；`depth_signal_level` 是结构信号等级，不是深度质量评价。

---

## 4. 首次基线（5 份历史报告，纯离线回放）

### 4.1 主报告：8093 深度思考档 · 34 题 `real-exam-v3`

| 代理量 | 命中 | 读法 |
|---|---|---|
| 契约齐全 | **33/34 (97.1%)** | 与既有门禁 45/46 一致，非新信息 |
| 因果机制（诊断题 25 道） | **21/25 (84.0%)** | 结构线索；是否真因果须人工盲评 |
| 可操作改错 | 2/34 (5.9%) | ⚠️ 词表未校准，不可读作「95% 不能指导改错」 |
| 解释「为什么」 | 1/34 (2.9%) | ⚠️ 同上，且刻意排除 essence 段 |
| 迁移 / 变式 | **0/34** | 结构事实：输出契约里没有变式段 |
| 结构化 ID（`kq_id` / `cause_id`） | **0/34** | 结构事实：KPI §6.3.1 缺口 |
| `depth_target` 未标定 | **34/34** | 结构事实：产品侧尚未定义目标深度 |
| 结构信号 L1/L2/L3/L4 | **5 / 26 / 3 / 0** | 76% 停在 L2；**不是质量分** |
| 讲解推导块均值 | 3.78 | 仅 teach 题 |
| 人工盲评待评队列 | **34/34** | P0 陷阱 > P1 诊断 > P2 讲解 |

### 4.2 同题集近似对照（仅方向性线索，题集版本 v2→v3 不同）

| 指标（`v0.2b-guard-trap`） | 8093 思考档 34 题 | 8092 非思考档 33 题 |
|---|---|---|
| 契约齐全 | 97.1% | 97.0% |
| 因果机制（诊断 25 题） | **84.0%** | 64.0% |
| L1 结构信号 | **5/34** | 10/33 |
| L3+L4 结构信号 | 3/34 | 3/33 |

→ 唯一值得追的线索是**因果机制信号 +20pp、L1 减半**，与「思考档改善归因」方向一致；但这是词表命中，**不能当作归因质量提升的结论**，须由人工盲评确认。

### 4.3 人工盲评状态 = `PENDING_FORMAL_BLIND_REVIEW`

| 计分文件 | 题数 | 评分表 | 本质均值 | 可指导均值 | κ(方向) | 可作正式基线 |
|---|---|---|---|---|---|---|
| `reports/blind-2026-11-02T21-16-43-计分.json` | 6 | `sim-r1-filled.csv` / `sim-r2-filled.csv` | 3.50 / 3.50 | 3.50 / 3.50 | 1.000 | **否** |

这是 **6 题模拟演练**（文件名 `sim-`），K1.3 要求 **50–100 条真实学生错题 + 2 人独立评分**。因此本质分/可指导分的正式基线**目前是空白**，本轮不填任何数字。

---

## 5. 暴露的四个缺口（可观测事实，非质量结论）

1. **结构化 ID 未落地**：KPI §6.3.1 标注为「MVP 期决定、不可后补」的 `kq_ids` / `cause_id`，当前三行/五段文本契约 0/34 产出。后补代价极高（历史 loop 的文本知识点无法反解成 ID）。**需产品侧先定 taxonomy，本轮不擅自发明 ID 体系。**
2. **深度目标未定义**：34/34 题无 `depth_target`，产品侧尚未逐题定义 L1–L4 目标，导致「深度完整度」无法验收。
3. **迁移/变式段缺席**：0/34，L4 结构信号 0 条；输出契约里根本没有变式字段（这是设计缺口，不是模型能力结论）。
4. **人工量表未接入真实样本**：正式盲评未跑，M1 认可率 ≥70% 若单独使用，正是 KPI §0.3 R-Gate1 的假闸门风险——用户可能因「说得很具体」就点认可（K1.3 §五 明确警告「不要用是否具体代替是否正确」）。

---

## 6. 下一步（B / C / D 层，未执行，需授权）

| 层 | 动作 | 前置 |
|---|---|---|
| **B 生成层** | ① 答案行↔推导一致性校验 + 冲突重试 / 由推导结构化重组；② JSON schema 输出替代文本正则；③ 诊断三段与讲解五段分离生成；④ R03 追问作深度补丁 | 先有 A 层人工基线，否则无法证明改完变好 |
| **C 知识锚定** | 本地题库 RAG（多模型编排文档 §4 / §9.2）注入相似题 / 正解 / 知识点标签；评测已有 `--anchors`，生产 `attributionService.ts` 仍硬编码 `ATTR_SYSTEM` | 题库来源、规模、license；联网检索受数据主权铁律默认关闭，只能本地 |
| **D 模型层** | 快模型出三项 + 校验器复核深度的级联，而非继续单模型换档 | 硬件门槛拍板 |

**待拍板**：① 质量优先是否把 M4「同步 p50≤30s」改为「首屏 <5s + 深度异步补齐」；② G1 认可率是否拆成可核验分量（陷阱 + 方向 + 本质/可指导分）；③ `kq_id` / `cause_id` taxonomy 与 `depth_target` 逐题标定；④ 正式盲评样本来源（50–100 条真实错题）与 2 名评分人。

---

## 7. 验证记录（全部实测）

| 项 | 结果 |
|---|---|
| 新单测 `quality-rubric.test.mjs` | **11/11 pass** |
| 既有数值判据单测 | **28/28 pass** |
| API 单测 | **75/75 pass** |
| `npm run typecheck -w @aicorrection/api` | 0 错 |
| 门禁复评（8093 合并报告） | `34 题 PASS 27 / PARTIAL 1 / FAIL 6`、陷阱 `0/1`、**脚本退出码 1**，与改动前逐字一致 |
| 三份历史报告回放 | `28/1/0`、`23/3/3`、`27/2/0`，与改动前逐字一致 |
| 基线脚本 | 5 份报告、0 异常 |

---

## 8. 复现

```bash
# 首次基线
node scripts/quality-baseline.mjs
# 单份报告（含新增质量维度）
node apps/api/src/tests/auto-eval.mjs --json reports/prompt-ab-8093-think-real-merged.json --set apps/api/src/tests/fixtures/prompt-ab-set-realexam.json
# 单测
node --test apps/api/src/tests/quality-rubric.test.mjs
node --test apps/api/src/tests/auto-eval.numeric.test.mjs
# 正式人工盲评（需 50–100 条真实错题 + 2 名评分人）
npm run blind:export -- --from-json <报告.json> --raters 2 --seed 20261107
npm run blind:score -- --key <key.json> --files <r1.csv>,<r2.csv>
```

---

## 9. 边界

全程离线：只读 `reports/*.json` + `fixtures/*.json`；**未连任何模型服务、未联网检索 / 未外发题干、未启 3001、未碰 335MB 生产库**；未改生产代码与默认变体；`reports/` 在 gitignore，不随仓库提交。G1 仍为 **OPEN BLOCKER / NO-GO**，v0.2（`R04/R05/R06/G2`）继续冻结。
