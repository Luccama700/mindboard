-- ============================================================================
-- mindboard daily logs (check-ins)
-- The "capacity" layer for the AI second brain: one row per user per local
-- day with mood, energy, sleep, and a free-text note. Filled from the
-- dashboard check-in strip or pushed from iOS Shortcuts (e.g. Apple Health
-- sleep) via the capture API. log_date is the user's local date key.
-- RLS scoped by auth.uid().
-- ============================================================================

create table public.daily_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  log_date    date not null,
  mood        integer check (mood between 1 and 5),
  energy      integer check (energy between 1 and 5),
  sleep_hours numeric check (sleep_hours >= 0 and sleep_hours <= 24),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, log_date)
);

create index daily_logs_user_date_idx on public.daily_logs (user_id, log_date desc);

alter table public.daily_logs enable row level security;

create policy "daily_logs_select_own"
  on public.daily_logs for select
  using (auth.uid() = user_id);

create policy "daily_logs_insert_own"
  on public.daily_logs for insert
  with check (auth.uid() = user_id);

create policy "daily_logs_update_own"
  on public.daily_logs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "daily_logs_delete_own"
  on public.daily_logs for delete
  using (auth.uid() = user_id);
