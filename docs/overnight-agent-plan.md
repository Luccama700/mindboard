# Overnight Agent Plan

Design record for the overnight AI worker: a nightly orchestrator on the
always-on PC that picks up Mindboard tasks and does real work on them while
the user sleeps. This is the "proactive planner" leg of
`docs/second-brain-plan.md` — the third consumer the agent tool layer was
built for.

Decided 2026-07-16 with the user:

- **Task state is a real column** — `tasks.ai_state` (migration 0036), not a
  title prefix. The plan text itself lands in `tasks.notes` (appended
  section), where the existing task panel already renders Markdown.
- **Delivery is branch + Vercel preview** — overnight builds push to
  `ai/<slug>` branches only; the preview URL goes into the task notes; the
  user merges from their phone. The agent never touches `main`.
- **Feature loop ships first** (Track A below). General-task triage (Track B),
  Siri capture, and the UI-redesign track come later, in that order.
- **The PC is on or asleep at 4am** — Task Scheduler wakes it ("wake to run");
  no catch-up-on-boot logic needed in v1.

## Architecture

One orchestrator script, `overnight/run.mjs`, fired daily at 4:00 AM by
Windows Task Scheduler (`overnight/install-task.ps1` registers it). It talks
to the deployed app **as an MCP client** using the user's `mbp_` PAT — the
same multi-tenant rails every other AI surface uses, so every write flows
through propose → confirm and lands in the `ai_audit_log`. No new server
transport, no database key on the PC (same posture as `worker/worker.py`).

### Track A — the Mindboard feature loop (v1)

`ai_state` lifecycle: `null → planned → approved → building → built | failed`.

1. **Plan.** The orchestrator pulls open tasks in the `mindboard` group with
   `ai_state` null (`list_code_tasks`). For each, it runs
   `claude -p --permission-mode plan --output-format json` in the repo
   (read-only — safe unattended), captures the plan, appends it to
   `tasks.notes` under an `## AI plan` heading, and sets `ai_state='planned'`
   via `update_task` + `confirm_action`.
2. **Approve.** The user reads the plan in the task panel and taps
   **approve build** (or **clear**) — a plain server action; user-initiated
   writes don't need proposals. The gate is server-enforced:
   `validateUpdateTask` rejects `aiState:'approved'`, so no MCP client (the
   orchestrator included) can approve a build — only the session-authed
   in-app action can.
3. **Build.** Next run, approved tasks each get a fresh `git worktree`;
   `claude -p --permission-mode acceptEdits` implements the plan; the gate is
   `npm run lint && npm run test && npm run build`. Green → commit, push
   `ai/<slug>`, write the branch + preview URL into the notes,
   `ai_state='built'`. Red or over budget → `ai_state='failed'` with a short
   diagnosis in the notes; the worktree is kept for inspection.

### Track B — general-task triage (v2, not yet built)

A cheap triage call (Haiku, task list + a checked-in
`overnight/capabilities.md` manifest) marks which non-code tasks the agent
can advance and how (research, drafting, browser via Playwright MCP with a
persistent logged-in profile). Each feasible task gets its own bounded
`claude -p` (or `codex exec`) run. Output contract: short summary into the
task notes, long output as a vault note, one "Night Report — {date}" via
`capture_to_brain`.

## Safety rails (non-negotiable)

- `--max-budget-usd` and `--max-turns` on every spawned run, plus a nightly
  total cap in the orchestrator.
- Planning runs are plan-mode (read-only). Build runs are confined to their
  worktree and never push to `main`.
- **Draft-never-submit**: browser/computer-use tasks may read, navigate, and
  draft, but never submit forms, purchases, messages, or graded work.
- Kill switch: disable the scheduled task, or delete the PAT in settings
  (every MCP call dies immediately).
- Logs: one file per night under `overnight/logs/`, plus per-task reporting
  in the task notes themselves.

## Non-goals

- No automation of graded academic work (quizzes, exams, submitted
  assignments) — prep and research only.
- No cloud execution in v1 — the repo, worktrees, and `claude` auth live on
  the PC; the app only stores state (`ai_state`, notes) and serves reads.
- Claude-in-Chrome is not used overnight (requires a visible window);
  unattended browser work is Playwright MCP, and only in Track B.
