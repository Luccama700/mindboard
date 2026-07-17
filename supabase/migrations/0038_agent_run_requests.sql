-- On-demand overnight-agent runs (docs/overnight-agent-plan.md): the app's
-- "run agent now" button stamps a request; the PC's 5-minute poll claims it
-- through the MCP claim_agent_run tool (clear + report). Pull-based like the
-- home worker — no inbound ports to the PC.
alter table public.user_settings
  add column agent_run_requested_at timestamptz;
