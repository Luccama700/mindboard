# Registers the scheduled digests in Windows Task Scheduler.
# Run once from a normal (non-elevated) PowerShell:  .\overnight\install-digests.ps1
# Re-running replaces the tasks. Remove with:
#   Unregister-ScheduledTask -TaskName "Mindboard Morning Report" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Mindboard Finance Digest" -Confirm:$false

param(
  [string]$MorningTime = "08:03",
  [string]$FinanceTime = "08:33",
  [string]$MorningTaskName = "Mindboard Morning Report",
  [string]$FinanceTaskName = "Mindboard Finance Digest"
)

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$wscript = "$env:SystemRoot\System32\wscript.exe"

if (-not (Test-Path (Join-Path $repo "overnight\.env"))) {
  Write-Warning "overnight\.env not found - the digests need MINDBOARD_URL/MINDBOARD_PAT."
}

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -MultipleInstances IgnoreNew

$morningAction = New-ScheduledTaskAction -Execute $wscript -Argument "`"$repo\overnight\digest-morning-hidden.vbs`"" -WorkingDirectory $repo
Register-ScheduledTask `
  -TaskName $MorningTaskName `
  -Action $morningAction `
  -Trigger (New-ScheduledTaskTrigger -Daily -At $MorningTime) `
  -Settings $settings `
  -Description "Daily morning report: overnight-agent outcomes + today's plan, captured to the brain vault (overnight\digest.ps1 -Kind morning)." `
  -Force

$financeAction = New-ScheduledTaskAction -Execute $wscript -Argument "`"$repo\overnight\digest-finance-hidden.vbs`"" -WorkingDirectory $repo
Register-ScheduledTask `
  -TaskName $FinanceTaskName `
  -Action $financeAction `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At $FinanceTime) `
  -Settings $settings `
  -Description "Weekly finance digest: snapshot + forecast + anomalies, captured to the brain vault (overnight\digest.ps1 -Kind finance)." `
  -Force

Write-Host "Registered '$MorningTaskName' daily at $MorningTime and '$FinanceTaskName' Mondays at $FinanceTime."
Write-Host "Test now with:  powershell -File `"$repo\overnight\digest.ps1`" -Kind morning"
