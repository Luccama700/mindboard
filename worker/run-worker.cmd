@echo off
rem Launches the Mindboard home worker (native Windows). Loads secrets +
rem config from worker\worker.env (gitignored), puts the pip --user Scripts
rem dir on PATH so yt-dlp / whisper-ctranslate2 resolve, and runs the poll
rem loop. Launched windowless by worker-hidden.vbs at logon.
setlocal
cd /d "%~dp0.."

rem pip --user console scripts (yt-dlp, whisper-ctranslate2) live here.
set "PATH=%APPDATA%\Python\Python314\Scripts;%PATH%"

rem Load KEY=VALUE lines from worker.env (skip blanks/#).
if exist "worker\worker.env" (
  for /f "usebackq eol=# tokens=1* delims==" %%A in ("worker\worker.env") do set "%%A=%%B"
)

python worker\worker.py >> worker\logs\worker.out 2>&1
