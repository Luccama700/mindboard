# Rocket Fuel co-founder loop — Claude (Visionary) × Codex (Integrator)

This directory wires **OpenAI Codex** into the dev workflow as an adversarial code reviewer, using Gino Wickman & Mark Winters' **Rocket Fuel** Visionary/Integrator model as the operating metaphor. The book's core claim: a venture runs best when a **Visionary** (ideas, direction, the "why," big bets) is paired with an **Integrator** (the "voice of reason" who filters ideas, pokes holes, forces resolution, and holds execution accountable). The two are wired differently on purpose — the friction between them is the fuel, not a bug.

Mapped onto this repo:

| | **Visionary — Claude Code (Opus 4.8)** | **Integrator — Codex (GPT-5.5 → 5.6)** |
|---|---|---|
| Wired for | Product intent, architecture, generating the change, connecting the dots | Discipline, follow-through, poking holes, forcing a decision |
| Owns | What we build and why; final authorship; the ship decision | Adversarial read-only review: correctness, security/RLS, scope creep, breakage, test gaps |
| Failure mode it guards against | — | "Vision without execution is hallucination": ideas that don't survive contact with reality |
| Never does | Ship un-reviewed non-trivial work; dismiss a finding without a reason | Edit files or own the vision — it *proposes*, the Visionary decides |

Why a *different* model as the reviewer: Codex and Claude have different training and different blind spots, so Codex catches classes of bugs a Claude self-review waves through. Cross-model review is the highest-leverage part of this setup.

## The 5 Rules, mapped to this loop

Rocket Fuel's five operating rules for a V/I duo translate almost directly into how Claude and Codex work together here:

1. **Stay on the Same Page.** Codex can only judge *intent-mismatch* if it knows the intent. The wrapper feeds it the repo rules (`AGENTS.md`/`CLAUDE.md`) plus the diff, and `--focus "..."` carries the change's purpose. Brief the Integrator before you ask it to judge.
2. **No End Runs.** Don't shop for a friendlier verdict or quietly bury a finding to get your way. Every finding is adjudicated in the open with a stated call (accept / reject-with-reason / defer).
3. **The Integrator is the tie-breaker — via Identify → Discuss → Solve.** On **execution/correctness** questions ("is this a real bug, will this break, is this untested"), Codex's call carries the weight: override only with a concrete reason, never a shrug. On **product scope/vision** questions, the Visionary holds the call. Either way: it matters more *that* you decide than *what* you decide — don't leave findings in limbo.
4. **Accountable in the seat.** The reviewer seat is accountable for producing *good* findings. If a model consistently returns noise, bump or swap it (see Model policy) — the seat can be "re-staffed." Codex runs read-only and plays by the repo's rules like any contributor.
5. **Maintain mutual respect; harness the friction.** The adversarial tension is the point, not disrespect. Don't reflexively reject Codex's findings; Codex doesn't rewrite your vision. Healthy friction is what catches what a self-review misses.

## How to run it

**Inside Claude Code (the normal path):**
```
/rocket-review                    # review uncommitted changes, then adjudicate + ship
/rocket-review --base main        # review the current branch vs main
/rocket-review --uncommitted focus: the finance projection math
```
The slash command (`.claude/commands/rocket-review.md`) runs the wrapper, walks the Visionary through the IDS adjudication of each finding, and loops until Codex returns `VERDICT: SHIP`.

**Directly, from a terminal:**
```bash
bash .claude/codex/review.sh                 # uncommitted working tree
bash .claude/codex/review.sh --base main     # current branch vs main
bash .claude/codex/review.sh --commit HEAD   # a single commit
```
```powershell
.\.claude\codex\review.ps1 -Base main        # PowerShell twin, same behavior
```
Each run saves its output under `.claude/codex/reviews/` (gitignored).

## Model policy

- **Default reviewer model: `gpt-5.5`** — currently OpenAI's strongest for coding and computer use. Override per-run with `--model` or `CODEX_REVIEW_MODEL`.
- **Bumping to GPT-5.6** (Sol / Terra / Luna, rolling out from preview): once it's live on this account, `export CODEX_REVIEW_MODEL=gpt-5.6` (or `sol`) — nothing else changes.
- **Effort:** default `high` for a snappy loop; `CODEX_REVIEW_EFFORT=xhigh` for a maximum-rigor final pass.
- **Your global Codex default is left untouched.** `~/.codex/config.toml` still points at whatever you set (currently `gpt-5.4`); this loop pins its model per-invocation so it never disturbs your other Codex use.

## Codex as a live delegate (MCP)

Codex is also registered as a **user-scoped MCP server**, so it's available as a delegate tool in *every* Claude Code session, not just this repo's slash command:
```
claude mcp add codex --scope user -- codex mcp-server   # already done
claude mcp remove codex -s user                         # to undo
```
This lets Claude hand a whole sub-task to Codex mid-session (Codex runs its own agentic loop and reports back) — the general "co-founder on call" path beyond the structured review ritual.

## About "computer use"

Codex is excellent at *agentic* work — driving a terminal, editing code, running commands in its own sandbox, multi-step reasoning over a repo. That's what this loop and the MCP delegate use. Note the distinction: GUI **computer use** in the screen-control sense (moving a cursor, clicking pixels in arbitrary desktop apps) is a separate model/API capability (OpenAI's `computer_use` tool / Operator), **not** something the `codex` CLI exposes. So: delegate coding, review, shell, and repo automation to Codex today; treat literal desktop screen-control as a future add-on needing its own harness (Claude's own browser tools already cover in-browser automation here).

## Safety

- The reviewer runs `-s read-only`, which blocks **writes**: Codex cannot modify files, commit, or reach outside the sandbox. Read-only does **not** block reads — Codex can read any file in the workspace, including gitignored secrets like `.env.local`. The review prompt therefore explicitly instructs it to review only the diff and never open or echo secret/credential files. If you want a hard guarantee rather than an instruction, run the review from a copy of the repo with `.env*` removed. (Observed: in this sandbox Codex also can't run `graphify` or chained commands — expected; it falls back to plain reads and the review still completes.)
- All code changes stay authored by the Visionary. Codex only ever proposes.

## Sourcing note

The framework here is applied from the user's own purchased copy of *Rocket Fuel* (Wickman & Winters); the concepts and 5 Rules are theirs, the mapping onto this repo's tooling is ours. No copyrighted text is reproduced here.
