<#
  Integrator review — Codex (default GPT-5.5) adversarially reviews the Visionary's
  (Claude/Opus) changes before shipping. Part of the Rocket Fuel co-founder loop.
  See .claude/codex/README.md. Reviewer runs READ-ONLY: it proposes, never edits.

  Examples:
    .\.claude\codex\review.ps1                       # review uncommitted working-tree changes
    .\.claude\codex\review.ps1 -Base main            # review current branch vs main
    .\.claude\codex\review.ps1 -Commit HEAD          # review a single commit
    $env:CODEX_REVIEW_EFFORT="xhigh"; .\.claude\codex\review.ps1   # max rigor
#>
param(
  [string]$Base = "",
  [string]$Commit = "",
  [switch]$Uncommitted,
  [string]$Model  = $(if ($env:CODEX_REVIEW_MODEL)  { $env:CODEX_REVIEW_MODEL }  else { "gpt-5.5" }),
  [string]$Effort = $(if ($env:CODEX_REVIEW_EFFORT) { $env:CODEX_REVIEW_EFFORT } else { "high" }),
  [string]$Focus  = ""
)
$ErrorActionPreference = "Stop"

if     ($Base)   { $mode = "base";        $diffCmd = "git diff $Base...HEAD --stat  then  git diff $Base...HEAD"; $scope = "the diff of the current branch against '$Base'" }
elseif ($Commit) { $mode = "commit";      $diffCmd = "git show --stat $Commit  then  git show $Commit";           $scope = "the changes introduced by commit $Commit" }
else             { $mode = "uncommitted"; $diffCmd = "git status --porcelain  then  git diff HEAD  (and read any untracked files listed as ?? )"; $scope = "the uncommitted working-tree changes" }

$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot
$reviewDir = Join-Path $PSScriptRoot "reviews"
New-Item -ItemType Directory -Force -Path $reviewDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $reviewDir "review-$mode-$stamp.md"

$focusLine = if ($Focus) { "Extra focus from the Visionary: $Focus" } else { "" }

$prompt = @"
You are the INTEGRATOR, co-founder to the VISIONARY (Claude/Opus) who authored these
changes. This is an adversarial pre-ship code review. Your job is to find what will
actually break or regress in production — not to praise, not to bikeshed.

Repository: a Next.js 16 App Router + React 19 + TypeScript (strict) + Supabase
(Postgres with row-level security) PWA. BEFORE judging, read AGENTS.md and CLAUDE.md at
the repo root for the project's hard rules (RLS must never be disabled; server-side
timezone correctness; AI writes are propose->confirm; keep changes narrow; pure logic is
unit-tested under __tests__/). Respect those rules when deciding what is a real defect.

Inspect $scope. Get it yourself by running:
  $diffCmd
Then open the full surrounding context of any file you flag — never judge from the hunk alone.

Hunt, in priority order:
1. Correctness — logic errors, bad async/await, off-by-one, null/undefined, broken
   optimistic UI, wrong money/date/timezone math.
2. Security — RLS bypass, leaked secrets/tokens, unvalidated external input, user-scoping mistakes.
3. Intent mismatch / scope creep — does the change do what it claims and ONLY that? Any new
   table/dependency/abstraction that violates the repo's scope rules?
4. Breakage — will 'npm run lint', 'npm run test', or 'npm run build' fail? Any type errors under strict mode?
5. Test gaps — new pure logic shipped with no unit test.

Rules of engagement:
- READ-ONLY. Propose fixes; do NOT modify any file.
- Every finding must be real and actionable with a concrete fix. No style nits, no
  speculation. If you are not sure something is a real bug, mark it low-confidence and say why.
- Prefer missing a nit over inventing one. Precision over volume.
$focusLine

Output format (markdown, nothing before it):
## Integrator review
Then, for each finding:
- **[SEVERITY]** ``path/to/file:line`` — one-line problem. Fix: concrete change. (SEVERITY = BLOCKER | HIGH | MEDIUM | LOW)
If there are no real findings, say so plainly.
End with EXACTLY one final line:
VERDICT: SHIP   — when there are no BLOCKER or HIGH findings
VERDICT: HOLD (B blockers, H high) — otherwise
"@

Write-Host "Integrator (Codex $Model, effort $Effort) reviewing $scope..." -ForegroundColor Cyan
codex exec -m $Model -c "model_reasoning_effort=$Effort" -s read-only $prompt | Tee-Object -FilePath $out
Write-Host "Saved review to: $out" -ForegroundColor DarkGray
