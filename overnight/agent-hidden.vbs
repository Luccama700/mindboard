' Windowless launcher for the 4am overnight run — same hidden pattern as
' poll-hidden.vbs so the nightly run never flashes a console window.
CreateObject("WScript.Shell").Run "cmd /c C:\Users\U\Documents\mindboard\mindboard\overnight\run-detached.cmd", 0, False
