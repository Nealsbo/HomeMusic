@echo off
setlocal
cd /d "%~dp0"
if defined PYTHON_BIN (
    "%PYTHON_BIN%" main.py %*
) else (
    python main.py %*
)
exit /b %errorlevel%
