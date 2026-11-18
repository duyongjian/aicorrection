@echo off
REM ============================================================================
REM  错题强化闭环 · 一键启动（Mock 模式，无需大模型）
REM  适用：Windows CMD
REM  PowerShell 请用 scripts/dev.ps1；Git Bash 请用 scripts/dev.sh
REM ============================================================================
setlocal EnableDelayedExpansion

cd /d "%~dp0.."

echo ==========================================
echo   错题强化闭环 · 本地开发环境（Mock）
echo ==========================================
echo.
echo   API server : http://localhost:3001
echo   Web client : http://localhost:5173
echo.
echo   模式：LLM_PROVIDER=mock  （无需 Ollama / MiniCPM）
echo   OCR    ：本地 quick-test 模式（跳过图片识别）
echo   搜索   ：关闭（避免网络请求）
echo.

REM ── 1. 构建 shared 包 ───────────────────────────────────────────────────────
echo [1/4] 构建 @aicorrection/shared ...
call npm run build:shared

REM ── 2. 环境覆盖（Mock 专用） ────────────────────────────────────────────────
set LLM_PROVIDER=mock
set OCR_MODE=llm
set WEB_SEARCH_ENABLED=false

REM ── 3. 并发启动 API + Web ───────────────────────────────────────────────────
echo [2/4] 启动 API 与 Web 开发服务器 (Ctrl+C 同时退出) ...
echo.

REM PowerShell one-liner：并行启动两个 npm script，任一退出则同时终止另一个
powershell -NoProfile -Command ^
  "$pApi = Start-Process -FilePath 'node' -ArgumentList 'node_modules/.bin/concurrently --names API --prefix-colors green.bold --names WEB --prefix-colors blue.bold npm:dev:api npm:dev:web' -PassThru -WindowStyle Normal; ^
   Write-Host 'Press Ctrl+C to stop all'; ^
   $pApi.WaitForExit(); ^
   taskkill /F /IM node.exe /T 2>nul"

echo.
echo 全部进程已退出。
pause
