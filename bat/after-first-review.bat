@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  after-first-review.bat —— 第一次人工审核后应用结论并生成后续清单
rem
rem  用法：
rem   1. 双击本文件          → 自动找 data\manual\ 下的 review.json 并应用
rem   2. 把 review.json 拖到本文件图标上 → 应用该清单
rem
rem  内部执行：
rem   第 1 步 串行应用第一次人工审核结论
rem   第 2 步 并行生成 keyword-refine 与 top 清单；任一失败则整体失败
rem ============================================================

set "ROOT=%~dp0.."
cd /d "%ROOT%"

set "REVIEW_FILE=%~1"
if not defined REVIEW_FILE goto :find_latest
goto :run_apply

:find_latest
if exist "%ROOT%\data\manual\review.json" (
  set "REVIEW_FILE=%ROOT%\data\manual\review.json"
  goto :run_apply
)
echo [错误] 未在 data\manual\ 找到 review.json 清单。
echo        请先运行采集管线（node scripts\build-news.js）自动生成待审清单。
goto :end

:run_apply
echo ============================================================
echo   第 1 步：应用第一次人工审核结论
echo   清单：%REVIEW_FILE%
echo ============================================================
node scripts\news-cli.js min-review apply --file "%REVIEW_FILE%"
if errorlevel 1 (
  echo.
  echo   [错误] 审核结论应用失败，已停止；不会生成关键词或 top 清单。
  goto :end
)

echo.
echo ============================================================
echo   第 2 步：并行生成关键词提纯和 AI top 清单
echo   任一任务失败会停止本次启动的另一任务，并以失败结束。
echo ============================================================
node scripts\run-after-first-review.js
if errorlevel 1 (
  echo.
  echo   [错误] 后续清单生成失败，请查看上方原因；不可将部分产物视为整体完成。
  goto :end
)

echo.
echo   全部完成。下一步：
echo   1. 编辑 data\manual\keyword-refine.json 的 adopted_keywords 后，运行 bat\apply-keywords.bat
echo   2. 编辑 data\manual\top.json 的 top_selected 后，运行 bat\apply-top.bat
echo   按任意键关闭窗口。
pause >nul
exit /b 0

:end
echo.
echo   按任意键关闭窗口。
pause >nul
exit /b 1
