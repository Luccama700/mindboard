-- ============================================================================
-- The v2 engine's own tables: the per-account switch and rules document, the
-- day record, the planner's blocks, one-tap asks, the outbox the channel sends
-- from, the watchdog's feed expectations and runs, its alerts, and the Telegram
-- channel link.
--
-- NOT APPLIED. Nothing in this file has run against any database. Read it
-- first, then apply it with the code that uses it already deployed: the engine
-- is off for every account until a v2_rules row says enabled, so deploying the
-- code before the tables exist changes nothing for anyone.
--
-- WHAT MUST EXIST FIRST:
--   0064_same_tenant_fks.sql, which is where `tasks` gets the
--   tasks_user_id_id_key unique constraint on (user_id, id). v2_blocks.task_id
--   is a composite foreign key to that key, so this file does NOT apply on a
--   database that stops at 0063. Nothing else is needed: auth.users and
--   gen_random_uuid() have been there since 0001.
--
-- This file creates tables and nothing else. It alters no existing table, adds
-- no column, policy or constraint to one, and writes no row. The one existing
-- table it names is `tasks`, as the TARGET of a foreign key, which adds nothing
-- to `tasks` itself.
--
-- TO REMOVE IT, in this order (the outbox references the asks):
--   drop table if exists public.v2_outbox;
--   drop table if exists public.v2_asks;
--   drop table if exists public.v2_blocks;
--   drop table if exists public.v2_days;
--   drop table if exists public.v2_alerts;
--   drop table if exists public.v2_feed_runs;
--   drop table if exists public.v2_feed_expectations;
--   drop table if exists public.v2_channels;
--   drop table if exists public.v2_rules;
--
-- ---------------------------------------------------------------------------
-- The shape of the security here, which is the same shape as 0054's URC
-- tables: every write is the server's. The engine runs on a ten minute cron
-- tick and a Telegram webhook, both of which authenticate by bearer token and
-- use the service client, so there is no path on which a browser session needs
-- to write any of this. Clients may read their own rows on seven of the nine
-- tables, so a future Today screen can render without an extra API, and read
-- NOTHING on the two that carry channel state: v2_outbox (message text already
-- sent elsewhere, plus the claim that makes a send single) and v2_channels (a
-- chat id and a live pairing hash).
--
-- Row level security is only half of that. New tables in `public` inherit
-- Supabase's default privileges, which hand anon, authenticated and
-- service_role every privilege on the table. 0065 narrows that default for
-- anon, but only for anon and only from the point it is applied, so nothing
-- here may rely on it: each table below first revokes everything from both
-- client roles, then takes back just select on the seven that have a select
-- policy. A client write is then refused twice over, by a missing privilege and
-- by a missing policy, whatever order the files are applied in. service_role is
-- deliberately left alone, since the engine itself runs on it.
--
-- Ids: block ids are text, because the planner derives them as
-- <date>:<kind>:<task or kind> so that a replan keeps the id of a block that
-- still fits. Ask, outbox and alert ids are uuids made by the caller.
--
-- Time: instants are timestamptz, local days are `date` columns the app fills
-- from the user's zone. There is deliberately no time-zone arithmetic in this
-- file; the zone lives in the rules document and every conversion happens in
-- app/lib/snapshots/zoned-time.ts.
-- ============================================================================

-- One row per account. `enabled` is the per-account switch the cron tick reads;
-- `rules` is the whole rules document (planner rules, lanes, feed labels) as
-- one jsonb object, validated on read by the store's parser rather than by a
-- constraint, because the planner's own defaults decide what a partial
-- document means.
create table public.v2_rules (
  user_id uuid not null references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  rules jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id)
);

-- Enabled accounts, for the tick's one cross-account read.
create index v2_rules_enabled_idx on public.v2_rules (user_id) where enabled;

-- One row per local day. `energy` is null until he answers; `energy_assumed`
-- records that the planner used "ok" without an answer. `dropped` and
-- `leave_by` are the planner's own output, kept so Today can explain itself.
create table public.v2_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  energy text check (energy in ('low', 'ok', 'good')),
  energy_assumed boolean not null default false,
  mode text not null default 'normal'
    check (mode in ('normal', 'short-night', 'rough-day', 'travel')),
  planned_at timestamptz,
  morning_sent_at timestamptz,
  dropped jsonb not null default '[]'::jsonb,
  leave_by jsonb not null default '[]'::jsonb,
  primary key (user_id, date)
);

