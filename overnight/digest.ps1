# Scheduled digest runner: a cheap headless Claude run over the Mindboard MCP.
#   .\overnight\digest.ps1 -Kind morning   # daily morning report
#   .\overnight\digest.ps1 -Kind finance   # weekly finance digest
# Reads overnight\.env for MINDBOARD_URL / MINDBOARD_PAT (same file the
# orchestrator uses). The report is captured to the brain vault by the agent
# itself (capture_to_brain) and mirrored to overnight\logs\digest-*.md.
# Registered in Task Scheduler by install-digests.ps1.

param(
  [Parameter(Mandatory = $true)][ValidateSet("morning", "finance")][string]$Kind
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$logDir = Join-Path $here "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null

# ---- config from overnight\.env (never exported to the child process) ----
$envFile = Join-Path $here ".env"
if (-not (Test-Path $envFile)) { throw "overnight\.env not found" }
$conf = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $conf[$Matches[1]] = $Matches[2] }
}
if (-not $conf.MINDBOARD_URL -or -not $conf.MINDBOARD_PAT) {
  throw "MINDBOARD_URL and MINDBOARD_PAT are required in overnight\.env"
}
$claudeBin = if ($conf.OVERNIGHT_CLAUDE_BIN) { $conf.OVERNIGHT_CLAUDE_BIN } else { "claude" }
$model = if ($conf.DIGEST_MODEL) { $conf.DIGEST_MODEL } else { "haiku" }
$budget = if ($conf.DIGEST_BUDGET_USD) { $conf.DIGEST_BUDGET_USD } else { "1" }

$today = Get-Date -Format "yyyy-MM-dd"
$yesterday = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")

# ---- prompts ----
if ($Kind -eq "morning") {
  $prompt = @"
You are Lucca's morning report agent. Build today's morning report, capture it, and print it.

1. OVERNIGHT: read the orchestrator logs $here\logs\$today.log and $here\logs\$yesterday.log with the Read tool (either may not exist — then say "no overnight run recorded"). Summarize: which runs fired and whether each completed; code track (plans written = awaiting approval in the app; builds = branch name, preview URL, and the AI review verdict if the log shows one); life track (approaches proposed, research done). Then FAILURES: scan the logs for FATAL, "MCP error", "proxy", "compromised", "FAILED" — one line each with a plain-language diagnosis. Silent failures are the whole reason this section exists; never omit it.
2. TODAY: call the mindboard MCP tools get_snapshot and tasks_snapshot. From them: the top 3 things that matter today, then due/overdue tasks, today's events and free gaps, and any bills landing within 3 days.
3. Compose "Morning report — $today" in plain markdown, phone-screen short, most urgent first. No filler, no headings larger than ###.
4. Call the mindboard capture_to_brain tool with title "Morning report — $today", summary_markdown = the full report, source "morning digest agent", topics ["morning-report"].

Your final message must be ONLY the report markdown.
"@
} else {
  $weekOf = (Get-Date).ToString("yyyy-MM-dd")
  $prompt = @"
You are Lucca's weekly finance digest agent. Build the digest, capture it, and print it.

1. Call the mindboard MCP tools: finance_snapshot, finance_forecast, list_recent_ledger, spend_limit_status.
2. Compose "Finance digest — week of $weekOf": current net worth and its trend; last week's spending by category with anything anomalous called out; the coming week's recurring bills and the forecast's projected low point (flag if it dips near or below zero); spend-limit status; at most ONE actionable suggestion. Numbers rounded to whole dollars. Plain markdown, phone-screen short, no headings larger than ###.
3. Call the mindboard capture_to_brain tool with title "Finance digest — week of $weekOf", summary_markdown = the full digest, source "finance digest agent", topics ["finance-digest"].

Your final message must be ONLY the digest markdown.
"@
}

# ---- one-shot MCP config (temp file so the PAT never sits in the repo) ----
$mcpFile = Join-Path $env:TEMP ("mb-digest-" + [guid]::NewGuid().ToString("N") + ".json")
@{
  mcpServers = @{
    mindboard = @{
      type = "http"
      url = "$($conf.MINDBOARD_URL)/api/mcp/mcp"
      headers = @{ Authorization = "Bearer $($conf.MINDBOARD_PAT)" }
    }
  }
} | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $mcpFile

try {
  $out = $prompt | & $claudeBin -p `
    --output-format json `
    --permission-mode dontAsk `
    --model $model `
    --effort medium `
    --max-turns 30 `
    --max-budget-usd $budget `
    --mcp-config $mcpFile `
    --strict-mcp-config `
    --allowedTools "Read,Glob,Grep,mcp__mindboard__*" `
    --disallowedTools "Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch"
  if ($LASTEXITCODE -ne 0) { throw "claude exited $LASTEXITCODE : $out" }
  $parsed = $out | ConvertFrom-Json
  $report = if ($parsed.result) { $parsed.result } else { "$out" }
  $report | Out-File -Encoding utf8 (Join-Path $logDir "digest-$Kind-$today.md")
  Write-Host "digest '$Kind' done (cost `$$([math]::Round([double]$parsed.total_cost_usd, 2)))"
} finally {
  Remove-Item -Force $mcpFile -ErrorAction SilentlyContinue
}
