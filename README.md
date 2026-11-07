# 错题强化闭环 · v0.1

> 验证最危险假设链第一步：**AI 归因可信**（R2 信任障碍）。
> 范围防火墙（强制）：仅实现 **R01（上传）+ R02（归因）+ R03（认可/追问）+ Infra-0（最小账户/存储/loop_id/埋点/OCR）**。
> **不实现** R04–R08、可视化、图谱渲染；`review_sessions` 仅建表不写逻辑；`loop_sessions` 的 `loop_complete/verify_*` 仅预埋。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite + TypeScript + MUI v5 |
| 后端 | Node.js + Express + TypeScript |
| AI | Ollama（OpenAI 兼容）+ 统一 `LlmProvider` 抽象层 + 规则化 Mock 兜底 |
| 数据库 | SQLite（better-sqlite3，同步）+ 迁移脚本 |
| 仓库 | npm workspaces 单仓：`apps/web` + `apps/api` + `packages/shared` |

## 目录结构

```
aicorrection-v0.1/
├── packages/shared   # 前后端共享：类型 / 常量 / 事件 Schema
├── apps/web          # 前端 React+Vite+MUI
└── apps/api          # 后端 Node+Express+TS
```

## 快速开始

### 1. 安装依赖

```bash
npm install          # 根目录，自动安装所有 workspace 依赖
```

> 网络受限（无法原生编译 better-sqlite3）时，依赖可能安装失败；此时代码仍可审阅，`tsc` 类型检查需在能编译环境执行。

### 2. 配置环境变量（可选）

```bash
cp .env.example apps/api/.env
# 默认 LLM_PROVIDER=ollama，AUTO_FALLBACK_TO_MOCK=true → 无 Ollama 也能跑通（自动 Mock）
```

### 3. 启动开发（Vite :5173 + Express :3001）

```bash
npm run dev
```

- 前端：http://localhost:5173 （`/api` 已代理到 :3001，无跨域）
- 后端：http://localhost:3001

### 4. 仅启动后端

```bash
npm run dev:api      # tsx 监听 apps/api/src/index.ts
```

### 5. 生产构建

```bash
npm run build        # 先 build shared → web → api
```

前端静态资源由后端 `express.static` 托管（见 `apps/api/src/app.ts`），生产态单进程 :3001。

## 线下分发 MVP（卡密 + 账号）

> 想直接发给真人试用，走这里。完整说明见 [`docs/线下分发MVP_卡密与账号.md`](docs/线下分发MVP_卡密与账号.md)。

```bash
npm run license:generate -- --count 20 --batch offline-01   # 发卡（明文只输出一次）
npm run distribute                                          # 构建 + 单端口启动（强制开启门禁）
# 打开 http://localhost:3001，把卡密发给试用者激活

npm run license:list -- --batch offline-01                   # 看状态
npm run license:revoke -- --code AC-XXXX-XXXX-XXXX           # 停用
```

- **卡密即账号**：兑换成功自动创建既有 `anon_user_id`，无需注册。
- **独立分发库**：`data/distribution/`，绝不读写生产库 `apps/api/src/data/aicorrection.db`（约 335MB）。
- **门禁默认关闭**：只有 `LICENSE_GATE_ENABLED=true` 生效，开发态与单测行为零变化。
- ⚠️ **本版为线下内测体验版，归因质量尚未通过正式验收（G1 仍 NO-GO）**，请仅用于体验与反馈，勿将内测数据当作正式基线。

## 自验证

```bash
# 1) 后端类型检查
npm run build:shared && npx tsc --noEmit -p apps/api/tsconfig.json

# 2) 前端构建
npm run build -w @aicorrection/web

# 3) 端到端冒烟（需先启动 api server，默认走 Mock 兜底也能跑通五步闭环）
npm run dev:api      # 另开终端
npm run smoke        # 覆盖：上传→归因→认可/追问→埋点→看板 M1

# 4) 卡密门禁端到端回归（真实 HTTP + 系统 temp 隔离库，不碰生产库，无需先启服务）
npm run build:shared && npx tsx scripts/license-e2e.mjs
```

