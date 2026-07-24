@echo off
rem Detached launcher for the digest runner (morning|finance) — same pattern
rem as run-detached.cmd so scheduled runs never flash a console window.
cd /d C:\Users\U\Documents\mindboard\mindboard
powershell -NoProfile -ExecutionPolicy Bypass -File overnight\digest.ps1 -Kind %1 > overnight\logs\digest-detached-last.out 2>&1
