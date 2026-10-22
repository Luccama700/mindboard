-- ============================================================================
-- Applied to production 2026-10-22 (Supabase MCP apply_migration "0054_urc").
-- ============================================================================
-- URC ("remote control"): starting a Claude Code remote-control session on the
-- home PC from a claude.ai chat, through the MCP server. The server never
-- reaches the PC — the PC pulls (heartbeat / claim / report) over
-- POST /api/urc/device with its own device token, exactly like the home worker
-- pulls /api/worker. Nothing here holds a path: the PC reports FOLDER KEYS and
-- the server only ever hands a key back, so a compromised server cannot point
-- a session at an arbitrary directory.
--
-- Three independent gates have to agree before a session starts (defense in
-- depth, one per layer):
--   1. server env   URC_OWNER_USER_ID must equal the MCP caller's user id, and
--                   the static MCP_BEARER_TOKEN is refused (OAuth/PAT only).
--   2. this schema  urc_devices binds a device to one user; the device token is
--                   stored as a SHA-256 hash and works on /api/urc/device only.
--   3. the PC       the agent acts only when URC_ENABLED=true and only on jobs
--                   whose user_id is its configured owner.
-- Permission mode is layer 3 ONLY: URC_BYPASS_PERMISSIONS lives in worker/urc.env
-- on the PC. The device REPORTS it (urc_devices.bypass_permissions) so the
-- propose preview can show the true command; no server/job field can turn it on.
--
-- RLS: urc_devices and urc_jobs have NO policies at all — they are reachable
-- only by the service role (the MCP tools and /api/urc/device). urc_log is
-- select-own so a future UI can show the history; it is append-only to clients
-- (no insert/update/delete policy), and only the service role writes it.
-- ============================================================================

create table public.urc_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- SHA-256 hex of the device token (plaintext shown once by
  -- scripts/urc-register-device.mjs). Unique so a presented token resolves to
  -- exactly one device.
  token_hash text not null unique,
  -- Folder keys as reported by the PC's heartbeat. The server validates a
  -- spawn request against this list and never learns a path from it.
  folder_keys text[] not null default '{}',
  -- Optional { key: label } the PC may report so the propose preview can show
  -- the path the session will actually open. Display only.
  folder_labels jsonb not null default '{}',
  -- Last reported PC-side permission mode. Reported, never commanded.
  bypass_permissions boolean not null default false,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

create index urc_devices_user_idx on public.urc_devices (user_id);

-- One spawn request. 'queued' is the only claimable state and it expires two
-- minutes after creation, so a session can never start long after the chat
-- that asked for it. confirmed_auth records WHICH credential confirmed the
-- proposal ('pat' or 'oauth:<client>') — the static bearer is refused upstream.
create table public.urc_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.urc_devices (id) on delete cascade,
  folder_key text not null,
  status text not null default 'queued' check (
    status in ('queued', 'claimed', 'running', 'stopping', 'stopped', 'failed', 'expired')
  ),
  session_url text,
  error text,
  -- The confirmed ai_audit_log proposal this job came from.
  audit_id uuid references public.ai_audit_log (id) on delete set null,
  confirmed_auth text not null,
  -- The permission mode the PC actually started the session with, as REPORTED
  -- by the PC in its `started` call. Null until then. Informational: the mode
  -- is chosen in worker/urc.env and can never be set from this side.
  bypass_permissions boolean,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes',
  claimed_at timestamptz,
  started_at timestamptz,
  stop_requested_at timestamptz,
  stopped_at timestamptz,
  -- Informational only. The PC kills PIDs from its own local state, never one
  -- echoed back by the server.
  pid_hint integer
);

create index urc_jobs_claim_idx on public.urc_jobs (device_id, status, created_at);
create index urc_jobs_user_idx on public.urc_jobs (user_id, created_at desc);

-- One job per confirmed proposal, enforced by the database rather than by the
-- executor's own re-checks: the proposal claim already makes a confirm
-- single-use, and this makes a second job impossible even if two confirms were
-- ever to race past it.
create unique index urc_jobs_audit_unique on public.urc_jobs (audit_id)
  where audit_id is not null;

-- Append-only history. Every state change lands here, including the ones that
-- never produced a session (expired / failed).
create table public.urc_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid references public.urc_jobs (id) on delete set null,
  event text not null check (
    event in ('spawn_confirmed', 'started', 'failed', 'stop_requested', 'stopped', 'expired')
  ),
  folder_key text,
  confirmed_auth text,
  detail text,
  at timestamptz not null default now()
);

create index urc_log_user_idx on public.urc_log (user_id, at desc);
create index urc_log_job_idx on public.urc_log (job_id);

alter table public.urc_devices enable row level security;
alter table public.urc_jobs enable row level security;
alter table public.urc_log enable row level security;

-- urc_devices / urc_jobs: deliberately NO policies. With RLS enabled and no
-- policy, anon and authenticated read and write nothing — not even their own
-- rows — so a stolen session JWT cannot read a device token hash, queue a job,
-- or flip one to 'running' with an attacker-chosen session_url. Both tables are
-- service-role only (the MCP tools + /api/urc/device).

-- urc_log: readable by its owner, writable by nobody but the service role.
create policy "urc_log_select_own" on public.urc_log
  for select using (auth.uid() = user_id);

-- Atomic claim for one device: the oldest still-valid queued job belonging to
-- that device's user. FOR UPDATE SKIP LOCKED so two polls can't take the same
-- row. Queued jobs that aged out are marked 'expired' (with a log row) in the
-- same call, which is what keeps the queue from handing out a stale session
-- after the PC was offline.
-- Shaped exactly like claim_next_job (0027): a language-sql function whose
-- final statement is the guarded UPDATE ... RETURNING. The device's user is
-- re-read from urc_devices rather than taken from the caller, so a job can only
-- ever be claimed by the device it was queued for, on that device's own user. An
-- unknown p_device makes the subquery NULL and nothing matches.
create or replace function public.claim_urc_job(p_device uuid)
returns setof public.urc_jobs
language sql
security definer
set search_path = public
as $$
  with expired as (
    update public.urc_jobs
       set status = 'expired'
     where device_id = p_device
       and user_id = (select user_id from public.urc_devices where id = p_device)
       and status = 'queued'
       and expires_at <= now()
    returning id, user_id, folder_key, confirmed_auth
  )
  insert into public.urc_log (user_id, job_id, event, folder_key, confirmed_auth, detail)
  select user_id, id, 'expired', folder_key, confirmed_auth, 'not claimed before expires_at'
    from expired;

  update public.urc_jobs
     set status = 'claimed',
         claimed_at = now()
   where id = (
     select id
       from public.urc_jobs
      where device_id = p_device
        and user_id = (select user_id from public.urc_devices where id = p_device)
        and status = 'queued'
        and expires_at > now()
      order by created_at
      limit 1
      for update skip locked
   )
  returning *;
$$;

-- Only the service role (via /api/urc/device) may claim.
revoke all on function public.claim_urc_job(uuid) from public;
revoke all on function public.claim_urc_job(uuid) from anon;
revoke all on function public.claim_urc_job(uuid) from authenticated;
