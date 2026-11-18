@echo off
setlocal EnableExtensions

set "LOG=%~dp0start-dev.log"
call :step "launched at %DATE% %TIME%"

cd /d D:\AllSideProject\AICorrection\aicorrection-v0.1
if errorlevel 1 (
  call :step "ERROR: cd to repo failed"
  goto :showlog
)
call :step "cd ok: %CD%"

REM Free ports 3001/5173 in case a previous run left an orphan process (avoids "port in use")
powershell -NoProfile -Command "foreach($pt in @(3001,5173)){ $c=Get-NetTCPConnection -LocalPort $pt -ErrorAction SilentlyContinue; foreach($x in $c){ if($x.OwningProcess -ne 0){ taskkill.exe /T /F /PID $x.OwningProcess 2>$null } } }" >nul 2>&1
call :step "freed ports 3001/5173 if previously occupied"

set "NODE22=C:\Users\ASUS\.workbuddy\binaries\node\versions\22.22.2-6"
call :step "NODE22=%NODE22%"
if not exist "%NODE22%\node.exe" (
  call :step "ERROR: built-in Node22 not found"
  goto :showlog
)
set "PATH=%NODE22%;%PATH%"

for /f "delims=" %%v in ('"%NODE22%\node.exe" -v 2^>nul') do set "NODEVER=%%v"
call :step "node version=%NODEVER%"

if exist apps\api\.env.local.bak if not exist apps\api\.env.local (
  move /Y apps\api\.env.local.bak apps\api\.env.local >nul
  call :step "restored leftover .env.local"
)
if exist apps\api\.env.local (
  move /Y apps\api\.env.local apps\api\.env.local.bak >nul
  call :step "moved .env.local -> .bak (restored on exit)"
)

set "AICORRECTION_DB_PATH=%CD%\apps\api\data\e2e_isolated.db"
set "LICENSE_GATE_ENABLED=false"
set "ANALYSIS_BASE_URL=http://localhost:8094/v1"
set "ANALYSIS_MODEL=Qwen3.8-27B-IQ2XS"
set "ANALYSIS_API_KEY=ollama"
set "LLM_BASE_URL=http://localhost:8094/v1"
set "LLM_MODEL=Qwen3.8-27B-IQ2XS"
set "LLM_API_KEY=ollama"
set "VISION_BASE_URL=http://localhost:8090/v1"
set "NO_COLOR=1"
set "FORCE_COLOR=0"
call :step "env injected: attribution->8094 Qwen3.8-27B, gate off, isolated db"

echo.
echo ==============================================================
echo  Dev environment is STARTING. KEEP THIS WINDOW OPEN.
echo  API : http://localhost:3001/health   (expect ok:true)
echo  Web : http://localhost:5173/
echo  To stop: close this window or Ctrl-C (.env.local auto-restored)
echo ==============================================================
echo.

call npm run dev
call :step "npm run dev returned code %ERRORLEVEL%"

if exist apps\api\.env.local.bak (
  move /Y apps\api\.env.local.bak apps\api\.env.local >nul
  call :step "restored .env.local"
)
call :step "exited."

:showlog
echo.
echo  Log saved to: %LOG%
echo  Press any key to close this window.
pause >nul
endlocal
goto :eof

:step
echo [start-dev] %~1
echo [start-dev] %~1 >> "%LOG%"
goto :eof
