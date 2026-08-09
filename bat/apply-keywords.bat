@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  apply-keywords.bat —— 应用维护者确认的关键词提纯清单
rem
rem  用法：
rem   1. 双击本文件 → 自动找 data\manual\ 下的 keyword-refine.json
rem   2. 把 keyword-refine.json 拖到本文件图标上 → 应用该清单
rem
rem  仅幂等追加 adopted_keywords 到 news-config-v2.json；不发布、不构建 dist。
rem ============================================================

set "ROOT=%~dp0.."
cd /d "%ROOT%"

set "KEYWORD_FILE=%~1"
if not defined KEYWORD_FILE goto :find_latest
goto :run_apply

:find_latest
if exist "%ROOT%\data\manual\keyword-refine.json" (
  set "KEYWORD_FILE=%ROOT%\data\manual\keyword-refine.json"
  goto :run_apply
)
echo [错误] 未在 data\manual\ 找到 keyword-refine.json 清单。
echo        请先完成第一次审核并运行 bat\after-first-review.bat。
goto :end

:run_apply
echo ============================================================
echo   应用维护者确认的关键词
echo   清单：%KEYWORD_FILE%
echo ============================================================
node scripts\news-cli.js min-review refine-apply --file "%KEYWORD_FILE%"
if errorlevel 1 (
  echo.
  echo   [错误] 关键词清单未应用，请修正清单后重试。
  goto :end
)

echo.
echo   已完成。关键词仅用于后续采集；未发布热点，也未构建 dist。
echo   按任意键关闭窗口。
pause >nul
exit /b 0

:end
echo.
echo   按任意键关闭窗口。
pause >nul
exit /b 1
