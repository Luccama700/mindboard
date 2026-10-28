-- ============================================================================
-- Retention prune (audit finding M9: "no retention" — ai_audit_log payloads,
-- jobs.payload, URC history and dormant Google refresh tokens are kept
-- forever). One nightly pg_cron job calls one SECURITY DEFINER function that
-- deletes operational exhaust only.
--
-- WHAT THIS NEVER TOUCHES, and must not start touching: anything the user can
-- see in the product. tasks, notes, daily_logs, finance rows, inventory,
-- people, courses, goals, ai_conversations / ai_messages (the assistant chat
-- the user can scroll back through) and the whole mindspace are product
-- history, not logs. Deleting a user's own history without being asked is the
-- opposite of the finding this closes. Only an account delete removes those.
--
-- NOT APPLIED. Enabling pg_cron needs elevated rights: if `create extension`
-- below fails for the migration role, enable it first in the Supabase
-- Dashboard under Integrations -> Cron, then re-run this file.
-- ============================================================================

-- pg_cron creates and owns its own `cron` schema; Supabase's documented
-- install puts the extension itself in pg_catalog (NOT in `extensions`, which
-- is the convention for pg_net/vector — pg_cron is the exception).
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;

-- ----------------------------------------------------------------------------
-- The prune itself. SECURITY DEFINER because it reads auth.users (which the
-- app's roles cannot) and because cron must run it without a session;
-- search_path is pinned, with pg_temp last so a temp object can never shadow
-- a referenced table. Returns the per-rule row counts so the job's entry in
-- cron.job_run_details says what it actually removed.
-- ----------------------------------------------------------------------------
create or replace function public.prune_retained_rows()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  jobs_removed            bigint := 0;
  audit_removed           bigint := 0;
  urc_jobs_removed        bigint := 0;
  urc_log_removed         bigint := 0;
  google_tokens_removed   bigint := 0;
begin
  -- Worker queue, 90 days. A terminal job is a receipt for work that already
  -- landed (the vault note, the episode row, the follow-up task); its payload
  -- still carries task notes and reel/course text, so it is exhaust worth
  -- ageing out. 'queued'/'processing' are deliberately exempt — a PC that has
  -- been offline for months must still find its queue intact.
  delete from public.jobs
  where status in ('done', 'failed')
    and created_at < now() - interval '90 days';
  get diagnostics jobs_removed = row_count;

  -- Assistant audit log, 180 days. Resolved rows ('executing', 'executed',
  -- 'rejected', 'error') hold the full tool input — including finance rows
  -- read off a statement screenshot. Six months is long enough to answer
  -- "what did the assistant do to my data"; 'proposed' rows are NEVER pruned
  -- here because they are live state (confirm_action resolves them, and the
  -- executors re-read the stored input), so expiring one would silently break
  -- an open propose -> confirm.
  delete from public.ai_audit_log
  where status <> 'proposed'
    and created_at < now() - interval '180 days';
  get diagnostics audit_removed = row_count;

  -- URC spawn requests, 30 days. A job is dead within two minutes of being
  -- queued (expires_at) and holds the private claude.ai session url of a
  -- remote-control session; the shortest window of the five is deliberate.
  -- urc_log.job_id is `on delete set null`, so the event history survives
  -- this as anonymous rows and ages out on its own 90-day rule below.
  delete from public.urc_jobs
  where created_at < now() - interval '30 days';
  get diagnostics urc_jobs_removed = row_count;

  -- URC event history, 90 days. The one record of "a session ran on the PC",
  -- so it outlives the jobs themselves — but it is an operator log, not
  -- product history. Note the column is `at`, not `created_at`.
  delete from public.urc_log
  where at < now() - interval '90 days';
  get diagnostics urc_log_removed = row_count;

  -- Dormant Google credentials, 180 days (audit finding H4). A refresh token
  -- for an account nobody has signed into in six months is a standing grant
  -- on that person's calendar with nothing using it. Losing it costs the user
  -- nothing: /auth/callback re-writes the row from the OAuth session on the
  -- next sign-in.
  --
  -- "Dormant" needs BOTH signals. last_sign_in_at alone is wrong: a session
  -- refresh and the MCP connector don't bump it, so a long-lived PWA session or
  -- a connector-only user would lose calendar access while actively using it.
  -- google_tokens.updated_at moves on every access-token refresh, and access
  -- tokens expire hourly, so any calendar use in the window keeps the row.
  delete from public.google_tokens g
  using auth.users u
  where u.id = g.user_id
    and g.updated_at < now() - interval '180 days'
    and (u.last_sign_in_at is null or u.last_sign_in_at < now() - interval '180 days');
  get diagnostics google_tokens_removed = row_count;

  return jsonb_build_object(
    'jobs', jobs_removed,
    'ai_audit_log', audit_removed,
    'urc_jobs', urc_jobs_removed,
    'urc_log', urc_log_removed,
    'google_tokens', google_tokens_removed
  );
end;
$$;

-- Only the owner (and therefore cron) may run it. A definer function that
-- deletes rows across every tenant must never be reachable from a session
-- JWT, and Postgres grants EXECUTE to PUBLIC by default — so revoking from
-- anon/authenticated alone would not be enough.
revoke all on function public.prune_retained_rows() from public;
revoke all on function public.prune_retained_rows() from anon;
revoke all on function public.prune_retained_rows() from authenticated;

-- ----------------------------------------------------------------------------
-- One nightly job, 03:27 UTC (off the hour so it does not collide with the
-- hourly jobs every other Supabase project schedules). Unschedule-if-exists
-- first so re-running this file never stacks duplicates.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'mindboard-retention-prune') then
    perform cron.unschedule('mindboard-retention-prune');
  end if;
end;
$$;

select cron.schedule(
  'mindboard-retention-prune',
  '27 3 * * *',
  $job$select public.prune_retained_rows();$job$
);
