-- ============================================================================
-- What Supabase gives a migration before it runs, and nothing more.
--
-- Loaded once by createDatabase() into a fresh in-memory Postgres (PGlite).
-- The migration files run on top of this unmodified, so anything a migration
-- takes for granted about the platform has to exist here: the three API roles,
-- the auth and storage schemas, and the three extension schemas (cron, net,
-- vault) that the stand-ins below only RECORD into.
--
-- Fidelity notes, because the point of the rehearsal is catching privilege and
-- row-level-security mistakes:
--   * Supabase grants `anon`, `authenticated` and `service_role` everything on
--     new public tables by default privilege. 0065 revokes anon's; without the
--     same defaults here the revoke would have nothing to prove.
--   * `service_role` bypasses row-level security; the other two do not.
--   * The migration runner is the superuser `postgres`, as it is on Supabase.
--
-- Nothing here touches any real service. The cron, net and vault stand-ins
-- write to their own tables so a test can read back what was asked.
-- ============================================================================

-- ---- roles ------------------------------------------------------------------
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
grant anon, authenticated, service_role to postgres;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ---- auth -------------------------------------------------------------------
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                  uuid primary key default gen_random_uuid(),
  aud                 text,
  role                text,
  email               text,
  raw_app_meta_data   jsonb,
  raw_user_meta_data  jsonb,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  last_sign_in_at     timestamptz
);

-- Same resolution order as the real function: the sub claim PostgREST sets for
-- the request, either as its own setting or inside the claims document.
create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- ---- storage ----------------------------------------------------------------
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id                  text primary key,
  name                text not null,
  owner               uuid,
  public              boolean default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create table storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets (id),
  name             text,
  owner            uuid,
  metadata         jsonb,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now()
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

-- Real implementation: the folder components of an object name, without the
-- file name. 'a/b/c.png' -> {a,b}.
create function storage.foldername(name text) returns text[]
language plpgsql
as $$
declare
  parts text[];
begin
  select string_to_array(name, '/') into parts;
  return parts[1:array_length(parts, 1) - 1];
end
$$;

grant all on all tables in schema storage to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- ---- cron (pg_cron stand-in) --------------------------------------------------
-- The extension itself cannot be installed in this engine (see the harness's
-- neutralised statements); the functions below keep its shape: scheduling a
-- name that already exists replaces it, as pg_cron does.
create schema cron;

create table cron.job (
  jobid     bigint generated always as identity primary key,
  jobname   text unique,
  schedule  text not null,
  command   text not null,
  database  text not null default current_database(),
  username  text not null default current_user,
  active    boolean not null default true
);

create function cron.schedule(job_name text, schedule text, command text) returns bigint
language plpgsql
as $$
declare
  id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update
    set schedule = excluded.schedule, command = excluded.command
  returning jobid into id;
  return id;
end
$$;

create function cron.schedule(schedule text, command text) returns bigint
language sql
as $$
  insert into cron.job (schedule, command) values (schedule, command) returning jobid
$$;

create function cron.unschedule(job_name text) returns boolean
language plpgsql
as $$
declare
  n int;
begin
  delete from cron.job where jobname = job_name;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'could not find valid entry for job ''%''', job_name;
  end if;
  return true;
end
$$;

create function cron.unschedule(job_id bigint) returns boolean
language plpgsql
as $$
declare
  n int;
begin
  delete from cron.job where jobid = job_id;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'could not find valid entry for job ''%''', job_id;
  end if;
  return true;
end
$$;

-- ---- net (pg_net stand-in) ------------------------------------------------------
-- Nothing is ever sent. A call is a row.
create schema net;

create table net.requests (
  id         bigint generated always as identity primary key,
  method     text not null,
  url        text not null,
  headers    jsonb,
  body       jsonb,
  asked_at   timestamptz not null default now()
);

create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language sql
as $$
  insert into net.requests (method, url, headers, body) values ('POST', url, headers, body) returning id
$$;

create function net.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language sql
as $$
  insert into net.requests (method, url, headers) values ('GET', url, headers) returning id
$$;

-- ---- vault (supabase_vault stand-in) ---------------------------------------------
-- Secrets are stored in the clear: this database holds invented data only.
create schema vault;

create table vault.secrets (
  id           uuid primary key default gen_random_uuid(),
  name         text unique,
  description  text not null default '',
  secret       text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
  from vault.secrets;

create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid
language sql
as $$
  insert into vault.secrets (secret, name, description)
  values (new_secret, new_name, coalesce(new_description, ''))
  returning id
$$;
