@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  apply-top.bat —— 一键应用 top 清单 + 重建前端（维护者入口）
rem
rem  用法：
rem   1. 双击本文件          → 自动找 data\manual\ 下最新的 top-*.json 并应用
rem   2. 把 top-*.json 拖到本文件图标上 → 应用该清单
rem
rem  内部执行（两步连续，均失败即停）：
rem   第 1 步 node scripts\news-cli.js min-review top-apply --file <清单>
rem           （读清单里 top_selected=true 的条目，批量置候选层 top_selected=true）
rem   第 2 步 node scripts\publish-news.js
rem           （从候选层 approved && top_selected 重建 hotspots.json + RSS，显示到前端）
rem ============================================================

rem 定位项目根目录：本文件在 bat\ 子目录，%~dp0 为 bat\，上一级即项目根。
set "ROOT=%~dp0.."
cd /d "%ROOT%"

rem 拖拽清单到图标 → %~1 为文件路径；无参数 → 找 data\manual\ 最新 top-*.json
set "TOP_FILE=%~1"
if not defined TOP_FILE goto :find_latest
goto :run_apply

:find_latest
for /f "delims=" %%f in ('dir /b /o-d "%ROOT%\data\manual\top-*.json" 2^>nul') do (
  set "TOP_FILE=%ROOT%\data\manual\%%f"
  goto :run_apply
)
echo [错误] 未在 data\manual\ 找到 top-*.json 清单。
echo        请先运行 min-review ai-top（或 bat\apply-review.bat 第 2 步）生成 top 清单。
goto :end

:run_apply
echo ============================================================
echo   第 1 步：应用 top 清单（top_selected=true 写回候选层）
echo   清单：%TOP_FILE%
echo ============================================================
node scripts\news-cli.js min-review top-apply --file "%TOP_FILE%"
if errorlevel 1 (
  echo.
  echo   [错误] 第 1 步应用失败，已停止（不重建前端）。
  goto :end
)

echo.
echo ============================================================
echo   第 2 步：重建公开投影 + RSS（显示到前端）
echo ============================================================
node scripts\publish-news.js
if errorlevel 1 (
  echo.
  echo   [错误] 第 2 步重建失败，请查看上方原因。
  goto :end
)

echo.
echo   全部完成。已把 top_selected=true 的消息重建到前端（hotspots.json + feed.xml）。
echo   按任意键关闭窗口。
pause >nul
exit /b 0

:end
echo.
echo   按任意键关闭窗口。
pause >nul
exit /b 1
