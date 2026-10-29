@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ================================================================
rem  CS2 Buy Helper - 本地 GSI 接收器
rem  用法：双击本文件（或桌面的快捷方式）。保持这个黑窗口开着，别关。
rem
rem  !! 重要 !!
rem  不要把 start.bat 单独复制到桌面或其他地方 ——
rem  它必须和 server.js / lib / public 待在同一个文件夹里。
rem  桌面上的「CS2购买助手.bat」就是干这个的，直接双击那个就行。
rem ================================================================

set "PORT=31982"
set "PROJDIR=%~dp0"

rem ---------- 0) 自检：确认自己待在正确的文件夹 ----------
rem （发生过的事故：start.bat 被复制到桌面 -> cd 到桌面 -> 找不到
rem   server.js -> node 立刻退出，但浏览器照样被打开 -> "连接被拒绝"）
if not exist "%PROJDIR%server.js" goto wrongfolder

rem ---------- 1) 找 node ----------
set "NODE="

rem 1a) PATH 里的 node（跳过 Microsoft Store 的占位假 node）
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE (
    echo %%i | find /i "WindowsApps" >nul || set "NODE=%%i"
  )
)

rem 1b) WorkBuddy 自带 node：读 versions\current 指向的版本。
rem     不把版本号写死在这里，WorkBuddy 升级 node 后脚本照样能用
set "NODEBASE=%USERPROFILE%\.workbuddy\binaries\node\versions"
set "CURVER="
if not defined NODE if exist "%NODEBASE%\current" set /p CURVER=<"%NODEBASE%\current"
if not defined NODE if exist "%NODEBASE%\%CURVER%\node.exe" set "NODE=%NODEBASE%\%CURVER%\node.exe"

rem 1c) 兜底：扫 versions 下任何一个能用的版本
if not defined NODE for /d %%d in ("%NODEBASE%\*") do (
  if not defined NODE if exist "%%~fd\node.exe" set "NODE=%%~fd\node.exe"
)

if not defined NODE goto nonode

rem ---------- 2) 端口检查：服务已经在跑就别重复启动 ----------
set "RUNNING="
netstat -ano 2>nul | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 set "RUNNING=1"

if defined RUNNING (
  echo.
  echo   服务已经在运行了，直接把界面打开。
  echo   地址: http://127.0.0.1:%PORT%/
  echo.
  echo   想重启服务：先关掉原来那个黑窗口，再双击一次。
  echo.
  start "" "http://127.0.0.1:%PORT%/"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

rem ---------- 3) 启动 ----------
echo.
echo   CS2 Buy Helper - 本地 GSI 接收器
echo   ------------------------------------------
echo   地址   http://127.0.0.1:%PORT%/
echo   Node   %NODE%
echo   目录   %PROJDIR%
echo.
echo   保持这个窗口开着；按 Ctrl+C 或直接关窗口即可停止。
echo   页面会在服务就绪后自动打开。
echo   ------------------------------------------
echo.

rem 让服务端自己在监听成功后打开浏览器。
rem 以前是这里盲等 2 秒再开浏览器，服务一旦没起来，
rem 就会出现"浏览器开了但连接被拒绝"这种让人摸不着头脑的情况。
set "CS2BH_OPEN=1"
"%NODE%" server.js
set "CS2BH_OPEN="

echo.
echo   服务已停止。
pause
exit /b 0

:wrongfolder
echo.
echo   [错误] 这个 start.bat 旁边没有 server.js。
echo.
echo   你现在运行的位置: %PROJDIR%
echo.
echo   原因：start.bat 被单独复制到了别的地方（比如桌面），
echo         它找不到自己要启动的 server.js，所以服务从来没起来过，
echo         浏览器自然显示"连接被拒绝"。
echo.
echo   正确做法：
echo     1. 进入 cs2-buy-helper 文件夹，直接双击里面的 start.bat；或
echo     2. 双击桌面上的「CS2购买助手.bat」启动器。
echo.
pause
exit /b 1

:nonode
echo.
echo   [错误] 没找到 Node.js。
echo.
echo   去装一个：https://nodejs.org   （LTS 版，一路下一步）
echo   装完以后重新双击这个文件。
echo.
pause
exit /b 1
