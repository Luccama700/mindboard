-- Overnight agent (docs/overnight-agent-plan.md): ai_state tracks the
-- feature-loop lifecycle on tasks the nightly orchestrator works.
--   null      not an AI task / untouched
--   planned   a plan is waiting in the notes for the user's approval
--   approved  user tapped "approve build" — next nightly run implements it
--   building  a build run has claimed it (crash-visible, not a lock)
--   built     branch pushed, preview URL in the notes
--   failed    build gate failed; diagnosis in the notes
alter table public.tasks
  add column ai_state text check (
    ai_state in ('planned', 'approved', 'building', 'built', 'failed')
  );
