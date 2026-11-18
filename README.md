<div align="center">

# 错题强化闭环 · AI Correction

**拍照 / 粘贴一道错题 → AI 定位错因、锚定知识点、讲透本质 → 练习 · 复述 · 验证，形成完整强化闭环。**

> 验证最危险假设链第一步：**AI 归因是否可信**（R2 信任障碍）。
> v0.1 严格范围防火墙：仅实现 R01 上传 + R02 归因 + R03 认可/追问 + Infra-0 最小地基；R04–R08、可视化、图谱渲染均不在本版范围。

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-19%20suites-brightgreen)
![License](https://img.shields.io/badge/license-PolyForm%20NC%201.0.0-blueviolet)

[快速开始](#-快速开始) · [功能](#-核心功能) · [架构](#-架构) · [部署](#-免费部署) · [模型验收](#-模型验收与honesty) · [文档](#-文档索引)

</div>

---

## ✨ 核心功能

| 环节 | 能力 | 实现要点 |
|---|---|---|
| 📷 **上传** | 拍照 / 图片 / 文本粘贴三入口 | 本地 RapidOCR（文本 + 公式）+ 视觉大模型双通道；拒识校验层拦截「非题目」防伪造题干 |
| 🧠 **归因** | 错因分类 · 知识点锚定 · 本质讲解 | 统一 `LlmProvider` 抽象；单模型 / 本地多模型编排 / 云端 API 三策略；题库 RAG 参考块（绝不虚构） |
| ✅ **认可 / 追问** | 用户评分 + 多轮追问验证 | 认可率 M1 闸门；追问轮次上限与诚实降级 |
| 🔁 **强化闭环** | 同类题练习 · 复述本质 · 验证掌握 | `loop_id` 贯穿五步；间隔复习与知识点掌握度沉淀 |
| 🎛️ **管理后台** | 配置覆盖 · 知识点库 · 归因调试台 | 独立 `x-admin-key` 授权面，与终端用户卡密门禁隔离 |
| 📊 **质量治理** | G1 闸门 · 灰度发布 · 埋点看板 | K1.4 灰度/cohort + kill-switch；M1 认可率、上传失败细分看板 |

> ⚠️ **诚实声明**：v0.1 是**线下内测体验版**，`attribution` 质量尚未通过正式 G1 验收闸门（见下方模型验收），请勿将内测数据当作正式基线。

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web  ·  React 18 + Vite + MUI v5  (PWA，可手机安装)   │
│  上传 → 归因 → 追问 → 练习 → 复习 → 看板                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ /api/v1  (开发态 Vite 代理 / 生产同源或 CORS 直连)
┌──────────────────────────▼──────────────────────────────────┐
│  apps/api  ·  Node + Express + TypeScript                   │
│  ├─ OCR: 本地 RapidOCR/公式引擎 + 视觉大模型 + 拒识闸门        │
│  ├─ 归因编排: single / ensemble / cloud 三策略               │
│  ├─ RAG: 题库哈希嵌入 + SQLite 余弦（零模型下载）             │
│  ├─ 门禁: 卡密 / 账号 / 灰度 / 管理后台独立鉴权               │
│  └─ 存储: SQLite (better-sqlite3) + 迁移                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  packages/shared  ·  前后端共享类型 / 常量 / 事件 Schema      │
└─────────────────────────────────────────────────────────────┘
```

**设计原则**：无 Mock 假数据凑数（真实模型失败如实降级）、数据主权默认不外发（联网搜索默认关闭）、诚实标定（设计值 ≠ 实测值）。

---

## 🚀 快速开始

### 环境要求
- Node.js 20+，npm workspaces
- （可选）本地 llama.cpp / Ollama 服务，或云端 OpenAI 兼容 API Key

### 1. 安装依赖
```bash
npm install
```
> 若无法原生编译 `better-sqlite3`，代码仍可审阅；类型检查需在可编译环境执行。

### 2. 配置环境变量（可选）
```bash
cp .env.example apps/api/.env
```
默认 `LLM_PROVIDER=ollama`。也可用云端 API：设 `ATTRIBUTION_STRATEGY=cloud` + `CLOUD_BASE_URL` / `CLOUD_API_KEY` / `CLOUD_MODEL`（详见 [`apps/api/.env.example`](apps/api/.env.example)）。

### 3. 启动开发（前端 :5173 + 后端 :3001）
```bash
npm run dev
```
- 前端 http://localhost:5173 （`/api` 已代理到 :3001）
- 后端 http://localhost:3001 · 管理后台 http://localhost:3001/admin-ui

### 4. 生产构建
```bash
npm run build       # shared tsc → web vite build → api tsc
npm run dev:api     # 生产态单进程托管前端静态资源于 :3001
```

---

## 🧪 自验证

```bash
npm run build                                              # 全量类型检查 + 构建
npm test -w @aicorrection/api                              # 19 个测试套件
npm run dev:api &                                          # 另开终端启动服务
npm run smoke                                              # 上传→归因→追问→埋点→看板 端到端
NO_PROXY='*' JSON=<report.json> npm run attrib:regress:real # 归因质量回归
```

---

## 🌐 免费部署

两套**互补**配方（详见 [`deploy/README.md`](deploy/README.md)）：

| 配方 | 平台 | 角色 | 关键点 |
|---|---|---|---|
| **1 · 静态 PWA** | Netlify | 托管前端 | `netlify.toml` 一键构建；PWA 经 `VITE_API_ORIGIN` CORS 直连后端，绕开函数 10s 超时 |
| **3 · 全栈容器** | Hugging Face Spaces | API + Web + 本地 OCR | `deploy/huggingface/Dockerfile` 单体镜像，监听 `$PORT`，归因默认走云端 API |

> 合规提示：切到公有云 + 第三方 API 后，PIPL / ICP 备案 / AIGC 备案 / 图像内容安全重新生效，部署前请按 [`deploy/README.md`](deploy/README.md) 逐项评估。

---

## 🔬 模型验收与 Honesty

项目坚持「一个个端口实测」的逐端口验收方法，统一口径见 [`docs/逐端口模型验收口径.md`](docs/逐端口模型验收口径.md)，判定结果见 [`docs/逐端口验收结果.md`](docs/逐端口验收结果.md)。

| 端口 | 模型 | 判定 | 关键结论 |
|---|---|---|---|
| 8098 | DeepSeek-V4-Pro-9B (Q4_K_M) | ❌ NO-GO | 算术/格式/算力健康但单调方向系统性写反（A6 硬闸） |
| 8090 | MiniCPM-V-4.5 (Q4_K_M) | ✅ 视觉端 V4/V5 收口 | V4 拒识 + V5 p95 经 P1-b 优化稳定 PASS |
| 8095 | Qwen3.8-27B-IQ1M (1.75bpw) | ❌ NO-GO | A6 基础算术 5/5 崩，极低量化退化 |
| 8085 | Qwen3.8-27B-Uncensored | ❌ NO-GO | 算术崩 + decode 仅 8.62 tok/s |

> **方法论纪律**：A6 必须逐份人工核对答案行与推导，禁止关键词正则替代；「未截断（stop）」≠「收敛正确」；设计值（验收阈值）与实测值严格区分。所有证据本地闭环，未外发。

---

## 📚 文档索引

**工程**
- [管理后台 + 卡密分发](docs/线下分发MVP_卡密与账号.md) · [上传失败埋点](docs/上传失败细分埋点.md)
- [灰度机制 K1.4](docs/k1.4-灰度机制设计.md) · [G1 闸门框架 K1.5](docs/k1.5-G1闸门报告框架.md)

**质量与验收**
- [逐端口验收口径](docs/逐端口模型验收口径.md) · [验收结果](docs/逐端口验收结果.md) · [回归门禁判据](docs/回归门禁数值判据.md)
- [归因质量量尺 A 层](docs/归因质量量尺A层落地.md) · [B 层校准](docs/归因质量量尺B层_词表校准与深度候选AB.md)
- [数据主权修复记录](docs/P0-数据主权默认外发修复.md) · [OCR 模型方案](docs/OCR_AI模型方案.md) · [llama.cpp 部署](docs/llama.cpp本地部署方案.md)

**部署**
- [免费部署双配方](deploy/README.md) · [Hugging Face Spaces](deploy/huggingface/README.md)

---

## 📄 许可

本项目采用 **[PolyForm Noncommercial License 1.0.0](LICENSE)** —— 允许任何**非商业目的**的使用、修改与分发（含个人研究/实验/测试、慈善/教育/公共研究/公共安全健康/环保/政府机构使用），**不允许商业使用**。完整条款见 [`LICENSE`](LICENSE)。

> 如需商业授权，请联系仓库所有者另行协商。

---

## 🔐 安全与隐私

- 所有密钥（`.env` / `.env.local`）、数据库（`*.db`）、上传图片、审计日志、内部工作元数据（`.workbuddy/`）均通过 `.gitignore` 排除，**不入库**。
- 联网搜索默认关闭（`WEB_SEARCH_ENABLED=false`）；任何外发须显式授权。
- 管理后台使用独立强随机 `ADMIN_API_KEY`，生产环境务必替换默认值。

---

<div align="center">

Built with careful attention to honesty, data sovereignty, and iterative verification.

</div>
