' Windowless launcher for the home worker — same no-flash pattern as the
' overnight tasks. wscript has no console; Run(..., 0, False) starts the
' worker's poll loop hidden and keeps it running.
CreateObject("WScript.Shell").Run "cmd /c C:\Users\U\Documents\mindboard\mindboard\worker\run-worker.cmd", 0, False
