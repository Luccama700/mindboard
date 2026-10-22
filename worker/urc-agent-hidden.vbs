' Windowless launcher for the URC agent - same no-flash pattern as
' worker-hidden.vbs and the overnight tasks. wscript has no console, so
' Run(..., 0, False) starts the poll loop hidden and leaves it running.
' Put a shortcut to this file in shell:startup to have it come up at logon.
' Full path on purpose: this box sets NoDefaultCurrentDirectoryInExePath=1.
CreateObject("WScript.Shell").Run "cmd /c C:\Users\U\Documents\mindboard\mindboard\worker\run-urc-agent.cmd", 0, False
