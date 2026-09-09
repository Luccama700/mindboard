# Overnight agent

The nightly orchestrator (design: `docs/overnight-agent-plan.md`). At 4am —
or on demand — it works the user's board over MCP, two tracks:

**Track A — code (the mindboard group):**

- **plans** untouched ideas — headless Claude Code in plan mode (read-only),
  plan appended to the task notes, badge flips to `✦ plan ready`;
- **builds** approved ones — fresh `git worktree`, headless Claude Code with
  edit permissions, then an authoritative `lint → test → build` gate, a push
  to `ai/<slug>`, and the Vercel preview URL written back into the notes.

**Track B — life (every other task):**

- **triages** untouched tasks in one cheap model call against
  `capabilities.md`; feasible ones get an `## AI approach` written into the
  notes + the same `✦ plan ready` badge; infeasible ones are cached in
  `state.json` (a retitle re-triages).
- **executes** approved ones with **WebSearch/WebFetch only** — no shell, no
  file edits, and a hard draft-never-submit rule. Summary lands in the task
  notes, the full result in the brain vault.

**Track C — dispatched ("do this now"):**

- one task the user picked in the app, with a one-shot note, run **now** at
  full power (shell + files + web, its own manifest in
  `dispatch-capabilities.md`) instead of the nightly sweep. The result is
  written back into the task notes as `## Agent result`.
- the task shows no agent badge while it waits — it wears `✦ working…` once
  the run actually starts, then `✦ done` or `✦ failed`.

Approve/dismiss happens on the task row in the app (the `ai build` controls
in the edit panel) — same button for both tracks. The agent never touches
`main`, and never submits anything anywhere.

## On-demand runs

- **From the app**: the `✦ run agent now` button on /tasks stamps a request;
  the `Mindboard Agent Poll` scheduled task (every 5 min,
  `run.mjs --if-requested`) claims it via the `claim_agent_run` MCP tool and
  fires a full run.
- **`✦ do it` on a task** (the day stream): writes a `task_dispatches` row +
  an `## Operator note` into the task. It stamps **no** run request — **every**
  run, poll or nightly, drains the dispatch queue first (up to 3 per run,
  oldest fresh request first), so the row alone is enough and a dispatch never
  drags a full sweep along behind it. One task may have one live dispatch at a
  time. A narrowed run (`--plan-only`, `--build-only`, `--code-only`,
  `--life-only`) skips the drain.
- **From Claude Code**: the `/overnight` skill, or directly, e.g.
  `node overnight\run.mjs --life-only --plan-only` (triage + propose only).

## Targeted runs (`--task`)

```powershell
node overnight\run.mjs --task <task-uuid>          # claim + run that task's dispatch
node overnight\run.mjs --dry --task <task-uuid>    # print the prompt + profile, claim nothing
```

`--task` claims the pending dispatch for that one task
(`claim_task_dispatch { taskId }`); with none pending it logs and exits 0. The
id must be a task uuid, and a bare `--task` with no id is a usage error
(exit 2) — never a silent full sweep; both exit before touching the network.

A claim that dies (machine asleep, crash) goes stale after 60 minutes, and
because every poll drains the queue, the next one re-claims it. A dispatch
that keeps killing its run is retired as failed after **3** claims
(`gave up after 3 attempts`) rather than eating a poll forever.

### First-run checklist (do this once, before pointing it at anything real)

1. Apply `supabase/migrations/0047_task_dispatches.sql` (agents never apply
   migrations — this one is yours to run).
2. Make a sandbox task, e.g. "agent smoke test".
3. On the day stream, tap `✦ do it` and send the note
   `write hello.md in the agent workspace`.
4. Run it in the foreground: `node overnight\run.mjs --task <task-uuid>`.
5. Check all three: `../mindboard-agent-workspace/hello.md` exists, the task
   notes carry `## Operator note` + `## Agent result`, and the
   `task_dispatches` row reads `done` with a `finished_at`.

## Setup (once)

