@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "ROOT=%~dp0.."
cd /d "%ROOT%"
if not "%~1"=="" goto :run

echo ============================================================
echo   五模块目录生成器 - 维护者操作入口
echo ============================================================
echo.
echo 指令说明：
echo   probe --confirm-cost
echo     检查 TAVILY_API_KEY、DEEPSEEK_API_KEY、模型和检索能力；会产生一次 Tavily 调用。
echo.
echo   new --seed ^<file^> --confirm-cost
echo     联网研究并生成目录草案 Preview；不会直接写入正式目录。
echo.
echo   prepare --seed ^<file^>
echo     使用已有输入准备离线草案；通常用于测试，不进行联网检索。
echo.
echo   list
echo     列出当前保存的所有草案及其状态；只读，不联网、~不写入目录。
echo.
echo   review ^<draft-id^>
echo     重新检查草案、目录版本和变更预览；只读，不写入正式目录。
echo.
echo   apply ^<draft-id^>
echo     显示变更并等待输入 APPLY 确认；确认后才写入五模块目录并构建静态站。
echo.
echo   cancel ^<draft-id^>
echo     删除尚未 Apply 的草案；不会修改正式目录。
echo.
echo   recover
echo     检查并恢复中断的目录事务；可能回滚未完成写入，请仅在异常中断后使用。
echo.
echo 注意：new、probe 可能产生 Tavily/DeepSeek API 费用；apply、cancel、recover 可能修改本地文件。
echo      API Key 只从 TAVILY_API_KEY、DEEPSEEK_API_KEY 环境变量读取，不要写入文件。
echo.
set /p "ARGS=请输入指令及参数（直接回车退出）: "
if not defined ARGS exit /b 0
call :run %ARGS%
exit /b %errorlevel%

:run
node scripts\catalog-generator.js %*
exit /b %errorlevel%
