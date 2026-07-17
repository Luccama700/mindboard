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

### Track B — life tasks (shipped 2026-07-17)

Every open task outside the mindboard group flows through the same
`ai_state` lifecycle:

1. **Triage.** One cheap model call (default haiku) over all untouched life
   tasks against the checked-in `overnight/capabilities.md` manifest
   (CAN: research/plan/draft/prep · CANNOT: accounts, physical actions,
   reminders · NEVER: submit/send/purchase, graded academic work). Feasible
   tasks get an `## AI approach` section in the notes + `ai_state='planned'`
   — the same badge and approve button as code tasks. Infeasible verdicts are
   cached in `overnight/state.json` (gitignored; a retitle re-triages).
2. **Approve.** Same user-only gate.
3. **Execute.** Per approved task, a bounded `claude -p` with
   **WebSearch/WebFetch only** (`dontAsk` mode — shell and file edits are
   denied), cwd in a workspace outside the repo so no project context loads.
   Deliverable: summary into the task notes (`## AI result`), full text into
   the brain vault via `capture_to_brain`, `ai_state='built'`.

### Models (shipped 2026-07-17)

Per-phase, per-user (settings → overnight agent; `user_settings.
agent_plan_model` / `agent_build_model`, migration 0039; ids in
`app/_components/agent-models.ts`, mirrored by `MODEL_CHOICES` in
`overnight/lib.mjs`): **plan** defaults to `fable-5`, **implementation**
(code builds + life execution) to `gpt-5.6-sol` through the local
claudex/CLIProxyAPI proxy — the orchestrator health-checks the proxy,
auto-starts it (`OVERNIGHT_PROXY_EXE`) and degrades to `opus-4.8` if it stays
down. All runs pass `--effort high` (triage: haiku, effort low). The app
setting wins over the env defaults; unknown ids fall back safely.

### On-demand runs (shipped 2026-07-17)

Besides 4am, runs can be triggered any time, still pull-based:

- **In-app**: the `✦ run agent now` button on /tasks (`requestAgentRun`
  server action) stamps `user_settings.agent_run_requested_at` (migration
  0038). A second scheduled task polls every 5 minutes with
  `run.mjs --if-requested`, which claims the request through the fenced
  `claim_agent_run` MCP tool (atomic clear-and-report) and exits silently
  when there is none.
- **From Claude Code on the PC**: the `/overnight` skill
  (`.claude/skills/overnight/SKILL.md`) or `node overnight/run.mjs` with
  `--code-only / --life-only / --plan-only / --build-only / --dry`.

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
