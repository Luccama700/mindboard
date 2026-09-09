# Agent hand-off: plan → do it → follow up, watchable — Design

Date: 2026-09-09
Status: approved in chat (Lucca, 2026-09-09); spec pending review

## Summary

Mindboard has three ways to hand a task to the home PC, built at different
times and not joined up:

- the **overnight loop** on `main` (`overnight/run.mjs`, `docs/overnight-agent-plan.md`):
  plan/triage → `✦ plan ready` → approve → build/execute at 4am or on a
  manual "run agent now";
- **follow-ups** on `main` (`app/lib/watch/followup.ts`, `worker/worker.py`,
  PRs #19/#20): a dictated or typed instruction the PC turns into a new task;
- **task dispatch** in PR #1 (`ai/task-dispatch`, July): "✦ do it" — a one-shot
  note, a queue row, a full-powers headless executor that writes results into
  the task.

This design makes them one system with one badge language, and makes the
user-initiated runs visible in the Claude Code app as Remote Control sessions.
Three sub-projects, shipped in order:

1. **Dispatch on main** — land PR #1 on today's `main`.
2. **One lifecycle** — approve acts within five minutes; declined tasks say so
   and offer follow-up.
3. **Remote Control executor** — user-initiated runs on the PC become
   named, watchable, steerable sessions.

### Goals

- Review a plan and act on it right away: approve → the PC starts within the
  5-minute poll window, badge moves `✦ queued → ✦ working… → ✦ done`.
- "✦ do it" for the cases where a note is enough and no plan is wanted.
- Follow-up is the explicit fallback when the AI won't take a task for a plan:
  the app says so, with the reason, and puts the follow-up composer right there.
- Every user-initiated PC run (do it, approved execution, follow-up) shows up
  under Remote Control on the phone and in the desktop app while it works, and
  stays open long enough to jump in.

### Non-goals

- No per-task chat surface in the app (the dispatch row stays "thread-root
  shaped", as PR #1 designed, but no thread UI ships here).
- The 4am batch (plans, triage, unattended builds) stays headless — there is
  nothing to watch and the proxy-model builds cannot use Remote Control anyway.
- No change to what the executors are *allowed* to do. PR #1's
  `overnight/dispatch-capabilities.md` (full local powers, never submit /
  send / sign / purchase, never `main`, never `git push`) and Track B's
  `overnight/capabilities.md` stay the contracts verbatim.
- No auto-queued follow-ups. A follow-up is an intent the user expresses.

## Current state (what each piece does today)

| Piece | Entry point | Queue | Executor on the PC | Result |
|---|---|---|---|---|
| Overnight code track (A) | 4am / `✦ run agent now` on `/tasks` (`requestAgentRun` stamps `user_settings.agent_run_requested_at`; `claim_agent_run` MCP tool claims it from the 5-min poll `run.mjs --if-requested`) | `tasks.ai_state` | `claude -p` plan mode → `planned`; approved → worktree + `claude -p` acceptEdits + lint/test/build gate → branch + preview URL | notes + `ai_state` |
| Overnight life track (B) | same | `tasks.ai_state` | one cheap triage call; feasible → `## AI approach` + `planned`; **infeasible → cached only in `overnight/state.json`, app shows nothing**; approved → `claude -p` web-only | notes + vault |
| Follow-up | task edit panel `✦ follow up`, watch dictation (`queueTaskFollowup` → `queueFollowupFromWatch`) | `jobs` (kind `followup`, migration 0050) | `worker.py` `claude -p --dangerously-skip-permissions`, prompt on stdin, temp `--mcp-config`, JSON result parsed from stdout | a new task, same group/due date |
| Dispatch (PR #1, unmerged) | stream card `✦ do it` → `DispatchSheet` → `requestTaskDispatch` | `task_dispatches` (its migration is numbered 0047, which now collides with the people migration) | `run.mjs` Track C: `claim_task_dispatch` / `update_task_dispatch` MCP tools, drain (cap 3) on every poll and full run, `claude -p` with `Bash(*)` + strict MCP, `$10` budget | `## Agent result` in notes, `ai_state` building → built/failed |

`ai_state` today: `planned | approved | building | built | failed | null`
(migration 0037 check constraint; `app/_components/types.ts`; `AI_STATES` in
`app/lib/mcp/validate.ts`, which rejects `approved` from any MCP client so only
the session-authed app can approve).

Remote Control facts that bound sub-project 3 (Claude Code docs, 2026-09-09):
interactive only, no documented `-p` combination; subscription auth only, API
keys unsupported; refuses a custom `ANTHROPIC_BASE_URL` (so nothing routed
through the `claudex` proxy can be an RC session); telemetry-off variables must
be unset; the session goes offline when its process stops (resumable for ~4h);
no idle auto-exit. Hidden-console launch on Windows and whether `--max-turns` /
`--max-budget-usd` apply outside print mode are undocumented → spike first.

## Sub-project 1 — Dispatch on main

Land PR #1 on today's `main` without changing its behavior.

**Rebase.** `ai/task-dispatch` onto `origin/main` in a worktree. Three known
conflicts:

- `app/actions/tasks.ts`: import block — keep both the follow-up imports
  (`queueFollowupFromWatch`, `validateFollowup`) and PR #1's
  `appendSection` from `app/lib/notes.ts`.
- `app/_components/stream-client.tsx`: keep `main`'s `restMax` (which includes
  `titleOpen`) and add PR #1's `aiBadge` / `aiBadgeNode` above it.
- `app/_components/onboarding/whats-new.ts`: PR #1's entry goes on top with
  today's date and a fresh id (`2026-09-09-do-it`); the follow-up and group-trim
  entries stay in place.

**Migration.** Rename `0047_task_dispatches.sql` → `0051_task_dispatches.sql`
(content unchanged: table, RLS, pending index, one-open-per-task partial unique
index). Apply to the live project via the Supabase MCP after merge (house
rule, memory: migrations are applied, not just committed).

**Gating.** `requestTaskDispatch` gates on `ownerUserId()`; follow-ups gate on
`workerAllowedUserIds()` (multi-tenant allowlist, migration 0035). Switch
dispatch to `workerAllowedUserIds().includes(user.id)` so both hand-offs agree
on who has a PC. Error copy stays "no agent PC serves this account".

**UI placement.** "✦ do it" stays on stream cards (PR #1's `DispatchSheet`).
Add the same button beside "✦ follow up" in the task edit panel
(`app/_components/task-row.tsx`), opening the same sheet, so both hand-offs are
reachable from the same place. Nothing else moves.

**Verification.** PR #1's five test files (`dispatch-sheet`, `mcp-dispatch`,
`notes-append`, `overnight-lib`, `tasks-dispatch-action`) plus the full gate
(`tsc`, lint, test, build). Then merge to `main` via PR.

**PC step (manual, Lucca).** The scheduled tasks run `run.mjs` from the PC's
checkout and nothing pulls; after the merge: `git pull` in
`C:\Users\U\Documents\mindboard\mindboard`. The 5-minute poll then drains
dispatches. First e2e per PR #1's `overnight/README.md` "Targeted runs": one
trivial dispatch ("write hello.md in the workspace").

## Sub-project 2 — One lifecycle

**Data.** Migration `0052_ai_state_declined.sql` widens the check:

```sql
alter table public.tasks drop constraint tasks_ai_state_check;
alter table public.tasks add constraint tasks_ai_state_check
  check (ai_state in ('planned','approved','building','built','failed','declined'));
```

(`tasks_ai_state_check` is the auto-generated name, verified against the live
schema on 2026-09-09; 0050 is the latest applied migration, so 0051/0052 are
free.)

`declined` = the orchestrator judged the task infeasible for it. Meaning by
state, after this change:

| state | who sets it | badge |
|---|---|---|
| `planned` | orchestrator | `✦ plan ready` |
| `approved` | user only | `✦ queued` |
| `building` | orchestrator / executor | `✦ working…` |
| `built` | orchestrator / executor | `✦ done` |
| `failed` | orchestrator / executor | `✦ failed` |
| `declined` | orchestrator (triage) | `✦ not taken` (muted) |
| `null` | user (clear) or untouched | — |

Update the union in `app/_components/types.ts`, `AI_STATES` in
`app/lib/mcp/validate.ts` (the "approved is user-only" rule is unchanged;
`declined` is accepted from the orchestrator like `planned`), and the
`AI_BADGE` map in `task-row.tsx` (PR #1's stream card imports it).

**Orchestrator (`overnight/run.mjs`, `triagePhase`).** On an infeasible
verdict, instead of only caching in `state.json`:

- `updateTask(task.id, { notes: appendSection(base, `AI triage — ${today}`, reason), aiState: "declined" })`
  where `reason` is the verdict's one-line reason followed by
  `*not something I can take on from here — ✦ follow up or ✦ do it if you want the PC to try anyway.*`
- The DB state replaces the on-disk cache as the skip signal: `pickLifeTasks`
  already only picks tasks with `ai_state === null`, so a `declined` task is
  not re-triaged and **clearing the badge in the app re-triages on the next
  run** (that is the retitle rule generalized). `state.infeasible` stays as a
  read-only compatibility field for one release and is no longer written.

**Approve acts now.** `setTaskAiState(id, "approved")` also stamps
`user_settings.agent_run_requested_at` for allowlisted users (the same upsert
`requestAgentRun` does; extract a shared `stampAgentRun(supabase, userId)`
helper in `app/actions/tasks.ts`). The 5-minute poll claims it via
`claim_agent_run` and runs a normal sweep: code builds keep their worktree and
lint/test/build gate; life executions run as today; the dispatch drain runs
too (PR #1 makes it unconditional on polls). Users without a PC in the
allowlist keep today's behavior (4am). Un-approve does not un-stamp; a sweep
with nothing approved is a cheap no-op.

**App.** In the task edit panel, when `aiState === "declined"`:

- the badge row shows `✦ not taken` and, under it, the reason line pulled from
  the latest `## AI triage` section of the notes via a pure helper
  `latestSection(notes, "AI triage")` (new `app/_components/notes-sections.ts`,
  unit-tested; falls back to "see the notes" when absent);
- the follow-up composer opens expanded by default with placeholder
  "tell the PC what to look into instead…";
- `✦ do it` remains available; `clear` (existing `setTaskAiState(id, null)`)
  removes the badge and re-triages next run.

Stream cards show the badge only (they already render `aiBadge` after
sub-project 1). Tours: the `/tasks` tour step that explains `✦ plan ready`
gains one sentence about `✦ not taken`; a what's-new entry ships with it.

**Error handling.** The orchestrator's decline write is inside the existing
per-task try/catch; a failed write logs and leaves the task untouched for the
next run. The approve stamp is best-effort: if the `user_settings` upsert
fails the state change still lands and the action returns the upsert error so
the panel shows it.

**Tests.** `notes-sections.test.ts` (latest section extraction, absent
section, multiple sections); `validate` test for `declined` accepted /
`approved` still rejected; `overnight-lib.test.ts` for the decline note body;
action test that approving calls the stamp for an allowlisted user and skips
it otherwise.

## Sub-project 3 — Remote Control executor

**Where.** `overnight/run.mjs` (Track C dispatches, Track B approved
executions, Track A builds when eligible) and `worker/worker.py`
(`handle_followup`). Both spawn `claude`; both gain an RC launch mode.

**Switches and eligibility.** RC mode is opt-in: `OVERNIGHT_RC=1` (run.mjs)
and `WORKER_RC=1` (worker.py), both read from the existing `.env` files. A run
uses RC only when all of:

1. it is user-initiated (a dispatch, an approved life execution, an approved
   build, or a follow-up) — never `planPhase`/`triagePhase`;
2. its engine is a Claude model on the subscription: no `OVERNIGHT_CLAUDE_BIN`
   shim other than `claude`, no `ANTHROPIC_BASE_URL` for that engine (builds
   on `gpt-5.6-sol` through `claudex` therefore stay headless);
3. the switch is on.

A pure `rcEligible({ userInitiated, engine, env })` in `overnight/lib.mjs`
(unit-tested) decides; worker.py mirrors it in a small function with the same
three rules.

**Launch.** One trusted root, `OVERNIGHT_RC_ROOT` (default
`<OVERNIGHT_WORKSPACE>/rc`), trusted once by hand (`claude` run there
interactively, accept the workspace-trust dialog) because a launched session
cannot answer a dialog. Per run: `<root>/runs/<id>/` holds `prompt.md`,
`mcp.json` (same shape worker.py writes today), and later `result.json`. The
child is started with cwd = `<root>` (trust is checked on the launch
directory), in a **minimized console**:

```
start "" /min cmd /c claude --remote-control <name> --dangerously-skip-permissions
  --mcp-config runs\<id>\mcp.json --strict-mcp-config [--model <id>]
  "Read runs/<id>/prompt.md and do exactly what it says."
```

The positional prompt is deliberately short: the real prompt lives in
`prompt.md`, which sidesteps the Windows 8k command-line limit that PR #1
already works around with stdin for `-p`. Session names: `task-<slug>` for
dispatches and executions, `followup-<slug>` for follow-ups (`slugify` in
`lib.mjs`; worker.py gets a 10-line port). The child's environment is the
parent's minus `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `CLAUDECODE`,
`DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
`DISABLE_GROWTHBOOK`. Hidden launch (`WScript.Shell.Run …, 0`) is used
instead of minimized only if the spike proves it registers.

**Completion protocol.** `prompt.md` ends with the same three closing steps for
every kind of run:

1. write the outcome through MCP exactly as the headless path does today
   (`update_task_dispatch` done/failed + `update_task` notes for dispatches;
   `update_task` notes + `ai_state` for executions; `create_task` for
   follow-ups, which already returns the new id);
2. write `runs/<id>/result.json` — `{ "status": "done"|"failed", "summary": "<≤500 chars>", "created_task_ids": [...] }`;
3. say `DONE` and wait for further instructions.

The worker polls for `result.json` every 15s until the run's existing
timeout (`OVERNIGHT_DISPATCH_TIMEOUT`, life/build timeouts,
`FOLLOWUP_TIMEOUT_SECONDS`). On the file: worker.py reports `complete` to
`/api/worker` from its contents (replacing today's stdout JSON parse); run.mjs
verifies the row/notes were written and repairs them from `result.json` if the
session skipped step 1. Then a **grace timer** (`RC_GRACE_MIN`, default 30)
keeps the session alive so Lucca can open it from the phone or the app and
continue; when it expires the worker kills the process tree
(`taskkill /PID <pid> /T /F`). The session then shows offline in the app and
stays resumable for the docs' ~4h window.

**Fallback.** If the RC child exits within 20s of launch (auth refused, a flag
rejected outside print mode, trust dialog), the same job runs headless through
the unchanged `-p` path, and the run log plus the task notes get one line:
`(ran headless: <first stderr line>)`. Work never stalls on RC.

**Caps.** `--max-turns` / `--max-budget-usd` are passed only if the spike shows
interactive mode accepts them. Either way the run timeout + grace kill is the
hard cap. Because RC requires subscription auth, RC runs consume subscription
usage rather than API dollars; the per-run USD budgets in `.env` do not apply
to them — documented in `overnight/README.md` and `worker/README.md`.

**Spike (before implementing).** `overnight/rc-spike.ps1`, run once on the PC
from the repo checkout. It prints `claude --version` and `claude auth status`,
whether each scrubbed variable is set, then launches three throwaway sessions
from the repo directory (already trusted): `rc-spike-hidden` (hidden console),
`rc-spike-min` (minimized console), and `rc-spike-flags` (minimized, with
`--max-turns 3 --max-budget-usd 1`), each told via a `prompt.md` to reply
`READY` and wait. It reports which processes are still alive after 30s and any
stderr, waits six minutes for Lucca to check Remote Control on the phone / in
the app for the three names and the `READY` replies, then kills all three. The
answers decide: hidden vs minimized launch, and whether the cap flags are
passed. The script is throwaway and is not wired into anything.

**Tests.** `rcEligible` table test; prompt-builder test that the closing steps
and the `runs/<id>` paths are present; `result.json` parsing (well-formed,
missing, malformed → failed with reason) for both run.mjs (`lib.mjs`) and
worker.py (`worker/test_worker.py` if a Python test file exists, else a small
`unittest` file added beside it). PC e2e checklist in `overnight/README.md`:
dispatch a trivial task → `task-<slug>` appears under Remote Control →
`## Agent result` lands → session stays for the grace period → goes offline.

## Data flow (after all three)

```
task edit panel / stream card
  ├─ approve (planned → approved) ──► agent_run_requested_at stamped
  │                                     └─► 5-min poll: claim_agent_run → sweep
  │                                           ├─ builds approved (worktree, gate)      [RC if Claude model]
  │                                           ├─ executes approved life tasks           [RC]
  │                                           └─ drains task_dispatches                 [RC]
  ├─ ✦ do it (note) ──► task_dispatches row ──► same drain
  ├─ ✦ follow up (text) ──► jobs(kind followup) ──► worker.py                            [RC]
  └─ ✦ not taken ◄── triage wrote ai_state declined + ## AI triage
                       (composer pre-opened for ✦ follow up)
4am run: plan + triage headless, builds/executions per the same eligibility.
```

## Rollout order

1. Sub-project 1 → merge → apply 0051 → PC `git pull` → e2e dispatch.
2. Sub-project 2 → merge → apply 0052 → PC `git pull` (orchestrator change).
3. Spike on the PC → decide hidden/minimized and caps → sub-project 3 → merge
   → PC `git pull`, set `OVERNIGHT_RC=1` / `WORKER_RC=1`, trust the RC root
   once, restart the worker → e2e.
4. Docs: AGENTS.md (Task UX + a new "Agent hand-off" section replacing the
   scattered mentions), `overnight/README.md`, `worker/README.md`,
   `whats-new.ts`, the `/tasks` tour step.

## Decisions (2026-09-09)

- Approve → the existing run request + 5-minute poll, not a targeted dispatch,
  so code builds keep their gate.
- RC only for user-initiated runs on Claude models; the 4am batch and
  proxy-model builds stay headless.
- Declined tasks are shown (`✦ not taken` + reason) with the follow-up composer
  offered, never auto-queued.
- A PC spike precedes the RC executor; its result picks hidden vs minimized
  launch and whether cap flags are passed.
