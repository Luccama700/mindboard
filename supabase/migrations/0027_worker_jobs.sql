-- ============================================================================
-- mindboard home-worker queue (L3 of docs/education-plan.md): a pull-based
-- jobs table the always-on PC polls through /api/worker. Claims are atomic
-- (FOR UPDATE SKIP LOCKED) with stale-heartbeat reclaim; three strikes dead-
-- letter the job.
-- ============================================================================

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ocr', 'tts')),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'done', 'failed')
  ),
  attempts integer not null default 0,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  error text,
  result jsonb,
  created_at timestamptz not null default now()
);

create index jobs_queue_idx on public.jobs (status, created_at);

alter table public.jobs enable row level security;

-- The app (session client) inserts and reads the user's own jobs; the worker
-- reaches them only through /api/worker on the service client.
create policy jobs_select_own on public.jobs
  for select using (auth.uid() = user_id);
create policy jobs_insert_own on public.jobs
  for insert with check (auth.uid() = user_id);
create policy jobs_update_own on public.jobs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy jobs_delete_own on public.jobs
  for delete using (auth.uid() = user_id);

-- One heartbeat row per user; the settings "home worker" card reads it.
create table public.worker_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  info jsonb not null default '{}'
);

alter table public.worker_status enable row level security;

create policy worker_status_select_own on public.worker_status
  for select using (auth.uid() = user_id);

-- Atomic claim: oldest queued job, or a processing job whose worker went
-- silent for 10+ minutes (crash reclaim). Three attempts dead-letters.
create or replace function public.claim_next_job()
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
    order by created_at
    limit 1
    for update skip locked
  )
  returning *;
$$;

-- Only the service role (via /api/worker) may claim.
revoke all on function public.claim_next_job() from public;
revoke all on function public.claim_next_job() from anon;
revoke all on function public.claim_next_job() from authenticated;
