@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  build-dist.bat —— 重建前端静态站 dist/（维护者入口）
rem
rem  用法：双击本文件 → node scripts/build-dist.js
rem  内部执行：node scripts\build-dist.js
rem          （清空重建 dist/ → 复制 src/web + public + data，
rem            含最新 hotspots.json / feed.xml，供 GitHub Pages 部署）
rem ============================================================

rem 定位项目根目录：本文件在 bat\ 子目录，%~dp0 为 bat\，上一级即项目根。
set "ROOT=%~dp0.."
cd /d "%ROOT%"

echo ============================================================
echo   重建前端静态站 dist/
echo ============================================================
node scripts\build-dist.js
if errorlevel 1 (
  echo.
  echo   [错误] dist 构建失败，请查看上方原因。
  goto :end
)

echo.
echo   完成。dist/ 已重建（含最新 hotspots.json / feed.xml / 前端资源）。
echo   按任意键关闭窗口。
pause >nul
exit /b 0

:end
echo.
echo   按任意键关闭窗口。
pause >nul
exit /b 1
