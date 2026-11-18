# ============================================================================
# 错题强化闭环 · 一键启动（Mock 模式，无需大模型）
# 适用：PowerShell 5.1+ / pwsh
# Git Bash 请用 scripts/dev.sh；Windows CMD 请用 scripts/dev.bat
# ============================================================================
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir   = Join-Path $scriptDir '..'

Set-Location $rootDir

Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  错题强化闭环 · 本地开发环境（Mock）' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '  API server : http://localhost:3001'
Write-Host '  Web client : http://localhost:5173'
Write-Host ''
Write-Host '  模式：LLM_PROVIDER=mock  （无需 Ollama / MiniCPM）'
Write-Host '  OCR    ：本地 quick-test 模式（跳过图片识别）'
Write-Host '  搜索   ：关闭（避免网络请求）'
Write-Host ''

# ── 1. 构建 shared 包 ────────────────────────────────────────────────────────
Write-Host '[1/4] 构建 @aicorrection/shared …' -ForegroundColor Yellow
npm run build:shared

# ── 2. 环境覆盖（Mock 专用） ─────────────────────────────────────────────────
$env:LLM_PROVIDER    = 'mock'
$env:OCR_MODE        = 'llm'
$env:WEB_SEARCH_ENABLED = 'false'

# ── 3. 并发启动 API + Web ────────────────────────────────────────────────────
Write-Host '[2/4] 启动 API 与 Web 开发服务器（Ctrl+C 同时退出）…' -ForegroundColor Yellow
Write-Host ''

& node node_modules/.bin/concurrently `
    --names 'API' --prefix-colors 'green.bold' `
    --names 'WEB' --prefix-colors 'blue.bold' `
    'npm:dev:api' 'npm:dev:web'

Write-Host ''
Write-Host '全部进程已退出。' -ForegroundColor Green
