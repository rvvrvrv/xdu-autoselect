@echo off
setlocal
chcp 65001 >nul 2>&1
title 西电选课助手 - 一键启动
cd /d "%~dp0"

rem ---------- 找 Node：优先便携 runtime\node.exe，其次系统 PATH ----------
set "NODE_EXE="
if exist "runtime\node.exe" set "NODE_EXE=runtime\node.exe"
if not defined NODE_EXE (
  where node >nul 2>&1
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo.
  echo  本机未检测到 Node.js。
  echo  请让分享者把官方 node.exe 放到本文件夹 runtime\ 目录；
  echo  或到 https://nodejs.org 下载 LTS 版并安装。
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   西电选课助手
echo   - 首次运行会弹出问答，按提示填你的课程
echo   - 到点后浏览器弹出，人工输验证码即可
echo   - 其余自动完成
echo ============================================

rem ---------- 依赖：依赖已随包提供则跳过；否则尽力安装 ----------
if not exist "node_modules" (
  where npm >nul 2>&1
  if not errorlevel 1 (
    echo.
    echo  [首次] 正在安装依赖，请稍候...
    call npm install
    if errorlevel 1 (
      echo.
      echo  依赖安装失败。请检查网络后重新双击本脚本。
      pause
      exit /b 1
    )
  ) else (
    echo.
    echo  缺少依赖 node_modules，且本机无 npm。
    echo  请让分享者补全 node_modules 后重新发送。
    pause
    exit /b 1
  )
)

rem ---------- 首次配置：已填课程则跳过向导 ----------
call "%NODE_EXE%" configure.js --check
if errorlevel 1 (
  echo.
  echo  [首次配置] 请填写你的课程...
  call "%NODE_EXE%" configure.js
  if errorlevel 1 (
    echo.
    echo  配置未完成，请重新双击运行。
    pause
    exit /b 1
  )
)

echo.
echo  开始抢课。浏览器弹出后请人工登录 + 输验证码。
echo  (本窗口请勿关闭，看日志即可)
call "%NODE_EXE%" select.js
echo.
pause
endlocal