-- The blocks the planner owns. A replan rewrites only rows still in state
-- 'planned'; 'started', 'done' and 'skipped' are his, not the planner's, which
-- is why state lives on the row and not in a separate log.
create table public.v2_blocks (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  date date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null
    check (kind in ('floor', 'focus', 'session', 'touch', 'income', 'gym', 'small')),
  lane text,
  task_id uuid,
  title text not null,
  state text not null default 'planned'
    check (state in ('planned', 'started', 'done', 'skipped')),
  reason text not null default '',
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint v2_blocks_window check (ends_at >= starts_at),
  -- Composite, as 0064 made every tenant-crossing reference: the task must
  -- belong to the same account. The column-list form of on delete set null
  -- nulls task_id only, never user_id.
  constraint v2_blocks_task_id_fkey
    foreign key (user_id, task_id) references public.tasks (user_id, id)
    on delete set null (task_id)
);

create index v2_blocks_day_idx on public.v2_blocks (user_id, date);
create index v2_blocks_open_idx on public.v2_blocks (user_id, date) where state in ('planned', 'started');
create index v2_blocks_task_idx on public.v2_blocks (user_id, task_id);

-- One question with buttons. The unique dedupe key is what makes an ask
-- happen once ever rather than once per tick: the engine tries to insert and
-- reads back whatever is already there. `status` is only ever moved by a
-- conditional update, so a double tap and a retried webhook are both no-ops.
create table public.v2_asks (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  kind text not null,
  topic text not null,
  text text not null,
  options jsonb not null,
  default_option_id text not null,
  time_critical boolean not null default false,
  opened_at timestamptz not null,
  remind_at timestamptz,
  reminded_at timestamptz,
  expires_at timestamptz not null,
  status text not null default 'open'
    check (status in ('open', 'answered', 'expired', 'cancelled')),
  answered_option_id text,
  answered_at timestamptz,
  assumed boolean not null default false,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, dedupe_key)
);

create index v2_asks_open_idx on public.v2_asks (user_id, expires_at) where status = 'open';
create index v2_asks_topic_idx on public.v2_asks (user_id, topic, opened_at desc);

-- Everything the channel will send, and everything it has sent. `claimed_at`
-- is the single-send guard: the sender claims with one conditional update, so
-- two overlapping ticks cannot both deliver the same message. The unique
-- dedupe key is the other half, stopping the message being queued twice.
create table public.v2_outbox (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  kind text not null check (kind in ('morning', 'ask', 'alert', 'note')),
  dedupe_key text not null,
  -- 'hold' is a decision, not a row: a held ask is never queued.
  delivery text not null check (delivery in ('interrupt', 'digest')),
  message jsonb not null,
  ask_id uuid,
  created_at timestamptz not null,
  claimed_at timestamptz,
  sent_at timestamptz,
  chat_message_id text,
  error text,
  primary key (user_id, id),
  unique (user_id, dedupe_key),
  constraint v2_outbox_ask_id_fkey
    foreign key (user_id, ask_id) references public.v2_asks (user_id, id)
    on delete set null (ask_id)
);

create index v2_outbox_unsent_idx on public.v2_outbox (user_id, created_at) where sent_at is null;
create index v2_outbox_budget_idx on public.v2_outbox (user_id, kind, delivery, created_at);

