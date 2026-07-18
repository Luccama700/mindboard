# Registers the nightly overnight-agent run in Windows Task Scheduler.
# Run once from a normal (non-elevated) PowerShell:  .\overnight\install-task.ps1
# Runs windowless via VBScript wrappers, so no admin and no console flash.
# Re-running replaces the existing task. Remove with:
#   Unregister-ScheduledTask -TaskName "Mindboard Overnight Agent" -Confirm:$false

param(
  [string]$Time = "04:00",
  [string]$TaskName = "Mindboard Overnight Agent",
  [string]$PollTaskName = "Mindboard Agent Poll",
  [int]$PollMinutes = 5
)

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$wscript = "$env:SystemRoot\System32\wscript.exe"

if (-not (Test-Path (Join-Path $repo "overnight\.env"))) {
  Write-Warning "overnight\.env not found - create it first (see overnight\README.md)."
}

# Actions launch through windowless VBScript wrappers (agent-hidden.vbs /
# poll-hidden.vbs) so a scheduled run never flashes a console window on the
# desktop. The .vbs just Run(..., 0, False) the run-detached.cmd launcher.
$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$repo\overnight\agent-hidden.vbs`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
# WakeToRun: the PC may be asleep at 4am; StartWhenAvailable catches a missed
# slot if the machine was off entirely.
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 5) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Mindboard overnight agent: plans and builds tasks from the mindboard group (docs/overnight-agent-plan.md)." `
  -Force

# Second task: the on-demand poll. Every $PollMinutes minutes it runs
# --if-requested, which exits immediately unless the user tapped
# "run agent now" in the app since the last poll.
$pollAction = New-ScheduledTaskAction -Execute $wscript -Argument "`"$repo\overnight\poll-hidden.vbs`"" -WorkingDirectory $repo
# [TimeSpan]::MaxValue serializes to an out-of-range XML duration; ten years
# of repetition is effectively indefinite.
$pollTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $PollMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$pollSettings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 5) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $PollTaskName `
  -Action $pollAction `
  -Trigger $pollTrigger `
  -Settings $pollSettings `
  -Description "Mindboard agent on-demand poll: picks up the app's 'run agent now' requests (docs/overnight-agent-plan.md)." `
  -Force

Write-Host "Registered '$TaskName' daily at $Time and '$PollTaskName' every $PollMinutes min."
Write-Host "Test now with:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "or a safe dry run with:"
Write-Host "  node `"$script`" --dry"
