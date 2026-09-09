-- 'declined': the overnight triage judged the task infeasible for the agent
-- (docs/superpowers/specs/2026-09-09-agent-handoff-design.md). The reason
-- lands in tasks.notes under "## AI triage — <date>"; the app shows
-- ✦ not taken and pre-opens ✦ follow up. Clearing the badge (ai_state back
-- to null) re-triages on the next run — the DB state replaces the old
-- overnight/state.json infeasible cache as the skip signal.
alter table public.tasks drop constraint tasks_ai_state_check;
alter table public.tasks add constraint tasks_ai_state_check check (
  ai_state in ('planned', 'approved', 'building', 'built', 'failed', 'declined')
);