## 关键契约速查

- 统一响应信封：`{ "code": 0, "data": {...}, "message": "ok" }`
- 错误码：1001 参数 / 2001 不存在 / 3002 超时 / 3003 缺项 / 3004 追问上限 / 5000 内部
- 埋点事件由**前端 SDK 上报**，服务端 `POST /api/v1/track` 仅接收 + 幂等落库
- 上传失败口径：失败也上报 `loop_upload`（`ocr_status='fail'`），无独立 `loop_upload_fail` 事件名
- 不认可：`attr_rate.rate_action='inaccurate'`（`attr_dislike` 已废除）
- `loop_id` = `l_YYYYMMDD_xxxx`，贯穿五步闭环

## v0.1 验收闸门 M1

- 归因认可率 `approval_rate = count(attr_rate=approve) / count(loop_attr_show)` ≥ 70% → `go`
- 看板：`GET /api/v1/dashboard/m1`

## AI 模型选择与实测结论（2026-10-24 本机）

- **接口形态**：后端通过 `openai` SDK 直连 `LLM_BASE_URL`，默认 `http://localhost:11434/v1`（Ollama 的 OpenAI 兼容端点）；切换模型只改 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`，业务代码零改动。
- **本机已拉取模型**：`qwen3:8b`、`qwen3:8b-8k`、`qwen2.5:0.5b`。
- **实测结论**：

  | 模型 | 单次归因耗时 | 输出可用性 | 结论 |
  |---|---|---|---|
  | `qwen3:8b` | ~92s | `content` 为空、内容落在 `reasoning`、`finish_reason=length` | ❌ thinking 模型，不适合归因 |
  | `qwen2.5:0.5b` | 首加载 ~33s / 热态 ~7.6s | `content` 正常、三段可解析 | ⚠️ 可跑通，但质量浅（错因/知识点可能重复、结论可能错误） |

- **默认配置**：`LLM_MODEL=qwen2.5:0.5b` + `AUTO_FALLBACK_TO_MOCK=true` + 归因超时 `ATTRIBUTION_TIMEOUT_MS=45000`。
- **生产/真实验证建议**：切换云模型（DeepSeek / MiniMax / OpenAI 兼容端点）或更大的**非 thinking** instruct 模型（如 qwen2.5:7b+），仅改环境变量即可。归因质量是 M1 闸门（认可率 ≥70%）的关键，0.5B 仅用于链路联调与演示。
- **视觉 OCR**：`VISION_MODEL=llama3.2-vision` 本机未拉取，图片入口会自动回退 Mock 占位题干（`ocr_status=partial`）；文本/粘贴入口不受影响，可完整跑通闭环。

## 已知限制（v0.1）

1. 专家盲评仅提供 API 回写 + 抽样列表（`/api/v1/review/*`），无独立评审 UI。
2. 图片加密落盘为占位（`apps/api/src/data/uploads/`），AES 加密待 v0.2 合规方案确认。
3. `session_id` 由客户端生成；`exp_group` 统一 `none`（字段仅预埋）。
4. 业务库与分析事件同库（`apps/api/src/data/aicorrection.db`），生产应拆分业务库/分析库。
5. 前端拍照依赖浏览器 `capture` 属性，桌面无摄像头时请用文本入口。

## 本次自验证记录

- `npm run build`：shared tsc + web `tsc --noEmit` + vite build + api `tsc --noEmit` 全部通过（Exit 0）。
- `npm run smoke`（真实 Ollama 路径）：**15/15 通过**；归因 `attr_model_version=qwen2.5:0.5b`、`attr_latency_ms≈7646`；看板 `approval_rate=1, gate=go`；追问第 1 次 `has_next_action=true`、第 2 次达上限 `false`；专家回写成功。
- Mock 兜底路径：模型缺失/超时/输出不合格式时自动 `mock-v1-fallback`，闭环仍可跑通（已实测）。
