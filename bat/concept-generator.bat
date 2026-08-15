@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "ROOT=%~dp0.."
cd /d "%ROOT%"
if not "%~1"=="" goto :run

echo ============================================================
echo   AI 概念库生成器 - 维护者操作入口
echo ============================================================
echo.
echo 指令说明：
echo   batch --file ^<待补概念卡.json^> --dry-run
echo     只查重 + 本地 approved 摘要证据 + 成本估算；零 AI 零网络，不写文件。
echo.
echo   batch --file ^<待补概念卡.json^> --confirm-cost
echo     抓 vibe-hub 补充证据 + DeepSeek 合成，写预览 data\manual\concept-previews.json；不写正式库。
echo.
echo   preview
echo     查看当前概念预览文件；只读。
echo.
echo   apply [--terms a,b]
echo     把预览写入正式 data\catalog\glossary.json；默认应用全部 pending，--terms 指定子集。
echo.
echo 注意：batch --confirm-cost 会产生 DeepSeek API 费用；apply 会修改正式 glossary.json，请先人工查看预览再执行。
echo      API Key 只从环境变量读取，不要写入文件。
echo.
set /p "ARGS=请输入指令及参数（直接回车退出）: "
if not defined ARGS exit /b 0
call :run %ARGS%
exit /b %errorlevel%

:run
node scripts\concept-generator.js %*
exit /b %errorlevel%
