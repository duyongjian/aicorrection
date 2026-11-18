#!/usr/bin/env bash
# ============================================================================
# AICorrection 本地开发一键启动（后端 API）
#
# 做了什么（全部只靠"启动参数 + 临时挪开 .env.local"，不改任何生产代码/密钥）：
#   1. 归因/分析模型切到 8094 端口的 Qwen3.8-27B-IQ2XS（不再用 ollama 11434）
#   2. 临时关闭许可证闸门 LICENSE_GATE_ENABLED，让本地能直接建账户/上传/归因
#      —— 做法：把 apps/api/.env.local 临时改名 .env.local.bak，
#         因为它用 override:true 锁死了闸门，命令行变量压不过它。
#         脚本退出（Ctrl-C / kill）时通过 trap 自动恢复原文件名。
#   3. 用 AICORRECTION_DB_PATH 指向隔离库，绝不碰那 335MB 生产库。
#
# 用法：
#   bash scripts/start-dev.sh          # 前台启动，日志可见，Ctrl-C 停止
#   另开终端： curl http://localhost:3001/health   # 看到 ok:true 即就绪
#            npm run smoke                       # 跑端到端冒烟
#   想要前端界面：再开一个终端 npm run dev:web
# ============================================================================
set -u

# 锁定 Node 22：node_modules 里的 better-sqlite3 是按 ABI 127 / Node22 预编译的，
# 你 MINGW64 默认 Node 要求 141，直接跑会 DLL 加载失败（即之前 start-dev.sh 崩的根因）。
# 与 start-dev.bat 保持一致，强制用 WorkBuddy 自带的 Node 22。
NODE22_BIN="/c/Users/ASUS/.workbuddy/binaries/node/versions/22.22.2-6"
if [ -d "$NODE22_BIN" ]; then export PATH="$NODE22_BIN:$PATH"; fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$REPO/apps/api"
ENVLOCAL="$API_DIR/.env.local"
BAK="$ENVLOCAL.bak"
API_PID=""

# 安全网：若上次异常退出留下 .bak 而 .env.local 不在，先恢复，绝不丢配置
if [ -f "$BAK" ] && [ ! -f "$ENVLOCAL" ]; then
  mv -f "$BAK" "$ENVLOCAL"
  echo "[start-dev] 已恢复上次遗留的 $ENVLOCAL"
fi

cleanup() {
  # 恢复 .env.local（若本轮被挪开且尚未恢复）
  if [ -f "$BAK" ] && [ ! -f "$ENVLOCAL" ]; then
    mv -f "$BAK" "$ENVLOCAL"
    echo "[start-dev] 已恢复 $ENVLOCAL"
  fi
  # 关停本次启动的 api
  if [ -n "$API_PID" ]; then kill "$API_PID" 2>/dev/null; fi
  pkill -f "tsx src/index.ts" 2>/dev/null
}
# EXIT/INT/TERM 都走 cleanup，确保 .env.local 一定还原
trap cleanup EXIT INT TERM

# 临时挪开 .env.local（override:true 会锁死 LICENSE_GATE_ENABLED）
if [ -f "$ENVLOCAL" ]; then
  mv -f "$ENVLOCAL" "$BAK"
  echo "[start-dev] 临时挪开 $ENVLOCAL -> .env.local.bak（退出时恢复）"
fi

# —— 全部用启动参数注入，不写任何密钥文件 ——
export AICORRECTION_DB_PATH="$API_DIR/data/e2e_isolated.db"
export LICENSE_GATE_ENABLED=false
export ANALYSIS_BASE_URL="http://localhost:8094/v1"
export ANALYSIS_MODEL="Qwen3.8-27B-IQ2XS"
export ANALYSIS_API_KEY="ollama"
export LLM_BASE_URL="http://localhost:8094/v1"
export LLM_MODEL="Qwen3.8-27B-IQ2XS"
export LLM_API_KEY="ollama"
export VISION_BASE_URL="http://localhost:8090/v1"

cd "$REPO"
echo "[start-dev] 编译共享包（build:shared）..."
npm run build:shared

cd "$API_DIR"
echo "[start-dev] 启动 API：归因走 8094 / 闸门临时关闭 / 隔离库 $AICORRECTION_DB_PATH"
echo "[start-dev] 健康检查： curl http://localhost:3001/health   （看到 ok:true 即就绪）"
echo "[start-dev] 停止：Ctrl-C（或 kill 本进程），.env.local 会自动恢复"
# 后台拉起 api 并 wait：wait 可被信号中断并可靠触发 trap（前台阻塞等价行为）
npx tsx src/index.ts &
API_PID=$!
wait "$API_PID"
