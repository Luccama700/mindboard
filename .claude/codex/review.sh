#!/usr/bin/env bash
# Integrator review — Codex (default GPT-5.5) adversarially reviews the Visionary's
# (Claude/Opus) changes before shipping. Part of the Rocket Fuel co-founder loop.
# See .claude/codex/README.md. Reviewer runs READ-ONLY: it proposes, never edits.
set -euo pipefail

MODEL="${CODEX_REVIEW_MODEL:-gpt-5.5}"
EFFORT="${CODEX_REVIEW_EFFORT:-high}"   # high (default) | xhigh (max rigor, slower) | medium | low
MODE="uncommitted"                       # uncommitted | base | commit
BASE=""
COMMIT=""
FOCUS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base)        MODE="base"; BASE="${2:-}"; shift 2 ;;
    --commit)      MODE="commit"; COMMIT="${2:-}"; shift 2 ;;
    --uncommitted) MODE="uncommitted"; shift ;;
    --model)       MODEL="${2:-}"; shift 2 ;;
    --effort)      EFFORT="${2:-}"; shift 2 ;;
    --focus)       FOCUS="${2:-}"; shift 2 ;;
    *)             FOCUS="${FOCUS:+$FOCUS }$1"; shift ;;
  esac
done

case "$MODE" in
  base)   DIFF_CMD="git diff ${BASE}...HEAD --stat  then  git diff ${BASE}...HEAD"
          SCOPE="the diff of the current branch against '${BASE}'" ;;
  commit) DIFF_CMD="git show --stat ${COMMIT}  then  git show ${COMMIT}"
          SCOPE="the changes introduced by commit ${COMMIT}" ;;
  *)      DIFF_CMD="git status --porcelain  then  git diff HEAD  (and read any untracked files listed as ?? )"
          SCOPE="the uncommitted working-tree changes" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(git rev-parse --show-toplevel)"
REVIEW_DIR="$SCRIPT_DIR/reviews"
mkdir -p "$REVIEW_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$REVIEW_DIR/review-${MODE}-${STAMP}.md"

FOCUS_LINE=""
[ -n "$FOCUS" ] && FOCUS_LINE="Extra focus from the Visionary: ${FOCUS}"

read -r -d '' PROMPT <<EOF || true
You are the INTEGRATOR, co-founder to the VISIONARY (Claude/Opus) who authored these
changes. This is an adversarial pre-ship code review. Your job is to find what will
actually break or regress in production — not to praise, not to bikeshed.

Repository: a Next.js 16 App Router + React 19 + TypeScript (strict) + Supabase
(Postgres with row-level security) PWA. BEFORE judging, read AGENTS.md and CLAUDE.md at
the repo root for the project's hard rules (RLS must never be disabled; server-side
timezone correctness; AI writes are propose->confirm; keep changes narrow; pure logic is
unit-tested under __tests__/). Respect those rules when deciding what is a real defect.

Inspect ${SCOPE}. Get it yourself by running:
  ${DIFF_CMD}
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
${FOCUS_LINE}

Output format (markdown, nothing before it):
## Integrator review
Then, for each finding:
- **[SEVERITY]** \`path/to/file:line\` — one-line problem. Fix: concrete change. (SEVERITY = BLOCKER | HIGH | MEDIUM | LOW)
If there are no real findings, say so plainly.
End with EXACTLY one final line:
VERDICT: SHIP   — when there are no BLOCKER or HIGH findings
VERDICT: HOLD (B blockers, H high) — otherwise
EOF

echo "Integrator (Codex ${MODEL}, effort ${EFFORT}) reviewing ${SCOPE}..." >&2
echo "----------------------------------------------------------------------" >&2
codex exec -m "$MODEL" -c model_reasoning_effort="$EFFORT" -s read-only "$PROMPT" | tee "$OUT"
echo "" >&2
echo "Saved review to: $OUT" >&2
