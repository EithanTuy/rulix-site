@echo off
setlocal

set "SUCCESS_FILE=.rulix-live-test-success.ok"
if exist "%SUCCESS_FILE%" del /q "%SUCCESS_FILE%" >nul 2>nul
set "RULIX_LIVE_WRAPPER_SUCCESS_FILE=%CD%\%SUCCESS_FILE%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-live-test.ps1" %*
set "LIVE_TEST_EXIT=%ERRORLEVEL%"

if exist "%SUCCESS_FILE%" (
  del /q "%SUCCESS_FILE%" >nul 2>nul
  exit /b 0
)

exit /b %LIVE_TEST_EXIT%
