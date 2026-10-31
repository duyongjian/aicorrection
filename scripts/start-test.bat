@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
REM ============================================================================
REM  错题强化闭环 · 一键启动【真实大模型模式 · 非 mock】   (Windows CMD 双击运行)
REM
REM  设计原则（严格对齐要求）：
REM   1. 本脚本【不启动任何大模型服务】——llama.cpp / Ollama 请自行在外部启动。
REM   2. 【绝不 mock】——强制 AUTO_FALLBACK_TO_MOCK=false，且不覆盖 LLM_PROVIDER，
REM      沿用 .env 策略直连真实服务。依据 src/services/llm/index.ts:23：
REM      LLM_PROVIDER 不等于 'mock' 即走真实 OllamaProvider（OpenAI 兼容客户端）。
REM   3. 启动前预检真实服务端点；未就绪只告警，【不降级、不 mock】。
REM
REM  停止：在本窗口按 Ctrl+C（不要用 taskkill 强杀 node，会误杀其他 Node 程序）
REM ============================================================================

cd /d "%~dp0.."

REM ── 读取 .env 中的真实服务地址（只取 URL，不碰任何密钥）────────────────────
set "ANALYSIS_URL=http://localhost:8085/v1"
set "RECOG_URL=http://localhost:8090/v1"
set "API_PORT=3001"
set "ANALYSIS_MODEL="
set "LLM_MODEL="
set "LLM_PROVIDER="

for /f "usebackq tokens=1,2 delims==" %%A in (`findstr /B "ANALYSIS_BASE_URL=" apps\api\.env 2^>nul`) do (
  for /f "tokens=1 delims=#" %%C in ("%%B") do set "ANALYSIS_URL=%%C"
)
for /f "usebackq tokens=1,2 delims==" %%A in (`findstr /B "LLM_BASE_URL=" apps\api\.env 2^>nul`) do (
  for /f "tokens=1 delims=#" %%C in ("%%B") do set "RECOG_URL=%%C"
)
for /f "usebackq tokens=1,2 delims==" %%A in (`findstr /B "PORT=" apps\api\.env 2^>nul`) do (
  for /f "tokens=1 delims=#" %%C in ("%%B") do set "API_PORT=%%C"
)
for /f "usebackq tokens=1,2 delims==" %%A in (`findstr /B "ANALYSIS_MODEL=" apps\api\.env 2^>nul`) do (
  for /f "tokens=1 delims=#" %%C in ("%%B") do set "ANALYSIS_MODEL=%%C"
)
for /f "usebackq tokens=1,2 delims==" %%A in (`findstr /B "LLM_MODEL=" apps\api\.env 2^>nul`) do (
  for /f "tokens=1 delims=#" %%C in ("%%B") do set "LLM_MODEL=%%C"
)
for /f "usebackq tokens=1,2 delims==" %%A in (`findstr /B "LLM_PROVIDER=" apps\api\.env 2^>nul`) do (
  for /f "tokens=1 delims=#" %%C in ("%%B") do set "LLM_PROVIDER=%%C"
)
REM 去掉可能残留的空格
set "ANALYSIS_URL=%ANALYSIS_URL: =%"
set "RECOG_URL=%RECOG_URL: =%"
set "API_PORT=%API_PORT: =%"

REM ── 强制关闭 mock 兜底（双保险）与自动拉起识别端 ───────────────────────────
set AUTO_FALLBACK_TO_MOCK=false
set RECOGNITION_AUTOSTART=false

echo ============================================================
echo   错题强化闭环 · 一键启动【真实大模型模式 · 非 mock】
echo ============================================================
echo.
echo   策略来源：apps\api\.env（脚本不覆盖模型地址，只做预检）
echo   provider  = %LLM_PROVIDER%
echo   识别端   = %LLM_MODEL%   @ %RECOG_URL%
echo   归因端   = %ANALYSIS_MODEL%   @ %ANALYSIS_URL%
echo   mock 兜底= 已强制关闭（AUTO_FALLBACK_TO_MOCK=false）
echo.

REM ── 预检真实服务（缺失只提示，绝不 mock 兜底）──────────────────────────────
echo [预检] 真实大模型服务（本脚本不负责启动它们）:
set MISSING=0
call :probe "归因/分析端 (ANALYSIS_BASE_URL)" "%ANALYSIS_URL%"
call :probe "识别/视觉端 (LLM_BASE_URL)"      "%RECOG_URL%"
if exist "D:\AllSideProject\AICorrection\.venv-ocr\Scripts\python.exe" (
  echo   [就绪]   本地 OCR 解释器  .venv-ocr
) else (
  echo   [未就绪] 本地 OCR 解释器（不存在；上传将走视觉大模型识别）
)
echo.

if "%MISSING%"=="0" (
  echo   全部真实服务就绪。
) else (
  echo   ⚠ 有 %MISSING% 个真实服务未就绪。本脚本【不会】降级为 mock，
  echo     仍会按 .env 策略直连真实服务；未就绪端点在调用时才报真实错误。
  echo     请自行在外部启动对应大模型服务（llama.cpp / Ollama）后重跑。
)
echo.

REM ── 构建共享包 ─────────────────────────────────────────────────────────────
echo [1/3] 构建 @aicorrection/shared ...
call npm run build:shared
if errorlevel 1 (
  echo shared 构建失败，已中止。
  pause
  exit /b 1
)
echo.

REM ── 启动 API + Web（前台；Ctrl+C 同时结束）──────────────────────────────────
echo [2/3] 启动 API(:%API_PORT%) + Web(:5173) ...
echo       停止请在本窗口按 Ctrl+C（不要 taskkill 强杀 node.exe）
echo.
REM 后台延时打开浏览器（8 秒后，等服务起来）
start "OpenBrowser" /MIN cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:5173"

echo [3/3] 访问 http://localhost:5173
echo       API 健康检查 http://localhost:%API_PORT%/health
echo.
call npm run dev

echo.
echo 服务已停止。
pause
exit /b 0

REM =============================== 子程序 ===============================
:probe
set "PNAME=%~1"
set "PURL=%~2"
set "PCODE=000"
REM --noproxy "*"：本机有 HTTP_PROXY(127.0.0.1:5209)，不绕过会把本地端口探测
REM 发给代理得到假 502，必须直连本机端口
for /f %%C in ('curl -s -o NUL -w "%%{http_code}" --noproxy "*" --max-time 3 "%PURL%/models" 2^>NUL') do set "PCODE=%%C"
if "%PCODE%"=="200" (
  echo   [就绪]   %PNAME%
  echo            %PURL%  (HTTP %PCODE%)
) else (
  echo   [未就绪] %PNAME%
  echo            %PURL%  (HTTP %PCODE%)
  set /a MISSING+=1
)
exit /b 0
