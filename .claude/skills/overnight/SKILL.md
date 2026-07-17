---
name: overnight
description: Run the Mindboard overnight agent on demand — plan/triage new tasks, build/execute approved ones, or dry-run — and summarize what happened.
---

# /overnight — run the agent from this session

The overnight agent (docs/overnight-agent-plan.md, runbook overnight/README.md)
normally fires at 4am via Task Scheduler. This skill runs it right now.

## How to run

Pick the variant from the user's ask (default: full run):

```powershell
node overnight\run.mjs                 # everything: plan+triage new, build+exec approved
node overnight\run.mjs --plan-only     # proposals only — nothing executes
node overnight\run.mjs --build-only    # execute/build approved tasks only
node overnight\run.mjs --code-only     # Track A only (mindboard-group features)
node overnight\run.mjs --life-only     # Track B only (all other life tasks)
node overnight\run.mjs --dry           # no Claude spawned, no writes; shows the queues
```

Flags combine (e.g. `--life-only --plan-only` = triage life tasks, propose
approaches, execute nothing).

Run it in the foreground with a generous timeout (build runs can take an
hour; plan/triage runs minutes). Full runs with builds are better via
`run_in_background`.

## After it finishes

Read the tail of today's log (`overnight/logs/<date>.log`) and report to the
user: what got planned/proposed (with each approach in one line), what got
built/executed, costs where logged, and any failures with their one-line
cause. Remind them approvals happen on the task rows in the app.

## Notes

- Config lives in `overnight/.env` (never read or print it — it holds the
  access token).
- A failed build keeps its worktree under `../mindboard-ai/` for inspection.
- The same on-demand run can be triggered from the app: the "✦ run agent
  now" button on /tasks, picked up by the 5-minute poll task.
