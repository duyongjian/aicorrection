# AICorrection v0.1 —— 免费部署指南（Netlify + Hugging Face Spaces）

本目录提供两套**免费**部署方案。它们不是二选一，而是**互补**：

```
┌──────────────┐         CORS / 同源        ┌──────────────────────────┐
│  Netlify     │  PWA（静态前端）           │  Hugging Face Spaces      │
│  (配方 1)    │  ── 拍照/粘贴错题 ───────▶ │  (配方 3, Docker 容器)    │
│  全球 CDN    │     归因/闭环请求          │  API + Web + 本地 OCR     │
│  手机可安装  │◀──── JSON 归因结果 ──────  │  云端大模型归因            │
└──────────────┘                           └──────────────────────────┘
   免费额度：静态托管 + 函数                免费额度：CPU 容器（可选 GPU）
```

- **前端（配方 1，Netlify）**：只托管编译后的 PWA（`apps/web/dist`）。手机浏览器「添加到主屏幕」即可获得原生般体验，拍照调用系统相机。
- **后端（配方 3，HF Spaces）**：全栈容器，托管 API + 静态前端 + 本地 OCR 子进程（CPU 免费），归因默认走云端大模型 API（按量计费，免本地显存）。

> 为什么这样拆？Netlify Functions **免费档超时仅 10s**，而本地/慢模型归因常 >10s。让 PWA **直连后端（CORS）** 可绕开该限制；后端容器没有这个约束。

---

## 一、环境变量总表

两类部署共享同一套 env 契约（见 `apps/api/src/config/env.ts`）。**加粗为必填**。

### 云端大模型（归因，按量计费）
| 变量 | 默认 | 说明 |
|------|------|------|
| **`CLOUD_BASE_URL`** | 空 | OpenAI 兼容端点，如 `https://api.deepseek.com/v1` |
| **`CLOUD_API_KEY`**  | 空 | 服务商 Key |
| **`CLOUD_MODEL`**    | 空 | 归因模型名，如 `deepseek-chat` |
| `ATTRIBUTION_STRATEGY` | `single` | 设为 `cloud` 启用上述云端归因 |

### 视觉 / OCR
| 变量 | 默认 | 说明 |
|------|------|------|
| `OCR_MODE` | `auto` | `auto`=本地 RapidOCR(免费) 失败降级视觉；`llm`=只用云端视觉；`local`=只用本地 |
| `VISION_BASE_URL` / `VISION_API_KEY` / `VISION_MODEL` | 回落 LLM_* | OCR 用云端视觉大模型时配置（配合 `OCR_MODE=llm`） |

### 管理后台
| 变量 | 默认 | 说明 |
|------|------|------|
| `ADMIN_API_KEY` | `aicorr-admin-dev` | **生产务必改成强随机值**，否则任何人可改模型/策略/题库 |

### Netlify 专属
| 变量 | 说明 |
|------|------|
| `VITE_API_ORIGIN` | 构建期变量，设为后端地址如 `https://aicorrection.hf.space`，PWA 直连后端 |
| `BACKEND_ORIGIN` | 仅当启用同源代理函数时填（见下） |

---

## 二、配方 1：Netlify 静态 PWA

1. 仓库连 GitHub，Netlify 导入本仓库。
2. Build 设置（已写在 `netlify.toml`，一般自动识别）：
   - Build command：`npm install && npm run build -w @aicorrection/web`
   - Publish directory：`apps/web/dist`
3. **Site configuration → Environment variables** 设置 `VITE_API_ORIGIN=https://<你的HF Space地址>`。
4. Deploy。手机打开站点 →「添加到主屏幕」即安装 PWA，相机可用。

### （可选）同源代理函数
若不想配 CORS、希望 PWA 走 `/api/v1` 同源路径：
- `netlify.toml` 取消 `[[redirects]]` 注释；
- Netlify 环境变量设 `BACKEND_ORIGIN=https://<后端>`；
- `netlify/functions/api.ts` 会把 `/api/v1/*` 透明转发到后端。
- ⚠️ 受 10s 函数超时限制，长耗时归因可能失败——生产仍推荐上面的 `VITE_API_ORIGIN` 直连。

---

## 三、配方 3：Hugging Face Spaces（Docker）

1. HF 新建 **Space**，SDK 选 **Docker**。
2. 把 `deploy/huggingface/` 下三个文件放到 Space 仓库根：`Dockerfile`、`requirements.txt`、`README.md`（含 YAML frontmatter）。
3. Space **Settings → Variables and secrets** 设置 `CLOUD_BASE_URL` / `CLOUD_API_KEY` / `CLOUD_MODEL`（以及按需 `VISION_*`）。
4. 推送后自动构建并启动；Space 地址即后端地址，填到 Netlify 的 `VITE_API_ORIGIN`。

> 任意 Docker 主机同理：`docker build -f deploy/huggingface/Dockerfile -t aicorrection . && docker run -p 7860:7860 -e CLOUD_BASE_URL=... -e CLOUD_API_KEY=... -e CLOUD_MODEL=... aicorrection`

---

## 四、合规提示（云 + 第三方 API 已重新引入）

切换到「公有云 + 服务商 API」后，下列合规项重新生效（均可通过配置规避/减弱）：

1. **个保法（PIPL）**：拍照题干属用户内容。优先选**声明不用于训练**的企业级 API；境内用户优先**国内服务商**（DeepSeek / 通义 / 智谱 / 豆包）避免数据跨境。图像建议先做**内容安全审核**再外发。
2. **ICP 备案**：对外提供 Web 服务（含 PWA 域名）通常需备案；HF Spaces 自带 `*.hf.space` 域名可省去自有域名备案，但自定义域名仍需备案。
3. **AIGC 服务备案**：若公开面向公众提供生成式 AI 服务，按《生成式人工智能服务管理暂行办法》可能需算法备案/安全评估。
4. **应用内购买 / 支付**：若后续做订阅付费，平台抽成 + 支付合规另行评估。
5. **数据主权**：本项目已获你授权放宽「零外发」铁律（云 + 服务商 API）。仍建议：默认关闭联网搜索、图像外发前脱敏/审核、明确告知用户数据去向。

---

## 五、关键限制速查

| 项 | 说明 |
|----|------|
| Netlify 函数 10s 超时 | 故 PWA 直连后端（CORS），不走函数代理 |
| 本地 OCR 仅在后端容器 | Netlify 纯静态无法跑 Python 子进程；OCR 由 HF 容器免费 CPU 承担 |
| 后端 SQLite 为临时 | HF 容器 FS 可能随重启重置；多端同步需另接云数据库（后续迭代） |
| 归因质量依赖云端模型 | `CLOUD_MODEL` 决定效果与成本；慢模型延时会直接反映到前端等待 |

详见 `apps/api/src/config/env.ts` 与各 `*.env.example`。
