#!/usr/bin/env bash
# =============================================================================
#  错题强化闭环 · 一键启动【真实大模型模式】
#
#  设计原则（与用户要求严格对齐）：
#   1. 本脚本【不启动任何大模型服务】——llama.cpp / Ollama 需你自行在外部启动。
#   2. 【绝不 mock】——强制 AUTO_FALLBACK_TO_MOCK=false，且不覆盖 LLM_PROVIDER。
#      依据 src/services/llm/index.ts:23：LLM_PROVIDER !== 'mock' 即走真实
#      OllamaProvider（OpenAI 兼容），故沿用 .env 的 LLM_PROVIDER=llama 就是真调用。
#   3. 启动前【预检】各真实服务端点；未就绪只告警提示、不降级、不 mock。
#
#  用法：
#    ./scripts/start-test.sh            # 预检 + 构建 shared + 启动 API/Web + 开浏览器
#    ./scripts/start-test.sh --check    # 只做预检，不启动
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# 清除代理环境变量，避免干扰本地服务探测
# 使用 NO_PROXY 覆盖比 unset 更可靠，防止环境 shim 恢复变量
export NO_PROXY="localhost,127.0.0.1,::1,.local"
export no_proxy="localhost,127.0.0.1,::1,.local"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy 2>/dev/null || true

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# ── 从 apps/api/.env 读取真实服务地址（只取 URL，不碰任何密钥）─────────────────
read_env() { # $1=变量名
  grep -E "^${1}=" apps/api/.env 2>/dev/null | head -1 \
    | sed -e 's/^[^=]*=//' -e 's/#.*$//' -e 's/[[:space:]]*$//' -e 's/\r$//'
}

ANALYSIS_URL="$(read_env ANALYSIS_BASE_URL)"; ANALYSIS_URL="${ANALYSIS_URL:-http://localhost:8085/v1}"
RECOG_URL="$(read_env LLM_BASE_URL)";        RECOG_URL="${RECOG_URL:-http://localhost:8090/v1}"
ANALYSIS_MODEL="$(read_env ANALYSIS_MODEL)"; ANALYSIS_MODEL="${ANALYSIS_MODEL:-}"
LLM_MODEL="$(read_env LLM_MODEL)";           LLM_MODEL="${LLM_MODEL:-}"
LLM_PROVIDER="$(read_env LLM_PROVIDER)";     LLM_PROVIDER="${LLM_PROVIDER:-}"
OCR_PY="$(read_env OCR_PYTHON)"
# .env 未配置时回退 env.ts 的默认路径
[ -z "$OCR_PY" ] && OCR_PY="D:/AllSideProject/AICorrection/.venv-ocr/Scripts/python.exe"
API_PORT="$(read_env PORT)";                 API_PORT="${API_PORT:-3001}"

# ── WSL 兼容：WSL2 有独立网络命名空间，其 localhost ≠ Windows 主机 localhost。
#    在 WSL 下必须改用 Windows 主机 IP（默认网关 / resolv.conf nameserver），
#    否则预检 8085/8090 全部连接被拒（HTTP 000）。
if grep -qi microsoft /proc/version 2>/dev/null; then
  WIN_HOST="$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
  [ -z "$WIN_HOST" ] && WIN_HOST="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)"
  if [ -n "$WIN_HOST" ]; then
    ANALYSIS_URL="${ANALYSIS_URL/localhost/$WIN_HOST}"
    RECOG_URL="${RECOG_URL/localhost/$WIN_HOST}"
    echo "[WSL] 检测到 WSL 环境，已将 localhost 替换为 Windows 主机 IP：$WIN_HOST"
  fi
fi

echo "============================================================"
echo "  错题强化闭环 · 一键启动【真实大模型模式 · 非 mock】"
echo "============================================================"
echo
echo "  策略来源：apps/api/.env（本脚本不覆盖模型地址，只做预检）"
echo "  provider = ${LLM_PROVIDER:-<默认>}   识别模型 = ${LLM_MODEL:-<默认>}  @ ${RECOG_URL}"
echo "  归因模型 = ${ANALYSIS_MODEL:-<默认>}  @ ${ANALYSIS_URL}"
echo "  fallback = 强制关闭（AUTO_FALLBACK_TO_MOCK=false，绝不降级 mock）"
echo

# ── 1. 预检真实服务（缺失只提示，绝不 mock 兜底）──────────────────────────────
missing=0
probe() { # $1=名称  $2=URL
  local code
  # --noproxy '*': 本机有 HTTP_PROXY(127.0.0.1:5209)，不绕过会把本地端口探测
  # 发给代理并得到假 502，必须直连本机端口
  # 注意：不要再加 `|| echo 000`——curl 连接失败时 -w 本身已输出 000，追加会变成 000000
  code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 3 "$2/models" 2>/dev/null)"
  [ -z "$code" ] && code="000"
  if [ "$code" = "200" ]; then
    echo "  [就绪] $1"
    echo "         $2  (HTTP $code)"
  else
    echo "  [未就绪] $1"
    echo "           $2  (HTTP ${code:-000})"
    missing=$((missing+1))
  fi
}

echo "[预检] 真实大模型服务（本脚本不负责启动它们）:"
probe "归因/分析端 (ANALYSIS_BASE_URL)" "$ANALYSIS_URL"
probe "识别/视觉端 (LLM_BASE_URL)"      "$RECOG_URL"

# OCR 本地环境（真实 OCR，非 mock）
if [ -n "$OCR_PY" ] && [ -f "$OCR_PY" ]; then
  echo "  [就绪] 本地 OCR 解释器  $OCR_PY"
else
  echo "  [未就绪] 本地 OCR 解释器  ${OCR_PY:-<未配置>}（不存在则上传走视觉大模型识别）"
fi
echo

if [ "$CHECK_ONLY" = "1" ]; then
  echo "--check 模式：仅预检，不启动服务。"
  exit 0
fi

if [ "$missing" -gt 0 ]; then
  echo "  ⚠ 有 $missing 个真实服务未就绪。脚本【不会】降级为 mock，"
  echo "    仍会按 .env 策略直连真实服务；未就绪的端点在调用时才会报真实错误。"
  echo "    请自行在外部启动对应大模型服务（例如 llama.cpp / Ollama），再重跑本脚本。"
  echo
  read -r -p "    仍要继续启动 API/Web 吗？[y/N] " ans
  case "$ans" in
    [yY]*) echo "    继续启动…" ;;
    *) echo "    已取消。"; exit 1 ;;
  esac
  echo
fi

# ── 2. 构建共享包 ────────────────────────────────────────────────────────────
echo "[1/3] 构建 @aicorrection/shared ..."
npm run build:shared || { echo "shared 构建失败，已中止。"; exit 1; }
echo

# ── 3. 启动（前台；Ctrl+C 同时结束 API 与 Web）────────────────────────────────
echo "[2/3] 启动 API(:${API_PORT}) + Web(:5173) ..."
echo "      停止请在本窗口按 Ctrl+C（不要用 taskkill 强杀 node）"
echo
# 后台延时打开浏览器（兼容 Windows Git Bash / macOS / Linux）
(
  sleep 8
  if command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "http://localhost:5173" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:5173" >/dev/null 2>&1
  elif command -v open >/dev/null 2>&1; then
    open "http://localhost:5173" >/dev/null 2>&1
  fi
) >/dev/null 2>&1 &

echo "[3/3] 访问 http://localhost:5173 （API 健康检查 http://localhost:${API_PORT}/health）"
echo
exec npm run dev