-- What "alive" means for one feed. `label` is the name shown to the user;
-- `enabled_at` is when this expectation started counting, so a feed cannot be
-- called late before it has had one interval to run.
create table public.v2_feed_expectations (
  user_id uuid not null references auth.users (id) on delete cascade,
  feed text not null,
  label text not null,
  every_minutes integer not null check (every_minutes > 0),
  grace_minutes integer not null default 0 check (grace_minutes >= 0),
  min_count integer not null default 0 check (min_count >= 0),
  -- The two halves of Expectation.activeHours, paired by a check so a window is
  -- either whole or absent. "HH:MM" in the user's zone, read through the
  -- zoned-time helpers; nothing in SQL interprets it.
  active_from text check (active_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  active_to text check (active_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  enabled_at timestamptz not null default now(),
  primary key (user_id, feed),
  constraint v2_feed_expectations_hours
    check ((active_from is null) = (active_to is null))
);

-- One run of one feed. The column is item_count rather than count because
-- `count` collides with PostgREST's aggregate syntax.
create table public.v2_feed_runs (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  feed text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('ok', 'error')),
  item_count integer not null default 0 check (item_count >= 0),
  -- A short stable code such as 'auth-expired'. Free text never goes here.
  error_class text,
  primary key (user_id, id),
  constraint v2_feed_runs_window check (finished_at is null or finished_at >= started_at)
);

-- Serves "the newest runs for this user and feed", which is every read the
-- watchdog makes.
create index v2_feed_runs_recent_idx on public.v2_feed_runs (user_id, feed, started_at desc);

-- One open alert per cause, enforced by the partial unique index rather than by
-- the watchdog's own re-check, so two overlapping ticks cannot both open one.
create table public.v2_alerts (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  cause text not null,
  feeds text[] not null default '{}',
  since timestamptz not null,
  step integer not null default 0 check (step in (0, 1, 2)),
  last_sent_at timestamptz,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create unique index v2_alerts_open_cause_idx on public.v2_alerts (user_id, cause)
  where status = 'open';

-- Serves "the last announced alert for this cause", which is how a reopened
-- alert stays quiet for a while.
create index v2_alerts_cause_idx on public.v2_alerts (user_id, cause, last_sent_at desc);

-- The Telegram link. One row per account, at most one account per chat.
--
-- pairing_hash is the SHA-256 hex of a one-time pairing code; the code itself
-- is shown once in the app and never stored, here or anywhere else, so a dump
-- of this table cannot be replayed into a link. pairing_expires_at is what
-- makes it short lived, and redeeming it clears both columns in the same
-- statement that writes chat_id, which is what makes it single use.
create table public.v2_channels (
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_id text,
  linked_at timestamptz,
  pairing_hash text,
  pairing_expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id),
  constraint v2_channels_pairing
    check ((pairing_hash is null) = (pairing_expires_at is null))
);

create unique index v2_channels_chat_idx on public.v2_channels (chat_id)
  where chat_id is not null;

-- A presented hash has to resolve to exactly one account, the same way a PAT
-- hash and a URC device token hash do.
create unique index v2_channels_pairing_idx on public.v2_channels (pairing_hash)
  where pairing_hash is not null;

-- ----------------------------------------------------------------------------
-- Row level security, on every table.
-- ----------------------------------------------------------------------------

alter table public.v2_rules enable row level security;
alter table public.v2_days enable row level security;
alter table public.v2_blocks enable row level security;
alter table public.v2_asks enable row level security;
alter table public.v2_outbox enable row level security;
alter table public.v2_feed_expectations enable row level security;
alter table public.v2_feed_runs enable row level security;
alter table public.v2_alerts enable row level security;
alter table public.v2_channels enable row level security;

-- ----------------------------------------------------------------------------
-- Privileges. Revoke what the default privileges handed both client roles, and
-- take back select only where a select policy exists. v2_outbox and
-- v2_channels appear only in the revoke list. service_role keeps everything it
-- inherited: it is what the tick and the webhook run on.
-- ----------------------------------------------------------------------------

revoke all on table public.v2_rules from anon, authenticated;
revoke all on table public.v2_days from anon, authenticated;
revoke all on table public.v2_blocks from anon, authenticated;
revoke all on table public.v2_asks from anon, authenticated;
revoke all on table public.v2_outbox from anon, authenticated;
revoke all on table public.v2_feed_expectations from anon, authenticated;
revoke all on table public.v2_feed_runs from anon, authenticated;
revoke all on table public.v2_alerts from anon, authenticated;
revoke all on table public.v2_channels from anon, authenticated;

grant select on table public.v2_rules to authenticated;
grant select on table public.v2_days to authenticated;
grant select on table public.v2_blocks to authenticated;
grant select on table public.v2_asks to authenticated;
grant select on table public.v2_feed_expectations to authenticated;
grant select on table public.v2_feed_runs to authenticated;
grant select on table public.v2_alerts to authenticated;

-- ----------------------------------------------------------------------------
-- Policies. Select own, and nothing else: there is no insert, update or delete
-- policy on any of these tables, because every write is the server's.
-- (select auth.uid()) rather than bare auth.uid(), as 0065 rewrote every
-- existing policy, so the check is a one-time initplan instead of per row.
-- ----------------------------------------------------------------------------

create policy "v2_rules_select_own" on public.v2_rules
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "v2_days_select_own" on public.v2_days
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "v2_blocks_select_own" on public.v2_blocks
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "v2_asks_select_own" on public.v2_asks
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "v2_feed_expectations_select_own" on public.v2_feed_expectations
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "v2_feed_runs_select_own" on public.v2_feed_runs
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "v2_alerts_select_own" on public.v2_alerts
  for select to authenticated using ((select auth.uid()) = user_id);

-- v2_outbox and v2_channels: deliberately NO policy at all. With row level
-- security on and no policy, a session JWT reads and writes nothing, not even
-- its own rows, so a stolen token cannot read a live pairing hash, point a
-- chat id at itself, or clear the claim that keeps a send single.