1. Create `overnight/.env` (gitignored — the PAT is a secret):

   ```ini
   MINDBOARD_URL=https://<your-vercel-domain>
   MINDBOARD_PAT=mbp_...            # settings → MCP connection → personal token
   # optional:
   # OVERNIGHT_PREVIEW_TEMPLATE=https://mindboard-git-{branch}-<team>.vercel.app
   # OVERNIGHT_PLAN_MODEL=fable-5   # fable-5 | opus-5 | opus-4.8 | gpt-5.6-sol (app setting wins)
   # OVERNIGHT_BUILD_MODEL=gpt-5.6-sol
   # OVERNIGHT_EFFORT=high
   # OVERNIGHT_PROXY_URL=http://127.0.0.1:8317   # claudex / CLIProxyAPI
   # OVERNIGHT_PROXY_EXE=C:\path\to\cli-proxy-api.exe  # auto-start when down
   # OVERNIGHT_MAX_PLANS=3          # plans per night
   # OVERNIGHT_MAX_BUILDS=2         # builds per night
   # OVERNIGHT_PLAN_BUDGET_USD=3    # per plan run
   # OVERNIGHT_BUILD_BUDGET_USD=15  # per build run
   # OVERNIGHT_MAX_LIFE=3           # life-task executions per run
   # OVERNIGHT_LIFE_BUDGET_USD=5    # per life-task run
   # OVERNIGHT_TRIAGE_MODEL=haiku   # cheap triage model
   # OVERNIGHT_DISPATCH_BUDGET_USD=10   # per dispatched (✦ do it) run
   # OVERNIGHT_DISPATCH_TIMEOUT_MIN=45  # hard timeout for one dispatch; clamped
   #                                    # to 50 — a claim goes stale at 60 min
   # OVERNIGHT_CLAUDE_BIN=claude    # or a proxy shim, e.g. claudex for gpt-5.6-sol
   # OVERNIGHT_REVIEW=1             # 0 disables the post-push build review
   # OVERNIGHT_REVIEW_MODEL=opus-5
   # OVERNIGHT_REVIEW_EFFORT=xhigh  # opus-5 house rule: xhigh, never max
   # OVERNIGHT_REVIEW_BUDGET_USD=4  # per review run
   # OVERNIGHT_REVIEW_TIMEOUT_MIN=15
   # DIGEST_MODEL=haiku             # digest.ps1 (morning report / finance digest)
   # DIGEST_BUDGET_USD=1
   ```

2. Dry run (no Claude spawned, no writes):

   ```powershell
   node overnight\run.mjs --dry
   ```

3. Register the 4am task (elevated PowerShell):

   ```powershell
   .\overnight\install-task.ps1
   ```

## Day-to-day

- Capture app ideas into the **mindboard** group from your phone.
- Next morning: tasks show `✦ plan ready`; read the plan in the notes, tap
  **approve build** (or **dismiss**).
- The following night the build runs; `✦ built` + preview URL land in the
  notes, followed by an **AI review** section: an adversarial read-only pass
  over the diff (default opus-5) ending in `VERDICT: ship` or
  `VERDICT: caution` with file:line findings. A branch whose review failed
  says so — read the diff yourself before merging that one. Merge the
  `ai/<slug>` branch when happy; **retry tonight** re-queues a failed one.
- `--plan-only` / `--build-only` narrow a manual run:
  `node overnight\run.mjs --build-only`.

## Safety

- Every write goes through the MCP propose → confirm rails and is visible in
  the `ai_audit_log` (`list_proposals`).
- Plan runs are read-only (plan mode). Build runs are confined to their
  worktree with a whitelisted tool set; the orchestrator does all git.
- Dispatched (`✦ do it`) runs get the widest profile: shell and files, with
  `--allowedTools Bash(*)` and `--strict-mcp-config` (no MCP server reaches
  the child — the orchestrator owns every Mindboard write). **The real
  isolation is the working directory**: the run happens in
  `../mindboard-agent-workspace`, not in a repo you care about.
- On top of that sit two *best-effort* layers, not a sandbox. A disallowed
  pattern list (`git push*`, `git -C*`, `git merge*`, `git rebase*`,
  `git reset --hard*`, and the `main` checkout/switch/branch spellings)
  catches the obvious ways to wreck a checkout — a determined or creative
  command line can still get around pattern matching. And the prompt carries
  `dispatch-capabilities.md` verbatim: prepare/research/build/draft only,
  never send, sign, purchase, publish, or submit in the user's name; no
  credential handling; graded coursework submission stays a human action;
  never operate on a repo outside the workspace (clone or worktree it in
  instead); `ai/*` branches only, never `main`.
- Per-run `--max-budget-usd` and `--max-turns`, plus nightly plan/build caps.
- Kill switch: `Disable-ScheduledTask -TaskName "Mindboard Overnight Agent"`,
  or revoke the PAT in settings (every MCP call dies instantly).
- Logs: `overnight/logs/<date>.log`. Failed builds keep their worktree under
  `../mindboard-ai/` for inspection.

## Scheduled digests

`digest.ps1` runs a cheap headless Claude (haiku by default) against the
Mindboard MCP and captures the result to the brain vault + a local mirror in
`overnight/logs/digest-*.md`:

- **Morning report** (daily 08:03): last night's orchestrator outcomes —
  including silent FATALs the logs would otherwise swallow — plus today's
  plan from `get_snapshot`/`tasks_snapshot`. Captured as
  "Morning report — date".
- **Finance digest** (Mondays 08:33): `finance_snapshot` + `finance_forecast`
  + last week's ledger — net-worth trend, anomalies, upcoming bills, and the
  projected low point. Captured as "Finance digest — week of date".

Register both with `.\overnight\install-digests.ps1`; test one with
`powershell -File overnight\digest.ps1 -Kind morning`. Remove with
`Unregister-ScheduledTask -TaskName "Mindboard Morning Report" -Confirm:$false`
(same for `"Mindboard Finance Digest"`).

