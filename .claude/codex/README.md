# Rocket Fuel co-founder loop — Claude (Visionary) × Codex (Integrator)

This directory wires **OpenAI Codex** into the dev workflow as an adversarial code reviewer, using Gino Wickman & Mark Winters' **Rocket Fuel** Visionary/Integrator model as the operating metaphor. The idea in one breath: a great venture pairs a **Visionary** — who generates ideas, owns the vision and the "why," and drives what to build — with an **Integrator**, who pressure-tests those ideas against reality, enforces discipline and follow-through, and makes sure the thing actually holds together before it goes out. The two roles are deliberately in tension, and that tension is the fuel. Neither is in charge of the other; they're accountable to a shared standard.

Mapped onto this repo:

| Role | Who | Owns |
|------|-----|------|
| **Visionary** | Claude Code (Opus 4.8) | Product intent, architecture, writing the change, adjudicating findings, the final ship decision |
| **Integrator** | Codex (GPT-5.5, → 5.6) | Adversarial read-only review: correctness, security/RLS, scope creep, breakage, test gaps. Proposes; never edits |

Why a *different* model as the reviewer: Codex and Claude have different training and different blind spots, so Codex catches classes of bugs a Claude self-review tends to wave through. Cross-model review is the highest-leverage part of this setup.

> Note on sourcing: the framework here is applied from general knowledge of the Visionary/Integrator concept and public summaries — no copy of the book was downloaded. The specifics are Wickman & Winters' work; the mapping to this repo is ours.

## How to run it

**Inside Claude Code (the normal path):**
```
/rocket-review                    # review uncommitted changes, then adjudicate + ship
/rocket-review --base main        # review the current branch vs main
/rocket-review --uncommitted focus: the finance projection math
```
The slash command (`.claude/commands/rocket-review.md`) runs the wrapper, then walks the Visionary through adjudicating each finding and looping until Codex returns `VERDICT: SHIP`.

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

- **Default reviewer model: `gpt-5.5`** — currently OpenAI's strongest for coding and computer use. Override per-run with `--model` or the `CODEX_REVIEW_MODEL` env var.
- **Bumping to GPT-5.6** (Sol / Terra / Luna, rolling out from preview): once it's live on this account, just `export CODEX_REVIEW_MODEL=gpt-5.6` (or `sol`) — nothing else changes.
- **Effort:** default `high` for a snappy loop; `CODEX_REVIEW_EFFORT=xhigh` for a maximum-rigor final pass.
- **Your global Codex default is left untouched.** `~/.codex/config.toml` still points at whatever you set (currently `gpt-5.4`); this loop pins its model per-invocation so it never disturbs your other Codex use. To also bump your global default: `codex` → `/model`, or edit that file.

## Codex as a live delegate (MCP)

Codex is also registered as a **user-scoped MCP server**, so it's available as a delegate tool in *every* Claude Code session, not just via this repo's slash command:
```
claude mcp add codex --scope user -- codex mcp-server   # already done
claude mcp remove codex -s user                         # to undo
```
This lets Claude hand a whole sub-task to Codex mid-session (Codex runs its own agentic loop and reports back), which is the general "co-founder on call" path beyond the structured review ritual.

## About "computer use"

Codex is excellent at *agentic* work — driving a terminal, editing code, running commands in its own sandbox, and multi-step reasoning over a repo. That's what this loop and the MCP delegate use. Note the distinction: GUI **computer use** in the screen-control sense (moving a cursor, clicking pixels in arbitrary desktop apps) is a separate model/API capability (OpenAI's `computer_use` tool / Operator), **not** something the `codex` CLI exposes. So: delegate coding, review, shell, and repo automation to Codex today; treat literal desktop screen-control as a future add-on that would need its own harness (Claude's own browser tools already cover in-browser automation here).

## Safety

- The reviewer runs `-s read-only`: it can read the repo and run read-only git commands, but cannot modify files or reach outside the sandbox — so it can't touch secrets or your `.env`.
- All code changes stay authored by the Visionary. Codex only ever proposes.
