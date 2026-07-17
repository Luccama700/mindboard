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

Approve/dismiss happens on the task row in the app (the `ai build` controls
in the edit panel) — same button for both tracks. The agent never touches
`main`, and never submits anything anywhere.

## On-demand runs

- **From the app**: the `✦ run agent now` button on /tasks stamps a request;
  the `Mindboard Agent Poll` scheduled task (every 5 min,
  `run.mjs --if-requested`) claims it via the `claim_agent_run` MCP tool and
  fires a full run.
- **From Claude Code**: the `/overnight` skill, or directly, e.g.
  `node overnight\run.mjs --life-only --plan-only` (triage + propose only).

## Setup (once)

1. Create `overnight/.env` (gitignored — the PAT is a secret):

   ```ini
   MINDBOARD_URL=https://<your-vercel-domain>
   MINDBOARD_PAT=mbp_...            # settings → MCP connection → personal token
   # optional:
   # OVERNIGHT_PREVIEW_TEMPLATE=https://mindboard-git-{branch}-<team>.vercel.app
   # OVERNIGHT_PLAN_MODEL=fable-5   # fable-5 | opus-4.8 | gpt-5.6-sol (app setting wins)
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
   # OVERNIGHT_CLAUDE_BIN=claude    # or a proxy shim, e.g. claudex for gpt-5.6-sol
   ```

2. Dry run (no Claude spawned, no writes):

   ```powershell
   node overnight\run.mjs --dry
   ```

3. Register the 4am task (elevated PowerShell):

   ```powershell
   .\overnight\install-task.ps1
   ```

## Onboarding persona audit

The separate persona runner exercises onboarding in a mobile Playwright browser.
`gpt-5.6-sol` sees each screenshot plus a numbered list of safe controls, acts
as an impatient teenager, and can quit early when attention is lost. It cannot
type or click account-mutating controls. A run resets tours through the existing
settings button, keeps a 40-step total cap across two scenarios, writes
`logs/persona-<date>.md`, captures the report to the brain, and files one
`mindboard` task per new finding through MCP's propose → confirm audit rail.

One-time browser and authenticated-session setup (the state file is gitignored):

```powershell
npx playwright install chromium
node overnight\persona\save-auth.mjs
```

Run it headless, visibly, or without browser/model/network writes:

```powershell
node overnight\persona\run.mjs
node overnight\persona\run.mjs --headed --scenario=first-minute
node overnight\persona\run.mjs --dry-run
```

Optional environment settings are `PERSONA_URL`, `PERSONA_MODEL` (kept at
`gpt-5.6-sol`), `PERSONA_MAX_STEPS`, `PERSONA_MODEL_TIMEOUT_SEC`, and
`PERSONA_AUTH_FILE`. Use `--no-file-tasks` or `--no-brain-capture` when auditing
locally without publishing those outputs.

## Day-to-day

- Capture app ideas into the **mindboard** group from your phone.
- Next morning: tasks show `✦ plan ready`; read the plan in the notes, tap
  **approve build** (or **dismiss**).
- The following night the build runs; `✦ built` + preview URL land in the
  notes. Merge the `ai/<slug>` branch when happy; **retry tonight** re-queues
  a failed one.
- `--plan-only` / `--build-only` narrow a manual run:
  `node overnight\run.mjs --build-only`.

## Safety

- Every write goes through the MCP propose → confirm rails and is visible in
  the `ai_audit_log` (`list_proposals`).
- Plan runs are read-only (plan mode). Build runs are confined to their
  worktree with a whitelisted tool set; the orchestrator does all git.
- Per-run `--max-budget-usd` and `--max-turns`, plus nightly plan/build caps.
- Kill switch: `Disable-ScheduledTask -TaskName "Mindboard Overnight Agent"`,
  or revoke the PAT in settings (every MCP call dies instantly).
- Logs: `overnight/logs/<date>.log`. Failed builds keep their worktree under
  `../mindboard-ai/` for inspection.
