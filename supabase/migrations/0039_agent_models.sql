-- Per-user model choice for the overnight agent (docs/overnight-agent-plan.md):
-- which model plans (Track A plan mode) and which implements (Track A builds +
-- Track B life execution). Null = the orchestrator's defaults (plan: fable-5,
-- build: gpt-5.6-sol via the local claudex proxy, falling back to opus-4.8).
-- Values are validated in code against a whitelist, not a CHECK, so new
-- models don't need a migration.
alter table public.user_settings
  add column agent_plan_model text,
  add column agent_build_model text;
