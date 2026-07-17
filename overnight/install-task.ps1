# Registers the nightly overnight-agent run in Windows Task Scheduler.
# Run once from an elevated PowerShell:  .\overnight\install-task.ps1
# Re-running replaces the existing task. Remove with:
#   Unregister-ScheduledTask -TaskName "Mindboard Overnight Agent" -Confirm:$false

param(
  [string]$Time = "04:00",
  [string]$TaskName = "Mindboard Overnight Agent"
)

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $repo "overnight\run.mjs"

if (-not (Test-Path (Join-Path $repo "overnight\.env"))) {
  Write-Warning "overnight\.env not found - create it first (see overnight\README.md)."
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $repo
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

Write-Host "Registered '$TaskName' daily at $Time. Test now with:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "or a safe dry run with:"
Write-Host "  node `"$script`" --dry"
