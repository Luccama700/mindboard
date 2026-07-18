' Windowless launcher for the 5-minute agent poll — wscript has no console and
' Run(..., 0, False) starts the batch hidden, so nothing flashes on screen.
' (Path has no spaces, so no inner quoting is needed.)
CreateObject("WScript.Shell").Run "cmd /c C:\Users\U\Documents\mindboard\mindboard\overnight\run-detached.cmd --if-requested", 0, False
