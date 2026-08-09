@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  archive-min.bat —— 维护者确认当天收尾完成后归档并清空候选层
rem
rem  重要：请确认当天审核、关键词提纯、AI top 和必要发布动作
rem  已完成后再执行。本操作只保留 id/title 历史摘要，不能恢复详情。
rem ============================================================

set "ROOT=%~dp0.."
cd /d "%ROOT%"

echo ============================================================
echo   警告：此操作会归档并清空当前 min-candidates.json
echo   请确认当天审核、关键词提纯、AI top 和必要发布动作均已完成。
echo   历史只保留每条信息的 id 和 title，不能恢复完整内容。
echo ============================================================
set /p "CONFIRM=确认继续？请输入 Y 或 N："
if /I not "%CONFIRM%"=="Y" goto :cancel

:run
node scripts\news-cli.js min-review archive --store min
if errorlevel 1 (
  echo.
  echo   [错误] 归档失败，当前候选未确认清空，请检查上方原因。
  pause
  exit /b 1
)
echo.
echo   归档完成。
pause
exit /b 0

:cancel
echo.
echo   已取消，未修改任何数据。
pause
exit /b 0
