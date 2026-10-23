@echo off
setlocal enabledelayedexpansion
title Error-DVR Server

echo =========================================================
echo    Error-DVR - Hardened Error Recorder and Replayer
echo =========================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js v22.5.0 or higher from https://nodejs.org/
    pause
    exit /b 1
)

:: Ensure dependencies are installed
if not exist "node_modules\express" (
    echo [INFO] Installing required dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install npm dependencies.
        pause
        exit /b 1
    )
)

:: Handle command-line arguments
if "%1"=="test" (
    echo [INFO] Running security regression tests...
    call npm test
    goto end
)

if "%1"=="e2e" (
    echo [INFO] Running headless browser E2E tests...
    call npm run test:e2e
    goto end
)

echo [INFO] Starting Error-DVR server...
echo.
echo   * Dashboard: http://127.0.0.1:3000/
echo   * Demo page: http://127.0.0.1:3000/demo
echo.
echo Press Ctrl+C in this window to stop the server.
echo.

node src/server.js

:end
pause
