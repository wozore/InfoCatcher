@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  apply-review.bat —— 一键应用人工审核结论 + 生成 top 名单（维护者入口）
rem
rem  用法：
rem   1. 双击本文件          → 自动找 data\manual\ 下最新的 review-*.json 并应用
rem   2. 把 review-*.json 拖到本文件图标上 → 应用该清单
rem
rem  内部执行（两步连续，均失败即停）：
rem   第 1 步 node scripts\news-cli.js min-review apply --file <清单>
rem           （读清单里 approved/discarded 结论批量写回 min-candidates.json，pending 跳过）
rem   第 2 步 node scripts\news-cli.js min-review ai-top
rem           （从 approved 候选调 AI 生成 top-<date>.json，供维护者二次审核；
rem             失败情形：无 approved / 缺 last-run.json / 缺 DEEPSEEK_API_KEY）
rem ============================================================

rem 定位项目根目录：本文件在 bat\ 子目录，%~dp0 为 bat\，上一级即项目根。
rem （双击/拖拽时 %~dp0 均为本文件所在目录，不受"当前目录"影响）
set "ROOT=%~dp0.."
cd /d "%ROOT%"

rem 拖拽清单到图标 → %~1 为文件路径；无参数 → 找 data\manual\ 最新 review-*.json
set "REVIEW_FILE=%~1"
if not defined REVIEW_FILE goto :find_latest
goto :run_apply

:find_latest
for /f "delims=" %%f in ('dir /b /o-d "%ROOT%\data\manual\review-*.json" 2^>nul') do (
  set "REVIEW_FILE=%ROOT%\data\manual\%%f"
  goto :run_apply
)
echo [错误] 未在 data\manual\ 找到 review-*.json 清单。
echo        请先运行采集管线（node scripts/build-news.js）自动生成待审清单。
goto :end

:run_apply
echo ============================================================
echo   第 1 步：应用人工审核结论
echo   清单：%REVIEW_FILE%
echo ============================================================
node scripts\news-cli.js min-review apply --file "%REVIEW_FILE%"
if errorlevel 1 (
  echo.
  echo   [错误] 第 1 步应用失败，已停止（结论未落地，不生成 top 名单）。
  goto :end
)

echo.
echo ============================================================
echo   第 2 步：生成 top 名单供二次审核
echo   （AI 从 approved 候选挑 top 10/15，写 data\manual\top-*.json）
echo ============================================================
node scripts\news-cli.js min-review ai-top
if errorlevel 1 (
  echo.
  echo   [警告] 第 2 步生成 top 名单失败，请查看上方原因。
  echo         常见原因：缺 DEEPSEEK_API_KEY / 缺 last-run.json / 无 approved 候选。
  goto :end
)

echo.
echo   全部完成。下一步：
echo   1. 打开 data\manual\top-*.json 二次审核，从中挑最终显示条目
echo   2. node scripts\news-cli.js min-review top-selected --ids ^<id1^,id2^,^...^>
echo   3. node scripts\publish-news.js 重建公开投影
echo   按任意键关闭窗口。
pause >nul
exit /b 0

:end
echo.
echo   按任意键关闭窗口。
pause >nul
exit /b 1
