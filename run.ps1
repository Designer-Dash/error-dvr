# run.ps1 - Launcher for Error-DVR
[CmdletBinding()]
param(
    [ValidateSet('start', 'test', 'e2e')]
    [string]$Mode = 'start'
)

$Host.UI.RawUI.WindowTitle = "Error-DVR Server"

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "   Error-DVR - Hardened Error Recorder and Replayer       " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Please install Node.js v22.5.0+ from https://nodejs.org/"
    exit 1
}

# Install dependencies if missing
if (-not (Test-Path "node_modules/express")) {
    Write-Host "[INFO] Installing required dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] npm install failed." -ForegroundColor Red
        exit 1
    }
}

switch ($Mode) {
    'test' {
        Write-Host "[INFO] Running security tests..." -ForegroundColor Green
        npm test
    }
    'e2e' {
        Write-Host "[INFO] Running browser E2E tests..." -ForegroundColor Green
        npm run test:e2e
    }
    'start' {
        Write-Host "[INFO] Starting Error-DVR server..." -ForegroundColor Green
        Write-Host "  * Dashboard: http://127.0.0.1:3000/" -ForegroundColor Cyan
        Write-Host "  * Demo page: http://127.0.0.1:3000/demo" -ForegroundColor Cyan
        Write-Host ""
        node src/server.js
    }
}
