-- ============================================================================
-- mindboard user settings
-- One row per user: timezone (anchors every "today" computation server-side,
-- where the process clock is UTC on Vercel), the wake window used for the
-- free-hours vital, and the hashed capture-API token for iOS Shortcuts.
-- RLS scoped by auth.uid(); the capture route reads it via the service-role
-- client (token lookup happens before any user session exists).
-- ============================================================================

create table public.user_settings (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  timezone         text not null default 'UTC',
  wake_start_hour  integer not null default 8 check (wake_start_hour between 0 and 23),
  wake_end_hour    integer not null default 22 check (wake_end_hour between 1 and 24),
  capture_token_hash text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index user_settings_capture_token_idx
  on public.user_settings (capture_token_hash)
  where capture_token_hash is not null;

alter table public.user_settings enable row level security;

create policy "user_settings_select_own"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "user_settings_insert_own"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "user_settings_update_own"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_settings_delete_own"
  on public.user_settings for delete
  using (auth.uid() = user_id);
