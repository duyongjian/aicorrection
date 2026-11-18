---
title: 错题强化闭环 AI 归因
emoji: 🎓
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
license: mit
pinned: false
---

# 错题强化闭环 · AI 归因 (AICorrection v0.1)

拍照 / 粘贴错题 → AI 定位错因、知识锚点与本质讲解，形成「识别 → 归因 → 练习 → 复述 → 验证」强化闭环。

## 部署到 Hugging Face Spaces（Docker SDK）

1. 在 HF 新建 **Space**，SDK 选 **Docker**。
2. 将本目录（`deploy/huggingface/`）下的三个文件放到 Space 仓库根：
   - `Dockerfile`
   - `requirements.txt`
   - 本 `README.md`（含上方 YAML frontmatter，HF 据此识别为 Docker Space）
3. 在 Space 的 **Settings → Variables and secrets** 中设置运行期环境变量（见下方清单）。
4. 推送后 HF 自动构建镜像并启动；访问 Space 地址即可，前端与 API 同源托管。

## 必填环境变量（云端归因）

| 变量 | 说明 |
|------|------|
| `CLOUD_BASE_URL` | OpenAI 兼容端点，如 `https://api.deepseek.com/v1` |
| `CLOUD_API_KEY`  | 服务商 API Key |
| `CLOUD_MODEL`    | 归因模型名，如 `deepseek-chat` |

可选：`VISION_BASE_URL` / `VISION_API_KEY` / `VISION_MODEL` 让 OCR 用云端视觉大模型（设 `OCR_MODE=llm` 时生效）；默认 `OCR_MODE=auto` 用容器内免费本地 RapidOCR。

## 端口

容器监听 `$PORT`（HF 注入，默认 7860），前端静态资源由同一 Express 进程在 `/` 托管。

完整部署与合规说明见上游仓库 `deploy/README.md`。
