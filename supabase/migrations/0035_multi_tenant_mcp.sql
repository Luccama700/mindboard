-- ============================================================================
-- Multi-tenant MCP: per-user token metadata + home-worker allowlist.
--
-- 1. user_settings gains display metadata for the per-user MCP personal access
--    token (the hash column itself exists since 0016_mcp_server): a last-4
--    hint and the generation timestamp for the /settings connection card.
--
-- 2. claim_next_job() gains an allowed_users uuid[] parameter so the shared
--    home worker only ever claims jobs from users the deployment owner has
--    allowlisted (WORKER_ALLOWED_USER_IDS env + the owner). The parameter
--    defaults to null = no filter, ONLY so already-deployed code calling the
--    zero-arg signature keeps working during the deploy window; the app always
--    passes the explicit list.
--
-- Idempotent: add column if not exists / drop function if exists / replace.
-- ============================================================================

alter table public.user_settings
  add column if not exists mcp_token_hint text,
  add column if not exists mcp_token_created_at timestamptz;

drop function if exists public.claim_next_job();

create or replace function public.claim_next_job(allowed_users uuid[] default null)
returns setof public.jobs
language sql
security definer
set search_path = public
as $$
  update public.jobs
  set status = 'processing',
      attempts = attempts + 1,
      claimed_at = now(),
      heartbeat_at = now()
  where id = (
    select id from public.jobs
    where (
      status = 'queued'
      or (status = 'processing' and heartbeat_at < now() - interval '10 minutes')
    )
    and attempts < 3
    and (allowed_users is null or user_id = any(allowed_users))
    order by created_at
    limit 1
    for update skip locked
  )
  returning *;
$$;

-- Only the service role (via /api/worker) may claim.
revoke all on function public.claim_next_job(uuid[]) from public;
revoke all on function public.claim_next_job(uuid[]) from anon;
revoke all on function public.claim_next_job(uuid[]) from authenticated;
