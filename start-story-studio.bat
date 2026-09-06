@echo off
setlocal

rem ============================================================
rem  Story Studio one-click launcher
rem  First run: install deps -> start dev server -> open browser.
rem  The project root is the folder this .bat lives in (copy the whole folder together).
rem ============================================================

set "APP_DIR=%~dp0"
if not exist "%APP_DIR%\package.json" (
  echo [ERROR] story-studio project not found next to this .bat. Keep this file inside the project root.
  pause
  exit /b 1
)
cd /d "%APP_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Install Node.js 18+ first.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [First run] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

rem Already running? Just open the browser.
netstat -ano | findstr ":5199" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [INFO] Story Studio already running on port 5199. Opening browser...
  start "" "http://localhost:5199/"
  exit /b 0
)

echo.
echo   Starting Story Studio at  http://localhost:5199/
echo   (This window IS the server. Close it or press Ctrl+C to stop.)
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5199/"
call npm run dev -- --port 5199 --strictPort
pause
