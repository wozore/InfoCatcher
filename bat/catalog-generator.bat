@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"
if "%~1"=="" (
  echo 用法: catalog-generator.bat probe --confirm-cost
  echo       catalog-generator.bat new --seed ^<file^> --confirm-cost
  echo       catalog-generator.bat prepare --seed ^<file^>
  echo       catalog-generator.bat review ^<draft-id^>
  echo       catalog-generator.bat apply ^<draft-id^>
  echo       catalog-generator.bat cancel ^<draft-id^>
  echo       catalog-generator.bat recover
  exit /b 1
)
node scripts\catalog-generator.js %*
exit /b %errorlevel%
