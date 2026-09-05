@echo off
setlocal
cd /d "%~dp0"
title XDU Course Picker

rem NOTE: keep this file ASCII-only and CRLF. Do NOT add Chinese echo lines here --
rem cmd garbles UTF-8 batch files (parser loses byte sync, lines get cut mid-token).
rem All Chinese text is printed by node instead (console API, codepage-independent).

rem ---------- Find Node.js: prefer portable runtime\node.exe, then system PATH ----------
set "NODE_EXE="
if exist "runtime\node.exe" set "NODE_EXE=runtime\node.exe"
if not defined NODE_EXE (
  where node >nul 2>&1
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo.
  echo  Node.js was not found on this computer.
  echo  Ask the sender to put the official node.exe into the runtime\ folder,
  echo  or download and install the LTS version from https://nodejs.org
  echo  See runtime\README.txt for details.
  echo.
  pause
  exit /b 1
)

rem ---------- Banner (Chinese, printed by node) ----------
"%NODE_EXE%" configure.js --banner

rem ---------- Dependencies: skip if bundled, otherwise best-effort install ----------
if not exist "node_modules" (
  where npm >nul 2>&1
  if not errorlevel 1 (
    echo.
    echo  [First run] Installing dependencies, please wait...
    call npm install
    if errorlevel 1 (
      echo.
      echo  Dependency installation failed. Check your network and double-click this file again.
      pause
      exit /b 1
    )
  ) else (
    echo.
    echo  node_modules is missing and npm is not available.
    echo  Ask the sender to include the node_modules folder.
    pause
    exit /b 1
  )
)

rem ---------- First-run wizard: skipped when courses are already configured ----------
call "%NODE_EXE%" configure.js --check
if errorlevel 1 (
  echo.
  echo  [First run] Course wizard: login in the browser, then pick courses by number.
  call "%NODE_EXE%" configure.js
  if errorlevel 1 (
    echo.
    echo  Configuration was not finished. Please double-click this file again.
    pause
    exit /b 1
  )
)

echo.
echo  Starting. The browser will open - please log in and type the captcha manually.
echo  (Keep this window open and watch the log)
call "%NODE_EXE%" select.js
echo.
pause
endlocal
