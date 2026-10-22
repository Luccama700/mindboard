@echo off
rem Launches the Mindboard URC agent (worker\urc-agent.mjs). Config is read by
rem the agent itself from worker\urc.env on every poll, so nothing is loaded
rem into the environment here. Launched windowless by urc-agent-hidden.vbs at
rem logon; run it directly in a console to watch the loop.
setlocal
cd /d "%~dp0.."

if not exist "worker\logs" mkdir "worker\logs"

rem Full path on purpose: this runs from a logon shortcut, where PATH is not
rem guaranteed to be the one an interactive shell gets, and this box sets
rem NoDefaultCurrentDirectoryInExePath=1. Falls back to PATH if Node moves.
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" worker\urc-agent.mjs >> worker\logs\urc-agent.out 2>&1
