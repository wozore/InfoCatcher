@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  identity-review.bat —— 模型身份歧义审计（维护者入口）
rem
rem  用法：双击本文件 → 输出待人工确认的模型名称歧义清单
rem  内部执行：node scripts\fetch-comparison.js review
rem  规则：零网络、零写入；不会调用 AI，不会修改 models-alias.json
rem ============================================================

rem 定位项目根目录：本文件在 bat\ 子目录，%~dp0 为 bat\，上一级即项目根。
set "ROOT=%~dp0.."
cd /d "%ROOT%"

echo ============================================================
echo   模型身份歧义审计
echo ============================================================
echo   本次仅生成待审清单，不调用 AI，不修改正式数据。
echo.
node scripts\fetch-comparison.js review
if errorlevel 1 (
  echo.
  echo   [错误] 身份审计失败，请查看上方原因。
  goto :error
)

echo.
echo   审计完成。以上建议必须人工确认后才能登记规则。
echo   按任意键关闭窗口。
pause >nul
exit /b 0

:error
echo.
echo   按任意键关闭窗口。
pause >nul
exit /b 1
