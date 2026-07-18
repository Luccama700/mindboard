@echo off
rem Detached launcher for the overnight orchestrator (survives session-scoped
rem kills). A dedicated npm cache keeps its `npm ci` from contending on the
rem global cache lock with a concurrent worktree build (e.g. a redesign
rem session) — that contention hangs `npm ci` indefinitely.
set "npm_config_cache=C:\Users\U\.npm-overnight"
cd /d C:\Users\U\Documents\mindboard\mindboard
node overnight\run.mjs %* > overnight\logs\detached-last.out 2>&1
