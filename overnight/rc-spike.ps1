# Throwaway spike for docs/superpowers/specs/2026-09-09-agent-handoff-design.md
# (sub-project 3). Run ONCE on the home PC from the repo checkout:
#
#   powershell -ExecutionPolicy Bypass -File overnight\rc-spike.ps1
#
# It answers three questions the Claude Code docs leave open:
#   1. does a Remote Control session launched from a HIDDEN console register?
#   2. does one launched from a MINIMIZED console register?
#   3. does interactive mode accept --max-turns / --max-budget-usd?
# and prints the auth / env facts RC depends on. It launches three throwaway
# sessions named rc-spike-hidden, rc-spike-min, rc-spike-flags, waits six
# minutes for you to look for them under Remote Control (phone or desktop
# app — each should have replied READY), then kills all three. Nothing else
# on this machine is touched. Report lands in overnight\logs\rc-spike.txt.

$ErrorActionPreference = "Continue"
$repo = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$report = Join-Path $logDir "rc-spike.txt"
$spikeRoot = Join-Path $PSScriptRoot "rc-spike-runs"
Remove-Item -Recurse -Force $spikeRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $spikeRoot | Out-Null

function Say($text) { $text | Tee-Object -FilePath $report -Append }

"" | Out-File $report
Say "rc-spike $(Get-Date -Format s) on $env:COMPUTERNAME"
Say "repo: $repo"

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { Say "FAIL: claude not on PATH"; exit 1 }
Say "claude: $claude"
Say "version: $(& $claude --version 2>&1)"
Say "auth: $(& $claude auth status 2>&1 | Out-String)"

foreach ($name in "ANTHROPIC_BASE_URL","ANTHROPIC_API_KEY","CLAUDECODE","DISABLE_TELEMETRY","DO_NOT_TRACK","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC","DISABLE_GROWTHBOOK") {
  $v = [Environment]::GetEnvironmentVariable($name)
  Say ("env {0}: {1}" -f $name, $(if ($v) { "SET" } else { "unset" }))
}

# The child gets the parent's env minus everything RC refuses or that marks a
# nested session. Values are never printed.
$scrub = "ANTHROPIC_BASE_URL","ANTHROPIC_API_KEY","CLAUDECODE","DISABLE_TELEMETRY","DO_NOT_TRACK","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC","DISABLE_GROWTHBOOK"
foreach ($name in $scrub) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }

# .cmd shims need cmd.exe; an .exe can be started directly.
$viaCmd = $claude -like "*.cmd"

function Launch($sessionName, $style, $extraArgs) {
  $dir = Join-Path $spikeRoot $sessionName
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  "Reply with the single word READY and then wait for further instructions. Do not touch any files." | Out-File (Join-Path $dir "prompt.md") -Encoding utf8
  $rel = "rc-spike-runs\$sessionName\prompt.md"
  $args = @("--remote-control", $sessionName, "--dangerously-skip-permissions") + $extraArgs + @("`"Read overnight\$rel and do exactly what it says.`"")
  $err = Join-Path $dir "stderr.txt"
  $out = Join-Path $dir "stdout.txt"
  if ($style -eq "hidden") {
    # Same route the scheduled tasks use: WScript.Shell.Run(..., 0, False).
    $cmdLine = "cmd /c `"$claude`" $($args -join ' ') 2> `"$err`""
    $shell = New-Object -ComObject WScript.Shell
    $shell.Run($cmdLine, 0, $false) | Out-Null
    Say "launched $sessionName hidden: $cmdLine"
    return $null
  }
  if ($viaCmd) {
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList (@("/c", "`"$claude`"") + $args) -WorkingDirectory $repo -WindowStyle Minimized -PassThru -RedirectStandardError $err -RedirectStandardOutput $out
  } else {
    $p = Start-Process -FilePath $claude -ArgumentList $args -WorkingDirectory $repo -WindowStyle Minimized -PassThru -RedirectStandardError $err -RedirectStandardOutput $out
  }
  Say "launched $sessionName minimized: pid $($p.Id)"
  return $p
}

Set-Location $repo
$pHidden = Launch "rc-spike-hidden" "hidden" @()
$pMin = Launch "rc-spike-min" "min" @()
$pFlags = Launch "rc-spike-flags" "min" @("--max-turns", "3", "--max-budget-usd", "1")

Start-Sleep -Seconds 30
Say ""
Say "after 30s:"
$alive = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*--remote-control rc-spike-*" }
foreach ($proc in $alive) { Say "  alive pid $($proc.ProcessId): $($proc.CommandLine)" }
if (-not $alive) { Say "  no rc-spike claude processes alive" }
foreach ($sessionName in "rc-spike-hidden","rc-spike-min","rc-spike-flags") {
  $err = Join-Path $spikeRoot "$sessionName\stderr.txt"
  if (Test-Path $err) {
    $text = (Get-Content $err -Raw -ErrorAction SilentlyContinue)
    if ($text) { Say "  $sessionName stderr: $($text.Substring(0, [Math]::Min(300, $text.Length)))" }
  }
}

Say ""
Say "NOW: open Remote Control on the phone or the desktop app and look for"
Say "  rc-spike-hidden / rc-spike-min / rc-spike-flags — note which are listed"
Say "  and which replied READY. You have six minutes."
Start-Sleep -Seconds 360

Say ""
Say "cleanup:"
foreach ($proc in (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*--remote-control rc-spike-*" })) {
  Say "  killing pid $($proc.ProcessId)"
  & taskkill /PID $proc.ProcessId /T /F 2>&1 | Out-Null
}
foreach ($p in @($pMin, $pFlags)) {
  if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null }
}
Say "done. Send overnight\logs\rc-spike.txt back, plus which names showed up."
