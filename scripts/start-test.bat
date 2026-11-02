@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
REM ============================================================================
REM  AiCorrection - One-click Startup Script (Real LLM Mode)
REM
REM  Design Principles:
REM   1. This script does NOT start any LLM services - please start llama.cpp / Ollama externally.
REM   2. NO mock fallback - forces AUTO_FALLBACK_TO_MOCK=false.
REM   3. Pre-checks real service endpoints; warns if unavailable, does NOT downgrade.
REM
REM  Stop: Press Ctrl+C in this window (do not use taskkill)
REM ============================================================================

cd /d "%~dp0.."

REM ── Read service URLs from .env (only URLs, no secrets) ─────────────────────
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
REM Remove possible spaces
set "ANALYSIS_URL=%ANALYSIS_URL: =%"
set "RECOG_URL=%RECOG_URL: =%"
set "API_PORT=%API_PORT: =%"

REM ── Force disable mock fallback and auto-start recognition ───────────────────
set AUTO_FALLBACK_TO_MOCK=false
set RECOGNITION_AUTOSTART=false

echo ============================================================
echo   AiCorrection - Startup Script (Real LLM Mode, No Mock)
echo ============================================================
echo.
echo   Config source: apps\api\.env (script only checks, does not override)
echo   provider  = %LLM_PROVIDER%
echo   Recog URL = %RECOG_URL%
echo   Analysis URL = %ANALYSIS_URL%
echo   Mock fallback = DISABLED (AUTO_FALLBACK_TO_MOCK=false)
echo.

REM ── Pre-check real services (warn only, no mock fallback) ────────────────────
echo [Pre-check] Real LLM services (script does not start them):
set MISSING=0
call :probe "Analysis Endpoint" "%ANALYSIS_URL%"
call :probe "Recognition Endpoint" "%RECOG_URL%"
if exist "D:\AllSideProject\AICorrection\.venv-ocr\Scripts\python.exe" (
  echo   [OK]     Local OCR interpreter (.venv-ocr)
) else (
  echo   [MISSING] Local OCR interpreter (not found; will use vision LLM for upload)
)
echo.

if "%MISSING%"=="0" (
  echo   All real services are ready.
) else (
  echo   [WARN] %MISSING% real service(s) not ready. Script will NOT downgrade to mock,
  echo     will connect to real services per .env config; errors will occur at call time.
  echo     Please start corresponding LLM services (llama.cpp / Ollama) externally and retry.
)
echo.

REM ── Build shared package ────────────────────────────────────────────────────
echo [1/3] Building @aicorrection/shared ...
call npm run build:shared
if errorlevel 1 (
  echo Shared build failed, aborting.
  pause
  exit /b 1
)
echo.

REM ── Start API + Web (foreground; Ctrl+C stops both) ─────────────────────────
echo [2/3] Starting API(:%API_PORT%) + Web(:5173) ...
echo       Press Ctrl+C to stop (do not use taskkill on node.exe)
echo.
REM Open browser in background after 8 seconds (wait for services to start)
start "OpenBrowser" /MIN cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:5173"

echo [3/3] Visit http://localhost:5173
echo       API health check: http://localhost:%API_PORT%/health
echo.
call npm run dev

echo.
echo Services stopped.
pause
exit /b 0

REM =============================== Subroutines ===============================
:probe
set "PNAME=%~1"
set "PURL=%~2"
set "PCODE=000"
REM --noproxy "*": Local HTTP_PROXY(127.0.0.1:5209) would hijack localhost probes
REM and return fake 502, must connect directly to local port
for /f %%C in ('curl -s -o NUL -w "%%{http_code}" --noproxy "*" --max-time 3 "%PURL%/models" 2^>NUL') do set "PCODE=%%C"
if "%PCODE%"=="200" (
  echo   [READY]  %PNAME%
  echo            %PURL%  (HTTP %PCODE%)
) else (
  echo   [NOT READY] %PNAME%
  echo            %PURL%  (HTTP %PCODE%)
  set /a MISSING+=1
)
exit /b 0
