# Overnight agent

The nightly orchestrator (design: `docs/overnight-agent-plan.md`). At 4am it
pulls open tasks from the **mindboard** group over MCP and:

- **plans** untouched ideas — headless Claude Code in plan mode (read-only),
  plan appended to the task notes, badge flips to `✦ plan ready`;
- **builds** approved ones — fresh `git worktree`, headless Claude Code with
  edit permissions, then an authoritative `lint → test → build` gate, a push
  to `ai/<slug>`, and the Vercel preview URL written back into the notes.

Approve/dismiss happens on the task row in the app (the `ai build` controls
in the edit panel). The agent never touches `main`.

## Setup (once)

1. Create `overnight/.env` (gitignored — the PAT is a secret):

   ```ini
   MINDBOARD_URL=https://<your-vercel-domain>
   MINDBOARD_PAT=mbp_...            # settings → MCP connection → personal token
   # optional:
   # OVERNIGHT_PREVIEW_TEMPLATE=https://mindboard-git-{branch}-<team>.vercel.app
   # OVERNIGHT_MODEL=claude-opus-4-8
   # OVERNIGHT_MAX_PLANS=3          # plans per night
   # OVERNIGHT_MAX_BUILDS=2         # builds per night
   # OVERNIGHT_PLAN_BUDGET_USD=3    # per plan run
   # OVERNIGHT_BUILD_BUDGET_USD=15  # per build run
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
