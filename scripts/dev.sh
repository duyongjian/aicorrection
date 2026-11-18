#!/usr/bin/env bash
# ============================================================================
# 错题强化闭环 · 一键启动（Mock 模式，无需大模型）
# 适用：Git Bash / macOS / Linux
# Windows 原生 CMD 请用 scripts/dev.bat；PowerShell 请用 scripts/dev.ps1
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "=========================================="
echo "  错题强化闭环 · 本地开发环境（Mock）"
echo "=========================================="
echo ""
echo "  API server : http://localhost:3001"
echo "  Web client : http://localhost:5173"
echo ""
echo "  模式：LLM_PROVIDER=mock  （无需 Ollama / MiniCPM）"
echo "  OCR    ：本地 quick-test 模式（跳过图片识别）"
echo "  搜索   ：关闭（避免网络请求）"
echo ""

# ── 1. 构建 shared 包 ────────────────────────────────────────────────────────
echo "[1/4] 构建 @aicorrection/shared …"
npm run build:shared

# ── 2. 环境覆盖（Mock 专用） ─────────────────────────────────────────────────
# 这些变量会叠加到 .env 之上，优先级更高。
export LLM_PROVIDER=mock
export OCR_MODE=llm          # 视觉大模型回退模式（Mock 不真实调用，直接占位返回）
export WEB_SEARCH_ENABLED=false

# ── 3. 并发启动 API + Web ────────────────────────────────────────────────────
echo "[2/4] 启动 API 与 Web 开发服务器（Ctrl+C 同时退出）…"
echo ""
concurrently \
  --names "API" --prefix-colors "green.bold" \
  --names "WEB" --prefix-colors "blue.bold" \
  "npm:dev:api" \
  "npm:dev:web"

echo ""
echo "全部进程已退出。"
