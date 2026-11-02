@echo off
REM ============================================================================
REM  AiCorrection - One-click Startup (Windows double-click)
REM
REM  This wrapper does NOT start any LLM services - start llama.cpp / Ollama
REM  externally first. It delegates to scripts/start-test.mjs (pure Node),
REM  which avoids both CMD codepage issues and the WSL network-namespace trap
REM  (PowerShell resolves `bash` to C:\Windows\System32\bash.exe, whose
REM  localhost is NOT the Windows host, making probes fail with HTTP 000).
REM
REM  Stop: Press Ctrl+C in this window.
REM ============================================================================
cd /d "%~dp0.."
node scripts\start-test.mjs %*
if errorlevel 1 pause
