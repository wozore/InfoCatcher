@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "ROOT=%~dp0.."
pushd "%ROOT%"
if not "%~1"=="" goto :run

:menu
cls
echo 工具更新审核维护入口
echo.
echo 1. 环境检查（GitHub / Tavily；AI fallback 可选）
echo 2. 确定性扫描并生成待审核队列
echo 3. 打开审核 JSON
echo 4. 预览 approved 日期变更
echo 5. Apply approved 日期变更
echo 6. 混合扫描（歧义项使用 AI fallback）
echo 0. 退出
echo.
set /p "CHOICE=请选择："
if "%CHOICE%"=="1" goto :preflight
if "%CHOICE%"=="2" goto :scan
if "%CHOICE%"=="3" goto :open
if "%CHOICE%"=="4" goto :preview
if "%CHOICE%"=="5" goto :apply
if "%CHOICE%"=="6" goto :hybrid
if "%CHOICE%"=="0" goto :done
goto :menu

:preflight
node scripts\tool-update-review.js preflight --mode deterministic --tavily-access-mode keyless
pause
goto :menu

:scan
node scripts\tool-update-review.js scan --mode deterministic --tavily-access-mode keyless
pause
goto :menu

:hybrid
node scripts\tool-update-review.js scan --mode hybrid --tavily-access-mode keyless
pause
goto :menu

:open
start "" notepad "%ROOT%\data\manual\tools\tool-update-review.json"
goto :menu

:preview
node scripts\tool-update-review.js preview
pause
goto :menu

:apply
set /p "EXPECTED_REVISION=请输入 preview 输出的 expected revision："
set /p "PREVIEW_HASH=请输入 preview 输出的 preview hash："
node scripts\tool-update-review.js apply --expected-revision "%EXPECTED_REVISION%" --preview-hash "%PREVIEW_HASH%"
pause
goto :menu

:run
node scripts\tool-update-review.js %*
set "EXIT_CODE=%errorlevel%"
popd
exit /b %EXIT_CODE%

:done
popd
exit /b 0
