-- ============================================================================
-- The v2 engine's clock: one pg_cron job every ten minutes that posts to the
-- tick route. Ten minutes is the watchdog's own interval, and the tick is
-- idempotent by construction (every message it queues carries a dedupe key and
-- every send is claimed with one conditional update), so a doubled or a missed
-- run costs nothing.
--
-- NOT APPLIED. Nothing in this file has run against any database. It is also
-- the last thing to apply, not the first: 0066 and the route it calls must be
-- live before the schedule exists, or the job posts into a 404 every ten
-- minutes.
--
-- WHAT MUST EXIST FIRST, all three switched on by the project owner in the
-- Supabase Dashboard rather than by this file, because enabling an extension
-- needs rights a migration role may not hold:
--   1. pg_cron        Dashboard -> Integrations -> Cron. 0061 installs it for
--                     the nightly prune; if that migration has been applied,
--                     this prerequisite is already met.
--   2. pg_net         Dashboard -> Database -> Extensions -> pg_net. This is
--                     what gives the database net.http_post.
--   3. Supabase Vault Dashboard -> Project Settings -> Vault, holding exactly
--                     two secrets, by these names:
--                       v2_tick_url     the full address of the tick route
--                       v2_cron_secret  the value of V2_CRON_SECRET, which the
--                                       route compares in constant time
-- Neither value appears anywhere in this repository. The job reads both out of
-- the vault at run time and sends the second as a bearer credential, so
-- rotating either one is a vault edit and needs no migration. While a secret
-- is missing the job does nothing at all, rather than failing every ten
-- minutes: the guard at the bottom of the job body is what makes that true.
--
-- TO REMOVE IT:
--   select cron.unschedule('mindboard-v2-tick');
--
-- Note on time: the schedule is UTC, like every pg_cron schedule, and that is
-- deliberate. Nothing here knows or needs a local hour. The tick itself decides
-- what to do in the account's own zone, which it reads from the rules document
-- and resolves through app/lib/snapshots/zoned-time.ts. No local time is
-- computed in SQL.
-- ============================================================================

-- Unschedule first, so re-running this file never stacks a second job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'mindboard-v2-tick') then
    perform cron.unschedule('mindboard-v2-tick');
  end if;
end;
$$;

-- The body is dollar-quoted, so only `cron` resolves when this file is applied
-- and the vault is read on every run instead of once at apply time.
--
-- timeout_milliseconds is explicit at 55 seconds, just under the route's own
-- maxDuration of 60: pg_net defaults to 5 seconds, which a tick that plans a
-- day and sends a message can exceed, and a timed-out request would be
-- retried as a fresh tick ten minutes later with the first one still running.
select cron.schedule(
  'mindboard-v2-tick',
  '*/10 * * * *',
  $job$
    with secret as (
      select
        (select decrypted_secret from vault.decrypted_secrets where name = 'v2_tick_url')
          as url,
        (select decrypted_secret from vault.decrypted_secrets where name = 'v2_cron_secret')
          as token
    )
    select net.http_post(
      url := s.url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || s.token
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
      from secret s
     where s.url is not null
       and s.token is not null;
  $job$
);
